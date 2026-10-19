// Frame-by-frame renderer: headless Chrome with virtual time -> PNG frames -> one ffmpeg process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { runtime } from './runtime.js';
import { serve } from './server.js';
import { findChrome, findFfmpeg, ffmpegEncoders } from './tools.js';
import { encoderArgs, startEncoder, contactSheet } from './encode.js';
import { diffPNG } from './png.js';

export const META_NAME = 'html2mp4';
export const PRESETS = {
  vertical: [1080, 1920], // TikTok / Reels / Shorts / Douyin
  landscape: [1920, 1080], // 16:9
  square: [1080, 1080],
  portrait: [1080, 1350], // 4:5 feed
  '720p': [1280, 720],
  '4k': [3840, 2160],
};
const DEFAULT_SIZE = [1920, 1080];
const EPOCH = Date.UTC(2026, 0, 1); // what `new Date()` returns at t=0 inside the page

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
let sandboxUnavailable = false; // learned on the first launch, so later launches skip the failing attempt

export function parseSize(s) {
  if (!s) return null;
  if (PRESETS[s]) return PRESETS[s];
  const m = /^(\d+)\s*[x×:]\s*(\d+)$/i.exec(String(s).trim());
  if (!m) throw new Error(`bad size "${s}" (use WIDTHxHEIGHT, e.g. 1080x1920, or a preset: ${Object.keys(PRESETS).join(', ')})`);
  return [Number(m[1]), Number(m[2])];
}

// Resolve the input to something we can open: a URL, or a local HTML file served over HTTP.
function resolveInput(input, root) {
  if (/^https?:\/\//i.test(input)) return { url: input };
  if (/^file:\/\//i.test(input)) input = new URL(input).pathname;
  let file = path.resolve(input);
  if (!fs.existsSync(file)) throw new Error(`input not found: ${input}`);
  if (fs.statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html');
    if (!fs.existsSync(idx)) throw new Error(`no index.html in ${input}`);
    file = idx;
  }
  const dir = root ? path.resolve(root) : path.dirname(file);
  const rel = path.relative(dir, file);
  if (rel.startsWith('..')) throw new Error(`--root ${root} does not contain ${file}`);
  return { file, root: dir, rel: rel.split(path.sep).map(encodeURIComponent).join('/') };
}

export function defaultOutput(input, ext = '.mp4') {
  if (/^https?:\/\//i.test(input)) return 'out' + ext;
  const p = path.resolve(input);
  const name = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.basename(p)
    : path.basename(p, path.extname(p)) === 'index' ? path.basename(path.dirname(p)) : path.basename(p, path.extname(p));
  return name + ext;
}

class Session {
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.warn = opts.warn || this.log;
    this.pageErrors = new Map();
  }

  async open(input) {
    const src = resolveInput(input, this.opts.root);
    if (src.file) {
      this.server = await serve(src.root);
      this.url = `${this.server.url}/${src.rel}`;
    } else {
      this.url = src.url;
    }
    this.chrome = findChrome(this.opts.chrome);
    await this.launch();
  }

  async launch() {
    const args = [
      '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--run-all-compositor-stages-before-draw', '--disable-new-content-rendering-timeout',
      '--disable-features=PaintHolding', '--font-render-hinting=none',
      // GPU rasterization of page content is not bit-exact from run to run (text in layers that
      // are fading or moving came out 1 LSB different). CPU raster is; WebGL still uses the GPU.
      '--disable-gpu-rasterization',
    ];
    if (this.opts.gl === 'swiftshader') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    else args.push('--enable-unsafe-swiftshader'); // allows WebGL on machines without a GPU (CI)
    if (sandboxUnavailable || (process.platform === 'linux' && process.getuid && process.getuid() === 0)) args.push('--no-sandbox');
    if (process.env.HTML2MP4_CHROME_ARGS) args.push(...process.env.HTML2MP4_CHROME_ARGS.split(/\s+/).filter(Boolean));
    const launch = () => puppeteer.launch({
      executablePath: this.chrome,
      headless: /headless[-_]shell/i.test(this.chrome) ? 'shell' : true,
      args,
      protocolTimeout: 0,
    });
    try {
      this.browser = await launch();
    } catch (e) {
      // Chrome's Linux sandbox needs user namespaces, which Docker (as non-root) and Ubuntu 23.10+
      // (AppArmor) block. Chrome then exits with "No usable sandbox!".
      if (process.platform !== 'linux' || args.includes('--no-sandbox') || !/No usable sandbox|SUID sandbox/i.test(e.message)) throw e;
      this.warn("Chrome's sandbox is not available on this system (no user namespaces); running Chrome with --no-sandbox");
      sandboxUnavailable = true;
      args.push('--no-sandbox');
      this.browser = await launch();
    }
  }

  // A fresh browser process (used by the determinism check so nothing is shared with pass one).
  async relaunch() {
    await this.browser?.close().catch(() => {});
    await this.launch();
  }

  pageError(kind, msg) {
    const key = `${kind}: ${msg}`.slice(0, 500);
    const n = this.pageErrors.get(key) || 0;
    this.pageErrors.set(key, n + 1);
    if (n === 0) this.warn(`[page ${kind}] ${msg}`);
  }

  // One worker = one isolated browser context (its own renderer process) with the runtime injected.
  async newWorker({ size, dpr, seed, timeout }) {
    const context = await this.browser.createBrowserContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => this.pageError('error', e.message || String(e)));
    page.on('console', (m) => { if (m.type() === 'error') this.pageError('console', m.text()); });
    page.on('requestfailed', (r) => this.pageError('request failed', `${r.url()} (${r.failure()?.errorText})`));
    page.on('response', (r) => { if (r.status() >= 400) this.pageError('http ' + r.status(), r.url()); });
    await page.setViewport({ width: Math.round(size[0] / dpr), height: Math.round(size[1] / dpr), deviceScaleFactor: dpr });
    await page.evaluateOnNewDocument(`(${runtime.toString()})(${JSON.stringify({ seed, epoch: EPOCH, gsap2d: this.opts.gsap3d !== true })})`);
    const cdp = await page.createCDPSession();
    await page.goto(this.url, { waitUntil: 'load', timeout });
    await page.waitForNetworkIdle({ idleTime: 250, timeout: Math.min(timeout, 15000) })
      .catch(() => this.warn('network did not go idle within 15 s; rendering anyway'));
    const hasRuntime = await page.evaluate(() => !!window.__h2m);
    if (!hasRuntime) throw new Error('the time runtime did not load in the page (is the URL an HTML page?)');
    return {
      page,
      async capture() {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false });
        return Buffer.from(data, 'base64');
      },
      probe: () => page.evaluate((m) => window.__h2m.probe(m), META_NAME),
      prepare: (o) => page.evaluate((o) => window.__h2m.prepare(o), o),
      step: (ms) => page.evaluate((ms) => window.__h2m.step(ms), ms),
      seek: (ms) => page.evaluate((ms) => window.__h2m.seek(ms), ms),
      // Advance to a frame and capture it; the screenshot is that frame's one rendering step.
      async frame(ms, seekMode) {
        await page.evaluate((ms, sk) => (sk ? window.__h2m.seek(ms, true) : window.__h2m.step(ms, true)), ms, seekMode);
        const png = await this.capture();
        await page.evaluate((sk) => window.__h2m.post(sk), seekMode);
        return png;
      },
      evaluate: (expr) => page.evaluate((e) => window.__h2m.evaluate(e), expr),
      close: () => context.close().catch(() => {}),
    };
  }

  async close() {
    await this.browser?.close().catch(() => {});
    await this.server?.close();
  }
}

// Work out size, fps, duration and mode by loading the page once.
async function plan(session, opts) {
  const timeout = opts.timeout ?? 60000;
  const dpr = opts.dpr || 1;
  let size = opts.size || DEFAULT_SIZE;
  let w = await session.newWorker({ size, dpr, seed: opts.seed, timeout });
  let probe = await w.probe();
  if (!opts.size && probe.size && (probe.size[0] !== size[0] || probe.size[1] !== size[1])) {
    size = probe.size;
    await w.close();
    w = await session.newWorker({ size, dpr, seed: opts.seed, timeout });
    probe = await w.probe();
  }
  const fps = opts.fps || probe.fps || 30;
  const stepMs = 1000 / fps;
  const { steps } = await w.prepare({ waitFor: opts.waitFor || null, stepMs, steps: null, timeoutMs: timeout });
  const after = await w.probe();
  await w.close();

  let duration = opts.duration || probe.duration;
  let durationSource = opts.duration ? 'option' : probe.duration ? 'page' : null;
  if (!duration) {
    const gsap = after.gsapEnd > 0 && after.gsapEnd < 1e5 ? after.gsapEnd : 0;
    const css = after.cssEnd > 0 ? after.cssEnd : 0;
    const end = Math.max(gsap, css);
    if (end > 0) {
      duration = Math.round((end + 0.5) * 1000) / 1000; // hold the final state for half a second
      durationSource = `inferred from ${gsap >= css ? 'the GSAP timeline' : 'CSS / Web Animations'} (${end.toFixed(2)} s + 0.5 s hold)`;
    }
  }
  if (!duration) {
    const why = after.cssInfinite || after.gsapEnd >= 1e5 ? 'the page only has infinite (looping) animations'
      : 'the page declares no duration and has no finite CSS/GSAP animations to infer it from';
    const err = new Error(`can't tell how long the video should be: ${why}.\n` +
      `  Pass --duration <seconds>, or declare it in the page: window.__render = { duration: 8 }  or  <meta name="${META_NAME}" content="duration=8">`);
    err.code = 'NO_DURATION';
    throw err;
  }
  if (size[0] % 2 || size[1] % 2) throw new Error(`size ${size[0]}x${size[1]} must be even in both dimensions for yuv420p video`);
  if (Math.round(size[0] / dpr) * dpr !== size[0] || Math.round(size[1] / dpr) * dpr !== size[1]) {
    throw new Error(`size ${size[0]}x${size[1]} is not divisible by --dpr ${dpr}`);
  }
  return {
    mode: probe.mode, size, dpr, fps, duration, durationSource, steps,
    frames: Math.max(1, Math.round(duration * fps)),
    title: probe.title, webgl: after.webgl, animations: after.animations,
  };
}

// Render the given frame indices with `workers` pages. Frames come out in index order through
// `sink(i, png)`, whatever order the workers finish them in.
async function pass(session, p, opts, { workers, indices, reverse = false, exact = true, sink, onProgress }) {
  const timeout = opts.timeout ?? 60000;
  const stepMs = 1000 / p.fps;
  const frameMs = (i) => (p.mode === 'seek' ? i : p.steps + i) * stepMs;
  // Virtual-time pages are path-dependent, so they render on a single page; seek pages fan out.
  workers = p.mode === 'seek' ? Math.max(1, Math.min(workers, indices.length)) : 1;
  const pages = await Promise.all(Array.from({ length: workers }, () => session.newWorker({ size: p.size, dpr: p.dpr, seed: opts.seed, timeout })));
  try {
    const prep = await Promise.all(pages.map((w) => w.prepare({ waitFor: opts.waitFor || null, stepMs, steps: p.steps, timeoutMs: timeout })));
    if (prep.some((r) => r.steps !== p.steps)) throw new Error('worker pages reached the ready state at different times');

    const order = new Map(indices.map((f, k) => [f, k]));
    const pending = new Map();
    let next = 0;
    let flushing = false;
    let failed = null;
    const waiters = [];
    const wake = () => waiters.splice(0).forEach((r) => r());
    const maxAhead = workers * 3;
    const flush = async () => {
      if (flushing) return;
      flushing = true;
      try {
        while (pending.has(next)) {
          const buf = pending.get(next);
          pending.delete(next);
          await sink(indices[next], buf);
          next++;
          onProgress?.(next, indices.length);
          wake();
        }
      } finally {
        flushing = false;
      }
    };
    const emit = async (frame, buf) => {
      const k = order.get(frame);
      while (k - next > maxAhead && !failed) await new Promise((r) => waiters.push(r));
      if (failed) throw failed;
      pending.set(k, buf);
      await flush();
    };

    const work = pages.map(async (w, j) => {
      const mine = indices.filter((_, k) => k % workers === j);
      if (p.mode === 'seek') {
        const list = reverse ? [...mine].reverse() : mine;
        // In reverse order the reorder buffer would hold everything; collect then emit in order.
        const held = reverse ? new Map() : null;
        for (const f of list) {
          const buf = await w.frame(frameMs(f), true);
          if (held) held.set(f, buf);
          else await emit(f, buf);
        }
        if (held) for (const f of mine) await emit(f, held.get(f));
        return;
      }
      // Virtual time: one page steps through every frame from 0. Each frame gets exactly one
      // rendering step. With `exact`, every frame is drawn through a screenshot, as in the video
      // (Chrome's raster heuristics depend on the history of drawn frames, so this is what makes
      // stills identical to video frames); otherwise frames that are not kept use a cheaper real
      // animation frame.
      const keep = new Set(mine);
      const last = mine[mine.length - 1];
      for (let f = 0; f <= last; f++) {
        if (keep.has(f)) await emit(f, await w.frame(frameMs(f), false));
        else if (exact) await w.frame(frameMs(f), false);
        else await w.step(frameMs(f));
      }
    });
    await Promise.all(work.map((x) => x.catch((e) => { failed = failed || e; wake(); throw e; })));
  } finally {
    await Promise.all(pages.map((w) => w.close()));
  }
}

function progressReporter(log, label, isTTY) {
  const t0 = Date.now();
  let lastPct = -1;
  return (n, total) => {
    const pct = Math.floor((n / total) * 100);
    const el = (Date.now() - t0) / 1000;
    const fps = n / Math.max(el, 1e-3);
    const eta = (total - n) / Math.max(fps, 1e-3);
    if (isTTY) {
      process.stderr.write(`\r${label} ${n}/${total} (${pct}%)  ${fps.toFixed(1)} frames/s  ETA ${eta.toFixed(0)}s   `);
      if (n === total) process.stderr.write('\n');
    } else if (pct >= lastPct + 10 || n === total) {
      lastPct = pct - (pct % 10);
      log(`${label} ${n}/${total} (${pct}%)  ${fps.toFixed(1)} frames/s  ETA ${eta.toFixed(0)}s`);
    }
  };
}

const defaultWorkers = () => Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)));

// Math.random is seeded unless the caller passes seed: null.
const withDefaults = (opts) => ({ ...opts, seed: opts.seed === undefined ? 1 : opts.seed });

export async function render(input, opts = {}) {
  opts = withDefaults(opts);
  const log = opts.log || (() => {});
  const t0 = Date.now();
  const session = new Session(opts);
  try {
    await session.open(input);
    const p = await plan(session, opts);
    const workers = p.mode === 'seek' ? Math.min(opts.workers || defaultWorkers(), p.frames) : 1;
    log(`${p.size[0]}x${p.size[1]} @ ${p.fps} fps, ${p.duration} s (${p.durationSource}), ${p.frames} frames, ` +
      (p.mode === 'seek' ? `seek mode (page exposes __render), ${workers} parallel page${workers > 1 ? 's' : ''}` : 'virtual time, one page') +
      (p.steps ? `, page ready after ${p.steps} startup frames` : ''));
    if (p.mode !== 'seek' && opts.workers > 1) log('note: --workers only applies to pages that expose window.__render seek(t); virtual-time pages render in order on one page');
    const indices = Array.from({ length: p.frames }, (_, i) => i);
    const hashes = new Array(p.frames);
    const samples = opts.evaluate ? new Array(p.frames) : null;

    let encoder = null;
    let output = null;
    if (opts.output !== false) {
      output = path.resolve(opts.output || defaultOutput(input));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const ffmpeg = findFfmpeg(opts.ffmpeg);
      encoder = startEncoder(ffmpeg, encoderArgs(await ffmpegEncoders(ffmpeg), output, p, opts));
    }
    const isTTY = !opts.quiet && process.stderr.isTTY;
    const progress = opts.quiet ? null : progressReporter(log, 'render', isTTY);
    // The determinism check compares pixels of frames whose hashes differ, so keep pass one's frames.
    const keepDir = opts.checkDeterminism ? fs.mkdtempSync(path.join(os.tmpdir(), 'html2mp4-det-')) : null;
    try {
      await pass(session, p, opts, {
        workers, indices, onProgress: progress,
        sink: async (i, buf) => {
          hashes[i] = sha256(buf);
          if (keepDir) fs.writeFileSync(path.join(keepDir, `${i}.png`), buf);
          if (encoder) await encoder.write(buf);
        },
      });
      if (encoder) await encoder.end();
    } catch (e) {
      encoder?.kill();
      throw e;
    }
    if (samples) {
      // --evaluate is a debugging aid: re-run once on a single page and read the expression per frame.
      const w = await session.newWorker({ size: p.size, dpr: p.dpr, seed: opts.seed, timeout: opts.timeout ?? 60000 });
      try {
        await w.prepare({ waitFor: opts.waitFor || null, stepMs: 1000 / p.fps, steps: p.steps, timeoutMs: opts.timeout ?? 60000 });
        for (const i of indices) {
          if (p.mode === 'seek') await w.seek((i * 1000) / p.fps);
          else await w.step(((p.steps + i) * 1000) / p.fps);
          samples[i] = await w.evaluate(opts.evaluate);
        }
      } finally {
        await w.close();
      }
    }

    const summary = {
      output, size: p.size, fps: p.fps, duration: p.frames / p.fps, frames: p.frames, mode: p.mode,
      durationSource: p.durationSource, workers, startupFrames: p.steps,
      renderSeconds: (Date.now() - t0) / 1000,
      webgl: p.webgl, pageErrors: [...session.pageErrors.keys()],
      framesHash: sha256(hashes.join('\n')),
    };
    if (output) summary.fileHash = sha256(fs.readFileSync(output));
    if (opts.hashes) fs.writeFileSync(path.resolve(opts.hashes), JSON.stringify({ fps: p.fps, frames: hashes }, null, 1));
    if (samples) summary.samples = samples;

    if (opts.checkDeterminism) {
      try {
        summary.determinism = await determinismPass(session, p, opts, { workers, indices, hashes, keepDir, log, isTTY });
      } finally {
        fs.rmSync(keepDir, { recursive: true, force: true });
      }
    }
    return summary;
  } finally {
    await session.close();
  }
}

// When two renders of a frame are not bit-identical, they still count as visually identical if at
// most 0.05% of the pixels differ by more than 2/255 and nothing differs by more than 64/255.
// Chrome rasterizes an element whose transform or opacity is changing a little differently
// depending on timing inside the compositor (which raster scale it picked, whether the layer was
// promoted yet); that shows up as antialiasing on the edges of that one element, e.g. 128 edge
// pixels of a scaling circle, or 1-6 levels on a few pixels of a fading subtitle. Real bugs (a
// frame that depends on seek order, unseeded randomness, a race with loading) change whole areas.
const TOLERANCE = { maxDiff: 64, strongFraction: 5e-4 };
const visuallySame = (d) => d.maxDiff <= TOLERANCE.maxDiff && d.strong <= Math.max(1, Math.floor(d.total * TOLERANCE.strongFraction));

async function determinismPass(session, p, opts, { workers, indices, hashes, keepDir, log, isTTY }) {
  const w2 = workers > 1 ? workers - 1 : 2;
  const how = p.mode === 'seek' ? `a new browser process, ${w2} parallel pages, frames seeked in reverse order` : 'a new browser process';
  log(`determinism: rendering again in ${how} and comparing every frame`);
  await session.relaunch();
  const diffs = [];
  await pass(session, p, opts, {
    workers: w2, indices, reverse: p.mode === 'seek',
    onProgress: opts.quiet ? null : progressReporter(log, 'verify', isTTY),
    sink: async (i, buf) => {
      if (sha256(buf) === hashes[i]) return;
      const d = diffPNG(fs.readFileSync(path.join(keepDir, `${i}.png`)), buf);
      diffs.push({ frame: i, time: i / p.fps, ...d });
      if (process.env.HTML2MP4_DUMP_DIR) {
        fs.copyFileSync(path.join(keepDir, `${i}.png`), path.join(process.env.HTML2MP4_DUMP_DIR, `a-${i}.png`));
        fs.writeFileSync(path.join(process.env.HTML2MP4_DUMP_DIR, `b-${i}.png`), buf);
      }
    },
  });
  const maxDiff = diffs.reduce((m, d) => Math.max(m, d.maxDiff), 0);
  const worst = diffs.reduce((m, d) => (!m || d.strong > m.strong || (d.strong === m.strong && d.maxDiff > m.maxDiff) ? d : m), null);
  return {
    identical: diffs.length === 0, // bit for bit
    visuallyIdentical: diffs.every(visuallySame),
    framesOverTolerance: diffs.filter((d) => !visuallySame(d)).length,
    maxPixelsDiffering: diffs.reduce((m, d) => Math.max(m, d.pixels), 0),
    tolerance: TOLERANCE,
    framesCompared: indices.length,
    framesDiffering: diffs.length,
    maxChannelDiff: maxDiff,
    firstDiff: diffs.length ? diffs.reduce((a, b) => (a.frame < b.frame ? a : b)) : null,
    worstDiff: worst,
    secondPass: how,
  };
}

// Render stills at the given times (seconds) to PNG files; optionally also one contact sheet.
export async function snap(input, opts = {}) {
  opts = withDefaults(opts);
  const log = opts.log || (() => {});
  const session = new Session(opts);
  try {
    await session.open(input);
    const p = await plan(session, { ...opts, duration: opts.duration || 1e9 });
    const times = (opts.at && opts.at.length ? opts.at : [0]).map(Number);
    const indices = [...new Set(times.map((t) => Math.max(0, Math.round(t * p.fps))))].sort((a, b) => a - b);
    const dir = path.resolve(opts.outDir || 'frames');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    const bufs = [];
    await pass(session, p, opts, {
      workers: 1, indices, exact: !!opts.exact,
      sink: async (i, buf) => {
        const f = path.join(dir, `frame-${(i / p.fps).toFixed(2).padStart(7, '0')}s.png`);
        fs.writeFileSync(f, buf);
        files.push({ time: i / p.fps, frame: i, file: f });
        bufs.push(buf);
      },
    });
    let sheet = null;
    if (opts.sheet) {
      sheet = path.resolve(opts.sheet);
      await contactSheet(findFfmpeg(opts.ffmpeg), bufs, p.size, sheet, opts.sheetWidth);
      log(`contact sheet: ${sheet} (${files.map((f) => f.time.toFixed(2) + 's').join(', ')}, left to right, top to bottom)`);
    }
    return { size: p.size, fps: p.fps, mode: p.mode, files, sheet, pageErrors: [...session.pageErrors.keys()] };
  } finally {
    await session.close();
  }
}

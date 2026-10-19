#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, snap, parseSize, PRESETS, META_NAME } from '../src/render.js';
import { check } from '../src/check.js';
import { findChrome, findFfmpeg, ffmpegEncoders } from '../src/tools.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const HELP = `html2mp4 ${pkg.version} - render an HTML animation to video, deterministically, frame by frame

Usage
  html2mp4 render <page.html | folder | url> [-o out.mp4] [options]
  html2mp4 snap   <page.html | folder | url> --at 0,1.5,3 [-o frames/] [--sheet sheet.png]
  html2mp4 check  <video.mp4> [--sheet sheet.png] [--transcode]
  html2mp4 doctor

render options
  -o, --output <file>      .mp4 (H.264), .webm (VP9) or .gif   [default: <page name>.mp4]
  -s, --size <WxH|preset>  e.g. 1080x1920; presets: ${Object.keys(PRESETS).join(', ')}   [default: page-declared, else 1920x1080]
  -p, --preset <name>      same as --size <preset>
  -d, --duration <sec>     [default: page-declared, else inferred from CSS/GSAP animations]
  -f, --fps <n>            [default: page-declared, else 30]
  -a, --audio <file>       mux an audio track (padded or cut to the video length)
  -w, --workers <n>        parallel pages for seek(t) pages [default: min(4, cores/2)];
                           virtual-time pages always render in order on one page
      --dpr <n>            device pixel ratio; page viewport = size / dpr  [default: 1]
      --crf <n>            quality, lower is better  [default: 18 for mp4, 30 for webm]
      --x264-preset <p>    x264 speed preset  [default: medium]
      --seed <n>           seed for Math.random  [default: 1]; --seed none keeps real randomness
      --wait-for <js>      start once this expression is true, e.g. "window.ready === true"
      --root <dir>         folder to serve (if the page loads files from above its own folder)
      --timeout <ms>       page load / ready timeout  [default: 60000]
      --check-determinism  render again in a fresh browser (seek pages: other split, reverse order)
                           and compare every frame
      --hashes <file>      write per-frame SHA-256 hashes as JSON
      --qc                 run \`check\` on the result
      --gl swiftshader     software WebGL (same pixels on any machine, slower)
      --chrome <path>      Chrome/Chromium binary  (or CHROME_PATH)
      --ffmpeg <path>      ffmpeg binary  (or FFMPEG_PATH)
      --json               print a JSON summary on stdout (logs stay on stderr)
      --evaluate <js>      with --json: also report this page expression after every frame (debugging)
  -q, --quiet              no progress output

snap options
      --at <t,t,...>       times in seconds  [default: 0]
      --sheet <file.png>   also tile the stills into one contact sheet
      --exact              draw skipped frames exactly as \`render\` does (slower; stills then match
                           video frames bit for bit; without it, sub-pixel antialiasing may differ)

check options
      --sheet <file.png>   also write a contact sheet of 8 evenly spaced frames
      --transcode          simulate a short-video platform re-encode (2 Mbps x264) and report SSIM
      --max-freeze <sec>   longest allowed still stretch  [default: 2]
      --lufs <n>           loudness target  [default: -14]

The page controls nothing by default: time is virtual (rAF, performance.now, Date, timers, CSS
animations/transitions, Web Animations, SVG SMIL, GSAP, Three.js clocks). Optional, in the page:
  window.__render = { duration: 8, fps: 30, width: 1080, height: 1920 }
  window.__render = { duration: 8, seek: async (t) => { /* draw time t (seconds) */ } }
  <meta name="${META_NAME}" content="duration=8; size=1080x1920; fps=30">

Environment: CHROME_PATH, FFMPEG_PATH, HTML2MP4_CHROME_ARGS (extra Chrome flags),
HTML2MP4_DUMP_DIR (with --check-determinism: save both versions of every frame that differs).

Exit codes: 0 ok, 1 error, 2 bad usage, 3 determinism or QC check failed.`;

const options = {
  output: { type: 'string', short: 'o' },
  size: { type: 'string', short: 's' },
  preset: { type: 'string', short: 'p' },
  duration: { type: 'string', short: 'd' },
  fps: { type: 'string', short: 'f' },
  audio: { type: 'string', short: 'a' },
  workers: { type: 'string', short: 'w' },
  dpr: { type: 'string' },
  crf: { type: 'string' },
  'x264-preset': { type: 'string' },
  seed: { type: 'string' },
  'wait-for': { type: 'string' },
  root: { type: 'string' },
  timeout: { type: 'string' },
  'check-determinism': { type: 'boolean' },
  hashes: { type: 'string' },
  qc: { type: 'boolean' },
  gl: { type: 'string' },
  chrome: { type: 'string' },
  ffmpeg: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  at: { type: 'string' },
  sheet: { type: 'string' },
  transcode: { type: 'boolean' },
  exact: { type: 'boolean' },
  'max-freeze': { type: 'string' },
  lufs: { type: 'string' },
  evaluate: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

class UsageError extends Error {}
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const num = (v, name, { int = false, min = 0 } = {}) => {
  if (v == null) return undefined;
  const x = Number(v);
  if (!Number.isFinite(x) || x <= min - 1e-12 || (int && !Number.isInteger(x))) throw new UsageError(`--${name} must be a ${int ? 'whole ' : ''}number${min > 0 ? ` >= ${min}` : ''}, got "${v}"`);
  return x;
};

function printGates(res) {
  const icon = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: '    ' };
  log(`check ${res.file}`);
  for (const g of res.gates) log(`  ${icon[g.status]}  ${g.name.padEnd(12)} ${g.detail}`);
  log(res.ok ? 'result: pass' : 'result: FAIL');
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError(e.message);
  }
  const { values: v, positionals } = parsed;
  if (v.version) { console.log(pkg.version); return 0; }
  const [cmd, target] = positionals;
  if (v.help || !cmd) { console.log(HELP); return cmd || v.help ? 0 : 2; }

  if (cmd === 'doctor') {
    const out = { node: process.version, platform: `${process.platform}-${process.arch}` };
    try { out.chrome = findChrome(v.chrome); } catch (e) { out.chrome = null; out.chromeError = e.message; }
    try {
      out.ffmpeg = findFfmpeg(v.ffmpeg);
      const enc = await ffmpegEncoders(out.ffmpeg);
      out.encoders = ['libx264', 'libvpx-vp9', 'aac', 'libopus'].filter((e) => enc.has(e));
    } catch (e) { out.ffmpeg = null; out.ffmpegError = e.message; }
    if (v.json) console.log(JSON.stringify(out, null, 2));
    else for (const [k, val] of Object.entries(out)) log(`${k.padEnd(12)} ${Array.isArray(val) ? val.join(', ') : val}`);
    return out.chrome && out.ffmpeg ? 0 : 1;
  }

  if (cmd === 'check') {
    if (!target) throw new UsageError('check needs a video file');
    const res = await check(target, {
      sheet: v.sheet, transcode: v.transcode, ffmpeg: v.ffmpeg,
      maxFreeze: num(v['max-freeze'], 'max-freeze'), lufs: v.lufs != null ? Number(v.lufs) : undefined,
    });
    if (v.json) console.log(JSON.stringify(res, null, 2));
    else printGates(res);
    return res.ok ? 0 : 3;
  }

  if (cmd !== 'render' && cmd !== 'snap') throw new UsageError(`unknown command "${cmd}" (render, snap, check, doctor)`);
  if (!target) throw new UsageError(`${cmd} needs a page: an .html file, a folder with index.html, or a URL`);
  if (v.size && v.preset) throw new UsageError('use --size or --preset, not both');
  if (v.preset && !PRESETS[v.preset]) throw new UsageError(`unknown preset "${v.preset}" (${Object.keys(PRESETS).join(', ')})`);
  let size;
  try { size = parseSize(v.size || v.preset); } catch (e) { throw new UsageError(e.message); }
  const common = {
    size,
    fps: num(v.fps, 'fps', { min: 1 }),
    duration: num(v.duration, 'duration'),
    dpr: num(v.dpr, 'dpr'),
    seed: v.seed === 'none' ? null : num(v.seed ?? '1', 'seed', { int: true }),
    waitFor: v['wait-for'],
    root: v.root,
    timeout: num(v.timeout, 'timeout', { int: true }),
    gl: v.gl,
    chrome: v.chrome,
    ffmpeg: v.ffmpeg,
    quiet: v.quiet,
    log: v.quiet ? () => {} : log,
    warn: log,
  };

  if (cmd === 'snap') {
    const at = (v.at || '0').split(',').map((s) => num(s.trim(), 'at'));
    const res = await snap(target, { ...common, at, outDir: v.output || 'frames', sheet: v.sheet, exact: v.exact });
    if (v.json) console.log(JSON.stringify(res, null, 2));
    else for (const f of res.files) log(`${f.time.toFixed(2)}s  ${f.file}`);
    return 0;
  }

  if (v.audio && !fs.existsSync(v.audio)) throw new UsageError(`audio file not found: ${v.audio}`);
  const res = await render(target, {
    ...common,
    output: v.output,
    audio: v.audio,
    workers: num(v.workers, 'workers', { int: true, min: 1 }),
    crf: num(v.crf, 'crf'),
    x264Preset: v['x264-preset'],
    checkDeterminism: v['check-determinism'],
    hashes: v.hashes,
    evaluate: v.evaluate,
  });
  let code = 0;
  if (!v.quiet) {
    log(`done: ${res.output}  ${res.size.join('x')} ${res.fps} fps ${res.duration.toFixed(2)} s, ${res.frames} frames in ${res.renderSeconds.toFixed(1)} s`);
    if (res.pageErrors.length) log(`note: the page reported ${res.pageErrors.length} distinct error(s), listed above`);
  }
  if (res.determinism) {
    const d = res.determinism;
    const w = d.worstDiff;
    if (d.identical) log(`determinism: PASS - all ${d.framesCompared} frames bit-identical (second pass: ${d.secondPass})`);
    else if (d.visuallyIdentical) {
      log(`determinism: PASS (visually identical) - ${d.framesCompared - d.framesDiffering} of ${d.framesCompared} frames bit-identical; ` +
        `${d.framesDiffering} differ by at most ${d.maxChannelDiff}/255 on at most ${d.maxPixelsDiffering} pixels per frame. ` +
        'That is compositor rounding on elements the page animates from JavaScript, not a content difference.');
    } else {
      log(`determinism: FAIL - ${d.framesOverTolerance} of ${d.framesCompared} frames differ visibly (up to ${d.maxChannelDiff}/255; ` +
        `worst at frame ${w.frame}, ${w.time.toFixed(3)} s: ${w.strong} pixels off by more than 2/255). ` +
        'Look for unseeded randomness, state that depends on seek order, or content that loads late; `snap --at` that time to see it.');
      code = 3;
    }
  }
  if (v.qc && res.output) {
    const q = await check(res.output, { ffmpeg: v.ffmpeg, sheet: v.sheet, transcode: v.transcode, maxFreeze: num(v['max-freeze'], 'max-freeze') });
    res.check = q;
    if (!v.json) printGates(q);
    if (!q.ok) code = 3;
  }
  if (v.json) console.log(JSON.stringify(res, null, 2));
  return code;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  if (e instanceof UsageError) { log(`error: ${e.message}\nrun "html2mp4 --help" for usage`); process.exitCode = 2; return; }
  log(`error: ${e.message}`);
  if (process.env.DEBUG && e.stack) log(e.stack);
  process.exitCode = 1;
});

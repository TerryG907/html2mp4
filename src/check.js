// Quality gates for a finished video: file format, blank first frame, frozen stretches, loudness,
// and (optional) how well it survives a platform re-encode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFfmpeg, run } from './tools.js';
import { contactSheet } from './encode.js';

// Parse what `ffmpeg -i file` prints about the streams (avoids needing ffprobe).
export async function probeVideo(ffmpeg, file) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file]);
  const info = { video: null, audio: null, duration: null };
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const v = /Stream #\S+.*?: Video: (\w+)[^,]*, (\w+)(?:\(([^)]*)\))?.*?, (\d+)x(\d+)/.exec(stderr);
  if (v) {
    const fps = /, ([\d.]+) fps/.exec(stderr.slice(v.index));
    info.video = { codec: v[1], pixFmt: v[2], color: v[3] || '', width: Number(v[4]), height: Number(v[5]), fps: fps ? Number(fps[1]) : null };
  }
  const a = /Stream #\S+.*?: Audio: (\w+)[^,]*, (\d+) Hz, ([^,]+)/.exec(stderr);
  if (a) info.audio = { codec: a[1], rate: Number(a[2]), layout: a[3].trim() };
  if (!info.video && !info.audio) throw new Error(`could not read ${file}:\n${stderr.trim().split('\n').slice(-3).join('\n')}`);
  return info;
}

// MP4 "faststart": the moov atom comes before mdat, so playback can start before the download ends.
function moovFirst(file) {
  if (!/\.(mp4|m4v|mov)$/i.test(file)) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const h = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= size) {
      fs.readSync(fd, h, 0, 16, pos);
      let len = h.readUInt32BE(0);
      const type = h.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (len === 1) len = Number(h.readBigUInt64BE(8));
      if (len < 8) return null;
      pos += len;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Decode the video as small grayscale frames and measure frame-to-frame change.
async function frameStats(ffmpeg, file, video) {
  const w = 240;
  const h = Math.max(2, Math.round((video.height / video.width) * w / 2) * 2);
  const { stdout, code, stderr } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:v:0',
    '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 2 ** 32 });
  if (code !== 0) throw new Error(`ffmpeg could not decode ${file}: ${stderr}`);
  if (stdout.length < w * h) throw new Error(`no video frames could be decoded from ${file}`);
  const px = w * h;
  const n = Math.floor(stdout.length / px);
  const changed = new Float64Array(n); // fraction of pixels that changed vs previous frame
  const sd = new Float64Array(n); // luma standard deviation per frame
  for (let f = 0; f < n; f++) {
    const off = f * px;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < px; i++) { const y = stdout[off + i]; s += y; s2 += y * y; }
    const m = s / px;
    sd[f] = Math.sqrt(Math.max(0, s2 / px - m * m));
    if (f === 0) continue;
    let c = 0;
    const prev = off - px;
    for (let i = 0; i < px; i++) if (Math.abs(stdout[off + i] - stdout[prev + i]) > 3) c++;
    changed[f] = c / px;
  }
  return { n, changed, sd };
}

async function loudness(ffmpeg, file) {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
  const I = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(sum);
  const LRA = /LRA:\s+(-?[\d.]+) LU/.exec(sum);
  const P = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(sum);
  const num = (m) => (!m ? null : m[1] === '-inf' ? -Infinity : Number(m[1]));
  return { integrated: num(I), range: num(LRA), truePeak: num(P) };
}

// Re-encode like a short-video platform does (x264 veryfast, ~2 Mbps) and measure per-frame SSIM.
async function transcodeSSIM(ffmpeg, file, fps, bitrate = '2M') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'html2mp4-'));
  const re = path.join(tmp, 're.mp4');
  const stats = path.join(tmp, 'ssim.log');
  try {
    let r = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', bitrate, '-maxrate', '2.5M', '-bufsize', '5M', '-pix_fmt', 'yuv420p', re]);
    if (r.code !== 0) throw new Error(r.stderr);
    r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', re, '-i', file, '-lavfi', `[0:v][1:v]ssim=stats_file=${stats.replace(/[\\:']/g, '\\$&')}`, '-f', 'null', '-']);
    if (r.code !== 0) throw new Error(r.stderr);
    const ys = fs.readFileSync(stats, 'utf8').trim().split('\n').map((l) => Number(/Y:([\d.]+)/.exec(l)?.[1])).filter((x) => !Number.isNaN(x));
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    let min = 1;
    let minAt = 0;
    ys.forEach((y, i) => { if (y < min) { min = y; minAt = i; } });
    const first3 = ys.slice(0, Math.round(3 * fps));
    return { mean, min, minAt: minAt / fps, minFirst3s: Math.min(...first3), bitrate };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const fmt = (x, d = 2) => (x == null ? 'n/a' : Number.isFinite(x) ? x.toFixed(d) : String(x));

export async function check(file, opts = {}) {
  const ffmpeg = findFfmpeg(opts.ffmpeg);
  file = path.resolve(file);
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const info = await probeVideo(ffmpeg, file);
  const gates = [];
  const add = (name, status, detail, extra = {}) => gates.push({ name, status, detail, ...extra });
  const maxFreeze = opts.maxFreeze ?? 2.0;

  // File format
  if (info.video) {
    const v = info.video;
    const okCodec = /h264|hevc|vp9|av1/.test(v.codec);
    const ok420 = /yuv420p/.test(v.pixFmt);
    const fast = moovFirst(file);
    const problems = [];
    if (!okCodec) problems.push(`codec ${v.codec}`);
    if (!ok420) problems.push(`pixel format ${v.pixFmt} (most players and platforms want yuv420p)`);
    if (v.width % 2 || v.height % 2) problems.push('odd dimensions');
    if (fast === false) problems.push('moov atom at the end (not faststart)');
    add('format', problems.length ? 'fail' : 'pass',
      `${v.width}x${v.height} ${v.codec} ${v.pixFmt}${v.color ? `(${v.color})` : ''} ${v.fps ?? '?'} fps, ${fmt(info.duration)} s` +
      (fast ? ', faststart' : '') + (problems.length ? ` - ${problems.join('; ')}` : ''));
  } else {
    add('format', 'fail', 'no video stream');
  }

  // Frames: blank first frame, frozen stretches, blank frames anywhere
  if (info.video) {
    const fps = info.video.fps || 30;
    const st = await frameStats(ffmpeg, file, info.video);
    const blankSd = 2.0;
    add('first frame', st.sd[0] < blankSd ? 'fail' : 'pass',
      st.sd[0] < blankSd ? `frame 0 is a flat color (luma spread ${fmt(st.sd[0])}) - viewers and platform thumbnails see an empty frame`
        : `frame 0 has content (luma spread ${fmt(st.sd[0], 1)})`, { lumaSpread: st.sd[0] });

    const thresh = opts.freezeThreshold ?? 0.0005; // fraction of pixels that must change for "motion"
    const runs = [];
    let start = -1;
    for (let f = 1; f <= st.n; f++) {
      const frozen = f < st.n && st.changed[f] < thresh;
      if (frozen && start < 0) start = f - 1;
      if (!frozen && start >= 0) { runs.push([start, f - 1]); start = -1; }
    }
    const stretches = runs.map(([a, b]) => ({ from: a / fps, to: (b + 1) / fps, seconds: (b + 1 - a) / fps }))
      .filter((r) => r.seconds >= 0.5);
    const longest = stretches.reduce((m, r) => (r.seconds > (m?.seconds || 0) ? r : m), null);
    const total = stretches.reduce((s, r) => s + r.seconds, 0);
    add('frozen', longest && longest.seconds > maxFreeze ? 'fail' : 'pass',
      longest ? `longest still stretch ${fmt(longest.seconds)} s at ${fmt(longest.from)}-${fmt(longest.to)} s (limit ${maxFreeze} s); ` +
        `${fmt(total, 1)} s of ${fmt(st.n / fps, 1)} s is still in stretches >= 0.5 s` : 'no still stretch of 0.5 s or more',
      { longest, totalSeconds: total, stretches });

    const blanks = [];
    for (let f = 1; f < st.n; f++) if (st.sd[f] < blankSd) blanks.push(f);
    if (blanks.length) {
      add('blank frames', blanks.length > fps / 3 ? 'warn' : 'pass',
        `${blanks.length} flat-color frame(s), first at ${fmt(blanks[0] / fps)} s`, { count: blanks.length, first: blanks[0] / fps });
    }
  }

  // Audio
  if (info.audio) {
    const target = opts.lufs ?? -14;
    const L = await loudness(ffmpeg, file);
    const problems = [];
    let status = 'pass';
    if (L.truePeak != null && L.truePeak > -1) { status = 'fail'; problems.push(`true peak ${fmt(L.truePeak, 1)} dBTP > -1 (clips after platform encoding)`); }
    if (L.integrated == null || L.integrated === -Infinity) { status = 'warn'; problems.push('audio is silent'); }
    else if (Math.abs(L.integrated - target) > 2) { if (status === 'pass') status = 'warn'; problems.push(`integrated ${fmt(L.integrated, 1)} LUFS is more than 2 LU from ${target}`); }
    add('loudness', status, `${fmt(L.integrated, 1)} LUFS, true peak ${fmt(L.truePeak, 1)} dBTP, range ${fmt(L.range, 1)} LU` +
      (problems.length ? ` - ${problems.join('; ')}` : ''), L);
  } else {
    add('audio', 'info', 'no audio stream');
  }

  // Platform re-encode (opt-in, costs one encode)
  if (opts.transcode && info.video) {
    const fps = info.video.fps || 30;
    const s = await transcodeSSIM(ffmpeg, file, fps, opts.transcodeBitrate);
    const fail = s.mean < 0.97 || s.minFirst3s < 0.9;
    add('transcode', fail ? 'warn' : 'pass',
      `after a ${s.bitrate}bps x264 re-encode: SSIM mean ${fmt(s.mean, 3)}, worst ${fmt(s.min, 3)} at ${fmt(s.minAt)} s, worst in first 3 s ${fmt(s.minFirst3s, 3)}` +
      (fail ? ' (wants mean >= 0.97 and first 3 s >= 0.90: fine detail, grain or fast full-screen motion will turn to blocks)' : ''), s);
  }

  if (opts.sheet && info.video) {
    const n = opts.sheetFrames || 8;
    const dur = info.duration || 1;
    const times = Array.from({ length: n }, (_, i) => (i * dur) / n);
    const pngs = [];
    for (const t of times) {
      const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
      if (stdout.length) pngs.push(stdout);
    }
    await contactSheet(ffmpeg, pngs, [info.video.width, info.video.height], path.resolve(opts.sheet));
    add('sheet', 'info', `${path.resolve(opts.sheet)} (${times.map((t) => fmt(t, 1) + 's').join(', ')})`);
  }

  const ok = !gates.some((g) => g.status === 'fail');
  return { file, ok, info, gates };
}

// End-to-end tests: real Chrome, real ffmpeg. Run with `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, snap, check, findFfmpeg } from '../src/index.js';
import { run } from '../src/tools.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const ex = (name) => path.join(root, 'examples', name);
const fx = (name) => path.join(root, 'test', 'fixtures', name);
const quiet = { quiet: true, log: () => {}, warn: (m) => console.log('    page:', m) };

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push([name, true]);
    console.log(`ok    ${name}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String(e.stack || e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

await test('virtual clock: timers, rAF, CSS animations/transitions, play-state, WAAPI, events', async () => {
  const r = await render(fx('clock.html'), { ...quiet, output: path.join(out, 'clock.mp4'), evaluate: '[state(), log]' });
  const at = (i) => r.samples[i][0];
  assert.equal(r.frames, 60);
  assert.deepEqual(r.size, [320, 240]);
  // CSS animation: 0 -> 100px over 1 s, linear
  assert.equal(at(15).a, '50px');
  assert.equal(at(30).a, '100px');
  // transition started by setTimeout at 200 ms, 1 s linear
  assert.equal(at(15).b, '30px');
  assert.equal(at(21).b, '50px');
  // animation-play-state switched to running by a timer at 1000 ms
  assert.equal(at(30).c, '0px');
  assert.equal(at(36).c, '20px');
  // WAAPI element.animate, 300 ms, fill forwards
  assert.equal(at(5).w, '166.667px');
  assert.equal(at(45).w, '300px');
  // rAF timestamps and performance.now are exactly the frame times
  assert.equal(at(45).now, 1500);
  assert.equal(at(45).lastTs, 1500);
  assert.equal(at(45).frames, 46);
  const log = Object.fromEntries(r.samples[59][1].map(([k, t]) => [k, t]));
  assert.equal(log.t500, 500);
  assert.equal(log['b-start'], 200);
  assert.equal(log['waapi-fin'], 300, 'finished promise resolves at the end time');
  assert.equal(log['a-end'], 1000, 'animationend fires at the end time');
  assert.deepEqual(r.samples[59][1].filter(([k]) => k === 'iv').map(([, t, d]) => [t, d]), [[100, 100], [200, 200], [300, 300]], 'setInterval and Date.now');
});

const sheets = [];
for (const name of ['css-keyframes', 'gsap-timeline', 'canvas-particles', 'threejs-scene']) {
  await test(`example ${name}: renders and passes QC`, async () => {
    const file = path.join(out, `${name}.mp4`);
    const r = await render(ex(name), { ...quiet, output: file });
    assert.ok(fs.statSync(file).size > 10000, 'mp4 written');
    assert.equal(r.pageErrors.length, 0, `page errors: ${r.pageErrors.join('; ')}`);
    const sheet = path.join(out, `${name}-sheet.png`);
    const q = await check(file, { sheet });
    const bad = q.gates.filter((g) => g.status === 'fail');
    assert.equal(bad.length, 0, bad.map((g) => `${g.name}: ${g.detail}`).join('; '));
    assert.equal(q.info.video.width, r.size[0]);
    assert.equal(q.info.video.height, r.size[1]);
    assert.ok(Math.abs(q.info.duration - r.duration) < 0.05, `duration ${q.info.duration} vs ${r.duration}`);
    sheets.push(sheet);
  });
}

for (const name of ['css-keyframes', 'canvas-particles', 'gsap-timeline']) {
  await test(`determinism ${name}: second render in a fresh browser matches frame by frame`, async () => {
    const r = await render(ex(name), { ...quiet, output: false, checkDeterminism: true });
    const d = r.determinism;
    assert.ok(d.visuallyIdentical, `${d.framesOverTolerance} frames differ visibly (max ${d.maxChannelDiff}/255), worst at ${d.worstDiff?.time} s`);
    console.log(d.identical ? `      all ${d.framesCompared} frames bit-identical`
      : `      ${d.framesCompared - d.framesDiffering}/${d.framesCompared} frames bit-identical; the rest differ by <= ${d.maxChannelDiff}/255 on <= ${d.maxPixelsDiffering} pixels (edge antialiasing)`);
  });
}

await test('determinism check fails on a page that really is nondeterministic (unseeded Math.random)', async () => {
  const r = await render(ex('canvas-particles'), { ...quiet, output: false, duration: 1, seed: null, checkDeterminism: true });
  assert.equal(r.determinism.identical, false);
  assert.equal(r.determinism.visuallyIdentical, false);
  assert.ok(r.determinism.framesOverTolerance > 0);
});

await test('two separate renders produce byte-identical mp4 files', async () => {
  const a = await render(ex('canvas-particles'), { ...quiet, output: path.join(out, 'same-a.mp4'), duration: 2 });
  const b = await render(ex('canvas-particles'), { ...quiet, output: path.join(out, 'same-b.mp4'), duration: 2 });
  assert.equal(a.framesHash, b.framesHash);
  assert.equal(a.fileHash, b.fileHash);
});

await test('seek protocol: --wait-for pre-roll, parallel pages, reverse-order determinism', async () => {
  const r = await render(fx('seek.html'), { ...quiet, output: path.join(out, 'seek.mp4'), workers: 3, waitFor: 'window.__ready === true', checkDeterminism: true });
  assert.equal(r.mode, 'seek');
  assert.equal(r.frames, 60);
  assert.ok(r.startupFrames >= 2, 'pre-rolled virtual time until the page timer fired');
  assert.ok(r.determinism.identical, `reverse order and a different split give the same frames (max ${r.determinism.maxChannelDiff}/255)`);
});

await test('audio is muxed and loudness is measured', async () => {
  const ffmpeg = findFfmpeg();
  const wav = path.join(out, 'tone.wav');
  const g = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-af', 'volume=-12dB', wav]);
  assert.equal(g.code, 0, g.stderr);
  const file = path.join(out, 'with-audio.mp4');
  await render(fx('seek.html'), { ...quiet, output: file, audio: wav, waitFor: 'window.__ready === true' });
  const q = await check(file);
  assert.equal(q.info.audio.codec, 'aac');
  const L = q.gates.find((x) => x.name === 'loudness');
  assert.ok(L && Number.isFinite(L.integrated), 'integrated loudness measured');
  assert.ok(Math.abs(q.info.duration - 2) < 0.1, `audio cut to video length (${q.info.duration} s)`);
});

await test('check catches a blank first frame', async () => {
  const ffmpeg = findFfmpeg();
  const file = path.join(out, 'blank-start.mp4');
  const g = await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1:r=30',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1:r=30', '-filter_complex', '[0:v][1:v]concat=n=2:v=1', '-pix_fmt', 'yuv420p', file]);
  assert.equal(g.code, 0, g.stderr);
  const q = await check(file);
  assert.equal(q.ok, false);
  assert.equal(q.gates.find((x) => x.name === 'first frame').status, 'fail');
  assert.equal(q.gates.find((x) => x.name === 'frozen').longest.seconds, 1);
});

await test('snap writes stills and a contact sheet', async () => {
  const r = await snap(ex('css-keyframes'), { ...quiet, at: [0, 1, 2.5], outDir: path.join(out, 'stills'), sheet: path.join(out, 'stills-sheet.png') });
  assert.equal(r.files.length, 3);
  for (const f of r.files) assert.ok(fs.statSync(f.file).size > 1000);
  assert.ok(fs.statSync(r.sheet).size > 1000);
});

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed. Contact sheets for eyeballing:\n  ${sheets.join('\n  ')}`);
process.exitCode = failed ? 1 : 0;

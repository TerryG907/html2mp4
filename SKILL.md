---
name: html2mp4
description: Turn an HTML/CSS/GSAP/Canvas/Three.js animation into an MP4 (or GIF/WebM) with the html2mp4 CLI, deterministically, frame by frame, and check the result. Use when the user wants a video, reel, short, explainer, title card, product animation, animated chart or GIF made from code, asks to "render this page to video", "export this animation", "make an MP4 from HTML", or when you have written an animated web page and need it as a video file.
---

# html2mp4: HTML animation to video

`html2mp4` loads a page in headless Chrome, replaces its clocks with virtual time, captures every frame and pipes them into ffmpeg. The page needs no special code: CSS animations and transitions, Web Animations, GSAP, `requestAnimationFrame` loops, Three.js, SVG SMIL and `Math.random` (seeded) all render exactly.

## The loop

1. Write the page (rules below). Put it in its own folder as `index.html` with its assets.
2. Look before rendering everything: `npx html2mp4 snap <folder> --at 0,1,2.5,5 --sheet sheet.png`, then read `sheet.png`. Fix layout, overlap, cut-off text, empty first frame.
3. Render: `npx html2mp4 render <folder> -o out.mp4 --qc --sheet sheet.png`. Read `sheet.png` again.
4. If `check` reports FAIL, fix the page, not the video. Hand back the MP4 path plus what `check` said.

Run `npx html2mp4 doctor` once if a command complains about Chrome or ffmpeg. Add `--json` when you want to parse the result.

## Commands you will use

```bash
npx html2mp4 render page.html -o out.mp4                         # size/duration from the page, else 1920x1080 + inferred
npx html2mp4 render reel/ -o reel.mp4 --preset vertical --duration 12 --audio voice.mp3
npx html2mp4 render page.html -o demo.gif --size 540x540 --dpr 0.5 --fps 20   # half-size GIF of a 1080 layout
npx html2mp4 snap page.html --at 0,2,4 --sheet sheet.png         # stills + one contact sheet
npx html2mp4 check out.mp4 --sheet sheet.png --transcode         # QC gates; --transcode simulates platform re-encoding
npx html2mp4 render page.html --check-determinism                # proves two renders match
```

Presets: `vertical` 1080x1920 (TikTok, Reels, Shorts, Douyin), `landscape` 1920x1080, `square` 1080x1080, `portrait` 1080x1350.

## Writing a page that renders well

**Declare size and length in the page** so the command stays short:

```html
<meta name="html2mp4" content="size=1080x1920; duration=12">
```

**Lay out at the final pixel size.** Set `html, body { margin: 0; width: 1080px; height: 1920px; overflow: hidden; }` (or your size) and use px. The viewport is exactly the video size, so `innerWidth`/`innerHeight` are the video size too.

**Drive everything from time, any of these ways:**
- CSS `@keyframes` with `animation-delay` for sequencing; transitions triggered by classes added in `setTimeout`.
- One GSAP timeline (`gsap.timeline()`), positions in seconds. If the page has no declared duration, the timeline's duration (+0.5 s) is used.
- A `requestAnimationFrame` loop that computes `t = (now - start) / 1000` from the rAF timestamp or `performance.now()`, and draws from `t` (or integrates `dt`).
- Three.js with `renderer.setAnimationLoop` and `THREE.Clock`.

**Or expose a seek function** when the scene is heavy or long: it renders in parallel (`--workers`).

```js
window.__render = { duration: 30, seek: (t) => drawFrame(t) };   // must draw time t from scratch
```

A seek function must be a pure function of `t`: the same `t` must draw the same pixels whatever was drawn before (do not rely on canvas contents from the previous call; if you scale large images with `drawImage`, set `ctx.imageSmoothingQuality = 'high'`).

**Do:**
- Make frame 0 a finished composition (title or hook visible). `check` fails a flat-color first frame; feeds show frame 0 as the thumbnail.
- Load fonts with `@font-face` or a `<link>` and images with `<img>` or CSS; they finish loading before frame 0. Draw canvas text only with fonts declared on the page.
- Keep key text out of the bottom ~20% and right ~15% of vertical videos (platform UI covers it).
- Use `Math.random()` freely; it is seeded. Change the seed with `--seed 7`.
- Hold the final state for at least 0.5-1 s; nobody can read a last frame that flashes by.

**Don't:**
- Don't use `<video>` or `<audio>` elements for timing or sound; they run in real time. Pass the soundtrack with `--audio`.
- Don't busy-wait on `performance.now()`; time does not advance inside a frame.
- Don't fetch data or add images in the middle of the animation; load everything up front.
- Don't rely only on infinite animations (`infinite`, `repeat: -1`) without declaring a duration; there is nothing to infer the length from.
- Don't put the animation inside an iframe or a Web Worker; those are not on virtual time.

## Reading the output

- `render` prints the resolved size, fps, duration and where each came from, plus any page errors (`[page error] ...`, failed requests). A page error usually means a missing file or a typo; fix it and rerun.
- `check` gates: `format` (H.264 yuv420p faststart), `first frame` (not a flat color), `frozen` (longest still stretch, default limit 2 s), `loudness` (true peak <= -1 dBTP, about -14 LUFS), and with `--transcode` the SSIM after a 2 Mbps re-encode. Exit code 3 means a gate failed.
- `--check-determinism` says `PASS` (bit-identical), `PASS (visually identical)` (a few pixels off by a few levels: compositor rounding, harmless) or `FAIL` (real nondeterminism: look for randomness not from `Math.random`, state that depends on seek order, or content loading late).

## Errors you may see

| Message | Fix |
|---|---|
| `can't tell how long the video should be` | Add `--duration 8`, or the `<meta>` / `window.__render` declaration. |
| `No Chrome or Chromium found` | `npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer` (Linux: add `--install-deps`, as root), or `--chrome /path`. |
| `No ffmpeg found` | Install ffmpeg (`brew install ffmpeg`, `apt install ffmpeg`) or pass `--ffmpeg /path`. |
| `timed out ... waiting for` | The `--wait-for` expression never became true, or `window.__render.ready` never resolved. |
| `size ... must be even` | Use even width and height (yuv420p). |

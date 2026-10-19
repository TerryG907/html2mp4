# Prior art (checked 2026-10-19)

Short survey of tools that turn web pages or web-tech scenes into video. Star counts are approximate (GitHub API), dates are last release or push.

| Tool | What it does | How it controls time | Status |
|---|---|---|---|
| **HyperFrames** (HeyGen, `hyperframes`) | HTML in, MP4 out. Full CLI (init, preview, lint, check, snapshot, render, doctor), cloud/Lambda rendering, 21 agent skills, Claude Code plugin, llms.txt. | Its own protocol: `window.__hf.seek(t)`, `data-start` / `data-duration` clips, GSAP timelines registered in `window.__timelines`. Its rules ban `Date.now` / `performance.now` / unseeded `Math.random` instead of virtualizing them. Docs say it is not meant for arbitrary animated pages. | Very active, near-daily releases, ~67k stars, Apache-2.0 |
| **Remotion** | Video as React components. | `useCurrentFrame()`; React only. | Very active, ~65k stars, source-available licence (companies pay) |
| **Revideo** / **Motion Canvas** | TypeScript generator scenes rendered in a browser. | Their own scene API, not HTML. | Revideo active (MIT); Motion Canvas npm stalled since 2024-12 |
| **timesnap / timecut** | Page to frames or video. | Shims Date, performance.now, rAF, timers. CSS animations are not controlled. Temp PNGs by default. | Dormant since 2022–2024, BSD-3 |
| **WebVideoCreator** | Node API for page to video. | Chrome BeginFrame plus custom attributes; slower compatibility mode on macOS. | Dormant since 2024-01, Apache-2.0 |
| **puppeteer-screen-recorder** | Records a page in real time (CDP screencast). | Real time, not deterministic. | Quiet since 2025-01, MIT |
| **puppeteer-capture** | BeginFrame capture in chrome-headless-shell. | Deterministic mode; Linux and Windows only. | Active, 1 maintainer, ~22 stars |
| **pagereel** | CLI that renders unmodified pages. | "Clock mode": virtual performance.now / Date / timers / rAF, seeded Math.random, sets CSS animations and transitions to the frame time; optional `seek(t)`. | Created 2026-10-08, v0.1.1, 0 stars, MIT. No agent docs or QC found. |
| **Multiplane**, **OpenFilm**, **Cetus** | Agent-oriented HTML video renderers. | Page must export a `render(t)` / `frame(t)` function (Cetus seeks CSS itself but needs a hook for canvas). | All created Sept–Oct 2026 |
| **flipbook** (`@liustack/flipbook`) | Agent skill plus renderer with output checks (blank and frozen frames, −14 LUFS, missing glyphs). | Own composition rules (mechanism unconfirmed). | v0.9.0, 2 stars |
| **html-animation-to-mp4** (AZR) | Skill plus renderer. | Experimental `--virtual` mode; temp PNGs; no QC. | 5 stars |

Also: Anthropic launched Claude Motion (beta, claude.ai, MP4 export) on 2026-10-08; it is not a CLI.

## Plainly

There is no gap in the sense of "nobody does HTML to MP4". HyperFrames owns the agent ecosystem and pagereel already does zero-edit clock virtualization. This space got crowded in the last two months.

## What html2mp4 does differently

1. **Zero edits to the page, and the page keeps working the way it does in a browser.** Virtual time covers rAF, performance.now, Date, timers, `requestIdleCallback`, CSS animations and transitions, Web Animations (including `finished` promises, `animationend` events and `animation-play-state`), SVG SMIL, and therefore GSAP / Three.js / anything that reads those clocks. Pages that already expose `window.__render(t)` or `{ seek }` are also supported, so it renders the same pages HyperFrames-style or Remotion-style engines would.
2. **Proof instead of promises.** `--check-determinism` renders the page again in a fresh browser (for seek pages also a different split across pages, in reverse seek order), compares SHA-256 per frame and, where frames differ, says by how much; `check` gates the finished MP4 on what goes wrong in short-video publishing: blank first frame, longest frozen stretch, loudness and true peak, and a simulated platform re-encode (SSIM after 2 Mbps x264) for vertical video.

Smaller things: frames are piped straight into one ffmpeg process (two renders of the examples give byte-identical MP4 files), pages that already expose `window.__render(t)` (like the author's own Douyin engines) render unchanged and in parallel, short-video presets, MP4 / GIF / WebM by extension, a `snap` command that writes stills or one contact sheet for an agent to look at.

// Locating Chrome and ffmpeg, plus small process helpers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (exists(p)) return p;
    }
  }
  return null;
}

// Browsers installed by puppeteer (~/.cache/puppeteer) or by `npx @puppeteer/browsers install`,
// which downloads into the current directory unless given --path.
function puppeteerCache() {
  const roots = [process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer'), process.cwd()];
  const newestFirst = (a, b) => b.localeCompare(a, 'en', { numeric: true });
  const out = [];
  for (const root of roots) for (const kind of ['chrome-headless-shell', 'chrome']) {
    const dir = path.join(root, kind);
    let versions = [];
    try { versions = fs.readdirSync(dir).sort(newestFirst); } catch { continue; }
    for (const v of versions) {
      const base = path.join(dir, v);
      let subs = [];
      try { subs = fs.readdirSync(base); } catch { continue; }
      for (const s of subs) {
        out.push(
          path.join(base, s, 'chrome-headless-shell'),
          path.join(base, s, 'chrome-headless-shell.exe'),
          path.join(base, s, 'chrome'),
          path.join(base, s, 'chrome.exe'),
          path.join(base, s, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        );
      }
    }
  }
  return out;
}

export function findChrome(explicit) {
  const tried = [];
  const pick = (p) => { tried.push(p); return exists(p) ? p : null; };
  for (const p of [explicit, process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH]) {
    if (p && pick(p)) return p;
  }
  const home = os.homedir();
  const byOs = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ],
    linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].map(onPath),
    win32: [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
  };
  for (const p of [...(byOs[process.platform] || []), ...puppeteerCache()]) if (p && pick(p)) return p;
  try {
    const p = require('puppeteer').executablePath();
    if (pick(p)) return p;
  } catch { /* puppeteer not installed */ }
  const err = new Error(
    'No Chrome or Chromium found.\n' +
    '  Install one with:  npx @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/puppeteer\n' +
    '                     (Linux: add --install-deps, as root, for the shared libraries it needs)\n' +
    '  or point to it:    --chrome /path/to/chrome   (or CHROME_PATH=...)',
  );
  err.code = 'NO_CHROME';
  throw err;
}

export function findFfmpeg(explicit) {
  const home = os.homedir();
  const candidates = [
    explicit,
    process.env.FFMPEG_PATH,
    onPath('ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    path.join(home, '.local/bin/ffmpeg'),
  ];
  for (const p of candidates) if (exists(p)) return p;
  try {
    const p = require('ffmpeg-static');
    if (exists(p)) return p;
  } catch { /* optional */ }
  const err = new Error(
    'No ffmpeg found.\n' +
    '  macOS: brew install ffmpeg    Debian/Ubuntu: sudo apt install ffmpeg\n' +
    '  or: npm i -g ffmpeg-static,  or point to it: --ffmpeg /path/to/ffmpeg (or FFMPEG_PATH=...)',
  );
  err.code = 'NO_FFMPEG';
  throw err;
}

// Run a command to completion, collecting stdout (as Buffer) and stderr (as string).
export function run(cmd, args, { input, maxBuffer = 1 << 30 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let err = '';
    p.stdout.on('data', (d) => { size += d.length; if (size <= maxBuffer) out.push(d); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

export async function ffmpegEncoders(ffmpeg) {
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-encoders']);
  return new Set(stdout.toString().split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean));
}

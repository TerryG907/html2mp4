// ffmpeg side: frames arrive as PNGs on stdin.
import path from 'node:path';
import { spawn } from 'node:child_process';

export function encoderArgs(ffmpegEnc, out, p, opts) {
  const ext = path.extname(out).toLowerCase();
  const [W, H] = p.size;
  const input = ['-f', 'image2pipe', '-c:v', 'png', '-framerate', String(p.fps), '-i', 'pipe:0'];
  const audio = opts.audio ? ['-i', path.resolve(opts.audio)] : [];
  const dur = (p.frames / p.fps).toFixed(6);
  if (ext === '.gif') {
    const gw = Math.min(W, opts.gifWidth || 720);
    return [...input, '-filter_complex',
      `[0:v]scale=${gw}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[pal];[b][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      '-loop', '0', out];
  }
  if (ext === '.webm') {
    return [...input, ...audio, '-map', '0:v', ...(opts.audio ? ['-map', '1:a', '-c:a', 'libopus', '-b:a', '160k', '-af', 'apad', '-t', dur] : []),
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
      '-c:v', 'libvpx-vp9', '-crf', String(opts.crf ?? 30), '-b:v', '0', '-row-mt', '1',
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-map_metadata', '-1', out];
  }
  let vcodec = ['-c:v', 'libx264', '-preset', opts.x264Preset || 'medium', '-crf', String(opts.crf ?? 18)];
  if (!ffmpegEnc.has('libx264')) {
    if (ffmpegEnc.has('libopenh264')) vcodec = ['-c:v', 'libopenh264', '-b:v', `${Math.round((W * H) / 100)}k`];
    else if (ffmpegEnc.has('h264_videotoolbox')) vcodec = ['-c:v', 'h264_videotoolbox', '-b:v', `${Math.round((W * H) / 80)}k`];
    else throw new Error('this ffmpeg has no H.264 encoder (libx264 / libopenh264 / videotoolbox)');
  }
  return [...input, ...audio, '-map', '0:v',
    ...(opts.audio ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-af', 'apad', '-t', dur] : []),
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p,setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
    ...vcodec, '-pix_fmt', 'yuv420p', '-r', String(p.fps),
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', '-map_metadata', '-1', out];
}

export function startEncoder(ffmpeg, args) {
  const ff = spawn(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', (d) => { stderr += d; });
  let exitErr = null;
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0) resolve();
      else { exitErr = new Error(`ffmpeg exited with code ${code}:\n${stderr.trim()}`); reject(exitErr); }
    });
  });
  ff.stdin.on('error', () => {}); // EPIPE surfaces through `done`
  return {
    async write(buf) {
      if (exitErr) throw exitErr;
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    },
    async end() { ff.stdin.end(); await done; },
    kill() { ff.kill('SIGKILL'); },
    done,
  };
}

// Tile PNG frames into one image an agent can look at in a single read.
export async function contactSheet(ffmpeg, pngs, size, out, cellWidth) {
  const n = pngs.length;
  const cols = Math.min(n, size[0] < size[1] ? 6 : 4);
  const rows = Math.ceil(n / cols);
  const cw = cellWidth || (size[0] < size[1] ? 240 : 400);
  const enc = startEncoder(ffmpeg, ['-f', 'image2pipe', '-c:v', 'png', '-i', 'pipe:0',
    '-vf', `scale=${cw}:-2:flags=area,tile=${cols}x${rows}:padding=6:margin=6:color=0x808080`, '-frames:v', '1', '-update', '1', out]);
  for (const b of pngs) await enc.write(b);
  await enc.end();
}

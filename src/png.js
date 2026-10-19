// Minimal PNG decoder (8-bit gray / RGB / RGBA, non-interlaced: what Chrome screenshots produce)
// and a pixel diff, so the determinism check can say how different two frames are.
import zlib from 'node:zlib';

export function decodePNG(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || data[12] !== 0) throw new Error('unsupported PNG (need 8-bit, non-interlaced)');
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
      if (!channels) throw new Error(`unsupported PNG color type ${color}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    const up = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[out + x - channels] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = x >= channels && y > 0 ? px[up + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[out + x] = v & 255;
    }
  }
  return { width, height, channels, data: px };
}

// Largest per-channel difference (0-255), how many pixels differ at all, and how many differ by
// more than 2 levels.
export function diffPNG(a, b) {
  const A = decodePNG(a);
  const B = decodePNG(b);
  if (A.width !== B.width || A.height !== B.height) return { maxDiff: 255, pixels: A.width * A.height, strong: A.width * A.height, total: A.width * A.height, sizeMismatch: true };
  const ca = A.channels;
  const cb = B.channels;
  const n = A.width * A.height;
  const cmp = Math.min(ca, cb, 3);
  let maxDiff = 0;
  let pixels = 0;
  let strong = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let k = 0; k < cmp; k++) d = Math.max(d, Math.abs(A.data[i * ca + k] - B.data[i * cb + k]));
    if (d) {
      pixels++;
      if (d > 2) strong++;
      if (d > maxDiff) maxDiff = d;
    }
  }
  return { maxDiff, pixels, strong, total: n };
}

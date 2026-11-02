import { inflateSync, zlibSync } from './vendor/fflate.js';
import { crc32 } from './zip.js';
const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
function concat(parts) {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const p of parts) { result.set(p, at); at += p.length; } return result;
}
function chunk(type, bytes) {
  const result = new Uint8Array(bytes.length + 12), view = new DataView(result.buffer);
  view.setUint32(0, bytes.length); result.set(new TextEncoder().encode(type), 4); result.set(bytes, 8);
  view.setUint32(result.length - 4, crc32(result.subarray(4, -4))); return result;
}
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
export function prepareIcon(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { bytes, mime: 'image/jpeg' };
  if (!pngSignature.every((b, i) => bytes[i] === b)) throw new Error('Unsupported icon format.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cgbi = false, ihdr, width, height, depth, color, interlace, at = 8;
  const parts = [];
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at), type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    if (at + 12 + length > bytes.length) throw new Error('Invalid PNG icon.');
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length)) throw new Error('Invalid PNG icon checksum.');
    if (type === 'CgBI') cgbi = true;
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('Invalid PNG icon header.');
      ihdr = data; width = view.getUint32(at + 8); height = view.getUint32(at + 12); depth = data[8]; color = data[9]; interlace = data[12];
    }
    if (type === 'IDAT') parts.push(data);
    at += 12 + length;
  }
  if (!ihdr || !width || !height || width > 2048 || height > 2048) throw new Error('Icon dimensions are unsupported.');
  if (!cgbi) return { bytes, mime: 'image/png' };
  if (depth !== 8 || ![2, 6].includes(color) || interlace !== 0) throw new Error('Unsupported optimized iOS icon.');
  const channels = color === 6 ? 4 : 3, stride = width * channels, expected = (stride + 1) * height;
  const raw = inflateSync(concat(parts), { out: new Uint8Array(expected) });
  if (raw.length !== expected) throw new Error('Invalid optimized iOS icon.');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; if (filter > 4) throw new Error('Invalid PNG filter.');
    for (let x = 0; x < stride; x++) {
      const pos = y * stride + x, a = x >= channels ? pixels[pos - channels] : 0, b = y ? pixels[pos - stride] : 0, c = y && x >= channels ? pixels[pos - stride - channels] : 0;
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      pixels[pos] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  const rows = new Uint8Array(expected);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pos = y * stride + x * channels, out = y * (stride + 1) + 1 + x * channels, alpha = channels === 4 ? pixels[pos + 3] : 255;
    rows[out] = alpha ? Math.min(255, Math.round(pixels[pos + 2] * 255 / alpha)) : 0;
    rows[out + 1] = alpha ? Math.min(255, Math.round(pixels[pos + 1] * 255 / alpha)) : 0;
    rows[out + 2] = alpha ? Math.min(255, Math.round(pixels[pos] * 255 / alpha)) : 0;
    if (channels === 4) rows[out + 3] = alpha;
  }
  return { bytes: concat([pngSignature, chunk('IHDR', ihdr), chunk('IDAT', zlibSync(rows)), chunk('IEND', new Uint8Array())]), mime: 'image/png' };
}

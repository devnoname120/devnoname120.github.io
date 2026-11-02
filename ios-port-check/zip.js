import { Inflate } from './vendor/fflate.js';

const decoder = new TextDecoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  return n >>> 0;
});
export function crc32(bytes, seed = 0) {
  let crc = seed ^ -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ -1) >>> 0;
}
const invalid = () => { throw new Error('This IPA contains an invalid or truncated ZIP archive.'); };
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function u64(view, at) {
  const n = Number(view.getBigUint64(at, true));
  if (!Number.isSafeInteger(n)) invalid(); return n;
}
export class ZipArchive {
  constructor(file) { this.file = file; this.entries = new Map(); }
  async bytes(at, length) {
    if (at < 0 || length < 0 || at + length > this.file.size) invalid();
    const data = new Uint8Array(await this.file.slice(at, at + length).arrayBuffer());
    if (data.length !== length) invalid(); return data;
  }
  static async open(file) {
    const zip = new ZipArchive(file), size = Math.min(file.size, 65557);
    if (size < 22) invalid();
    const tail = await zip.bytes(file.size - size, size), view = viewOf(tail);
    let eocd = -1;
    for (let i = size - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === size) { eocd = i; break; }
    }
    if (eocd < 0) invalid();
    if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true)) throw new Error('Multi-part ZIP archives are not supported. Select a complete IPA.');
    let count = view.getUint16(eocd + 10, true), length = view.getUint32(eocd + 12, true), offset = view.getUint32(eocd + 16, true);
    if (count === 65535 || length === 0xffffffff || offset === 0xffffffff) {
      const loc = viewOf(await zip.bytes(file.size - size + eocd - 20, 20));
      if (loc.getUint32(0, true) !== 0x07064b50 || loc.getUint32(4, true) || loc.getUint32(16, true) !== 1) invalid();
      const record = viewOf(await zip.bytes(u64(loc, 8), 56));
      if (record.getUint32(0, true) !== 0x06064b50 || record.getUint32(16, true) || record.getUint32(20, true)) invalid();
      if (u64(record, 24) !== u64(record, 32)) invalid();
      count = u64(record, 32); length = u64(record, 40); offset = u64(record, 48);
    } else if (view.getUint16(eocd + 8, true) !== count) invalid();
    if (count > 200000 || length > 64 * 1024 * 1024) throw new Error('The archive directory is too large to inspect in this browser.');
    if (offset + length > file.size - size + eocd) invalid();
    const directory = await zip.bytes(offset, length), dv = viewOf(directory);
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > length || dv.getUint32(at, true) !== 0x02014b50) invalid();
      const nameSize = dv.getUint16(at + 28, true), extraSize = dv.getUint16(at + 30, true), commentSize = dv.getUint16(at + 32, true);
      const end = at + 46 + nameSize + extraSize + commentSize;
      if (end > length) invalid();
      const entry = { name: decoder.decode(directory.subarray(at + 46, at + 46 + nameSize)), flags: dv.getUint16(at + 8, true), method: dv.getUint16(at + 10, true), crc: dv.getUint32(at + 16, true), compressed: dv.getUint32(at + 20, true), size: dv.getUint32(at + 24, true), offset: dv.getUint32(at + 42, true), symlink: ((dv.getUint32(at + 38, true) >>> 16) & 0xf000) === 0xa000 };
      const disk = dv.getUint16(at + 34, true);
      if (disk && disk !== 65535) invalid();
      let found64 = false;
      for (let p = at + 46 + nameSize, extraEnd = p + extraSize; p < extraEnd;) {
        if (p + 4 > extraEnd) invalid();
        const tag = dv.getUint16(p, true), n = dv.getUint16(p + 2, true); p += 4;
        if (p + n > extraEnd) invalid();
        if (tag === 1) {
          found64 = true; let q = p;
          for (const key of ['size', 'compressed', 'offset']) if (entry[key] === 0xffffffff) { if (q + 8 > p + n) invalid(); entry[key] = u64(dv, q); q += 8; }
          if (disk === 65535 && (q + 4 > p + n || dv.getUint32(q, true))) invalid();
        }
        p += n;
      }
      if (!found64 && (entry.size === 0xffffffff || entry.compressed === 0xffffffff || entry.offset === 0xffffffff || disk === 65535)) invalid();
      if (zip.entries.has(entry.name)) throw new Error('The archive contains duplicate file paths and cannot be inspected reliably.');
      zip.entries.set(entry.name, entry); at = end;
    }
    if (at !== length) invalid(); return zip;
  }
  async stream(entry, receive, maxBytes = Number.MAX_SAFE_INTEGER) {
    if (!entry || entry.symlink) throw new Error('A required app file is missing or is a symbolic link.');
    if (entry.flags & 0x41) throw new Error('Password-protected ZIP entries cannot be inspected. Select an unprotected IPA.');
    if (entry.method !== 0 && entry.method !== 8) throw new Error('This IPA uses an unsupported ZIP compression method.');
    if (entry.size > maxBytes) throw new Error('An app metadata or icon file exceeds the inspection limit.');
    const local = viewOf(await this.bytes(entry.offset, 30));
    if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(8, true) !== entry.method || (local.getUint16(6, true) & 0x41)) invalid();
    const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (start + entry.compressed > this.file.size) invalid();
    let total = 0, crc = 0;
    const output = chunk => {
      total += chunk.length;
      if (total > entry.size || total > maxBytes) invalid();
      crc = crc32(chunk, crc); receive(chunk);
    };
    const inflate = entry.method === 8 ? new Inflate(output) : null;
    for (let at = 0; at < entry.compressed; at += 64 * 1024) {
      const data = await this.bytes(start + at, Math.min(64 * 1024, entry.compressed - at));
      if (inflate) inflate.push(data, at + data.length === entry.compressed); else output(data);
    }
    if (total !== entry.size || crc !== entry.crc) throw new Error('A required file failed its ZIP integrity check. This IPA may be damaged.');
  }
  async read(entry, limit = 4 * 1024 * 1024) {
    if (!entry) throw new Error('A required file is missing from this IPA.');
    if (entry.size > limit) throw new Error('An app metadata or icon file exceeds the inspection limit.');
    const bytes = new Uint8Array(entry.size); let at = 0;
    await this.stream(entry, chunk => { bytes.set(chunk, at); at += chunk.length; }, limit); return bytes;
  }
}

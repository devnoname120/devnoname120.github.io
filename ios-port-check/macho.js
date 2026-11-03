const invalid = () => { throw new Error('The main executable has invalid or unsupported Mach-O headers. No portability verdict was assigned.'); };
const viewOf = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const architecture = (cpu, subtype) => {
  if (cpu === 12) return ({ 0: 'arm', 5: 'armv4t', 6: 'armv6', 7: 'armv5tej', 8: 'xscale', 9: 'armv7', 10: 'armv7f', 11: 'armv7s', 12: 'armv7k' })[subtype & 0xffffff] || `arm (subtype ${subtype & 0xffffff})`;
  if (cpu === 0x100000c) return (subtype & 0xffffff) === 2 ? 'arm64e' : 'arm64';
  if (cpu === 0x200000c) return 'arm64_32';
  if (cpu === 7) return 'i386';
  if (cpu === 0x1000007) return 'x86_64';
  return `CPU ${cpu}, subtype ${subtype & 0xffffff}`;
};
function header(bytes, sliceSize) {
  if (bytes.length < 28) invalid();
  const v = viewOf(bytes), magic = v.getUint32(0, false);
  const little = magic === 0xcefaedfe || magic === 0xcffaedfe;
  if (![0xcefaedfe, 0xcffaedfe, 0xfeedface, 0xfeedfacf].includes(magic)) invalid();
  const is64 = magic === 0xcffaedfe || magic === 0xfeedfacf, size = is64 ? 32 : 28;
  if (bytes.length < size || sliceSize < size) invalid();
  const cpu = v.getUint32(4, little), subtype = v.getUint32(8, little), commands = v.getUint32(16, little), commandBytes = v.getUint32(20, little);
  if (v.getUint32(12, little) !== 2 || commands > 100000 || commandBytes > 16 * 1024 * 1024 || size + commandBytes > sliceSize || commands * 8 > commandBytes) invalid();
  if (!!(cpu & 0x1000000) !== is64 && cpu !== 0x200000c) invalid();
  return { cpu, subtype, size, commands, commandBytes, little, name: architecture(cpu, subtype) };
}
function copyOverlap(target, start, chunk, chunkStart) {
  const from = Math.max(start, chunkStart), to = Math.min(start + target.length, chunkStart + chunk.length);
  if (to > from) target.set(chunk.subarray(from - chunkStart, to - chunkStart), from - start);
  return to > from ? to - from : 0;
}

// Retain only the fat table and load commands while the full executable is streamed
// through the hash. Large resources and executable bodies are never accumulated.
export class MachOScanner {
  constructor(total) { this.total = total; this.position = 0; this.prefix = new Uint8Array(Math.min(8192, total)); this.prefixUsed = 0; this.slices = null; this.commandMemory = 0; }
  allocateCommands(length) {
    this.commandMemory += length;
    if (this.commandMemory > 32 * 1024 * 1024) throw new Error('The executable load commands exceed the local inspection limit.');
    return new Uint8Array(length);
  }
  push(chunk) {
    const start = this.position;
    if (!this.slices) {
      this.prefixUsed += copyOverlap(this.prefix, 0, chunk, start);
      if (this.prefixUsed >= Math.min(this.total, 32)) this.plan();
    }
    if (this.slices) for (const slice of this.slices) {
      slice.headerUsed += copyOverlap(slice.header, slice.offset, chunk, start);
      if (!slice.info && slice.headerUsed === slice.header.length) {
        slice.info = header(slice.header, slice.size);
        if (slice.cpu !== undefined && (slice.cpu !== slice.info.cpu || slice.subtype !== slice.info.subtype)) invalid();
        slice.load = this.allocateCommands(slice.info.commandBytes); slice.loadUsed = 0;
      }
      if (slice.info) slice.loadUsed += copyOverlap(slice.load, slice.offset + slice.info.size, chunk, start);
    }
    this.position += chunk.length;
  }
  plan() {
    if (this.prefixUsed < 4) invalid();
    const v = viewOf(this.prefix), magic = v.getUint32(0, false);
    if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
      if (this.prefixUsed < 8) return;
      const little = magic === 0xbebafeca || magic === 0xbfbafeca, is64 = magic === 0xcafebabf || magic === 0xbfbafeca;
      const count = v.getUint32(4, little), width = is64 ? 32 : 20;
      if (!count || count > 128 || 8 + width * count > this.total) invalid();
      if (this.prefixUsed < 8 + width * count) return;
      this.slices = Array.from({ length: count }, (_, i) => {
        const at = 8 + width * i;
        const offset = is64 ? Number(v.getBigUint64(at + 8, little)) : v.getUint32(at + 8, little);
        const size = is64 ? Number(v.getBigUint64(at + 16, little)) : v.getUint32(at + 12, little);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 8 + width * count || size < 28 || offset + size > this.total) invalid();
        return { offset, size, cpu: v.getUint32(at, little), subtype: v.getUint32(at + 4, little) };
      });
      const sorted = [...this.slices].sort((a, b) => a.offset - b.offset);
      for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].offset + sorted[i - 1].size > sorted[i].offset) invalid();
    } else this.slices = [{ offset: 0, size: this.total }];
    for (const slice of this.slices) {
      slice.header = new Uint8Array(Math.min(32, slice.size)); slice.headerUsed = 0;
      // A very small initial chunk may already have held a slice header.
      slice.headerUsed = copyOverlap(slice.header, slice.offset, this.prefix.subarray(0, this.prefixUsed), 0);
      if (slice.headerUsed === slice.header.length) {
        slice.info = header(slice.header, slice.size);
        if (slice.cpu !== undefined && (slice.cpu !== slice.info.cpu || slice.subtype !== slice.info.subtype)) invalid();
        slice.load = this.allocateCommands(slice.info.commandBytes);
        slice.loadUsed = copyOverlap(slice.load, slice.offset + slice.info.size, this.prefix.subarray(0, this.prefixUsed), 0);
      }
    }
    // push() will copy the current chunk; account only for earlier prefix bytes.
    for (const slice of this.slices) {
      slice.headerUsed = Math.max(0, Math.min(slice.header.length, this.position - slice.offset));
      if (slice.info) slice.loadUsed = Math.max(0, Math.min(slice.load.length, this.position - slice.offset - slice.info.size));
    }
  }
  finish() {
    if (this.position !== this.total || !this.slices) invalid();
    const results = this.slices.map(slice => {
      const info = slice.info;
      if (!info || slice.headerUsed !== slice.header.length || slice.loadUsed !== slice.load.length) invalid();
      let at = 0, encrypted = false;
      const view = viewOf(slice.load);
      for (let i = 0; i < info.commands; i++) {
        if (at + 8 > slice.load.length) invalid();
        const command = view.getUint32(at, info.little), size = view.getUint32(at + 4, info.little);
        if (size < 8 || size % 4 || at + size > slice.load.length) invalid();
        if (command === 0x21 || command === 0x2c) {
          if (size < (command === 0x2c ? 24 : 20)) invalid();
          encrypted ||= view.getUint32(at + 16, info.little) !== 0;
        }
        at += size;
      }
      if (at !== slice.load.length) invalid();
      return { name: info.name, cpu: info.cpu, subtype: info.subtype & 0xffffff, encrypted, offset: slice.offset, size: slice.size };
    });
    const supported = results.filter(s => s.cpu === 12 && (s.subtype === 6 || s.subtype === 9));
    return { slices: results, architectures: [...new Set(results.map(s => s.name))], portable: supported.length > 0, encrypted: supported.some(s => s.encrypted) };
  }
}

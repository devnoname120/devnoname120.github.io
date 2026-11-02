const utf8 = new TextDecoder();
const fail = () => { throw new Error('The property list is invalid or unsupported.'); };

// Both formats occur in IPAs. Never resolve XML entities or external resources.
export function parsePlist(bytes) {
  if (bytes.length > 4 * 1024 * 1024) throw new Error('The property list exceeds the 4 MiB inspection limit.');
  return utf8.decode(bytes.subarray(0, 8)) === 'bplist00' ? parseBinary(bytes) : parseXML(utf8.decode(bytes));
}

function parseBinary(bytes) {
  if (bytes.length < 40) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const integer = (at, length) => {
    if (![1, 2, 4, 8].includes(length) || at < 0 || at + length > bytes.length) fail();
    let result = 0;
    for (let i = 0; i < length; i++) result = result * 256 + bytes[at + i];
    if (!Number.isSafeInteger(result)) fail();
    return result;
  };
  const offsetSize = bytes[trailer + 6], refSize = bytes[trailer + 7];
  const count = integer(trailer + 8, 8), top = integer(trailer + 16, 8), table = integer(trailer + 24, 8);
  if (!count || count > 100000 || top >= count || table < 8 || table + count * offsetSize > trailer) fail();
  const offsets = Array.from({ length: count }, (_, i) => integer(table + i * offsetSize, offsetSize));
  if (offsets.some(at => at < 8 || at >= table)) fail();
  const cache = new Map(), active = new Set();
  function object(id, depth = 0) {
    if (id >= count || depth > 128 || active.has(id)) fail();
    if (cache.has(id)) return cache.get(id);
    active.add(id);
    let at = offsets[id];
    const marker = bytes[at++], kind = marker >> 4;
    let length = marker & 15, value;
    if ([4, 5, 6, 7, 10, 12, 13].includes(kind) && length === 15) {
      const sizeMarker = bytes[at++];
      if ((sizeMarker >> 4) !== 1) fail();
      const size = 2 ** (sizeMarker & 15);
      length = integer(at, size); at += size;
    }
    const requireBytes = n => { if (!Number.isSafeInteger(n) || n < 0 || at + n > table) fail(); };
    if (kind === 0) {
      if (marker === 0) value = null;
      else if (marker === 8 || marker === 9) value = marker === 9;
      else fail();
    } else if (kind === 1 || kind === 8) {
      const size = kind === 1 ? 2 ** length : length + 1;
      requireBytes(size); value = integer(at, size);
    } else if (kind === 2 || kind === 3) {
      const size = kind === 3 ? 8 : 2 ** length;
      requireBytes(size);
      if (size !== 4 && size !== 8) fail();
      value = size === 4 ? view.getFloat32(at) : view.getFloat64(at);
      if (kind === 3) value = new Date((value + 978307200) * 1000).toISOString();
    } else if (kind === 4 || kind === 5 || kind === 7) {
      requireBytes(length);
      value = kind === 4 ? bytes.slice(at, at + length) : utf8.decode(bytes.subarray(at, at + length));
    } else if (kind === 6) {
      requireBytes(length * 2);
      value = new TextDecoder('utf-16be').decode(bytes.subarray(at, at + length * 2));
    } else if (kind === 10 || kind === 12 || kind === 13) {
      requireBytes(length * refSize * (kind === 13 ? 2 : 1));
      if (length > 100000) fail();
      if (kind === 13) {
        value = Object.create(null);
        for (let i = 0; i < length; i++) {
          const key = object(integer(at + i * refSize, refSize), depth + 1);
          if (typeof key !== 'string' || Object.hasOwn(value, key)) fail();
          value[key] = object(integer(at + (length + i) * refSize, refSize), depth + 1);
        }
      } else value = Array.from({ length }, (_, i) => object(integer(at + i * refSize, refSize), depth + 1));
    } else fail();
    active.delete(id); cache.set(id, value); return value;
  }
  return object(top);
}

function parseXML(text) {
  // Plist's fixed vocabulary needs no general-purpose XML/DTD interpreter.
  const tokens = text.replace(/^\uFEFF/, '').match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g) || [];
  let index = 0, nodes = 0;
  const skip = () => { while (index < tokens.length && (/^\s*$/.test(tokens[index]) || /^<!--|^<\?|^<!DOCTYPE/.test(tokens[index]))) index++; };
  const decode = s => s.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) fail();
      return String.fromCodePoint(n);
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity];
  });
  function value(depth = 0) {
    skip(); if (++nodes > 100000 || depth > 128) fail();
    const token = tokens[index++] || '';
    const match = /^<(dict|array|string|key|integer|real|date|data|true|false)\s*(\/?)>$/.exec(token);
    if (!match) fail();
    const [, kind, empty] = match;
    if (kind === 'dict' || kind === 'array') {
      const result = kind === 'dict' ? Object.create(null) : [];
      if (empty) return result;
      while (true) {
        skip(); if (tokens[index] === `</${kind}>`) { index++; return result; }
        if (kind === 'dict') {
          if (!/^<key\s*[/>]/.test(tokens[index] || '')) fail();
          const key = value(depth + 1);
          if (typeof key !== 'string' || Object.hasOwn(result, key)) fail();
          result[key] = value(depth + 1);
        } else result.push(value(depth + 1));
      }
    }
    let content = '';
    if (!empty) {
      while (index < tokens.length && tokens[index] !== `</${kind}>`) {
        const part = tokens[index++];
        if (part.startsWith('<![CDATA[')) content += part.slice(9, -3);
        else if (part.startsWith('<!--')) continue;
        else if (part.startsWith('<')) fail();
        else content += decode(part);
      }
      if (tokens[index++] !== `</${kind}>`) fail();
    }
    if (kind === 'true' || kind === 'false') return kind === 'true';
    if (kind === 'integer' || kind === 'real') {
      const n = Number(content.trim()); if (!Number.isFinite(n)) fail(); return n;
    }
    return content;
  }
  skip(); if (!/^<plist(?:\s[^>]*)?>$/.test(tokens[index++] || '')) fail();
  const result = value(); skip(); if (tokens[index++] !== '</plist>') fail(); skip();
  if (index !== tokens.length) fail(); return result;
}

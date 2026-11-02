import { artworkURL } from './app-store.js';

export function formatSize(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'], exponent = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  return `${Number((bytes / 1000 ** exponent).toFixed(2))} ${units[exponent]}`;
}
const escape = value => String(value ?? 'Not available').replace(/[\r\n\u2028\u2029]/g, ' ').replace(/([\\`*_{}\[\]<>|])/g, '\\$1');
function code(value) {
  const text = String(value ?? 'Not available').replace(/[\r\n\u2028\u2029]/g, ' ');
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
  const fence = '`'.repeat(longest + 1), pad = /^[` ]|[` ]$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
export function markdownReport(r) {
  const verdict = r.portable ? 'Portable ✅' : 'This version is not portable ❌';
  return [
    `**${escape(r.name)} iOS ${escape(r.version || r.build || 'unknown version')}**`, '',
    ...(r.appStoreIconUrl ? [`![${escape(r.name)} icon](${r.appStoreIconUrl})`, ''] : []),
    `- **Result:** ${verdict}`,
    `- **Bundle ID:** ${code(r.bundleId)}`,
    `- **Minimum iOS:** ${escape(r.minimumIOS)}`,
    ...(r.releaseDate ? [`- **Release date:** ${r.releaseDate}`] : []),
    `- **Architectures:** ${r.architectures.map(escape).join(', ')}`,
    `- **IPA:** ${code(r.fileName)}`,
    `  - Size: ${formatSize(r.ipaSize)}`,
    `  - SHA-256: ${code(r.ipaSha256)}`,
    `- **Main executable:** ${code(r.executablePath)}`,
    `  - Size: ${formatSize(r.executableSize)}`,
    `  - SHA-256: ${code(r.executableSha256)}`,
    ...(!r.portable ? ['', 'Try an older version of this game: it may still include an ARMv7 executable.'] : []),
    ...(r.encrypted ? ['', 'The ARMv7 executable has an encryption flag; this report does not establish that it is ready to run.'] : [])
  ].filter((line, i, lines) => line !== '' || lines[i - 1] !== '').join('\n').trim();
}

const text = value => String(value ?? 'Not available').replace(/[\r\n\u2028\u2029]/g, ' ');
const html = value => text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Use semantic HTML rather than Markdown rendered as text. Every metadata value
// is escaped before it enters the preview or clipboard HTML representation.
export function richTextReport(r) {
  const title = `${text(r.name)} iOS ${text(r.version || r.build || 'unknown version')}`;
  const fields = [
    ['Result', r.portable ? 'Portable ✅' : 'This version is not portable ❌'],
    ['Bundle ID', r.bundleId, true],
    ['Minimum iOS', r.minimumIOS],
    ...(r.releaseDate ? [['Release date', r.releaseDate]] : []),
    ['Architectures', r.architectures.join(', ')]
  ];
  const files = [
    ['IPA', r.fileName, r.ipaSize, r.ipaSha256],
    ['Main executable', r.executablePath, r.executableSize, r.executableSha256]
  ];
  const image = artworkURL(r.appStoreIconUrl);
  const notes = [
    ...(!r.portable ? ['Try an older version of this game: it may still include an ARMv7 executable.'] : []),
    ...(r.encrypted ? ['The ARMv7 executable has an encryption flag; this report does not establish that it is ready to run.'] : [])
  ];
  return {
    html: `<p><strong>${html(title)}</strong></p>` +
      (image ? `<p><img src="${html(image)}" alt="${html(r.name)} icon" width="64" height="64"></p>` : '') +
      '<ul>' + fields.map(([label, value, monospace]) => `<li><strong>${label}:</strong> ${monospace ? `<code>${html(value)}</code>` : html(value)}</li>`).join('') +
      files.map(([label, path, size, hash]) => `<li><strong>${label}:</strong> <code>${html(path)}</code><ul><li>Size: ${formatSize(size)}</li><li>SHA-256: <code>${html(hash)}</code></li></ul></li>`).join('') +
      '</ul>' + notes.map(note => `<p>${html(note)}</p>`).join(''),
    text: [title, '', ...fields.map(([label, value]) => `• ${label}: ${text(value)}`),
      ...files.flatMap(([label, path, size, hash]) => [`• ${label}: ${text(path)}`, `  • Size: ${formatSize(size)}`, `  • SHA-256: ${text(hash)}`]),
      ...notes.flatMap(note => ['', note])].join('\n')
  };
}

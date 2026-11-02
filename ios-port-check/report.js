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

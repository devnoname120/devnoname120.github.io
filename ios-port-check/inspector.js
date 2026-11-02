import { ZipArchive } from './zip.js';
import { parsePlist } from './plist.js';
import { MachOScanner } from './macho.js';
import { prepareIcon } from './icon.js';
import { sha256 } from './vendor/noble/sha2.js';
import { bytesToHex } from './vendor/noble/utils.js';

const string = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const list = value => Array.isArray(value) ? value.filter(v => typeof v === 'string') : typeof value === 'string' ? [value] : [];
function date(value) {
  const s = string(value);
  // Accept dates only from explicit release fields, never ZIP or signing timestamps.
  if (!s || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(s) || !Number.isFinite(Date.parse(s))) return null;
  return s.slice(0, 10);
}
export async function hashBlob(file, progress = () => {}) {
  const hash = sha256.create(), step = 4 * 1024 * 1024;
  for (let at = 0; at < file.size; at += step) {
    hash.update(new Uint8Array(await file.slice(at, at + step).arrayBuffer()));
    progress(Math.min(at + step, file.size), file.size);
  }
  return bytesToHex(hash.digest());
}
async function findIcon(zip, root, info) {
  const declarations = [
    ...list(info.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles),
    ...list(info['CFBundleIcons~ipad']?.CFBundlePrimaryIcon?.CFBundleIconFiles),
    ...list(info.CFBundleIconFiles), ...list(info.CFBundleIconFile)
  ];
  const roots = [...zip.entries.values()].filter(e => e.name.startsWith(root) && !e.name.slice(root.length).includes('/') && /\.png$/i.test(e.name));
  const declared = roots.filter(e => declarations.some(name => {
    const base = name.replace(/\.png$/i, '');
    return e.name.slice(root.length).replace(/\.png$/i, '').replace(/@\dx(?:~ipad|~iphone)?$/i, '') === base || e.name.slice(root.length) === name;
  })).sort((a, b) => b.size - a.size);
  const fallback = roots.filter(e => /^(?:app)?icon[^/]*\.png$/i.test(e.name.slice(root.length))).sort((a, b) => b.size - a.size);
  const artwork = ['iTunesArtwork@2x', 'iTunesArtwork'].map(n => zip.entries.get(n)).filter(Boolean);
  for (const e of [...new Set([...declared, ...fallback, ...artwork])].slice(0, 12)) {
    try { return { ...prepareIcon(await zip.read(e, 16 * 1024 * 1024)), path: e.name }; } catch { /* Optional icons must not hide a valid architecture result. */ }
  }
  return null;
}
export async function inspectIPA(file, onProgress = () => {}) {
  onProgress({ label: 'Reading archive directory', percent: 2 });
  const zip = await ZipArchive.open(file);
  const apps = [...zip.entries.keys()].filter(name => /^Payload\/[^/]+\.app\/Info\.plist$/.test(name));
  if (!apps.length) throw new Error('No iOS app was found. Select an IPA containing Payload/YourApp.app/Info.plist.');
  if (apps.length !== 1) throw new Error('This IPA contains more than one main app. It cannot be checked unambiguously.');
  const infoPath = apps[0], root = infoPath.slice(0, -'Info.plist'.length);
  onProgress({ label: 'Reading app metadata', percent: 8 });
  const info = parsePlist(await zip.read(zip.entries.get(infoPath)));
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('The app Info.plist is not a metadata dictionary.');
  let store = Object.create(null);
  const warnings = [];
  const metadataEntry = zip.entries.get('iTunesMetadata.plist') || zip.entries.get(`${root}iTunesMetadata.plist`);
  if (metadataEntry) {
    try { store = parsePlist(await zip.read(metadataEntry)); if (!store || typeof store !== 'object') store = Object.create(null); }
    catch { warnings.push('Optional iTunes metadata could not be read.'); }
  }
  const executableName = string(info.CFBundleExecutable);
  if (!executableName || /[/\\]/.test(executableName) || executableName === '.' || executableName === '..') throw new Error('Info.plist does not declare a valid main executable. No portability verdict was assigned.');
  const executablePath = root + executableName, executable = zip.entries.get(executablePath);
  if (!executable) throw new Error('The declared main executable is missing. No portability verdict was assigned.');
  const scanner = new MachOScanner(executable.size), hash = sha256.create();
  let scanned = 0, lastUpdate = 0;
  onProgress({ label: 'Checking and hashing the main executable', percent: 12 });
  await zip.stream(executable, chunk => {
    hash.update(chunk); scanner.push(chunk); scanned += chunk.length;
    if (performance.now() - lastUpdate > 120) {
      onProgress({ label: 'Checking and hashing the main executable', percent: 12 + Math.round(40 * scanned / Math.max(1, executable.size)) }); lastUpdate = performance.now();
    }
  });
  const mach = scanner.finish(), executableSha256 = bytesToHex(hash.digest());
  onProgress({ label: 'Reading the app icon', percent: 54 });
  const icon = await findIcon(zip, root, info);
  onProgress({ label: 'Calculating IPA SHA-256', percent: 58 });
  const ipaSha256 = await hashBlob(file, (done, total) => {
    if (performance.now() - lastUpdate > 120 || done === total) {
      onProgress({ label: 'Calculating IPA SHA-256', percent: 58 + Math.round(42 * done / Math.max(1, total)) }); lastUpdate = performance.now();
    }
  });
  const versionRelease = date(store.softwareVersionReleaseDate);
  const releaseDate = versionRelease || date(store.releaseDate) || date(info.releaseDate);
  const name = string(info.CFBundleDisplayName) || string(info.CFBundleName) || string(store.itemName) || root.split('/')[1].slice(0, -4);
  const result = {
    name, bundleId: string(info.CFBundleIdentifier) || string(store.softwareVersionBundleId),
    version: string(info.CFBundleShortVersionString) || string(store.bundleShortVersionString), build: string(info.CFBundleVersion),
    minimumIOS: string(info.MinimumOSVersion) || string(store.minimumOsVersion), releaseDate,
    releaseSource: releaseDate ? versionRelease ? 'softwareVersionReleaseDate (this version)' : store.releaseDate ? 'releaseDate (iTunes metadata)' : 'releaseDate (Info.plist)' : null,
    fileName: file.name || 'selected.ipa', ipaSize: file.size, executablePath, executableSize: executable.size,
    appSize: [...zip.entries.values()].filter(e => e.name.startsWith(root)).reduce((sum, e) => sum + e.size, 0),
    ipaSha256, executableSha256, ...mach, icon, warnings
  };
  return result;
}

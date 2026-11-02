import { formatSize, markdownReport } from './report.js';
import { lookupAppStoreIcon } from './app-store.js';
const $ = id => document.getElementById(id);
let activeWorker = null, currentResult = null, iconURL = null, dragDepth = 0;
let artworkRequest = null;
const setText = (id, text) => { $(id).textContent = text; };
function writeReport(result) {
  const report = $('markdown-report');
  report.value = markdownReport(result); report.setSelectionRange(0, 0); report.scrollTop = 0;
}
function cancelArtworkLookup() {
  if (artworkRequest) { clearTimeout(artworkRequest.timer); artworkRequest.controller.abort(); artworkRequest = null; }
  $('copy-report').disabled = false;
}
function clearResult() {
  cancelArtworkLookup();
  currentResult = null; $('results').hidden = true;
  if (iconURL) URL.revokeObjectURL(iconURL); iconURL = null;
  $('app-icon').removeAttribute('src'); $('app-icon').hidden = true; $('icon-fallback').hidden = false;
  setText('copy-feedback', '');
}
function stopWorker() {
  if (activeWorker) activeWorker.terminate(); activeWorker = null;
}
function idle() {
  $('processing').hidden = true; $('checked-state').hidden = true; $('drop-zone').hidden = false;
}
function showError(message) {
  stopWorker(); idle(); $('error').hidden = false; setText('error-message', message);
}
function inspect(file) {
  if (!file) return;
  stopWorker(); clearResult(); $('error').hidden = true;
  if (!/\.ipa$/i.test(file.name)) { showError('Choose a file ending in .ipa. Renaming another file to .ipa will not make it a valid iOS archive.'); return; }
  if (!file.size) { showError('This file is empty. Choose a complete IPA archive.'); return; }
  if (typeof Worker === 'undefined') { showError('This browser does not support local background inspection. Try a current version of Safari, Firefox, Chrome, or Edge.'); return; }
  $('drop-zone').hidden = true; $('checked-state').hidden = true; $('processing').hidden = false;
  setText('processing-file', file.name); setText('progress-label', 'Reading archive'); setText('progress-value', '0%'); $('progress').value = 0;
  try {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); activeWorker = worker;
    worker.onmessage = ({ data }) => {
      if (activeWorker !== worker) return;
      if (data.type === 'progress') {
        setText('progress-label', data.label); setText('progress-value', `${data.percent}%`); $('progress').value = data.percent;
      } else if (data.type === 'error') showError(data.message);
      else if (data.type === 'result') { stopWorker(); render(data.result); }
    };
    worker.onerror = event => {
      event.preventDefault();
      if (activeWorker === worker) showError('Local inspection could not finish. The file may be damaged or exceed this browser’s available memory. Try another IPA or a desktop browser.');
    };
    worker.postMessage({ file });
  } catch { showError('The local inspection worker could not start. Reload this page or try another browser.'); }
}
function render(r) {
  currentResult = r;
  $('processing').hidden = true; $('checked-state').hidden = false; setText('checked-file', r.fileName);
  const verdict = $('verdict'); verdict.classList.toggle('negative', !r.portable);
  setText('verdict-icon', r.portable ? '✓' : '↶');
  setText('verdict-eyebrow', r.portable ? 'ARMV7 FOUND · ARCHITECTURE CHECK PASSED' : 'NO ARMV7 FOUND · TRY AN OLDER VERSION');
  setText('verdict-title', r.portable ? 'Portable — a candidate for Vita.' : 'This version is not portable.');
  setText('verdict-description', r.portable ? 'This version includes an ARMv7 executable. That’s the first requirement for a PS Vita port. iOS dependencies, graphics, and memory use still need manual review; a working port isn’t guaranteed.' : `This version contains ${r.architectures.join(', ')} but no ARMv7 executable. Try an older version of this game — it may still include ARMv7 and could be portable.`);
  setText('app-name', r.name); setText('bundle-id', r.bundleId || 'Bundle ID not available');
  setText('app-version', `${r.version || 'Not available'}${r.build ? ` · build ${r.build}` : ''}`);
  setText('minimum-ios', r.minimumIOS ? `iOS ${r.minimumIOS}` : 'Not in metadata');
  setText('ipa-size', formatSize(r.ipaSize)); $('ipa-size').title = `${r.ipaSize.toLocaleString()} bytes (compressed archive); app contents: ${formatSize(r.appSize)}`;
  $('release-date-field').hidden = !r.releaseDate;
  setText('release-date', r.releaseDate || ''); $('release-date').title = r.releaseSource || '';
  $('architectures').replaceChildren(...r.architectures.map(name => { const chip = document.createElement('span'); chip.className = 'arch-chip' + (name === 'armv7' ? ' armv7' : ''); chip.textContent = name; return chip; }));
  setText('executable-name', r.executablePath.split('/').at(-1)); $('executable-name').title = `${r.executablePath} (${formatSize(r.executableSize)})`;
  const notes = [...r.warnings];
  if (!r.icon) notes.push('No readable standalone icon was found; the icon may be in an asset catalog.');
  if (r.releaseDate) notes.push(`Release date source: ${r.releaseSource}.`);
  if (r.encrypted) notes.push('The ARMv7 executable has an encryption flag. Architecture compatibility does not establish that it is ready to run.');
  setText('metadata-note', notes.join(' ')); $('metadata-note').hidden = !notes.length;
  if (r.icon) {
    iconURL = URL.createObjectURL(new Blob([r.icon.bytes], { type: r.icon.mime })); $('app-icon').src = iconURL;
    $('app-icon').alt = `${r.name} app icon`; $('app-icon').hidden = false; $('icon-fallback').hidden = true;
  }
  setText('ipa-hash', r.ipaSha256); setText('executable-hash', r.executableSha256);
  writeReport(r); setText('copy-feedback', '');
  $('results').hidden = false;
  setText('announcements', `${r.name}: ${r.portable ? 'ARMv7 found. Architecture check passed.' : 'This version is not portable. Try an older version.'}`);
  $('results').focus({ preventScroll: true });
  $('results').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  void updateArtwork();
}
async function updateArtwork() {
  cancelArtworkLookup();
  const result = currentResult;
  if (!result) return;
  result.appStoreIconUrl = null;
  writeReport(result);
  setText('copy-feedback', '');
  if (!result.bundleId) { setText('artwork-feedback', 'No bundle ID is available for App Store artwork.'); return; }
  const request = { controller: new AbortController(), timer: null };
  request.timer = setTimeout(() => request.controller.abort(), 5000);
  artworkRequest = request;
  $('copy-report').disabled = true;
  setText('artwork-feedback', 'Looking up an App Store icon…');
  try {
    const url = await lookupAppStoreIcon(result.bundleId, { signal: request.controller.signal });
    if (artworkRequest !== request || currentResult !== result) return;
    result.appStoreIconUrl = url;
    writeReport(result);
    setText('artwork-feedback', url ? 'Report includes artwork from the current App Store listing.' : 'No icon found in the US App Store. The report is ready without one.');
  } catch {
    if (artworkRequest !== request || currentResult !== result) return;
    setText('artwork-feedback', 'App Store artwork is unavailable. The report is ready without it.');
  } finally {
    clearTimeout(request.timer);
    if (artworkRequest === request) { artworkRequest = null; $('copy-report').disabled = false; }
  }
}
async function copy(text, button) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    setText('copy-feedback', button === $('copy-report') ? 'Markdown report copied. Ready to paste.' : 'SHA-256 copied.');
    setText('announcements', 'Copied to clipboard.');
  } catch {
    $('markdown-report').focus(); $('markdown-report').select();
    setText('copy-feedback', 'Clipboard access is unavailable. The report is selected — press ⌘C or Ctrl+C to copy.');
  }
}
$('choose-button').addEventListener('click', () => $('file-input').click());
$('another-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; inspect(file); });
$('cancel-button').addEventListener('click', () => { stopWorker(); idle(); clearResult(); setText('announcements', 'Inspection cancelled. No files were uploaded.'); $('choose-button').focus(); });
$('dismiss-error').addEventListener('click', () => { $('error').hidden = true; $('choose-button').focus(); });
$('copy-report').addEventListener('click', () => { if (currentResult) void copy($('markdown-report').value, $('copy-report')); });
$('copy-ipa-hash').addEventListener('click', () => { if (currentResult) void copy(currentResult.ipaSha256, $('copy-ipa-hash')); });
$('copy-executable-hash').addEventListener('click', () => { if (currentResult) void copy(currentResult.executableSha256, $('copy-executable-hash')); });
$('app-icon').addEventListener('error', () => { $('app-icon').hidden = true; $('icon-fallback').hidden = false; });
const zone = $('drop-zone');
zone.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; zone.classList.add('dragging'); });
zone.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove('dragging'); } });
zone.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
zone.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); dragDepth = 0; zone.classList.remove('dragging'); const files = event.dataTransfer.files; if (files.length !== 1) showError('Choose one IPA at a time.'); else inspect(files[0]); });
document.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { event.preventDefault(); });
window.addEventListener('pagehide', () => { stopWorker(); cancelArtworkLookup(); if (iconURL) URL.revokeObjectURL(iconURL); });

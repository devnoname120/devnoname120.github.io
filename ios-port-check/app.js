import { markdownReport, richTextReport } from './report.js';
import { lookupAppStoreIcon } from './app-store.js';
const $ = id => document.getElementById(id);
let activeWorker = null, currentResult = null, dragDepth = 0;
let artworkRequest = null;
const setText = (id, text) => { $(id).textContent = text; };
function writeReport(result) {
  const report = $('markdown-report');
  report.value = markdownReport(result); report.setSelectionRange(0, 0); report.scrollTop = 0;
  $('rich-text-report').innerHTML = richTextReport(result).html;
  $('rich-text-report').scrollTop = 0;
}
function disableReportCopy(disabled) {
  $('copy-report').disabled = disabled; $('copy-rich-text').disabled = disabled;
}
function cancelArtworkLookup() {
  if (artworkRequest) { clearTimeout(artworkRequest.timer); artworkRequest.controller.abort(); artworkRequest = null; }
  disableReportCopy(false);
}
function clearResult() {
  cancelArtworkLookup();
  currentResult = null; $('results').hidden = true;
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
  const supported = r.architectures.filter(name => name === 'armv6' || name === 'armv7');
  const supportedLabel = supported.map(name => name.replace('arm', 'ARM')).join(' and ');
  setText('verdict-icon', r.portable ? '✓' : '↶');
  setText('verdict-eyebrow', r.portable ? `${supportedLabel} FOUND · ARCHITECTURE CHECK PASSED` : 'NO ARMv6 OR ARMv7 FOUND · TRY AN OLDER VERSION');
  setText('verdict-title', r.portable ? 'Portable — a candidate for Vita.' : 'This version is not portable.');
  setText('verdict-description', r.portable ? `This version includes ${supportedLabel} code, meeting the loader’s architecture requirement. iOS dependencies, graphics, and memory use still need manual review; a working port isn’t guaranteed.` : `This version contains ${r.architectures.join(', ')} but no ARMv6 or ARMv7 executable. Try an older version of this game — it may include ARMv6 or ARMv7 and could be portable.`);
  writeReport(r); setText('copy-feedback', '');
  $('results').hidden = false;
  setText('announcements', `${r.name}: ${r.portable ? `${supportedLabel} found. Architecture check passed.` : 'This version is not portable. Try an older version.'}`);
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
  disableReportCopy(true);
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
    if (artworkRequest === request) { artworkRequest = null; disableReportCopy(false); }
  }
}
async function copyMarkdown() {
  if (!currentResult) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText($('markdown-report').value);
    setText('copy-feedback', 'Markdown report copied. Ready to paste.');
    setText('announcements', 'Copied to clipboard.');
  } catch {
    $('markdown-details').open = true;
    $('markdown-report').focus(); $('markdown-report').select();
    setText('copy-feedback', 'Clipboard access is unavailable. The report is selected — press ⌘C or Ctrl+C to copy.');
  }
}
async function copyRichText() {
  if (!currentResult) return;
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Rich text clipboard unavailable');
    const report = richTextReport(currentResult);
    // Call write during the click gesture; no network work precedes clipboard access.
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([report.html], { type: 'text/html' }),
      'text/plain': new Blob([report.text], { type: 'text/plain' })
    })]);
    setText('copy-feedback', 'Rich text report copied. Ready to paste into a rich-text editor.');
    setText('announcements', 'Rich text copied to clipboard.');
  } catch {
    const preview = $('rich-text-report'), selection = window.getSelection(), range = document.createRange();
    preview.focus(); range.selectNodeContents(preview); selection.removeAllRanges(); selection.addRange(range);
    setText('copy-feedback', 'Rich text clipboard access is unavailable. The formatted report is selected — press ⌘C or Ctrl+C to copy.');
  }
}
$('choose-button').addEventListener('click', () => $('file-input').click());
$('another-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; inspect(file); });
$('cancel-button').addEventListener('click', () => { stopWorker(); idle(); clearResult(); setText('announcements', 'Inspection cancelled. No files were uploaded.'); $('choose-button').focus(); });
$('dismiss-error').addEventListener('click', () => { $('error').hidden = true; $('choose-button').focus(); });
$('copy-report').addEventListener('click', () => { void copyMarkdown(); });
$('copy-rich-text').addEventListener('click', () => { void copyRichText(); });
const zone = $('drop-zone');
zone.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; zone.classList.add('dragging'); });
zone.addEventListener('dragleave', event => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove('dragging'); } });
zone.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
zone.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); dragDepth = 0; zone.classList.remove('dragging'); const files = event.dataTransfer.files; if (files.length !== 1) showError('Choose one IPA at a time.'); else inspect(files[0]); });
document.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { event.preventDefault(); });
window.addEventListener('pagehide', () => { stopWorker(); cancelArtworkLookup(); });

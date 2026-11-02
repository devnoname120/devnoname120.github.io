// Only an exact bundle-ID match may supply artwork. Local game/version metadata
// and the portability verdict are never replaced with current Store metadata.
export function artworkURL(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.mzstatic.com') || url.username || url.password || url.port) return null;
    return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  } catch { return null; }
}
export async function lookupAppStoreIcon(bundleId, { signal, fetchImpl = fetch } = {}) {
  if (typeof bundleId !== 'string' || bundleId.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundleId)) return null;
  const url = new URL('https://itunes.apple.com/lookup');
  url.searchParams.set('bundleId', bundleId); url.searchParams.set('country', 'us');
  const response = await fetchImpl(url.href, { method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
  if (!response.ok) throw new Error('App Store artwork lookup failed.');
  const data = await response.json();
  if (!Array.isArray(data?.results)) return null;
  const match = data.results.find(app => app?.bundleId === bundleId);
  if (!match) return null;
  return artworkURL(match.artworkUrl512) || artworkURL(match.artworkUrl100) || artworkURL(match.artworkUrl60);
}

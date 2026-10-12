/**
 * Save a file the page generated (a CSV, a report) without a server: a Blob, an object URL and a temporary
 * `<a download>`. Nothing leaves the machine — the URL is `blob:` on this origin and is revoked right after the click.
 *
 * CSP: a download is a navigation, which the app's policy does not restrict (there is no `navigate-to`), and no
 * fetch, frame or image is involved, so neither connect-src nor img-src needs a `blob:` source. The desktop wrapper
 * (electron/main.js) refuses every download by design (`will-download` → preventDefault); there the click does
 * nothing, which the panel says.
 */
export function downloadText(text: string, filename: string, mime: string): boolean {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename(filename);
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/** Letters, digits, dot, dash and underscore only; never empty. */
export function safeFilename(name: string): string {
  const s = name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return (s || 'deluge-export').slice(0, 96);
}

/** True inside the desktop wrapper, where downloads are blocked. */
export function downloadsBlocked(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'app:';
}

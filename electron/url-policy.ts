/**
 * Navigation and external-link policy.
 *
 * Kept free of any electron import so it can be tested in Node directly — the
 * main process module cannot be, because it opens a window on load.
 */

/**
 * Schemes safe to hand to the OS.
 *
 * `shell.openExternal` runs whatever is registered for a scheme, so this is an
 * allowlist. `file:` would open local paths, and the assorted app-launching
 * schemes a compromised renderer could reach for are all denied by omission.
 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * True when `url` is the document already loaded, rather than somewhere new.
 *
 * The window shows one document for its whole life; the only navigation it
 * should ever perform is a reload, which is how Vite delivers a full HMR
 * refresh in dev.
 */
export function isSameOrigin(url: string, current: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(current);
    // Every file: URL has the opaque "null" origin, so origin comparison would
    // treat any local file as same-origin. Compare the path instead.
    if (a.protocol === 'file:' || b.protocol === 'file:') {
      return a.protocol === b.protocol && a.pathname === b.pathname;
    }
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

/**
 * Optional autosave of the current project to this browser's localStorage — OFF by default.
 *
 * Deluge stores nothing unless the user turns this on (README "Security"). When on, the project (without the
 * portfolio: it may be sensitive) is written under one key after changes; turning it off deletes that copy. Every
 * storage call is wrapped: private windows, blocked storage and quota errors simply mean "no autosave", never a
 * failure. The desktop wrapper clears storage each time it starts (electron/main.js), so there an autosave lasts only
 * until the app quits — the panel says so.
 */
export const AUTOSAVE_KEY = 'deluge.project.autosave.v1';
export const AUTOSAVE_ON_KEY = 'deluge.project.autosave.on';
/** Largest project text autosaved, characters (localStorage quotas are ~5 MB per origin). */
export const AUTOSAVE_MAX_CHARS = 1_000_000;

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function autosaveEnabled(): boolean {
  try {
    return storage()?.getItem(AUTOSAVE_ON_KEY) === '1';
  } catch {
    return false;
  }
}

/** Turn autosave on or off. Off also deletes the saved copy. Returns whether the setting could be stored. */
export function setAutosaveEnabled(on: boolean): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (on) s.setItem(AUTOSAVE_ON_KEY, '1');
    else {
      s.removeItem(AUTOSAVE_ON_KEY);
      s.removeItem(AUTOSAVE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

export function writeAutosave(text: string): boolean {
  if (text.length > AUTOSAVE_MAX_CHARS || !autosaveEnabled()) return false;
  try {
    storage()?.setItem(AUTOSAVE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

export function readAutosave(): string | null {
  try {
    if (!autosaveEnabled()) return null;
    const t = storage()?.getItem(AUTOSAVE_KEY) ?? null;
    return t && t.length <= AUTOSAVE_MAX_CHARS ? t : null;
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    storage()?.removeItem(AUTOSAVE_KEY);
  } catch {
    /* nothing stored */
  }
}

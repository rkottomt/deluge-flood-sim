/**
 * Optional autosave of the current project to this browser's localStorage — OFF by default.
 *
 * Deluge stores nothing unless the user turns this on (README "Security"). When on, the project (without the
 * portfolio: it may be sensitive) is written under one key after changes; turning it off deletes that copy (and the
 * backup below). Every storage call is wrapped: private windows, blocked storage and quota errors simply mean "no
 * autosave", never a failure. The desktop wrapper clears storage each time it starts (electron/main.js), so there an
 * autosave lasts only until the app quits — the panel says so.
 *
 * Nothing is overwritten silently. A session writes only once the user has made a real change (AutosaveGate: the
 * scene as first shown — the default one, or a ?project= link's — is not one), restored the offered copy or turned
 * autosave on; and its first write keeps the copy it replaces under a second key, one step back, which the panel
 * offers to restore.
 */
export const AUTOSAVE_KEY = 'deluge.project.autosave.v1';
export const AUTOSAVE_ON_KEY = 'deluge.project.autosave.on';
/** The copy a session's first write replaced (one-step backup). */
export const AUTOSAVE_BACKUP_KEY = 'deluge.project.autosave.v1.previous';
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
      s.removeItem(AUTOSAVE_BACKUP_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

/** Write the copy; with `backup`, first keep the copy it replaces under AUTOSAVE_BACKUP_KEY. */
export function writeAutosave(text: string, opts: { backup?: boolean } = {}): boolean {
  if (text.length > AUTOSAVE_MAX_CHARS || !autosaveEnabled()) return false;
  try {
    const s = storage();
    if (opts.backup) {
      const prev = s?.getItem(AUTOSAVE_KEY) ?? null;
      if (prev && prev !== text) s?.setItem(AUTOSAVE_BACKUP_KEY, prev);
    }
    s?.setItem(AUTOSAVE_KEY, text);
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

/** The copy kept one step back (null when there is none, or autosave is off). */
export function readAutosaveBackup(): string | null {
  try {
    if (!autosaveEnabled()) return null;
    const t = storage()?.getItem(AUTOSAVE_BACKUP_KEY) ?? null;
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

/**
 * When a session may write. The panel ticks every few seconds with the project's key (its JSON without savedAt and
 * the camera, which moves on its own). Nothing is written before the project as first shown has been seen
 * (setBaseline), nor while it is still that project, untouched: the copy from last time stays until the user restores
 * it, makes a real change, or turns autosave on here (arm). After that, only when the key changed.
 */
export class AutosaveGate {
  private baseline: string | null = null;
  private armed = false;
  private backedUp = false;
  private last = '';

  /** The project as first shown (the first call wins). */
  setBaseline(key: string): void {
    if (this.baseline === null) this.baseline = key;
  }
  /**
   * What was put on screen for the user, not by them (a ?project= link at startup): the new baseline, unless they
   * have already made the session's project their own.
   */
  rebase(key: string): void {
    if (!this.armed) this.baseline = key;
  }
  /** The user restored a copy, opened a project or turned autosave on: write from the next change on. */
  arm(): void {
    this.armed = true;
    this.last = '';
  }
  /** Should the project with this key be written now? */
  shouldWrite(key: string): boolean {
    if (key === this.last) return false;
    if (!this.armed) {
      if (this.baseline === null || key === this.baseline) return false;
      this.armed = true; // a real change
    }
    this.last = key;
    return true;
  }
  /** The session's first write keeps the copy it replaces (true once). */
  takeBackup(): boolean {
    if (this.backedUp) return false;
    this.backedUp = true;
    return true;
  }
}

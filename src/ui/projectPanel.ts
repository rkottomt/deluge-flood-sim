/**
 * The "Project" panel section: save everything on screen as a `.deluge.json` file, open one, share a small project as
 * a `?project=` link, and — off by default — autosave it in this browser.
 *
 * PRIVACY. A project file is generated in this tab and downloaded; an opened file is read with File.text() here and
 * never uploaded. The portfolio CSV goes into a file only when its box is ticked, and never into a link or the
 * autosave. Autosave is the one thing in Deluge that writes to browser storage, and only after the user turns it on;
 * turning it off deletes the copy.
 *
 * SECURITY. Every file and link goes through the strict reader (src/project/validate.ts). Messages are fixed
 * sentences; names from a link are not shown (format.ts). Nothing here writes markup.
 */
import type { TerrainData } from '../contracts';
import { cleanPlaceLabel } from '../data/placeName';
import { AutosaveGate, autosaveEnabled, readAutosave, readAutosaveBackup, setAutosaveEnabled, writeAutosave } from '../project/autosave';
import { describeEdits, editLogFor, editsCost, replayEdits } from '../project/edits';
import { PROJECT_EXTENSION, PROJECT_LIMITS, PROJECT_MIME, type ProjectEdit, type ProjectFile } from '../project/format';
import { decodeProjectLink, encodeProjectLink, LINK_BUDGET, PROJECT_PARAM } from '../project/share';
import { parseProjectText, projectToJson, type ReadResult } from '../project/validate';
import { bridgeFor } from './bridge';
import { button, toggleSwitch } from './controls';
import { h, setText, toggleClass, type UIContext } from './dom';
import { downloadsBlocked, downloadText, safeFilename } from './download';
import { fmtNum } from './format';
import { headlessBusy } from './headless';
import { applyProject, captureProject, gridMatches, sceneMatches } from './projectState';
import { sitesFor } from './sites';

/** Autosave cadence, ms of wall time (a write happens only when the project changed). */
const AUTOSAVE_MS = 5000;
/** How long a project from a link or the autosave waits for its scene, ms. */
const SCENE_WAIT_MS = 120_000;

export interface ProjectSection {
  body: HTMLElement[];
  badge: HTMLElement;
}

export function createProjectSection(ctx: UIContext): ProjectSection {
  const { store, actions } = ctx;
  const bridge = bridgeFor(store);
  const log = editLogFor(store);
  const getTerrain = (): TerrainData | null => bridge.scene?.getTerrain() ?? null;

  let includePortfolio = false;
  let includeResults = true;
  let busy = false;
  let autosaveOn = autosaveEnabled();
  const gate = new AutosaveGate();
  /** A link's terrain edits, held until the user agrees to apply them (on the scene they were opened on). */
  let pendingTerrain: { edits: ProjectEdit[]; terrain: TerrainData } | null = null;
  /** Scene key a ?project= link was applied on; leaving it drops the parameter from the address bar. */
  let linkScene: string | null = null;

  // ─── DOM ────────────────────────────────────────────────────────────────────────────────────────────────────
  const badge = h('span', { class: 'dl-sec-badge', hidden: true });
  const intro = h(
    'p',
    { class: 'dl-impact-note' },
    'Save everything on screen — the scene, your scenario changes, walls and digging, Site check sites and settings, ensemble settings, designs, camera and view — as a .deluge.json file, and open it again later. Files stay on this computer.',
  );
  const nameIn = h('input', { type: 'text', class: 'dl-num-input dl-site-name', maxlength: PROJECT_LIMITS.nameChars, placeholder: 'Project name (optional)', 'aria-label': 'Project name', 'data-project': 'name' });
  const contents = h('p', { class: 'dl-impact-fine', 'data-project': 'contents' });
  const portfolioSwitch = toggleSwitch('Include the portfolio CSV', (on) => {
    includePortfolio = on;
    portfolioSwitch.set(on);
  }, { tip: 'Off by default: a portfolio may hold sensitive values. Never put into a link or the autosave.' });
  portfolioSwitch.set(includePortfolio);
  const resultsSwitch = toggleSwitch('Include the last comparison’s numbers', (on) => {
    includeResults = on;
    resultsSwitch.set(on);
  }, { tip: 'Cached results: the design comparison’s table (not its maps)' });
  resultsSwitch.set(includeResults);
  const saveBtn = button('Save project…', () => void save(), { icon: 'database', variant: 'primary', className: 'dl-btn-sm', tip: `Download the project as a ${PROJECT_EXTENSION} file`, side: 'top' });
  saveBtn.dataset.project = 'save';
  const fileInput = h('input', { type: 'file', accept: `${PROJECT_EXTENSION},.json,application/json`, class: 'dl-file-input', tabindex: -1, 'aria-hidden': 'true', 'data-project': 'file' });
  const openBtn = button('Open project…', () => fileInput.click(), { icon: 'arrowRight', className: 'dl-btn-sm', tip: 'Open a .deluge.json file (read in this tab, never uploaded)', side: 'top' });
  openBtn.dataset.project = 'open';
  const shareBtn = button('Share link', () => void share(), { className: 'dl-btn-sm', tip: `Put a small project in the address bar (?${PROJECT_PARAM}=); a larger one needs the file`, side: 'top' });
  shareBtn.dataset.project = 'share';
  const status = h('p', { class: 'dl-impact-status', 'aria-live': 'polite', 'data-project': 'status' });
  const issues = h('ul', { class: 'dl-impact-issues', 'data-project': 'warnings' });
  const autosaveSwitch = toggleSwitch('Autosave in this browser', (on) => setAutosave(on), { tip: 'Off by default. On: the project (without a portfolio) is kept in this browser’s storage and offered back next time. Off deletes it.' });
  autosaveSwitch.set(autosaveOn);
  autosaveSwitch.el.dataset.project = 'autosave';
  const autosaveNote = h('p', { class: 'dl-impact-fine', 'data-project': 'autosave-note' });
  const restorePrevBtn = button('Restore the earlier copy', () => void restoreBackup(), { className: 'dl-btn-sm', tip: 'The autosaved project from before this session’s first autosave', side: 'top' });
  restorePrevBtn.dataset.project = 'autosave-previous';
  restorePrevBtn.hidden = true;
  // A link's terrain edits wait for the user's yes: a link is someone else's text, and digging is not undone by Clear walls.
  const terrainText = h('p', { class: 'dl-impact-fine' });
  const terrainApplyBtn = button('Apply terrain edits', () => applyPendingTerrain(), { variant: 'primary', className: 'dl-btn-sm', tip: 'Dig and raise the ground as the link says', side: 'top' });
  terrainApplyBtn.dataset.project = 'link-terrain-apply';
  const terrainSkipBtn = button('Leave the ground as it is', () => dropPendingTerrain('The link’s terrain edits were not applied.'), { className: 'dl-btn-sm', side: 'top' });
  terrainSkipBtn.dataset.project = 'link-terrain-skip';
  const terrainCard = h('div', { class: 'dl-impact-block', 'data-project': 'link-terrain', hidden: true }, h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Terrain edits from the link')), terrainText, h('div', { class: 'dl-row dl-row-wrap' }, terrainApplyBtn, terrainSkipBtn));

  const body = [
    intro,
    h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Name'), nameIn),
    contents,
    h('div', { class: 'dl-switches' }, portfolioSwitch.el, resultsSwitch.el),
    h('div', { class: 'dl-row dl-row-wrap' }, saveBtn, openBtn, shareBtn, fileInput),
    status,
    issues,
    terrainCard,
    h('div', { class: 'dl-impact-block' }, h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Privacy')), h('div', { class: 'dl-switches' }, autosaveSwitch.el), autosaveNote, h('div', { class: 'dl-row dl-row-wrap' }, restorePrevBtn)),
  ];

  // ─── Behaviour ──────────────────────────────────────────────────────────────────────────────────────────────
  function setStatus(text: string, tone: 'info' | 'warn' = 'info', warnings: readonly string[] = []) {
    setText(status, text);
    toggleClass(status, 'dl-warn', tone === 'warn');
    issues.replaceChildren(...warnings.slice(0, 8).map((w) => h('li', null, w)));
  }

  function capture(forLink = false) {
    return captureProject(store, { name: nameIn.value, includePortfolio: includePortfolio && !forLink, includeResults: includeResults && !forLink });
  }

  async function save() {
    const c = capture();
    if (!c.ok) return setStatus(c.error, 'warn');
    if (downloadsBlocked()) {
      return setStatus('The desktop app blocks downloads by design, so it cannot save a project file. Use Share link for a small project, or run Deluge in a browser to save the file.', 'warn', c.notes);
    }
    const text = projectToJson(c.project);
    const base = safeFilename(`${c.project.name || `deluge-${store.get().presetId ?? 'area'}`}`);
    const ok = downloadText(text, `${base.replace(/\.json$/i, '')}${PROJECT_EXTENSION}`, PROJECT_MIME);
    setStatus(ok ? `Saved ${fmtNum(text.length / 1024, 0)} KB${c.project.portfolio ? ' (with the portfolio CSV)' : ''}. Nothing was uploaded.` : 'This browser cannot save files from the page.', ok ? 'info' : 'warn', c.notes);
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > PROJECT_LIMITS.maxFileChars * 4) return setStatus('The file is too large to be a Deluge project.', 'warn');
    let text: string;
    try {
      text = await file.text();
    } catch {
      return setStatus('The file could not be read.', 'warn');
    }
    await open(parseProjectText(text), false);
  });

  async function open(r: ReadResult, fromLink: boolean): Promise<boolean> {
    if (!r.ok) {
      setStatus(r.error, 'warn');
      return false;
    }
    if (busy) return false;
    if (headlessBusy(store)) {
      setStatus('A sweep, ensemble or comparison is running: open the project when it has finished.', 'warn');
      return false;
    }
    busy = true;
    setStatus('Opening the project…');
    // Another project replaces what a link left pending.
    if (pendingTerrain) dropPendingTerrain('');
    try {
      const out = await applyProject(r.project, { store, actions, fromLink, waitForScene });
      if (!fromLink) nameIn.value = r.project.name;
      // The user chose this project (a file, or the autosave offered back): autosave may keep it from now on.
      if (out.ok && !fromLink) gate.arm();
      const notes = [...r.warnings, ...out.notes];
      if (out.ok) setStatus(`${fromLink ? 'Opened the project from the link' : r.project.name ? `Opened “${r.project.name}”` : 'Opened the project'}: ${summaryText(r.project)}.`, notes.length ? 'warn' : 'info', notes);
      else setStatus('The project could not be opened.', 'warn', notes);
      render();
      return out.ok;
    } catch (err) {
      setStatus(`The project could not be opened (${err instanceof Error ? err.name : 'error'}).`, 'warn');
      return false;
    } finally {
      busy = false;
    }
  }

  function summaryText(p: ProjectFile): string {
    const e = describeEdits(p.edits);
    return [
      `${e.walls} wall${e.walls === 1 ? '' : 's'}`,
      ...(e.terrain ? [`${e.terrain} terrain edit${e.terrain === 1 ? '' : 's'}`] : []),
      `${p.sites.length} site${p.sites.length === 1 ? '' : 's'}`,
      `${p.designs.length} design${p.designs.length === 1 ? '' : 's'}`,
      ...(p.portfolio ? ['a portfolio'] : []),
    ].join(', ');
  }

  /** Resolve with the terrain once a scene is on screen and not loading (null after SCENE_WAIT_MS). */
  function waitForScene(): Promise<TerrainData | null> {
    return new Promise((resolve) => {
      const ready = () => {
        const t = getTerrain();
        const s = store.get();
        return !s.loading && t && s.terrainName && bridge.scene?.getSolver() ? t : null;
      };
      const now = ready();
      if (now) return resolve(now);
      const timer = setTimeout(() => {
        off();
        resolve(ready());
      }, SCENE_WAIT_MS);
      const off = store.subscribe(() => {
        const t = ready();
        if (!t) return;
        clearTimeout(timer);
        off();
        resolve(t);
      });
    });
  }

  async function share() {
    const c = capture(true);
    if (!c.ok) return setStatus(c.error, 'warn');
    // The reader holds a link to a far smaller replay budget than a file (format.ts maxLinkBrushCells): a link it would
    // refuse is not written.
    const g = c.project.grid;
    if (g && [c.project.edits, ...c.project.designs.map((d) => d.edits)].some((e) => editsCost(e, g).cells > PROJECT_LIMITS.maxLinkBrushCells)) {
      return setStatus('The walls and terrain edits of this project cover too much of the map for a link. Save the file and share that instead.', 'warn');
    }
    let enc: { value: string | null; length: number };
    try {
      enc = await encodeProjectLink(c.project);
    } catch {
      return setStatus('This browser cannot compress a project link; save the file instead.', 'warn');
    }
    if (!enc.value) return setStatus(`This project is too large for a link (${fmtNum(enc.length)} characters; a link holds ${fmtNum(LINK_BUDGET)}). Save the file and share that instead.`, 'warn');
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(PROJECT_PARAM, enc.value);
      window.history.replaceState(null, '', url);
      linkScene = sceneKey();
      const note = downloadsBlocked() ? ' (In the desktop app the address is not a web link; open Deluge in a browser to share it.)' : '';
      await navigator.clipboard?.writeText(url.href).then(
        () => setStatus(`Link copied and put in the address bar (${fmtNum(enc.length)} characters). It carries the scene, walls, sites and settings — no names, no portfolio.${note}`),
        () => setStatus(`Project put in the address bar (?${PROJECT_PARAM}=, ${fmtNum(enc.length)} characters). It carries no names and no portfolio.${note}`),
      );
      if (!navigator.clipboard) setStatus(`Project put in the address bar (?${PROJECT_PARAM}=, ${fmtNum(enc.length)} characters). It carries no names and no portfolio.${note}`);
    } catch {
      setStatus('Couldn’t write the address bar here.', 'warn');
    }
  }

  function sceneKey(): string {
    const s = store.get();
    return `${s.presetId}|${s.terrainName}`;
  }

  // ─── Autosave ───────────────────────────────────────────────────────────────────────────────────────────────
  function setAutosave(on: boolean) {
    const stored = setAutosaveEnabled(on);
    autosaveOn = on && stored;
    autosaveSwitch.set(autosaveOn);
    if (on && !stored) setStatus('This browser does not allow storage here (private window or blocked site data), so autosave is unavailable.', 'warn');
    else if (on) {
      // Turned on here and now: keep what is on screen (there is no older copy — turning it off deleted it).
      gate.arm();
      tickAutosave();
      setStatus('Autosave on: the project (without a portfolio) is kept in this browser and offered back next time.');
    } else setStatus('Autosave off: the saved copy was deleted. Nothing is stored.');
    renderAutosaveNote();
  }

  /** The project as autosave compares it: no time stamp, no camera (it moves on its own; it is saved with the rest). */
  function autosaveKey(p: ProjectFile): string {
    return projectToJson({ ...p, savedAt: '', camera: null }, false);
  }

  /** What is on screen, as an autosave key (null while nothing can be captured). */
  function currentKey(): { key: string; project: ProjectFile } | null {
    if (busy || headlessBusy(store) || store.get().loading || !getTerrain()) return null;
    const c = captureProject(store, { name: nameIn.value, includePortfolio: false, includeResults: true });
    return c.ok ? { key: autosaveKey(c.project), project: c.project } : null;
  }

  function tickAutosave() {
    if (!autosaveOn) return;
    const now = currentKey();
    if (!now) return;
    // The first project seen is the baseline (normally set at startup, below): it is not a change worth a write.
    gate.setBaseline(now.key);
    if (!gate.shouldWrite(now.key)) return;
    writeAutosave(projectToJson(now.project, false), { backup: gate.takeBackup() });
    renderAutosaveNote();
  }

  async function restoreBackup() {
    const text = readAutosaveBackup();
    if (!text) return renderAutosaveNote();
    await open(parseProjectText(text), false);
  }

  // ─── A link's terrain edits (asked first) ───────────────────────────────────────────────────────────────────
  function holdTerrain(edits: ProjectEdit[], terrain: TerrainData) {
    pendingTerrain = { edits, terrain };
    setText(terrainText, `The link also digs or raises the ground in ${fmtNum(edits.length)} place${edits.length === 1 ? '' : 's'}. They are applied only if you choose to (Reset all undoes them).`);
    terrainCard.hidden = false;
  }

  function dropPendingTerrain(message: string) {
    pendingTerrain = null;
    terrainCard.hidden = true;
    if (message) setStatus(message);
  }

  function applyPendingTerrain() {
    const p = pendingTerrain;
    if (!p) return;
    if (headlessBusy(store)) return setStatus('A sweep, ensemble or comparison is running: apply the terrain edits when it has finished.', 'warn');
    const solver = bridge.scene?.getSolver() ?? null;
    if (getTerrain() !== p.terrain || !solver) return dropPendingTerrain('The scene changed, so the link’s terrain edits were not applied.');
    // Ground edits commute with the walls (another raster), so applying them after the link's walls changes nothing.
    // Recorded like the user's own digging.
    replayEdits(solver, p.edits);
    dropPendingTerrain(`Applied the link’s ${fmtNum(p.edits.length)} terrain edit${p.edits.length === 1 ? '' : 's'}.`);
  }

  function renderAutosaveNote() {
    const desktop = downloadsBlocked();
    setText(
      autosaveNote,
      autosaveOn
        ? `On: kept in this browser only, every few seconds while you work${desktop ? '. The desktop app clears storage each time it starts, so the copy lasts until you quit.' : '.'} Turning it off deletes the copy.`
        : 'Off: Deluge stores nothing. Turn it on to have this browser keep your project (without a portfolio) and offer it back next time.',
    );
    restorePrevBtn.hidden = !autosaveOn || !readAutosaveBackup();
  }

  const timer = setInterval(tickAutosave, AUTOSAVE_MS);
  ctx.own(() => clearInterval(timer));

  // ─── Rendering ──────────────────────────────────────────────────────────────────────────────────────────────
  function render() {
    const t = getTerrain();
    const e = describeEdits(log.edits);
    const sites = sitesFor(store).sites.length;
    setText(
      contents,
      t
        ? `On screen: ${store.get().terrainName} · ${e.walls} wall${e.walls === 1 ? '' : 's'}${e.walls ? ` (${fmtNum((e.wallCells * t.cellSize) / 1000, 2)} km)` : ''}${e.terrain ? ` · ${e.terrain} terrain edit${e.terrain === 1 ? '' : 's'}` : ''} · ${sites} site${sites === 1 ? '' : 's'}${log.overflow ? ' · edit log full' : ''}`
        : 'No scene loaded yet.',
    );
    badge.hidden = !e.walls && !e.terrain && !sites;
    setText(badge, `${e.walls + e.terrain} edit${e.walls + e.terrain === 1 ? '' : 's'}`);
    saveBtn.disabled = shareBtn.disabled = !t;
    renderAutosaveNote();
  }

  let logFull = false;
  ctx.own(
    log.on(() => {
      render();
      if (log.overflow && !logFull) {
        bridge.notify({ kind: 'warn', key: 'edit-log-full', title: 'Edit log full', message: 'Walls and digging from now on stay on the map but are not kept in a saved project or link: the log holds as much as a project can reopen.' });
      }
      logFull = log.overflow;
    }),
  );
  ctx.own(sitesFor(store).on(() => render()));
  ctx.bind(
    (s) => `${s.presetId}|${s.terrainName}|${!!s.loading}`,
    () => {
      render();
      // A link's project belongs to its scene: once the user moves to another, a reload should not bring it back.
      if (linkScene && !store.get().loading && sceneKey() !== linkScene && getTerrain()) {
        linkScene = null;
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete(PROJECT_PARAM);
          window.history.replaceState(null, '', url);
        } catch {
          /* sandboxed history */
        }
      }
    },
  );

  // ─── Startup: a ?project= link, else an autosave to offer ───────────────────────────────────────────────────
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(window.location.search).get(PROJECT_PARAM);
  } catch {
    raw = null;
  }
  // Autosave's baseline: the project as first shown (the default scene) is not a change, so it never overwrites the
  // copy from last time on its own (AutosaveGate).
  void waitForScene().then((t) => {
    const now = t ? currentKey() : null;
    if (now) gate.setBaseline(now.key);
  });
  if (raw !== null) {
    void (async () => {
      const r = await decodeProjectLink(raw);
      if (!r.ok) {
        bridge.notify({ kind: 'info', key: 'project-link', title: 'Project link', message: r.error });
        return;
      }
      const t = await waitForScene();
      if (!t) return;
      // The link's walls, sites and settings open at once; its digging waits for the user's yes (holdTerrain).
      const terrainEdits = r.project.edits.filter((e) => e.op === 'terrain');
      const ok = await open({ ...r, project: { ...r.project, edits: r.project.edits.filter((e) => e.op !== 'terrain') } }, true);
      if (!ok) return;
      linkScene = sceneKey();
      // Put on screen for the user, not by them: autosave keeps waiting for a real change (the earlier copy stays).
      const now = currentKey();
      if (now) gate.rebase(now.key);
      const kept = autosaveOn && readAutosave() ? ' Your autosaved project is still kept in this browser.' : '';
      const onScene = getTerrain();
      if (terrainEdits.length && onScene && gridMatches(r.project.grid, onScene)) {
        holdTerrain(terrainEdits, onScene);
        bridge.notify({
          kind: 'warn',
          key: 'project-link',
          title: 'Project link opened',
          message: `Walls, sites and settings from the link are on screen. The link also digs or raises the ground in ${fmtNum(terrainEdits.length)} place${terrainEdits.length === 1 ? '' : 's'}: apply that only if you trust the link.${kept}`,
          action: { label: 'Apply terrain edits', run: () => applyPendingTerrain() },
          durationMs: 30000,
        });
      } else {
        const stored = kept ? parseProjectText(readAutosave() ?? '') : null;
        bridge.notify({
          kind: 'info',
          key: 'project-link',
          title: 'Project link opened',
          message: `Walls, sites and settings from the link are on screen. Names are not carried by links.${kept}`,
          ...(stored?.ok ? { action: { label: 'Restore my project', run: () => void open(stored, false) }, durationMs: 15000 } : {}),
        });
      }
    })();
  } else if (autosaveOn) {
    const text = readAutosave();
    if (text) {
      const r = parseProjectText(text);
      if (r.ok) {
        void waitForScene().then((t) => {
          if (!t) return;
          const where = r.project.scene.kind === 'preset' && sceneMatches(store.get(), t, r.project.scene) ? '' : ' (it loads its own scene)';
          bridge.notify({
            kind: 'info',
            key: 'project-autosave',
            title: 'Autosaved project',
            message: `This browser kept your last project${r.project.name ? ` “${cleanPlaceLabel(r.project.name, PROJECT_LIMITS.nameChars)}”` : ''}${where}.`,
            action: { label: 'Restore', run: () => void open(r, false) },
            durationMs: 20000,
          });
        });
      }
    }
  }

  render();
  return { body, badge };
}

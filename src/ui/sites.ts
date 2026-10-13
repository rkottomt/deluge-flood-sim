/**
 * The user's candidate sites (Site check), shared by the map tool (src/ui/tools.ts places them), the map overlay
 * (siteOverlay.ts draws them) and the panel section (siteCheck.ts edits and assesses them).
 *
 * Held in memory only, keyed by the Store like the UI bridge. Nothing is written to storage or sent anywhere; the one
 * way out is the share link (?sites=, src/loss/site.ts encodeSites), which the user writes into the address bar on
 * purpose. Sites are kept in lon/lat so they survive a change of scene (a site outside the new map says so).
 */
import type { Store } from '../contracts';
import { newSite, SITE_LIMITS, type SiteSpec } from '../loss/site';

type Listener = () => void;

export class SiteRegistry {
  private list: SiteSpec[] = [];
  private seq = 0;
  selectedId: string | null = null;
  /** Outline being drawn with the site tool, grid coords [gx, gy, …] (null when not drawing). */
  draft: number[] | null = null;
  private readonly fns = new Set<Listener>();
  private readonly draftFns = new Set<Listener>();

  get sites(): readonly SiteSpec[] {
    return this.list;
  }

  get selected(): SiteSpec | null {
    return this.list.find((s) => s.id === this.selectedId) ?? null;
  }

  get full(): boolean {
    return this.list.length >= SITE_LIMITS.maxSites;
  }

  on(fn: Listener): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }

  onDraft(fn: Listener): () => void {
    this.draftFns.add(fn);
    return () => this.draftFns.delete(fn);
  }

  private emit(): void {
    for (const fn of this.fns) {
      try {
        fn();
      } catch (err) {
        console.error('[ui] site listener failed', err);
      }
    }
  }

  setDraft(pts: number[] | null): void {
    this.draft = pts;
    for (const fn of this.draftFns) fn();
  }

  private nextId(): string {
    const used = new Set(this.list.map((s) => s.id));
    let id: string;
    do id = `s${++this.seq}`;
    while (used.has(id));
    return id;
  }

  /** Add a site (a pin, or an outline in lon/lat with its centroid as the pin). Returns null when full. */
  add(lon: number, lat: number, ring: number[] | null = null): SiteSpec | null {
    if (this.full || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const s = newSite(this.nextId(), lon, lat, ring);
    s.name = `Site ${this.list.length + 1}`;
    // A new site inherits the planned use of the one selected (several candidate parcels for one project).
    const prev = this.selected;
    if (prev) {
      s.occupancy = prev.occupancy;
      s.floors = prev.floors;
    }
    this.list = [...this.list, s];
    this.selectedId = s.id;
    this.emit();
    return s;
  }

  update(id: string, patch: Partial<Omit<SiteSpec, 'id'>>): void {
    let changed = false;
    this.list = this.list.map((s) => {
      if (s.id !== id) return s;
      changed = true;
      return { ...s, ...patch };
    });
    if (changed) this.emit();
  }

  remove(id: string): void {
    const n = this.list.length;
    this.list = this.list.filter((s) => s.id !== id);
    if (this.list.length === n) return;
    if (this.selectedId === id) this.selectedId = this.list[this.list.length - 1]?.id ?? null;
    this.emit();
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit();
  }

  /** The list exactly as it is (ids and selection included), for putting back later with restoreState. */
  saveState(): { list: SiteSpec[]; selectedId: string | null; seq: number } {
    return { list: this.list.map((s) => ({ ...s, ring: s.ring ? s.ring.slice() : null })), selectedId: this.selectedId, seq: this.seq };
  }

  /** Put a saveState() back, ids included (so results keyed by site id still match). */
  restoreState(st: { list: SiteSpec[]; selectedId: string | null; seq: number }): void {
    this.list = st.list.map((s) => ({ ...s }));
    this.selectedId = st.selectedId;
    this.seq = st.seq;
    this.draft = null;
    this.emit();
  }

  /** Replace everything (a ?sites= link). */
  replace(sites: SiteSpec[]): void {
    this.seq = 0;
    this.list = sites.slice(0, SITE_LIMITS.maxSites).map((s) => ({ ...s, id: `s${++this.seq}` }));
    this.selectedId = this.list[0]?.id ?? null;
    this.emit();
  }
}

const registries = new WeakMap<Store, SiteRegistry>();

export function sitesFor(store: Store): SiteRegistry {
  let r = registries.get(store);
  if (!r) registries.set(store, (r = new SiteRegistry()));
  return r;
}

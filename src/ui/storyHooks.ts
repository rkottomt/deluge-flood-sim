/**
 * What the narrated story player (storyPlayer.ts) may ask of the panels that answer a business question — Site check
 * (siteCheck.ts), Compare designs (compareDesigns.ts) and the dam-breach view (damView.ts) — without importing them:
 * each registers its hooks here on the store, as the project hooks do (projectState.ts).
 *
 * The facts are already-formatted text for the caption tokens {site:…}, {bca:…}, {dam:…} and {arrival:…}
 * (src/story/captions.ts): the numbers on screen are the ones the panel computed on this run, never typed into a story.
 * Null means "not computed yet" (the caption shows a dash).
 *
 * Every state a story changes in these panels is snapshotted when it starts and put back when it ends (Esc, the close
 * button, another scene), as the story player does for the stage, the rain and the walls.
 */
import type { Store } from '../contracts';
import type { BcaFact, DamFact, SiteFact } from '../story/captions';

export interface SiteStoryHooks {
  /** The sites and sweep settings as they are now. */
  snapshot(): unknown;
  /** Put a snapshot back (the sweep results of the story's run are dropped). */
  restore(snap: unknown): void;
  /** The site use case's demo parcels in place of the list; false when there is no scene. */
  useDemoParcels(): boolean;
  /** Run the sweep over the scene's default ladder with every level ticked; true when it completed. */
  sweep(): Promise<boolean>;
  /** A sweep is running. */
  busy(): boolean;
  /** Ask a running sweep to stop (resolves once the user's scenario is back). */
  cancel(): Promise<void>;
  /** A fact about the parcel at `index` (list order) from the last sweep. */
  fact(index: number, f: SiteFact): string | null;
}

export interface CompareStoryHooks {
  snapshot(): unknown;
  restore(snap: unknown): void;
  /**
   * The walls on the map as the only design, run against the baseline over the named stage-ladder levels (user return
   * periods typed where given), at the FEMA default discount rate. True when the comparison completed.
   */
  runWalls(levels: readonly string[], userRp: ReadonlyArray<{ level: string; years: number }>): Promise<boolean>;
  busy(): boolean;
  cancel(): Promise<void>;
  /** A fact about the first design's benefit–cost analysis. */
  fact(f: BcaFact): string | null;
}

export interface DamStoryHooks {
  /**
   * Make sure the dam's breach is the scene on screen: the valley below it loaded (a live area — this needs the
   * internet) and the breach sent in. True when it is.
   */
  open(nid: string, breach: 'sunny' | 'flood'): Promise<boolean>;
  /** The breach on screen is this dam's. */
  isOn(nid: string): boolean;
  /** Read the downstream arrivals from the run so far; true when there is a readout. */
  readArrivals(): Promise<boolean>;
  fact(f: DamFact): string | null;
  /** The last readout at `km` below the dam: the arrival with its spread across the band, or "not yet". */
  arrival(km: number): string | null;
}

export interface StoryHooks {
  site: SiteStoryHooks | null;
  compare: CompareStoryHooks | null;
  dam: DamStoryHooks | null;
}

const hooks = new WeakMap<Store, StoryHooks>();

export function storyHooksFor(store: Store): StoryHooks {
  let h = hooks.get(store);
  if (!h) hooks.set(store, (h = { site: null, compare: null, dam: null }));
  return h;
}

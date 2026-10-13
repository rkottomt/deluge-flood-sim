/**
 * Narrated stories: data-driven, cinematic walk-throughs of a preset (src/story/stories/*.ts), played by
 * src/ui/storyPlayer.ts. A story is a list of beats; each beat puts the camera somewhere, does something to the
 * simulation, shows a caption with a compact source, and holds for a while (or until the simulation reaches a point).
 *
 * Everything here is plain data (no DOM, no app imports) so the validator, the scheduler and the URL parser can be
 * unit-tested and imported by src/app/url.ts.
 *
 * FACTS. Every number in a caption comes from the repo's sourced docs (the preset's meta.json description and
 * observations, docs/research/*, BUSINESS.md, DEMO.md) and says where in `source`. Numbers the model computes (a
 * modelled front time, the acres a wall keeps dry) are not typed into captions: they are read live through the
 * caption tokens below, so a recalibration of the model cannot leave a story quoting a stale figure.
 */
import type { WaterViewMode } from '../contracts';

/** Where the camera goes at the start of a beat. `seconds` is the flight time (reduced motion: a cut). */
export type CameraSpec = (
  | { kind: 'scenario'; zoom?: number; yawOffset?: number; pitch?: number }
  | { kind: 'levee' }
  | { kind: 'frame' }
  | { kind: 'at'; lat: number; lon: number; distance: number; yaw?: number; pitch?: number }
  | { kind: 'station'; station: string; distance: number; yaw?: number; pitch?: number }
) & {
  seconds?: number;
  /** Slow yaw drift over the beat once the flight has landed, degrees (skipped with reduced motion). */
  orbitDeg?: number;
};

/** Something the beat does to the simulation, in order, when it starts. */
export type SimAction =
  /** Clean slate: walls cleared, river back to normal, no evacuation, water reset, simulation paused. */
  | { kind: 'reset' }
  | { kind: 'pause' }
  /** Run, at `speed`× when given (300 = "as fast as this GPU allows", what the Try-it buttons use). */
  | { kind: 'play'; speed?: number }
  /** Raise (or lower) the river to a gauge reading, feet (scenes with a stage control). */
  | { kind: 'raiseStage'; feet: number }
  /** Glacier scenes: start the routed flood wave over again (water reset) and run it fast. */
  | { kind: 'release'; speed?: number }
  /** The scenario's one-click demo levee (Try it → Build a levee): wall up, then the rise replayed. */
  | { kind: 'levee' }
  /** Plan an evacuation from the scenario's own start (Try it → Evacuate). */
  | { kind: 'evacuate' }
  | { kind: 'waterView'; mode: WaterViewMode | 'default' }
  | { kind: 'rain'; mmPerHour: number }
  /** The valley timeline's "Replay upstream": the flood's run from its source down to the map. */
  | { kind: 'replayUpstream' }
  /** Set up a business use case (src/ui/useCaseDefs.ts) on the scene. */
  | { kind: 'useCase'; id: 'site' | 'glacier' | 'portfolio' }
  /**
   * Site check: put the site use case's two demo parcels in the list in place of whatever is there (the user's own
   * sites come back when the story ends), select the first and open the section.
   */
  | { kind: 'demoSites' }
  /** Site check: run the sweep over the scene's default ladder, every level ticked. Resolves when it is done. */
  | { kind: 'siteSweep' }
  /**
   * Compare designs: the walls on the map become the only design, and it runs against the baseline over the named
   * levels of the stage ladder (with return periods typed for levels that have no published one — labelled as the
   * user's input, as in the panel). Resolves when the comparison is done. The user's designs come back at the end.
   */
  | { kind: 'compare'; levels: string[]; userRp?: Array<{ level: string; years: number }> }
  /** Dam stories: read arrival time and peak depth along the flow path below the dam (the dialog's Read arrivals). */
  | { kind: 'readArrivals' }
  /** Open the side panel on a section, or close it (null). */
  | { kind: 'panel'; section: PanelSection | null };

/** Side-panel sections a story may open (panel.ts section ids). */
export const PANEL_SECTIONS = ['scenario', 'chain', 'weather', 'evac', 'impact', 'site', 'designs', 'view'] as const;
export type PanelSection = (typeof PANEL_SECTIONS)[number];

/** What a beat waits for before it moves on (on top of its reading time; capped by `maxWaitMs`). */
export type UntilSpec =
  /** Chain time (s after the event's clock zero) reached on the map. */
  | { kind: 'chainTime'; t: number }
  /** The modelled flood front has reached a station of the hazard chain (plus `after` s). */
  | { kind: 'station'; station: string; after?: number }
  /** Simulated seconds since the water was last reset. */
  | { kind: 'simTime'; t: number }
  /** The river has reached the stage it was raised to. */
  | { kind: 'stageArrived' }
  /** Walls keep land dry (the protection estimate is non-zero). */
  | { kind: 'protection' }
  /** An evacuation route is on the map. */
  | { kind: 'route' };

/** UI the player may point at: a fixed allowlist, never a selector from data. */
export const UI_TARGETS = ['timeline', 'route', 'impact', 'site', 'designs', 'hud', 'tryit'] as const;
export type UiTarget = (typeof UI_TARGETS)[number];

export type Highlight =
  /** A station chip on the valley timeline. */
  | { kind: 'station'; station: string }
  /** A labelled pin on the map at a hazard-chain station. */
  | { kind: 'stationPin'; station: string; label?: string }
  /** A labelled pin on the map at a coordinate. */
  | { kind: 'pin'; lat: number; lon: number; label: string }
  | { kind: 'ui'; target: UiTarget };

export interface Beat {
  /** Unique within the story, [a-z0-9-]. */
  id: string;
  /** Small line above the caption, e.g. "08:37 NPT · 26 Aug 2026". */
  kicker?: string;
  /** The narration. May hold live tokens (CAPTION_TOKENS). */
  caption: string;
  /** Compact citation: where the caption's facts come from. */
  source: string;
  /** Reading time, ms: the beat holds at least this long (scaled by the player's pace). */
  durationMs: number;
  camera?: CameraSpec;
  actions?: SimAction[];
  until?: UntilSpec;
  /** Longest the beat waits for `until`, ms (default DEFAULT_MAX_WAIT_MS); then it moves on regardless. */
  maxWaitMs?: number;
  highlight?: Highlight[];
}

/**
 * A story that plays on a dam breach rather than a preset: the dam-breach use case's own scene (src/ui/damView.ts),
 * the valley below an NID dam loaded as a live area with the breach sent in. Needs the internet for the terrain, as
 * the use case does; the dam index ships with the app.
 */
export interface DamScene {
  /** NID id (src/dams/nidIndex.ts NID_ID_RE). */
  nid: string;
  breach: 'sunny' | 'flood';
}

/** Which business stories there are: they are listed first. */
export type StoryGroup = 'business' | 'event';

export interface Story {
  /** [a-z0-9-], ≤ 32 chars: the `?story=` value. */
  id: string;
  /** The preset it plays on (exactly one of `preset` and `dam`). */
  preset?: string;
  /** …or the dam breach it plays on. */
  dam?: DamScene;
  /** A business decision ('business', listed first) or an event retold ('event', the default). */
  group?: StoryGroup;
  title: string;
  /** One line under the title (the event and its date). */
  subtitle: string;
  /** One sentence for the entry buttons. */
  summary: string;
  beats: Beat[];
}

/** Default cap on a beat's `until` wait, ms. */
export const DEFAULT_MAX_WAIT_MS = 90_000;

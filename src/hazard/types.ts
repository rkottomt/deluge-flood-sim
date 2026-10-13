/**
 * Glacier hazard chain — shared types between the bake pipeline (scripts/), the CPU chain engine (src/hazard/) and
 * the app. THE FILE FORMAT BELOW (ChainFile, the per-preset `chain.json`) IS A CONTRACT: the bake writes it and the
 * engine reads it, so change both together.
 *
 * The chain: (1) a SOURCE (glacial lake outburst, mass movement into a lake or river, melt anomaly, or a published
 * hydrograph) → (2) an OUTFLOW hydrograph Q(t) → (3) 1-D ROUTING down a DEM-derived valley profile, tens of km,
 * giving the front's arrival time at towns, gauges and hydropower plants (= warning lead time) → (4) the routed
 * hydrograph enters the 2-D GPU domain as an inflow `WaterSource.hydrograph` at the domain edge → (5) impacts.
 * Stages 1–3 run on the CPU (cheap enough for an ensemble); only stage 4 runs on the GPU.
 *
 * Units: SI throughout — m, s, m³/s, m³. Times are simulated seconds since the chain's clock zero
 * (ChainFile.clockZero, an absolute ISO time where the event is real), which is also the 2-D solver's t = 0 unless a
 * preset says otherwise (HazardChainSpec.domainOffset).
 */

/** Where a number came from — shown next to it on screen. */
export type Provenance = 'observed' | 'reconstructed' | 'modelled' | 'scenario';

/** Debris-flow / flood rheology for the 2-D solver (uniform per scenario in v1). 'water' = today's Manning code path. */
export type Rheology =
  | { kind: 'water' }
  /** Voellmy: S_f = μ + u²/(ξ·h). μ dry-Coulomb coefficient (–), ξ turbulence coefficient (m/s²). */
  | { kind: 'voellmy'; mu: number; xi: number }
  /**
   * O'Brien–Julien quadratic (FLO-2D): yield stress and viscosity from Cv via τ_y = a2·e^(b2·Cv) (dyn/cm²),
   * η = a1·e^(b1·Cv) (poise); K laminar resistance parameter (default 2285).
   */
  | { kind: 'quadratic'; cv: number; material: RheoMaterial; K?: number }
  /** Bingham plastic: yield stress τ_y (Pa), plastic viscosity μ_B (Pa·s), bulk density ρ (kg/m³). */
  | { kind: 'bingham'; tauY: number; muB: number; rho: number };

/** O'Brien & Julien (1988) material coefficients (CGS units, as published). */
export interface RheoMaterial {
  name: string;
  a1: number;
  b1: number;
  a2: number;
  b2: number;
}

/** A glacial lake (or a landslide-dammed lake). */
export interface GlacialLake {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Lake surface elevation, m. */
  elevation: number;
  /** Surface area, m². */
  area: number;
  /** Volume with its band; `method` says where it came from. */
  volume: { median: number; lo: number; hi: number; method: 'bathymetry' | 'veh2025' | 'empirical' };
  damType: 'moraine' | 'ice' | 'bedrock' | 'supraglacial' | 'landslide';
  /** Dam height and freeboard, m, where known. */
  damHeight?: number;
  freeboard?: number;
  /** Inventory reference, e.g. 'ICIMOD2020:GL086476E27861N' (cited, not redistributed). */
  inventoryRef?: string;
}

/** Breach parameters (research spec §B.3; defaults in src/hazard/defaults.ts). */
export interface BreachParams {
  model: 'weirErosion' | 'gamma' | 'empirical';
  /** Linear down-cutting rate, m/h (default 30; trigger-driven 100). */
  erosionRate: number;
  /** Final breach depth below the initial lake level, m. */
  finalDepth: number;
  /** Breach bottom width / depth ratio (default 2). */
  widthRatio: number;
  /** Breach side slope, horizontal : vertical (default 1). */
  sideSlope: number;
  /** Lake hypsometry exponent p: V(h) ∝ h^p below the initial level (default 1.5). */
  hypsometry: number;
  /** For model 'gamma' or 'empirical': which published peak-discharge relation sets Qp. */
  empiricalEq?: string;
}

/** A mass movement (ice/rock avalanche, moraine collapse, landslide). */
export interface MassMovement {
  /** Volume, m³. */
  volume: number;
  /** Fraction of the volume that is ice (melts → water), 0–1. */
  iceFraction: number;
  /** Vertical drop, m, and horizontal path length, m (Heim's ratio H/L). */
  fallHeight: number;
  pathLength: number;
  impactAngleDeg?: number;
  thickness?: number;
  width?: number;
  /**
   * Mean speed of the mass from detachment to the end of its path, m/s (default AVALANCHE_SPEED, 50). The chain's
   * clock starts at the collapse (its seismic signal), so the water cannot leave the impact point before
   * pathLength / travelSpeed — the avalanche's own travel time.
   */
  travelSpeed?: number;
}

/**
 * Where a lake's dam lies relative to a slide entering it, for the impulse wave's spreading (src/hazard/mass.ts
 * impulseWave). All optional: depth = the lake's mean depth, distance = √area, angle 0 (the dam straight ahead of the
 * slide), spread 90° (open water).
 */
export interface ImpulseGeometry {
  depth?: number;
  distance?: number;
  angleDeg?: number;
  spreadDeg?: number;
}

/** What starts the chain. */
export type HazardTrigger =
  | { kind: 'breach'; lake: GlacialLake; breach: BreachParams }
  | { kind: 'massIntoLake'; lake: GlacialLake; mass: MassMovement; breach: BreachParams; wave?: ImpulseGeometry }
  | {
      kind: 'massIntoRiver';
      mass: MassMovement;
      mode: 'transientDam' | 'directFlow';
      damLength?: number;
      baseflow: number;
      /**
       * directFlow only: shape of the hydrograph where the mass enters the river (src/hazard/mass.ts DirectFlowShape) —
       * 'gamma' (default; a breach-like rise to the peak) or 'surge' (a debris-flow surge whose peak arrives with the
       * mass). Same peak and volume either way.
       */
      shape?: 'gamma' | 'surge';
      /**
       * directFlow only: run the avalanche as a Voellmy–Salm sliding block (src/hazard/runout.ts) from the detachment
       * down its path and along the profile until the routed flood would be the faster, and start the flood there —
       * instead of a fixed travel speed to the profile's head. μ (–) and ξ (m/s²) from a published back-analysis
       * (`source` says which). Absent: the first calibration's behaviour.
       */
      slide?: { mu: number; xi: number; source?: string };
    }
  | { kind: 'meltAnomaly'; glacierArea: number; meanElevation: number; debrisFraction: number; deltaT: number; days: number }
  | { kind: 'given'; hydrograph: Array<[number, number]>; provenance: Provenance };

/** A named point along the routing profile. */
export interface ChainStation {
  /** Chainage along the profile, m from its upstream end. */
  s: number;
  name: string;
  kind: 'source' | 'lake' | 'gauge' | 'town' | 'hydro' | 'bridge' | 'domainEdge';
  lat: number;
  lon: number;
  /** For kind 'hydro': installed capacity, MW. */
  capacityMW?: number;
}

/** A structure the 1-D routing treats as a weir (dam, barrage, intake). */
export interface ChainStructure {
  s: number;
  name: string;
  kind: 'weir' | 'dam';
  /** Crest elevation, m, and crest width, m. */
  crest: number;
  width: number;
  /** Reservoir stage–storage curve [[stage m, storage m³], …] if it has a reservoir worth modelling. */
  storage?: Array<[number, number]>;
}

/**
 * A cross-section of the valley at one profile node, as a stage table: for each stage (water-surface elevation, m)
 * the flow area (m²), top width (m) and wetted perimeter (m). Stages ascend from the thalweg.
 */
export interface ChainSection {
  stage: number[];
  area: number[];
  width: number[];
  perimeter: number[];
}

/**
 * `public/presets/<id>/chain.json` — the valley the 1-D stage routes along, baked from the DEM (Copernicus GLO-30
 * outside the US) along the river's centreline, from the source down to (and optionally past) the 2-D domain edge.
 */
export interface ChainFile {
  version: 1;
  /** Human name of the valley, e.g. "Lhende Khola → Bhote Koshi → Trishuli". */
  name: string;
  /** ISO time of t = 0 where the event is real (e.g. '2026-08-26T08:37:00+05:45'); absent for what-ifs. */
  clockZero?: string;
  /** Node spacing is not required to be uniform; `s` ascends. */
  s: number[];
  /** Thalweg (bed) elevation at each node, m. */
  zBed: number[];
  /** Manning n per node (the bake's default 0.05 for steep mountain rivers). */
  n: number[];
  /** Cross-sections, one per node. */
  sections: ChainSection[];
  /** Centreline geometry for drawing the chain on a map: [lon, lat] per node. */
  lonlat: Array<[number, number]>;
  structures: ChainStructure[];
  stations: ChainStation[];
  /** Chainage where the river enters the 2-D domain; the routed hydrograph there becomes the GPU inflow. */
  domainEntry: { s: number; gx: number; gy: number; radius: number };
  /** Sources and licences of everything in this file. */
  attribution: string;
}

/** An observation to validate the chain against (shown beside the model's number). */
export interface ChainObservation {
  station: string;
  /** Front arrival, s after clock zero. */
  tFront?: number;
  /** Peak discharge, m³/s, and its time. */
  qPeak?: number;
  tPeak?: number;
  note: string;
  source: string;
}

/**
 * Bed resistance law of the 1-D routing (src/hazard/resistance.ts). 'manning' (the default when absent): the
 * ChainFile's n per node. 'ferguson2007': Ferguson's (2007) variable-power equation
 * U/u* = a1·a2·(R/D84)/√(a1² + a2²·(R/D84)^{5/3}) on the bed's D84, applied as its depth-dependent equivalent n — it
 * REPLACES the ChainFile's n (which the bake keeps at 0.05 for the Manning path). Additive: a spec without it routes as
 * before, bit for bit.
 */
export type ResistanceLaw =
  | { law: 'manning' }
  | {
      law: 'ferguson2007';
      /**
       * D84 of the bed, m: one value for the whole profile, or reaches [{ s, d84 }, …] — each applies from its
       * chainage s (m) down to the next entry's (the first also upstream of its s).
       */
      d84: number | ReadonlyArray<{ s: number; d84: number }>;
      /** Override Ferguson's a1 = 6.5 / a2 = 2.5 (sensitivity studies only). */
      a1?: number;
      a2?: number;
    };

/** A tributary (or a reach's lumped lateral inflow) joining the routed river: constant clear water at chainage s. */
export interface ChainTributary {
  /** Chainage of the confluence, m. */
  s: number;
  /** Discharge it adds, m³/s. */
  q: number;
  /** What joins there, and where the number comes from (shown in notes; not read by the engine). */
  name?: string;
}

/** `ScenarioPreset.hazardChain` (in meta.json): how a preset's flood is produced upstream. */
export interface HazardChainSpec {
  trigger: HazardTrigger;
  /** File name of the baked ChainFile in the preset directory (normally 'chain.json'). */
  profile: string;
  rheology: Rheology;
  /** Per-scenario solver overrides: speed cap (debris floods were measured at 20–25 m/s; the default is 15). */
  solver?: { uMax?: number };
  /**
   * 1-D routing options of this preset (additive; absent = Manning with the ChainFile's n). `resistance`: the bed
   * resistance law (ResistanceLaw); a ChainOverrides.routing.resistance replaces it for one run. `tributaries`: the
   * river's own flow joining below the source — constant clear-water inflows at chainages (m, m³/s), on top of the
   * baseflow at the profile's upstream end, so the flood runs on the river as it was that day rather than on the
   * source stream's baseflow alone; a ChainOverrides.tributaries replaces the list for one run.
   */
  routing?: { resistance?: ResistanceLaw; tributaries?: ChainTributary[] };
  /** Time of the alert (s after clock zero), for warning lead time; e.g. Nepal 2026's SMS at 09:15 NPT. */
  alertTime?: number;
  observations?: ChainObservation[];
  /**
   * File name of the baked chain run in the preset directory (normally 'chain-result.json', a BakedChainResult): what
   * the chain produced when the preset was baked, so the UI can show fronts, peaks, bands and lead times without
   * re-running the chain. Absent: no baked run (the UI may run the chain itself).
   */
  result?: string;
}

/**
 * `public/presets/<id>/chain-result.json` — one baked run of the preset's hazard chain (written by
 * scripts/bake-chain-result.ts from chain.json + meta.json `scenario.hazardChain`, read by the UI). Additive to the
 * ChainFile contract: nothing in the engine reads it.
 *
 * JSON SHAPE (every time in seconds after ChainFile.clockZero = the trigger, every discharge in m³/s of mixture,
 * every volume in m³):
 *
 *   {
 *     "version": 1,
 *     "preset": "nepal",                        // preset id
 *     "profile": "chain.json",                  // the ChainFile it was routed on
 *     "clockZero": "2026-08-26T08:37:00+05:45", // copied from the ChainFile when the event is real; absent for what-ifs
 *     "generated": "2026-10-12",                // bake date (UTC), and the script that wrote the file
 *     "generator": "scripts/bake-chain-result.ts",
 *     "provenance": "modelled",                 // every number below is the model's, never an observation
 *     "label": "…",                             // one-line caption for the UI
 *     "run": { "routeDx": 100, "memberDx": 100, "members": 9, "ms": 1800, "note": "…",
 *              "member": { "volumeFactor": 1, "erosionRate": 30, "cv": 0.2 } },  // which member this run is
 *     "source": { "trigger": "massIntoRiver", "volume": …, "peak": …, "tPeak": …, "cv": 0.4, "notes": ["…"] },
 *     "stations": [                             // in chainage order, one per ChainFile station
 *       { "name": "Betrawati", "s": 60300, "kind": "town",
 *         "tFront": 2580, "tPeak": 2900, "qPeak": 9100, "stageMax": 590.2, "rise": 9.1,
 *         "leadTime": 300,                      // tFront − alertTime; absent when the spec has no alertTime
 *         "band": { "tFront": [p10, p50, p90], "qPeak": [p10, p50, p90] },   // ensemble; absent without one
 *         "observed": [ { "tFront": 2580, "qPeak": 7355, "note": "…", "source": "…" } ]  // absent when none
 *       }, …
 *     ],
 *     "entry": { "s": 53800, "tFront": …, "qPeak": …, "volume": …, "baseflow": …,
 *                "band": { "tFront": [p10, p50, p90], "qPeak": [p10, p50, p90] } },
 *     "alertTime": 2280,                        // copied from the spec when known
 *     "domain": { "offset": 1800, "sourceId": "trishuli-inflow", "inflowVolume": …, "inflowPeak": … }
 *   }
 *
 * `null` stands for "never arrived" (a NaN/∞ front: JSON has neither) in tFront, leadTime and band entries.
 * `domain.offset` is the chain time that is the 2-D solver's t = 0: the preset's inflow (meta.json scenario.sources,
 * id `domain.sourceId`) is this run's routed entry hydrograph shifted by it (chain.ts toWaterSource), so
 * 2-D time t corresponds to chain time t + offset, and a station's chain time minus `offset` is its 2-D time.
 * `domain.inflowVolume` is the area under that whole hydrograph, m³: the routed volume after the offset, exact, plus
 * the finite ramp to baseflow after it (chain.ts recessionRamp); past its last point the forcing holds only baseflow.
 */
export interface BakedChainResult {
  version: 1;
  preset: string;
  profile: string;
  clockZero?: string;
  generated: string;
  generator: string;
  provenance: 'modelled';
  label: string;
  /** Grid of the deterministic run (m), of the ensemble members (m), member count, wall time (ms), and a caption. */
  run: {
    routeDx: number;
    memberDx: number;
    members: number;
    ms: number;
    note: string;
    /** The ensemble member this run is (its chain.ts ChainOverrides): the median of the members' entry peaks. */
    member?: { volumeFactor: number; erosionRate?: number; cv: number };
  };
  source: { trigger: HazardTrigger['kind']; volume: number; peak: number; tPeak: number; cv: number; notes: string[] };
  stations: BakedStationResult[];
  entry: { s: number; tFront: number | null; qPeak: number; volume: number; baseflow: number; band?: BakedBand };
  alertTime?: number;
  domain: { offset: number; sourceId: string; inflowVolume: number; inflowPeak: number };
}

/** p10 / p50 / p90 of an ensemble; `null` = the flood never got there (in that quantile). */
export interface BakedBand {
  tFront: [number | null, number | null, number | null];
  qPeak: [number, number, number];
}

/** One station of a BakedChainResult. */
export interface BakedStationResult {
  name: string;
  s: number;
  kind: ChainStation['kind'];
  tFront: number | null;
  tPeak: number;
  qPeak: number;
  /** Highest stage (m a.s.l.) and its rise above the stage at t = 0 (m). */
  stageMax: number;
  rise: number;
  leadTime?: number | null;
  band?: BakedBand;
  /** The spec's observations at this station, copied so the UI can show model beside observation. */
  observed?: Array<{ tFront?: number; qPeak?: number; tPeak?: number; note: string; source: string }>;
}

/** What a chain run produces. */
export interface ChainResult {
  /** Outflow at the source, sampled: t (s), Q (m³/s). */
  source: { t: Float64Array; q: Float64Array; volume: number; peak: number; tPeak: number };
  /** At each station: front arrival (first Q above a threshold), peak and its time, max stage, sediment Cv. */
  stations: Array<{ name: string; s: number; tFront: number; tPeak: number; qPeak: number; stageMax: number; cv: number }>;
  /** The hydrograph at the domain entry, ready for WaterSource.hydrograph (t relative to clock zero). */
  entry: Array<{ t: number; q: number }>;
  /** Warning lead time per station, s (station front − alertTime), when an alert time is known. */
  leadTime?: Record<string, number>;
  /** p10 / p50 / p90 across the ensemble, when one was run. */
  ensemble?: { qPeak: [number, number, number]; tFront: [number, number, number] };
}

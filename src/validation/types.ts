/**
 * File formats of the validation data under public/validation/ (written by scripts/validation/fetch.ts and
 * scripts/validate.ts, read by the harness, the regression test and the Scenario panel's Validation block).
 */
import type { HwmSite, RejectedMark } from './hwm';

/** FEMA NFHL zone classes in fema-zones.json. */
export const FEMA_CLASSES = {
  0: 'not mapped by the NFHL',
  1: '1 % annual chance (Special Flood Hazard Area: A, AE, AH, AO, VE …)',
  2: '0.2 % annual chance (shaded X)',
  3: 'minimal hazard (unshaded X) or undetermined (D)',
  4: 'open water',
} as const;

export interface ObservedSource {
  id: string;
  title: string;
  url: string;
  licence: string;
  retrieved: string;
}

export interface GaugePeak {
  id: string;
  name: string;
  lon: number;
  lat: number;
  gx: number;
  gy: number;
  date: string;
  stageFt: number;
  gaugeDatumFt: number;
  datum: 'NAVD88';
  /** Peak water-surface elevation, m NAVD88. */
  elevation: number;
  dischargeCfs: number | null;
  /** USGS peak qualification codes (e.g. 9 = discharge due to a dam failure / hurricane; 2 = estimated). */
  codes: string;
  datumAccuracyFt: number | null;
  source: string;
}

/** The FEMA 1 % water level at a stage preset's gauge: where the stage ladder is set for the extent comparison. */
export interface FemaLadder {
  gauge: string;
  gaugeName: string;
  method: string;
  levelFt: number;
  /** m NAVD88. */
  level: number;
  datum: 'NAVD88';
  samples: Array<{ distanceM: number; elevationFt: number }>;
  sourceUrl: string;
  /** Riverine: every NAVD88 Base Flood Elevation line in the domain (grid coords), for the 1 % profile comparison. */
  bfeLines?: Array<{ elevFt: number; elev: number; pts: number[] }>;
}

export interface EmsDamage {
  activation: string;
  aoi: number;
  product: string;
  images: string[];
  observedEvent: string[];
  /** RLE (src/validation/raster.ts) of the analysed area on the grid: the AOI minus its not-analysed parts. */
  analysedRle: number[];
  buildings: Array<{ gx: number; gy: number; grade: string }>;
  roads: Array<{ pts: number[]; grade: string; type: string }>;
}

/**
 * A local government's post-flood damage assessment of PARCELS (Metro Nashville's windshield survey of May 2010):
 * which parcels had a structure damaged by the flood, rasterised onto the preset grid, with the gauged peak of the
 * same flood that the comparison run is raised to. Only the mask is committed — no owners, addresses or parcel IDs.
 */
export interface ParcelDamage {
  event: string;
  /** Date of the flood's crest at the gauge, YYYY-MM-DD. */
  date: string;
  /** Who surveyed what (shown in the report). */
  survey: string;
  /** The gauged crest of this flood at the stage gauge the scene's slider reads. */
  gauge: { id: string; name: string; stageFt: number; gaugeDatumFt: number; datum: 'NAVD88'; elevation: number; source: string };
  /** Damaged parcels inside the domain. */
  parcels: number;
  /** Of those, parcels smaller than one cell centre (condominium units, small lots): marked at their centroid's cell. */
  subCellParcels: number;
  /** RLE (src/validation/raster.ts) of the damaged-parcel mask on the grid: 1 = on a parcel with a damaged structure. */
  maskRle: number[];
}

export interface ObservedFile {
  version: 1;
  preset: string;
  event: string;
  retrieved: string;
  sources: ObservedSource[];
  /** Why there is nothing to compare against, when there is not. */
  none: string | null;
  hwm?: {
    event: string;
    eventId: number;
    marksAccepted: number;
    sites: Array<HwmSite & { gx: number; gy: number }>;
    rejected: RejectedMark[];
  };
  gauges?: GaugePeak[];
  fema?: { file: string; counts: Record<string, number>; dfirm: string[]; ladder?: FemaLadder };
  ems?: EmsDamage;
  damage?: ParcelDamage;
}

export interface FemaZonesFile {
  version: 1;
  preset: string;
  nx: number;
  ny: number;
  classes: typeof FEMA_CLASSES;
  counts: Record<string, number>;
  dfirm: string[];
  polygons: number;
  rle: number[];
}

/** One headline number per preset for the app's Validation block (public/validation/summary.json). */
export interface ValidationHeadline {
  /** Short label, e.g. "High-water marks (Ian)". */
  label: string;
  /** The number as shown, e.g. "bias −0.21 m, RMSE 0.34 m". */
  value: string;
  /** One-line plain-language reading of it. */
  note: string;
}

export interface ValidationSummaryEntry {
  preset: string;
  event: string;
  headline: ValidationHeadline | null;
  /** Further comparisons for the same scene (another observed flood), shown under the headline. */
  more?: ValidationHeadline[];
  /** Machine-readable metrics (the regression test pins these). */
  metrics: Record<string, number | null>;
  runs: Array<{ id: string; description: string; simMinutes: number }>;
}

export interface ValidationSummary {
  version: 1;
  generated: string;
  solver: string;
  presets: Record<string, ValidationSummaryEntry>;
}

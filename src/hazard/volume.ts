/**
 * Glacial-lake volume from surface area (research spec §A). Area is what satellites give for every lake in an
 * inventory; volume is what drives the flood. The empirical relations disagree by ×2–×10 for a given lake (Cook &
 * Quincey 2015: mean depth varies by up to an order of magnitude at a given area, D–A r² = 0.38), so the answer is a
 * median with a band, and the band feeds the ensemble.
 *
 * All relations: A in m², V in m³ (relations published in Mm³ / km² are converted once, here).
 */
import type { GlacialLake } from './types';
import { VA_BAND_BATHYMETRY, VA_BAND_FACTOR, VA_BAND_FACTOR_SUPRAGLACIAL } from './defaults';

export interface VARelation {
  id: string;
  label: string;
  cite: string;
  /** Evidence tag from the spec: V verified, S secondary, M from memory. */
  tag: 'V' | 'S' | 'M';
  /** Volume, m³, from area, m². */
  volume(areaM2: number): number;
  /** The relation should not be extrapolated beyond this area, m² (where the source says so). */
  maxArea?: number;
}

/** Power law V = c·A^e in SI. */
const power = (c: number, e: number) => (A: number) => c * Math.pow(A, e);
/** Power law published as V[Mm³] = c·A[km²]^e. */
const powerKm = (c: number, e: number) => (A: number) => 1e6 * c * Math.pow(A / 1e6, e);

/** The V–A relations of spec Table A.1, by id. */
export const VA_RELATIONS: Readonly<Record<string, VARelation>> = {
  huggel2002: {
    id: 'huggel2002',
    label: 'Huggel et al. 2002 (D̄ = 0.104 A^0.42)',
    cite: 'Huggel et al. 2002, Can. Geotech. J. 39:316, doi:10.1139/t01-099',
    tag: 'V',
    volume: power(0.104, 1.42),
  },
  evans1986: {
    id: 'evans1986',
    label: 'Evans 1986 (ice-dammed)',
    cite: 'Evans 1986, Can. Geotech. J. 23:385, doi:10.1139/t86-053',
    tag: 'V',
    volume: power(0.035, 1.5),
  },
  oconnor2001: {
    id: 'oconnor2001',
    label: "O'Connor et al. 2001 (small Oregon moraine lakes — do not extrapolate)",
    cite: "O'Connor et al. 2001, USGS Prof. Paper 1606",
    tag: 'V',
    volume: (A) => 3.114 * A + 0.0001685 * A * A,
    // Over-predicts Tsho Rolpa (1.5 km²) ×4.7; the Oregon lakes are a few hectares.
    maxArea: 1e5,
  },
  cookQuincey2015Huggel: {
    id: 'cookQuincey2015Huggel',
    label: 'Cook & Quincey 2015 — Huggel re-plot',
    cite: 'Cook & Quincey 2015, Earth Surf. Dynam. 3:559, doi:10.5194/esurf-3-559-2015, Table 1',
    tag: 'V',
    volume: power(0.1217, 1.4129),
  },
  cookQuincey2015DA: {
    id: 'cookQuincey2015DA',
    label: 'Cook & Quincey 2015 — D–A compilation',
    cite: 'Cook & Quincey 2015, Table 1',
    tag: 'V',
    volume: power(0.1697, 1.3778),
  },
  cookQuincey2015: {
    id: 'cookQuincey2015',
    label: 'Cook & Quincey 2015 — direct V–A (n = 55)',
    cite: 'Cook & Quincey 2015, Table 2',
    tag: 'V',
    volume: power(0.1, 1.434),
  },
  cookQuincey2015Supraglacial: {
    id: 'cookQuincey2015Supraglacial',
    label: 'Cook & Quincey 2015 — growing supraglacial lakes',
    cite: 'Cook & Quincey 2015, §4',
    tag: 'V',
    volume: power(0.3, 1.239),
  },
  sakai2012: {
    id: 'sakai2012',
    label: 'Sakai 2012 (Himalayan moraine lakes)',
    cite: 'Sakai 2012, Global Environ. Res. 16:23, doi:10.57466/ger.16.1_23',
    tag: 'V',
    volume: powerKm(43.24, 1.5307),
  },
  khanal2015: {
    id: 'khanal2015',
    label: 'Khanal et al. 2015 (Poiqu / Bhote Koshi)',
    cite: 'Khanal et al. 2015, Mt. Res. Dev. 35:351',
    tag: 'V',
    volume: power(0.0578, 1.4683),
  },
  wang2012: {
    id: 'wang2012',
    label: 'Wang et al. 2012 (D̄ = 0.087 A^0.434)',
    cite: 'Wang X. et al. 2012, NHESS 12:3109, doi:10.5194/nhess-12-3109-2012',
    tag: 'V',
    volume: power(0.087, 1.434),
  },
  kapitsa2017: {
    id: 'kapitsa2017',
    label: 'Kapitsa et al. 2017',
    cite: 'Kapitsa et al. 2017, NHESS 17:1837, doi:10.5194/nhess-17-1837-2017',
    tag: 'V',
    volume: power(0.036, 1.49),
  },
  zhang2023: {
    id: 'zhang2023',
    label: 'Zhang G. et al. 2023 (greater Himalaya)',
    cite: 'Zhang G. et al. 2023, Nat. Geosci., doi:10.1038/s41561-023-01150-1',
    tag: 'V',
    volume: powerKm(42.95, 1.408),
  },
};

/** The members of the default empirical estimate (spec §A.3): Huggel 2002, Cook & Quincey #6, Sakai 2012. */
export const VA_DEFAULT_MEMBERS: readonly string[] = ['huggel2002', 'cookQuincey2015', 'sakai2012'];

export interface VolumeEstimate {
  median: number;
  lo: number;
  hi: number;
  method: GlacialLake['volume']['method'];
  /** What each member relation gave, m³ (empty for a measured volume). */
  members: Record<string, number>;
}

/**
 * Volume of a lake from its area (spec §A.3): the geometric mean of Huggel 2002, Cook & Quincey 2015 #6 and Sakai 2012
 * with a ×/÷2 band — or, for growing supraglacial lakes, Cook & Quincey's supraglacial relation with ×/÷2.5. The
 * geometric mean, not the arithmetic, because the relations' errors are multiplicative (Table A.2: −26 % … +164 %).
 */
export function volumeFromArea(areaM2: number, damType: GlacialLake['damType'] = 'moraine'): VolumeEstimate {
  if (!(areaM2 > 0)) return { median: 0, lo: 0, hi: 0, method: 'empirical', members: {} };
  if (damType === 'supraglacial') {
    const v = VA_RELATIONS.cookQuincey2015Supraglacial.volume(areaM2);
    return {
      median: v,
      lo: v / VA_BAND_FACTOR_SUPRAGLACIAL,
      hi: v * VA_BAND_FACTOR_SUPRAGLACIAL,
      method: 'empirical',
      members: { cookQuincey2015Supraglacial: v },
    };
  }
  const members: Record<string, number> = {};
  let logSum = 0;
  for (const id of VA_DEFAULT_MEMBERS) {
    const v = VA_RELATIONS[id].volume(areaM2);
    members[id] = v;
    logSum += Math.log(v);
  }
  const median = Math.exp(logSum / VA_DEFAULT_MEMBERS.length);
  return { median, lo: median / VA_BAND_FACTOR, hi: median * VA_BAND_FACTOR, method: 'empirical', members };
}

/** A surveyed volume with the ±10 % band of a bathymetry (spec §A.3). */
export function volumeFromBathymetry(volume: number): VolumeEstimate {
  return { median: volume, lo: volume * (1 - VA_BAND_BATHYMETRY), hi: volume * (1 + VA_BAND_BATHYMETRY), method: 'bathymetry', members: {} };
}

/**
 * Volume that can drain above a breach base `d` metres below the lake surface, m³.
 *
 * With the hypsometry V(h) = V·(h/D)^p (h measured up from the deepest point, D the maximum depth), the surface area is
 * A = dV/dh at h = D = p·V/D, so D = p·V/A follows from what an inventory records. The breach drains the slice
 * between D − d and D: V·[1 − (1 − d/D)^p], all of it once d ≥ D. Thame's lower lake (V = 0.36 Mm³, A = 0.048 km²,
 * p = 1.5 → D ≈ 11 m) drains completely through its 12 m breach, as observed (Khadka et al. 2026). [H — the
 * hypsometry is the spec's §B.3 default, not a survey]
 */
export function drainableVolume(volume: number, area: number, breachDepth: number, hypsometry: number): number {
  if (!(volume > 0) || !(breachDepth > 0)) return 0;
  if (!(area > 0)) return volume;
  const D = (hypsometry * volume) / area;
  if (breachDepth >= D) return volume;
  return volume * (1 - Math.pow(1 - breachDepth / D, hypsometry));
}

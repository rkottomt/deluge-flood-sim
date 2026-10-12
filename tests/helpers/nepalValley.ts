/**
 * A SYNTHETIC stand-in for the Nepal preset's chain.json — Lhende Khola → Bhote Koshi → Trishuli, from the 26 August
 * 2026 avalanche impact (~2,900 m) to Devghat — built from the distances and elevations in the glacier research spec
 * (§G.1, §E.1) until the baked profile (public/presets/nepal/chain.json, DEM-derived) lands. Every number marked ≈ is
 * an estimate from known geography, not a measurement: chainages are river distances guessed from straight-line
 * distances × sinuosity, sections are trapezoids sized like the gorge / valley floor, baseflows are monsoon-season
 * orders of magnitude. Use it to check the chain's ORDER of magnitude against the observed timeline, not to tune it.
 *
 * Observed (NDRRMA SitRep 1, YAE/KU rapid report; times after the 08:37 NPT failure): Rasuwagadhi ~3 min,
 * Betrawati ~43 min, Galchhi 111 min, Malekhu 193 min, Mugling 263 min, Devghat 403 min (peak 443 min, 5,850 m³/s).
 */
import type { ChainFile, ChainObservation, HazardChainSpec } from '../../src/hazard/types';
import { syntheticValley } from './valley';

/** Stations: chainage from the impact (m, ≈) and riverbed elevation (m, ≈). */
export const NEPAL_STATIONS = [
  { name: 'Lhende impact', s: 0, z: 2900, kind: 'source' as const },
  { name: 'Rasuwagadhi', s: 20000, z: 1800, kind: 'hydro' as const },
  { name: 'Syafrubesi', s: 35000, z: 1460, kind: 'gauge' as const },
  { name: 'Betrawati', s: 76000, z: 600, kind: 'town' as const },
  { name: 'Trishuli Bazar', s: 88000, z: 540, kind: 'town' as const },
  { name: 'Galchhi', s: 118000, z: 450, kind: 'town' as const },
  { name: 'Malekhu', s: 138000, z: 370, kind: 'town' as const },
  { name: 'Mugling', s: 172000, z: 260, kind: 'town' as const },
  { name: 'Devghat', s: 197000, z: 180, kind: 'gauge' as const },
];

/** Observed front arrivals, s after 08:37 NPT, and the Devghat peak. */
export const NEPAL_OBSERVED: ChainObservation[] = [
  { station: 'Rasuwagadhi', tFront: 180, note: 'flood at Rasuwagadhi ~08:40', source: 'NDRRMA SitRep 1; ICIMOD' },
  { station: 'Betrawati', tFront: 43 * 60, note: '~09:20', source: 'NDRRMA SitRep 1' },
  { station: 'Galchhi', tFront: 111 * 60, note: '10:28', source: 'NDRRMA SitRep 1' },
  { station: 'Malekhu', tFront: 193 * 60, note: '11:50', source: 'NDRRMA SitRep 1' },
  { station: 'Mugling', tFront: 263 * 60, note: '13:00', source: 'NDRRMA SitRep 1' },
  { station: 'Devghat', tFront: 403 * 60, tPeak: 443 * 60, qPeak: 5850, note: '15:20, peak 16:00 = 5,850 m³/s', source: 'NDRRMA SitRep 1 (DHM)' },
];

/** Tributary baseflows joining the routed river, m³/s (≈ monsoon orders of magnitude). */
export const NEPAL_TRIBUTARIES = [
  { s: 21000, q: 150 }, // Bhote Koshi from Tibet joins the Lhende near Timure
  { s: 35000, q: 80 }, // Chilime / Langtang Khola at Syafrubesi
  { s: 76000, q: 30 }, // Phalakhu Khola at Betrawati
  { s: 88000, q: 80 }, // Tadi Khola near Trishuli Bazar
  { s: 128000, q: 700 }, // Budhi Gandaki at Benighat
  { s: 172000, q: 900 }, // Marsyangdi at Mugling
];

export function nepalValley(dx = 100): ChainFile {
  const st = NEPAL_STATIONS;
  // Sections: a steep bouldery gorge (Lhende, Bhote Koshi), then the Trishuli's wider floor, then the lower valley.
  const section = (s: number) =>
    s < 35000 ? { bottomWidth: 30, sideSlope: 1, n: 0.05 } : s < 88000 ? { bottomWidth: 50, sideSlope: 1.5, n: 0.045 } : { bottomWidth: 90, sideSlope: 2.5, n: 0.04 };
  const reaches = [];
  for (let k = 1; k < st.length; k++) reaches.push({ length: st[k].s - st[k - 1].s, drop: st[k - 1].z - st[k].z, ...section(st[k - 1].s) });
  return syntheticValley({
    reaches,
    dx,
    z0: st[0].z,
    tableDepth: 80,
    tableStep: 1,
    stations: st.map((x) => ({ s: x.s, name: x.name, kind: x.kind, lat: 0, lon: 0 })),
    entryS: 76000,
    name: 'Lhende → Bhote Koshi → Trishuli (SYNTHETIC, from spec distances)',
    clockZero: '2026-08-26T08:37:00+05:45',
  });
}

/**
 * The 26 Aug 2026 trigger as the evidence reads (spec §G.1): ~113 Mm³ of rock and glacier ice (YAE/KU estimate,
 * "field verification required"), falling ~2,300 m to the Lhende over ~8 km (≈), turning directly into a debris flood.
 * Ice fraction 0.2 makes its melt water ≈ the 19.96 Mm³ "excess water" DHM measured at Devghat — a calibration by
 * construction, said out loud. Alert: SMS at ~09:15 → 38 min.
 */
export function nepalSpec(): HazardChainSpec {
  return {
    trigger: {
      kind: 'massIntoRiver',
      mass: { volume: 113e6, iceFraction: 0.2, fallHeight: 2300, pathLength: 8000 },
      mode: 'directFlow',
      baseflow: 20,
    },
    profile: 'chain.json',
    rheology: { kind: 'voellmy', mu: 0.05, xi: 500 },
    solver: { uMax: 25 },
    alertTime: 38 * 60,
    observations: NEPAL_OBSERVED,
  };
}

/**
 * Breach hydrographs (src/hazard/breach.ts): the empirical relations reproduce Khadka et al. 2026 Table S2 for the
 * Thame lower lake to the m³/s (units right), the weir-erosion ODE reproduces the spec's Table B.3 (Thame ≈ 1,043 vs
 * 912 m³/s observed, Dig Tsho ≈ 2,893 vs 2,350), and the gamma hydrograph delivers exactly its volume.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  breachHydrograph,
  breachTimeFroehlich1995,
  breachTimeFroehlich2025,
  gammaHydrograph,
  gammaVolumeFactor,
  peakBand,
  PEAK_RELATIONS,
  weirErosionBreach,
} from '../../src/hazard/breach';
import { hydrographVolume } from '../../src/sim/forcing';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('empirical peak relations reproduce Khadka et al. 2026 Table S2 (Thame lower lake, V = 3.6e5 m³, Bd = 12 m)', () => {
  const V = 3.6e5;
  const H = 12;
  const expect: Record<string, number> = {
    evans1986: 634,
    popov1991: 457,
    costa1985: 1648,
    costa1985VH: 601,
    froehlich1995: 576,
    froehlich2025: 648,
    costaSchuster1988: 396,
  };
  for (const [id, q] of Object.entries(expect)) close(PEAK_RELATIONS[id].qp(V, H), q, 1.01, id);
  close(breachTimeFroehlich1995(V, H), 860, 2, 'Froehlich 1995b breach time (0.239 h)');
  close(breachTimeFroehlich2025(V, H), 1112, 2, 'Froehlich 2025 breach time');
  // The spread is the point: ×9 between relations for one lake (spec §B.1: 182–1,648 incl. ones not tabled here).
  const band = peakBand(V, H);
  assert.ok(band.max / band.min > 9, `spread ${band.min}–${band.max}`);
  assert.ok(band.min < 912 && 912 < band.max, 'the observed 912 m³/s lies inside the band');
});

test('weir-erosion breach reproduces spec Table B.3 (peaks to ±2 m³/s, times to ±0.2 min)', () => {
  // [V0, d, k m/h, Qp, tp min] from the spec's breach.mjs reproduction.
  const rows: Array<[string, number, number, number, number, number]> = [
    ['Thame lower k=100', 3.6e5, 12, 100, 1043, 6.9],
    ['Thame lower k=30', 3.6e5, 12, 30, 360, 17.7],
    ['Thame lower k=10', 3.6e5, 12, 10, 128, 36.3],
    ['Gongbatongsha k=100', 1.2e5, 9, 100, 476, 5.1],
    ['Dig Tsho k=30', 5e6, 18, 30, 2893, 35.0],
    ['Dig Tsho k=100', 5e6, 18, 100, 4968, 10.5],
    ['South Lhonak k=30', 5e7, 40, 30, 14204, 76.9],
  ];
  for (const [name, V0, d, k, qp, tp] of rows) {
    const h = weirErosionBreach({ volume: V0, depth: d, erosionRate: k });
    close(h.peak, qp, 2, `${name} peak`);
    close(h.tPeak / 60, tp, 0.2, `${name} time to peak`);
    // What drained left the lake: the series' integral is the drained volume, to rounding.
    close(h.series.total, h.volume, 1e-6 * h.volume, `${name} volume`);
    assert.ok((h.drained ?? 0) > 0.99, `${name} drains`);
  }
  // Observed / reconstructed anchors, within the spec's stated reading: Thame lower 912 m³/s at k = 100 (+14 %),
  // Dig Tsho 2,350 m³/s at 7.1 km at k = 30 (+23 %, before any attenuation).
  const thame = weirErosionBreach({ volume: 3.6e5, depth: 12, erosionRate: 100 });
  assert.ok(Math.abs(thame.peak / 912 - 1) < 0.2);
  const dig = weirErosionBreach({ volume: 5e6, depth: 18, erosionRate: 30 });
  assert.ok(Math.abs(dig.peak / 2350 - 1) < 0.25);
});

test('weir-erosion breach: slower erosion → lower, later peak; no erosion → overtopping only; a start head speeds it', () => {
  const peaks = [10, 30, 100].map((k) => weirErosionBreach({ volume: 5e6, depth: 18, erosionRate: k }));
  assert.ok(peaks[0].peak < peaks[1].peak && peaks[1].peak < peaks[2].peak);
  assert.ok(peaks[0].tPeak > peaks[1].tPeak && peaks[1].tPeak > peaks[2].tPeak);
  const none = weirErosionBreach({ volume: 5e6, depth: 18, erosionRate: 0, tMax: 3600 });
  assert.ok(none.peak < 50, `a 0.5 m overtopping head on a 1 m sill drains slowly (${none.peak})`);
  const scoured = weirErosionBreach({ volume: 5e6, depth: 18, erosionRate: 100, startHead: 8 });
  assert.ok(scoured.tPeak < peaks[2].tPeak);
  assert.equal(weirErosionBreach({ volume: 0, depth: 10 }).volume, 0);
});

test('gamma hydrograph: c(a) = e^a Γ(a+1)/a^(a+1) and the samples integrate to exactly V (also as a forcing table)', () => {
  close(gammaVolumeFactor(2), 1.847, 5e-4, 'a = 2');
  close(gammaVolumeFactor(3), 1.488, 5e-4, 'a = 3');
  close(gammaVolumeFactor(4), 1.28, 5e-4, 'a = 4');
  close(gammaVolumeFactor(6), 1.038, 5e-4, 'a = 6');
  for (const [qp, V] of [
    [912, 3.6e5],
    [13900, 8.2e6],
    [5850, 19.96e6],
  ]) {
    const h = gammaHydrograph(qp, V);
    close(h.series.total, V, 1e-9 * V, 'trapezoid integral');
    // The same points as WaterSource.hydrograph: src/sim/forcing.ts integrates them to the same volume.
    const pts = h.series.points();
    close(hydrographVolume(pts, 0, pts[pts.length - 1].t + 10), V, 1e-9 * V, 'forcing integral');
    close(h.peak, qp, 2e-3 * qp, 'peak');
    close(h.tPeak, V / (gammaVolumeFactor(3) * qp), 1e-9, 'tp = V / (1.488 Qp)');
  }
});

test('breachHydrograph dispatches: weirErosion by default, gamma on a named empirical relation', () => {
  const p = { model: 'weirErosion' as const, erosionRate: 100, finalDepth: 12, widthRatio: 2, sideSlope: 1, hypsometry: 1.5 };
  close(breachHydrograph(3.6e5, p).peak, 1043, 2, 'weir');
  const g = breachHydrograph(3.6e5, { ...p, model: 'empirical', empiricalEq: 'froehlich2025' });
  close(g.peak, 648, 2, 'Froehlich 2025 peak via gamma');
  close(g.volume, 3.6e5, 1e-6, 'gamma volume');
});

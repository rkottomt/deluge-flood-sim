/**
 * Mass movements, bulking and melt (src/hazard/mass.ts, melt.ts): the spec's computed numbers (§C, §F) and the
 * qualitative behaviour each function promises.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GlacialLake, MassMovement } from '../../src/hazard/types';
import {
  bulked,
  CV_MAX,
  damHeight,
  debrisFlowStops,
  directFlow,
  dispersiveManningFactor,
  flowType,
  impulseWave,
  mixtureDensity,
  mobilityRatio,
  overtopping,
  runout,
  scheideggerRatio,
  takahashiCv,
} from '../../src/hazard/mass';
import { daysToFill, degreeDayFactor, meltAnomaly, meltFromTrigger } from '../../src/hazard/melt';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const deg = (d: number) => (d * Math.PI) / 180;

test('runout: Scheidegger H/L (0.29 at 27 Mm³, 0.24 at 100 Mm³); ice-rich masses reach Chamoli’s 0.16', () => {
  close(scheideggerRatio(27e6), 0.29, 0.005, '27 Mm³');
  close(scheideggerRatio(100e6), 0.24, 0.006, '100 Mm³');
  const chamoli: MassMovement = { volume: 26.9e6, iceFraction: 0.2, fallHeight: 3700, pathLength: 3700 / 0.17 };
  close(mobilityRatio(chamoli), 0.16, 1e-12, 'ice-rich mobility');
  assert.ok(runout(chamoli).reaches, 'Chamoli reached Tapovan at H/L 0.16–0.17');
  assert.ok(!runout({ ...chamoli, iceFraction: 0 }).reaches, 'a dry rock avalanche of that size would not have');
  assert.ok(debrisFlowStops(100, 1000) && !debrisFlowStops(300, 1000), '11° stopping slope (Huggel 2003)');
});

test('Takahashi equilibrium Cv: ≈ 0.20 at 10°, ≈ 0.38 at 15°, capped at 0.9·C* from ~19°, ≈ 0.05 at 3°', () => {
  close(takahashiCv(deg(10)), 0.204, 0.005, '10°');
  close(takahashiCv(deg(15)), 0.376, 0.005, '15°');
  close(takahashiCv(deg(19)), CV_MAX, 1e-12, '19°');
  close(takahashiCv(deg(40)), CV_MAX, 1e-12, 'above φ');
  close(takahashiCv(deg(3)), 0.049, 0.002, '3°');
  assert.equal(takahashiCv(0), 0);
});

test('bulking and dispersive roughness', () => {
  close(bulked(100, 0.4), 166.67, 0.01, 'Q/(1 − Cv)');
  close(mixtureDensity(0.4), 1660, 1e-9, 'ρ_m');
  assert.equal(flowType(0.1), 'water flood');
  assert.equal(flowType(0.3), 'mud flood');
  assert.equal(flowType(0.5), 'mudflow');
  assert.equal(dispersiveManningFactor(0), 1, 'clear water keeps the baked n');
  // Lin et al. 2005: n_td/n_t = 1 + 0.0538 e^{6.0896 Cv}; normalised to clear water.
  close(dispersiveManningFactor(0.4), (1 + 0.0538 * Math.exp(6.0896 * 0.4)) / 1.0538, 1e-12, 'Cv 0.4');
});

test('direct flow (avalanche → debris flow) reproduces Chamoli 2021: Qp in 8,200–14,200 m³/s, 10–20 min', () => {
  const h = directFlow({ volume: 26.9e6, iceFraction: 0.2, fallHeight: 3700, pathLength: 23000 });
  assert.ok(h.peak > 8200 && h.peak < 14200, `peak ${h.peak}`);
  close(h.water, 26.9e6 * 0.2 * 0.917, 1, 'melt water');
  close(h.series.total, h.mixture, 1e-6 * h.mixture, 'mixture volume exact');
  // Most of it through in 10–20 min: 90 % of the volume passes within 20 min.
  const t90 = (() => {
    const s = h.series;
    for (let i = 0; i < s.t.length; i++) if (s.cum[i] >= 0.9 * s.total) return s.t[i];
    return Infinity;
  })();
  assert.ok(t90 > 600 && t90 < 1200, `t90 ${t90}`);
});

test('impulse wave: P grows with slide speed and mass; a big freeboard survives, a small one overtops', () => {
  const lake: GlacialLake = {
    id: 'l',
    name: 'test lake',
    lat: 0,
    lon: 0,
    elevation: 5000,
    area: 1.6e6,
    volume: { median: 1e8, lo: 9e7, hi: 1.1e8, method: 'bathymetry' },
    damType: 'moraine',
    freeboard: 2,
  };
  const mass: MassMovement = { volume: 14.7e6, iceFraction: 0.1, fallHeight: 300, pathLength: 800 };
  const w = impulseWave(mass, lake);
  assert.ok(w.P > 0 && w.hMax > w.heightAtDam && w.heightAtDam > 0);
  assert.ok(w.heightAtDam > 5 && w.heightAtDam < 100, `wave ${w.heightAtDam} m`);
  assert.ok(impulseWave({ ...mass, volume: 1e6 }, lake).P < w.P, 'smaller slide, smaller P');
  const ot = overtopping(w, lake);
  assert.ok(ot.overtops && ot.volume > 0);
  close(ot.pulse.series.total, ot.volume, 1e-6 * ot.volume, 'pulse volume');
  const safe = overtopping(impulseWave({ ...mass, volume: 1e4, fallHeight: 50 }, lake), { ...lake, freeboard: 30 });
  assert.ok(!safe.overtops && safe.volume === 0, 'the lake survived');
});

test('impulse wave: the manual’s 2-D coefficients (Evers et al. 2019, eqs. 3.13–3.19), checked against the text', () => {
  // A slide built so P comes out exactly 1: F = 1, S = 1, M = 1, α = 0 (cos 0 = 1). Then H_M = 5/9·h, a = 4/5·H,
  // x_M = 5.5·h, and the flume decay at X = 27 is (3/4)·(27^(−1/3))^(4/5)·h = (3/4)·3^(−4/5)·h.
  const h = 50;
  const lake: GlacialLake = { id: 'l', name: 'l', lat: 0, lon: 0, elevation: 0, area: 1e8, volume: { median: h * 1e8, lo: 1, hi: 1, method: 'bathymetry' }, damType: 'moraine', freeboard: 1 };
  // v_s = √(g·h) needs fallHeight − μ·L = h/2 (the energy line); s = h; M = ρ_s·V/(ρ_w·b·h²) = 1 with ice (917 kg/m³).
  const b = 100;
  const volume = (1000 * b * h * h) / 917;
  const mu = mobilityRatio({ volume, iceFraction: 1, fallHeight: 1, pathLength: 1 });
  const mass: MassMovement = { volume, iceFraction: 1, fallHeight: h / 2 + mu * 1000, pathLength: 1000, thickness: h, width: b, impactAngleDeg: 0 };
  const w = impulseWave(mass, lake, { depth: h, distance: 27 * h, spreadDeg: 0 });
  close(w.P, 1, 1e-9, 'P');
  close(w.hMax, (5 / 9) * h, 1e-9, 'H_M = (5/9)·P^(4/5)·h (3.13)');
  close(w.aMax, (4 / 9) * h, 1e-9, 'a_M = (4/5)·H_M (3.16)');
  close(w.xM, 5.5 * h, 1e-9, 'x_M = (11/2)·P^½·h (3.14)');
  close(w.heightAtDam2D, 0.75 * Math.pow(3, -0.8) * h, 1e-9, 'H(x) (3.19)');
  close(w.heightAtDam, w.heightAtDam2D, 1e-9, 'a flume (β = 0) does not spread');
  close(w.amplitudeAtDam, 0.8 * w.heightAtDam2D, 1e-9, 'the dam sees the crest, a = 0.8·H');
  close(w.period, 9 * Math.pow(27, 5 / 16) * Math.sqrt(h / 9.81), 1e-9, 'T(x) (3.20)');
  // Open water spreads the front (Ruffini et al. 2019, eq. 4.3) and a dam off the slide's axis sees less (cos²(2γ′/3)).
  const open = impulseWave(mass, lake, { depth: h, distance: 27 * h });
  assert.ok(open.heightAtDam < w.heightAtDam, 'open water lowers the wave');
  const side = impulseWave(mass, lake, { depth: h, distance: 27 * h, angleDeg: 90 });
  close(side.heightAtDam / open.heightAtDam, Math.cos(deg(60)) ** 2, 1e-9, 'γ′ = 90°: cos²(60°) = 1/4');
});

test('impulse wave: South Lhonak 2023 — the flume equations gave 46 m, the spreading lake ~15 m, against ~20 m observed', () => {
  const lake: GlacialLake = {
    id: 'south-lhonak',
    name: 'South Lhonak Lake',
    lat: 27.9125,
    lon: 88.1964,
    elevation: 5200,
    area: 1.674e6,
    volume: { median: 102.4e6, lo: 76.8e6, hi: 128e6, method: 'empirical' },
    damType: 'moraine',
  };
  const mass: MassMovement = { volume: 14.7e6, iceFraction: 0.2, fallHeight: 150, pathLength: 500 };
  const w = impulseWave(mass, lake, { distance: 1330, angleDeg: 77 });
  close(w.P, 2.79, 0.01, 'P');
  close(w.heightAtDam2D, 46, 1, 'the first version’s flume answer');
  assert.ok(w.heightAtDam > 10 && w.heightAtDam < 25, `wave ${w.heightAtDam.toFixed(1)} m at the outlet vs ~20 m observed (Sattar et al. 2025)`);
  assert.ok(w.warnings.some((x) => /^M = /.test(x)), 'M ≈ 14 is outside the tested range, and says so');
  const ot = overtopping(w, lake);
  close(ot.excess, w.amplitudeAtDam - 1, 1e-9, 'overtopping by the crest above the 1 m default freeboard');
});

test('dam height: V = A(H)·L solved for H', () => {
  // Rectangular valley 100 m wide: A(H) = 100 H, so 1.5 Mm³ over 1 km stands 15 m.
  close(damHeight(1.5e6, 1000, (h) => 100 * h), 15, 1e-6, 'rectangular');
  close(damHeight(1e12, 1000, (h) => 100 * h, 200), 200, 1e-9, 'capped');
});

test('melt: 100 km² of ice, DDF 7, +3 °C ≈ 24 m³/s (spec §F.1), and it is labelled baseflow', () => {
  // The spec's sizing uses DDF 7; the Lirung DDFs are 6 (< 5,000 m) and 7.5 (above).
  const lo = meltAnomaly([{ area: 100e6, elevation: 4800, surface: 'ice' }], 3, 1);
  const hi = meltAnomaly([{ area: 100e6, elevation: 5200, surface: 'ice' }], 3, 1);
  close((lo.extraQ * 7) / 6, 24.3, 0.1, 'scaled to DDF 7');
  assert.ok(lo.extraQ < 24.3 && 24.3 < hi.extraQ);
  assert.equal(lo.kind, 'baseflow');
  assert.equal(degreeDayFactor('debris', 4800), 3, 'debris cover halves the clean-ice DDF');
  const t = meltFromTrigger({ glacierArea: 100e6, meanElevation: 4800, debrisFraction: 0.5, deltaT: 3, days: 10 });
  close(t.extraQ, 0.75 * lo.extraQ, 1e-9, 'half debris-covered');
  close(t.volume, t.extraQ * 10 * 86400, 1e-6, 'volume over the anomaly');
  // A band well below freezing in the climatology only melts for the part of ΔT that lifts it above 0 °C.
  const cold = meltAnomaly([{ area: 1e6, elevation: 6000, surface: 'snow' }], 3, 1, { tRef: 0, zRef: 5000 });
  assert.equal(cold.extraQ, 0);
  // 2 m of freeboard on a 1 km² lake at +5 m³/s: 4.6 days.
  close(daysToFill(2, 1e6, 5), 4.63, 0.01, 'days to fill');
});

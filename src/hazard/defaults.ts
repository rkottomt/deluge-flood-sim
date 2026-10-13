/**
 * Every default of the glacier hazard chain in one place (research spec §I.3), each with its source and how well it
 * is known. Evidence tags, carried over from the spec:
 *   [V] verified against the primary source text   [S] from a secondary source (review, report, news)
 *   [M] from memory of the literature, not re-verified — check before a number derived from it is shown as fact
 *   [C] computed (spec scratchpad scripts / this repo's tests)   [H] heuristic: a modelling choice, not a measurement
 *
 * The numbers here are the MIDDLE of wide published ranges. The chain's honest output is a band (src/hazard/chain.ts
 * runEnsemble), not the single run these defaults produce.
 */

// ────────────────────────────────────────────────────────────────────────────────────────────
// Physical constants
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Gravity, m/s² (the 2-D solver uses the same value, src/sim/constants.ts). */
export const G = 9.81;
/** Density of water, kg/m³. */
export const RHO_WATER = 1000;
/** Density of sediment grains (quartz/feldspar), kg/m³ — the standard value for bulking (spec §C.5). [standard] */
export const RHO_SEDIMENT = 2650;
/** Density of glacier ice, kg/m³: a melted m³ of ice gives 0.917 m³ of water. [standard] */
export const RHO_ICE = 917;
/**
 * Bulk density of a rock-avalanche deposit (grains + pores), kg/m³, for the slide mass in the impulse-wave product.
 * Granular deposits sit near 30 % porosity: 2650 × 0.7 ≈ 1,850–2,000. [H]
 */
export const RHO_ROCK_BULK = 2000;

// ────────────────────────────────────────────────────────────────────────────────────────────
// §A Lake volume from area
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Band of the empirical volume for moraine / bedrock / ice-dammed lakes: ×/÷ 2 around the geometric mean of Huggel
 * 2002, Cook & Quincey 2015 #6 and Sakai 2012. Covers the misfit seen on Tsho Rolpa (−26…−3 %), Lejiacocha (+129…+161 %)
 * and Khadka 2026's Thame lakes (−3 % / −64 %); Cook & Quincey report depth varies ×10 at a given area. [C]
 */
export const VA_BAND_FACTOR = 2;
/** Band for growing supraglacial lakes (Cook & Quincey 2015 §4 relation, few points; Purepu 2025 came out −44 %). [C] */
export const VA_BAND_FACTOR_SUPRAGLACIAL = 2.5;
/** Relative band when the volume comes from a bathymetric survey (Tsho Rolpa, Imja, South Lhonak …). [H] */
export const VA_BAND_BATHYMETRY = 0.1;

// ────────────────────────────────────────────────────────────────────────────────────────────
// §B Breach
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Linear breach down-cutting rate k, m/h. 30 m/h fits large moraine lakes (Dig Tsho 2,893 vs 2,350 m³/s observed at
 * 7.1 km [C]); the 10–100 m/h range for moraine dams is Walder & O'Connor 1997 as remembered [M].
 */
export const EROSION_RATE = 30;
/** k for failures driven by a surge (displacement wave, debris inflow): small lakes then empty "instantly" — Thame
 * lower lake 1,043 vs 912 m³/s (Khadka et al. 2026), Gongbatongsha 476 vs 618 [C]. */
export const EROSION_RATE_TRIGGERED = 100;
/** k for ice-rich, uncompacted avalanche dams (spec §C.3: 100–300 m/h). [H] */
export const EROSION_RATE_AVALANCHE_DAM = 150;
/** Ensemble values of k, m/h (spec §I.5). */
export const EROSION_RATE_ENSEMBLE: readonly number[] = [10, 30, 100];
/** Breach bottom width / depth ratio r (Froehlich 2008's B_avg gives ~3 for Dig Tsho). [M/H] */
export const BREACH_WIDTH_RATIO = 2;
/** Breach side slope m, horizontal : vertical (Froehlich 2008: 1H:1V overtopping). [V for the slope] */
export const BREACH_SIDE_SLOPE = 1;
/** Lake hypsometry exponent p in V(s) = V₀ (s/d)^p: 1 = vertical walls, 2 = cone-like. [H] */
export const LAKE_HYPSOMETRY = 1.5;
/** Overtopping head that starts the breach run, m (z_b0 = d − 0.5). [H] */
export const BREACH_START_HEAD = 0.5;
/** Minimum breach bottom width b₀, m. [H] */
export const BREACH_MIN_WIDTH = 1;
/**
 * Broad-crested trapezoidal weir coefficients, SI: Q = 1.7·b·H^1.5 + 1.35·m·H^2.5 (Fread's NWS-BREACH/DAMBRK). [M]
 * 1.7 ≈ (2/3)^1.5·√g — critical flow over a broad crest.
 */
export const WEIR_C_RECT = 1.7;
export const WEIR_C_SIDE = 1.35;
/** Breach ODE time step, s (Heun/midpoint; Q·dt ≪ V for every case in the spec's table B.3). */
export const BREACH_DT = 1;
/** Stop the breach run when the lake holds less than this fraction of what it started with, or at BREACH_T_MAX. */
export const BREACH_V_END = 1e-4;
export const BREACH_T_MAX = 12 * 3600;
/** Gamma hydrograph shape a: Q = Qp (t/tp)^a e^{a(1 − t/tp)}; a = 3 gives V = 1.488·Qp·tp. [C] */
export const GAMMA_SHAPE = 3;

// ────────────────────────────────────────────────────────────────────────────────────────────
// §C Mass movements
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Heim ratio H/L reached by the most mobile ice-rich avalanches: Chamoli 2021, 0.16 (Shugar et al. 2021). [V] */
export const HEIM_RATIO_ICE_RICH = 0.16;
/** Ice fraction at which the ice-rich mobility applies in full (Chamoli was ~20 % ice). Below it, linear blend toward
 * Scheidegger's rock-avalanche ratio. [H] */
export const ICE_RICH_FRACTION = 0.2;
/** GLOF-induced debris flows stop where the mean slope from the source falls to 11° (H/L ≈ 0.19) — Huggel et al.
 * 2003 NHESS 3:647. [V] */
export const DEBRIS_FLOW_STOP_RATIO = Math.tan((11 * Math.PI) / 180);
/**
 * Water-body side angle β of a lake for the impulse wave's spreading, degrees (Ruffini et al. 2019 via Evers et al.
 * 2019 manual §4.2.1): 0 = a flume, 90 = open water. A lake is open water to a slide narrower than it; the manual
 * notes that even a corner impact behaves far closer to 3-D than to 2-D (Heller et al. 2012). [V for the method,
 * H for applying 90° to every lake]
 */
export const IMPULSE_SPREAD_DEG = 90;
/** Largest crest amplitude / depth of a non-breaking solitary wave on a horizontal bed (manual §3.3.3). [V] */
export const IMPULSE_A_BREAK = 0.78;
/**
 * Mean speed of an ice-rock avalanche from detachment to the end of its path, m/s, to time its arrival at the river
 * or lake (the chain's clock starts at the seismic signal of the collapse). ≈ 50 m/s is the speed the OPRI
 * reconstruction of the 2026 Lirung event gives for the flow the debris became "within three minutes of the impact"
 * (OPRI, "The Langtang Collapse", Sep 2026) [S]; large rock-ice avalanches are reported at tens of m/s. [H as a default]
 */
export const AVALANCHE_SPEED = 50;
/** Impulse-wave overtopping volume coefficient c_ot in V_ot = (a − f)·A·c_ot. [H — flag on screen] */
export const OVERTOPPING_COEFF = 0.3;
/** Duration over which the overtopping pulse is released, s (Q = V_ot / 60 s). [H] */
export const OVERTOPPING_PULSE = 60;
/** Cap on the slide impact velocity from the energy line, m/s. [H] */
export const IMPACT_VELOCITY_MAX = 60;
/** Default slide impact angle, degrees. [H] */
export const IMPACT_ANGLE = 30;
/** Default freeboard when a lake record has none, m. [H] */
export const FREEBOARD_DEFAULT = 1;
/**
 * Slide geometry when the record lacks it: thickness s = 0.25·V^(1/3), width b = 2·V^(1/3). Chamoli's slab was ~80 m
 * thick and ~550 m wide at 26.9 Mm³ (V^(1/3) ≈ 300 m: 0.27 and 1.8). [H, anchored on Shugar 2021]
 */
export const SLIDE_THICKNESS_FACTOR = 0.25;
export const SLIDE_WIDTH_FACTOR = 2;
/** Default length of an avalanche deposit damming a river, m (spec §C.3: 1–2 km). [H] */
export const DAM_LENGTH = 1500;
/** Fraction of the ice in an avalanche that melts on the way (Chamoli: "almost entirely", Shugar 2021). [V] */
export const ICE_MELT_FRACTION = 1;
/** Sediment concentration the direct-flow (avalanche → debris flow) hydrograph leaves the impact with. FLO-2D's
 * "mudflow" range is 0.45–0.55, a mud flood 0.20–0.45 [M]; 0.4 sits at the top of the mud-flood band. [H] */
export const DIRECT_FLOW_CV = 0.4;

// ────────────────────────────────────────────────────────────────────────────────────────────
// §C.5 / §E.2 Bulking and routing
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Internal friction angle φ in Takahashi's equilibrium concentration, degrees. [M] */
export const FRICTION_ANGLE = 35;
/** Packing concentration C* of the bed; Cv is capped at 0.9·C*. [M] */
export const PACKING_CONCENTRATION = 0.65;
/** Length over which Cv relaxes toward the local equilibrium, m (dCv/dx = (C∞ − Cv)/L_r). [H] */
export const CV_RELAX_LENGTH = 1000;
/** Ensemble values of the source Cv (spec §I.5). */
export const CV_ENSEMBLE: readonly number[] = [0, 0.2, 0.4];
/** Dispersive Manning enhancement n_td = n (1 + 0.0538 e^{6.0896 Cv}) (Lin, Wang & Huang 2005, NHESS 5:439, eq. 7). [V] */
export const NTD_A = 0.0538;
export const NTD_B = 6.0896;

/** Routing node spacing a bake should use, m (spec §E.2). */
export const ROUTING_DX = 100;
/** Courant number of the 1-D local-inertial step. 0.7 as the spec recommends (Bates et al. 2010 use ≤ 0.7). */
export const ROUTING_CFL = 0.7;
/**
 * de Almeida et al. 2012 flux-smoothing weight θ: Q* = θ·Q_f + (1 − θ)/2·(Q_{f−1} + Q_{f+1}). 1 is Bates 2010's plain
 * scheme; 0.7–0.9 damps the checkerboard mode that steep, high-Froude reaches excite. [V for the method, H for 0.8]
 */
export const ROUTING_THETA = 0.8;
/** Longest routing step, s (keeps the output sampling honest while the river is shallow). */
export const ROUTING_DT_MAX = 10;
/** Water depth below which a face carries no flow, m (the 2-D solver's wet threshold is 1 cm too). */
export const ROUTING_H_MIN = 0.01;
/**
 * Speed cap of the 1-D routing, m/s. Measured debris-flood fronts: 25 m/s at Raini (Chamoli), ≈ 23 m/s mean
 * Rasuwagadhi → Betrawati in 2026 [V/S]. The cap is a safety net that should almost never bind; the 2-D solver's
 * 15 m/s cap is about its own robustness and must not set the 1-D clock. [H]
 */
export const ROUTING_U_MAX = 30;
/** Froude cap, as in the 2-D solver: |u| ≤ 8·√(g·h). */
export const ROUTING_FROUDE_MAX = 8;
/** Manning n of a bouldery mountain river carrying clear water (spec §E.2; the bake's default). [S] */
export const MANNING_N = 0.05;
/**
 * Ferguson (2007, WRR 43, W05427) variable-power resistance equation, U/u* = a1·a2·(R/D84)/√(a1² + a2²·(R/D84)^{5/3}):
 * his compromise coefficients for absolute and relative error on 376 gravel- and boulder-bed measurements, restated by
 * Ferguson & Recking 2025 (WRR, doi:10.1029/2024WR038852). src/hazard/resistance.ts. [V]
 */
export const VPE_A1 = 6.5;
export const VPE_A2 = 2.5;
/**
 * Bed D84 of a Himalayan boulder-bed main stem for the VPE, m. ASSUMPTION [H]: no surveyed D84 for the Bhote Koshi /
 * Trishuli, Lachen Chu or Rishiganga / Dhauliganga was found; 0.5 m is the middle of the 0.3–1 m range taken for
 * boulder-bed mountain rivers, a bed coarser than gravel but finer than the 4.5–30 m flood boulders that sit in the
 * Trishuli and Sunkoshi channels (Huber et al. 2020, ESurf 8:769, "visibly larger than the surrounding bed load").
 * Chosen before, and not adjusted after, comparing with the observed arrival times; the sensitivity to 0.3 and 1 m is
 * in research spec §G.9. At flood depths (R ≈ 5–15 m) it is equivalent to n ≈ 0.044–0.047.
 */
export const VPE_D84_HIMALAYA = 0.5;
/** Baseflow when a scenario gives none, m³/s: keeps the routed river wet so the front does not run on a dry bed. [H] */
export const BASEFLOW_DEFAULT = 20;
/** Spin-up of the routing on baseflow alone before t = 0, s: lets the river settle from the normal-depth guess. [H] */
export const ROUTING_SPINUP = 1800;
/** Sampling interval of the routed entry hydrograph handed to the 2-D solver, s. */
export const ENTRY_DT = 30;
/** Longest simulated routing time after t = 0, s. */
export const ROUTING_T_MAX = 24 * 3600;

/**
 * Front arrival at a station: the first time Q exceeds the station's baseflow by max(FRONT_Q_MIN, FRONT_Q_FRAC × the
 * station's peak excess) OR the stage has risen FRONT_STAGE_RISE above its value at t = 0 while Q exceeds baseflow by
 * FRONT_Q_MIN. The absolute 10 m³/s keeps numerical noise from counting; 5 % of the excess scales the threshold for big
 * rivers (Devghat carries ~2,000 m³/s before the wave); the stage clause is what a gauge reader or a riverside villager
 * notices, and its flow condition keeps a backwater rise (a tributary junction settling, a reservoir) from counting. [H]
 */
export const FRONT_Q_MIN = 10;
export const FRONT_Q_FRAC = 0.05;
export const FRONT_STAGE_RISE = 0.5;

// ────────────────────────────────────────────────────────────────────────────────────────────
// §D Rheology presets for the 2-D solver (passed through; the 1-D routing uses Manning × n_td(Cv))
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Voellmy "debris flood": μ 0.05, ξ 500 m/s² (spec §D.1, bracketing Sattar 2022's Gongbatongsha μ 0.08 ξ 500). [S/H] */
export const VOELLMY_DEBRIS_FLOOD = { mu: 0.05, xi: 500 } as const;
export const VOELLMY_DEBRIS_FLOW = { mu: 0.15, xi: 300 } as const;
export const VOELLMY_STIFF = { mu: 0.25, xi: 200 } as const;
/** O'Brien–Julien laminar resistance K when unknown (FLO-2D default). [M] */
export const QUADRATIC_K = 2285;
/** O'Brien & Julien 1988 materials (CGS, as published; pairing reconstructed from Lin et al. 2005 Table 1). [S] */
export const MATERIAL_GLENWOOD_1 = { name: 'Glenwood 1', a2: 0.0345, b2: 20.1, a1: 0.00283, b1: 23.0 } as const;
export const MATERIAL_ASPEN_PIT_1 = { name: 'Aspen Pit 1', a2: 0.181, b2: 25.7, a1: 0.036, b1: 22.1 } as const;
/** Speed cap for debris presets in the 2-D solver, m/s (15 otherwise). */
export const U_MAX_DEBRIS = 25;

// ────────────────────────────────────────────────────────────────────────────────────────────
// §F Melt
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Degree-day factors, mm w.e. °C⁻¹ d⁻¹, Lirung Glacier, Langtang (Parajuli et al. 2015, PIAHS 368:409). [V] */
export const DDF_SNOW_LOW = 5;
export const DDF_SNOW_HIGH = 6.5;
export const DDF_ICE_LOW = 6;
export const DDF_ICE_HIGH = 7.5;
/** Elevation splitting the low and high DDFs, m. [V] */
export const DDF_SPLIT_ELEVATION = 5000;
/** Melt reduction under debris cover (× clean-ice DDF) (Parajuli 2015 after Kayastha 2000). [V] */
export const DEBRIS_MELT_FACTOR = 0.5;
/** Lapse rates, °C/km, Langtang (Immerzeel et al. 2014, WRR 50:2212). [V] */
export const LAPSE_ANNUAL = -5.4;
export const LAPSE_PREMONSOON = -6.4;
export const LAPSE_MONSOON = -4.6;
export const LAPSE_POSTMONSOON = -4.9;
export const LAPSE_WINTER = -5.8;
/** Environmental lapse rate fallback, °C/km. [standard] */
export const LAPSE_STANDARD = -6.5;

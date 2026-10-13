# Deluge — Glacier Hazard Chain: implementation-ready technical spec

Research date: 12 October 2026. Method: web and literature review. Scope: sections A–I of the brief.

How to read the evidence tags used throughout:

* **[V]** = verified this session against the primary source text (PDF extracted / page read).
* **[S]** = taken from a secondary source (review, news, report quoting the primary); the quoted number is as published there.
* **[M]** = from memory of the literature / standard textbook result, NOT re-verified this session — check before shipping a number to the screen.
* **[C]** = computed for this spec (`docs/research/breach-check.mjs` and inline node runs), reproducible.

Deluge context assumed (read from the repo): 2-D local-inertial solver (Bates 2010 / de Almeida 2012) with upwind
advection, staggered `rgba32float` state `(h, qx, qy, z−z0)`, semi-implicit Manning friction with ONE global `n²`
uniform (`src/sim/shaders/momentum.ts`, `momentum()`), safety caps `|q| ≤ hf·min(uMax=15 m/s, 8·√(g·hf))`,
inflow sources = constant-Q discs with optional `stopAfter` (`WaterSource` in `src/contracts.ts`), up to 16 sources,
open outflow boundaries masked near inflows. Nepal preset: 1024² × 7.8125 m, Betrawati, constant 11,100 m³/s for
1,800 s (20 Mm³), front pinned at the 15 m/s cap.

---------------------------------------------------------------------------------------------------------------------

## 0. Executive design in one page

```
 (1) SOURCE            (2) OUTFLOW Q(t)             (3) ROUTING (1-D, CPU)             (4) 2-D GPU            (5) IMPACTS
 lake V(A) ± band  →   weir + linear-erosion   →   thalweg profile from DEM,      →   'hydrograph' inflow  →  envelopes (hmax,
 mass movement         breach ODE (default)         local-inertial 1-D (or MC),       disc at domain edge,     vmax, h·v², t_arrive)
 melt (degree-day)     or parametric/empirical      Cv relaxation to Takahashi        rheology term in         → buildings, roads,
 avalanche-dam                                      equilibrium, stations,            momentum shader          bridges, hydropower,
                                                    arrival/lead time                 (+ optional Cv tracer)   lead-time timeline
```

* Stages 1–3 are cheap (≤ 30 ms per run in JS for 100 km at Δx = 100 m) → run them in a Web Worker on every slider
  change and as a 27-member ensemble (volume × erosion rate × Cv) to show uncertainty bands of peak and arrival time.
  Only the chosen member drives the GPU.
* Stage 4 needs three solver changes: (a) a time-series inflow (`type: 'hydrograph'`), (b) a rheology term in
  `momentum()` (Voellmy / O'Brien-quadratic / Bingham, uniform Cv per scenario in v1), (c) a scenario-level
  `uMax` override (debris floods were measured at 20–25 m/s; the 15 m/s cap is what sets Betrawati's clock today).
* Stage 5 reuses the protection-worker pattern on readbacks of four envelope fields.
* Ranked new presets: (1) **Betrawati upgrade** (existing domain, routed chain from Langtang Lirung/Lhende, validated
  against the NDRRMA arrival-time series), (2) **Chungthang / Teesta-III** (South Lhonak 2023, 1,200 MW dam
  destroyed), (3) **Raini–Tapovan** (Chamoli 2021, two hydropower plants, video-derived velocities/discharges).
  Thame 2024 is the best small validation case.

---------------------------------------------------------------------------------------------------------------------

## A. Lake volume from area (V–A)

### A.1 Equations (V in m³, A in m² unless stated)

| # | Relation | Source / basis | Tag |
|---|---|---|---|
| 1 | D̄ = 0.104 A^0.42 ⇒ **V = 0.104 A^1.42** | Huggel et al. 2002, Can. Geotech. J. 39:316–330, doi:10.1139/t01-099. Ice-, moraine-, thermokarst lakes. | [V] (as reproduced in Cook & Quincey 2015, eqs. 2–3) |
| 2 | V = 0.035 A^1.5 | Canadian Inland Waters Directorate via Evans 1986, Can. Geotech. J. 23:385–387, doi:10.1139/t86-053 (ice-dammed) | [V] |
| 3 | V = 3.114 A + 0.0001685 A² | O'Connor et al. 2001 (USGS PP 1606), small Oregon moraine lakes — **do not extrapolate** (over-predicts Tsho Rolpa ×4.7, see A.2) | [V] |
| 4 | **V = 0.1217 A^1.4129** (re-plot of Huggel data, n = 15) | Cook & Quincey 2015, Earth Surf. Dynam. 3:559–575, doi:10.5194/esurf-3-559-2015, Table 1 | [V] |
| 5 | **V = 0.1697 A^1.3778** (D–A compilation excluding duplicates + Huggel, n = 45) | Cook & Quincey 2015, Table 1 | [V] |
| 6 | V[10⁶ m³] = 1×10⁻⁷ A^1.434 ⇒ **V = 0.1 A^1.434** (direct V–A, n = 55, r² ≈ 0.96, A 6,120 m²–19.5 km²) | Cook & Quincey 2015, Table 2 | [V] |
| 7 | V[10⁶ m³] = 3×10⁻⁷ A^1.239 ⇒ **V = 0.3 A^1.239** — *growing supraglacial lakes* (few points, r² 0.99) | Cook & Quincey 2015, §4 | [V] |
| 8 | V[10⁶ m³] = 43.24 A[km²]^1.5307 | Sakai 2012, Global Environ. Res. 16:23–30, doi:10.57466/ger.16.1_23 (Himalayan moraine lakes) | [V] via Khadka et al. 2026 Table S1 |
| 9 | V = 0.0578 A^1.4683 | Khanal et al. 2015, Mt. Res. Dev. 35:351–364 (Poiqu/Bhote Koshi) | [V] via Khadka et al. 2026 |
| 10 | V = A·D̄, D̄ = 0.087 A^0.434 | Wang X. et al. 2012, NHESS 12:3109–3122, doi:10.5194/nhess-12-3109-2012 | [V] via Khadka et al. 2026 |
| 11 | V = 0.036 A^1.49 | Kapitsa et al. 2017, NHESS 17:1837–1856, doi:10.5194/nhess-17-1837-2017 | [V] via Khadka et al. 2026 |
| 12 | V[10⁶] = 42.95 A[km²]^1.408 | Zhang G. et al. 2023, Nat. Geosci., doi:10.1038/s41561-023-01150-1 (greater Himalaya) | [V] via Khadka et al. 2026 |
| 13 | V[10⁶] = 48.58 A[km²]^1.59 (proglacial); 44.47 A[km²]^1.5 (periglacial) | Zhang T., Wang W., An B. 2023, The Cryosphere 17:5137–5154, doi:10.5194/tc-17-5137-2023 | [V] via Khadka et al. 2026 |
| 14 | Bayesian hierarchical V–A by dam type, fitted to > 300 surveyed lakes; per-lake posterior median + 68 % HDI for every lake on Earth | Veh et al. 2025, *Nature Water* — data: Zenodo doi:10.5281/zenodo.17896427 (CC BY 4.0), code github.com/geveh/LakeVolumes | [V] (record read) |
| — | Muñoz et al. 2020, ESPL 45:1510–1527, doi:10.1002/esp.4826 — 121 Cordillera Blanca bathymetries; **coefficients not retrievable this session** (paywalled). Their main finding (as reported by citing work) is that A–D/A–V scatter is large and lake-type specific. | | [S] |

Khadka et al. 2026 = "The 2024 cascading glacial lake outburst flood in the Thame Valley of Everest region, Nepal",
NHESS 26:4131–4152, doi:10.5194/nhess-26-4131-2026; their supplement Table S1 applies nine of these to one event.

### A.2 How wrong are they? (test this research ran, [C])

| Lake (measured) | Huggel02 | C&Q #6 | Sakai12 | C&Q supraglacial #7 | O'Connor01 |
|---|---|---|---|---|---|
| Tsho Rolpa, A = 1.537 km², **V = 85.94 Mm³** (ICIMOD bathymetry, via Wikipedia) | 63.4 (−26 %) | 74.4 (−13 %) | 83.5 (−3 %) | 13.9 (−84 %) | 403 (+369 %) |
| Purepu 2025 supraglacial, A = 0.68 km², **V = 9.09 Mm³** (Zhang T.-G. et al. 2026, ACCR, doi:10.1016/j.accre.2026.06.022) | 19.9 (+119 %) | 23.1 (+154 %) | 24.0 (+164 %) | **5.05 (−44 %)** | 80 (+780 %) |
| Lejiacocha, A = 0.184 km², **V = 1.356 Mm³** (Muñoz 2020 via citing paper) | 3.11 (+129 %) | 3.54 (+161 %) | 3.24 (+139 %) | 1.0 (−26 %) | 6.3 |

Also [V]: Khadka et al. 2026 found the empirical mean of nine relations within −3 % for the lower (moraine) Thame
lake but −64 % for the upper lake; Das & Ramsankaran 2025 report ±36–1736 % discrepancies on four Himalayan lakes [S].
Cook & Quincey 2015: for a given area, mean depth (and hence V) varies by up to an order of magnitude; D–A r² = 0.38.

### A.3 Recommendation for Deluge

* `volumeFromArea(A, damType)` returns `{median, lo, hi}`:
  * moraine / bedrock / ice-dammed: median = geometric mean of {#1, #6, #8}; band = ×/÷ 2 (covers the 68 % spread seen above).
  * supraglacial / growing: median = #7; band ×/÷ 2.5.
  * If a Veh et al. 2025 per-lake value exists (bake-time join on lake centroid), use it and its HDI instead.
  * If a bathymetric volume exists (Tsho Rolpa, Imja, South Lhonak, Thulagi…), use it and set band ±10 %.
* Show the band on screen; feed lo/median/hi into the ensemble (I.5).
* "Drained volume" ≠ lake volume: default drained fraction = 1 − (final breach base depth / mean depth); simplest
  default: drain to breach base computed by the breach model (B.3), which returns the drained volume itself.

---------------------------------------------------------------------------------------------------------------------

## B. Breach / outburst hydrograph Q(t)

### B.1 Empirical peak-discharge relations (Qp in m³/s; V released volume; H or Bd breach/lake-level drop in m)

All rows marked [V]* were checked numerically: they reproduce, to the m³/s, the values in Khadka et al. 2026
Table S2 for the Thame lower lake (V = 3.6×10⁵ m³, Bd = 12 m) — so units and coefficients below are correct.

| Relation | Units | Source | Tag |
|---|---|---|---|
| Qp = 0.72 V^0.53 | V m³ | Evans 1986 | [V]* (634 m³/s for Thame lower) |
| Qp = 0.0048 V^0.896 | V m³ | Popov 1991 (N. Tien Shan moraine lakes) | [V]* (457) |
| Qp = 1.122 V^0.57 | V m³ | Costa 1985, USGS OFR 85-560 | [V]* (1,648) |
| Qp = 0.981 (V·H)^0.42 | V m³, H m | Costa 1985 | [V]* (601) |
| Qp = 0.607 V^0.295 H^1.24 | V m³, H m | Froehlich 1995, J. Water Resour. Plann. Manage. 121:90–97 | [V]* (576) |
| Qp = 142 Bd^0.766 V^0.378 | V **Mm³**, Bd m | Froehlich 2025, Nat. Hazards Rev. 26:04025047, doi:10.1061/NHREFO.NHENG-2492 — *fitted to moraine-dammed glacial lakes* | [V]* (648) |
| Qp = 136 (Bd·V)^0.73 | V Mm³ | listed in Khadka 2026 Table S2 (column alignment ambiguous; likely Costa & Schuster 1988, GSA Bull. 100:1054–1068) | [V]* value (396), attribution [S] |
| Qp = 0.0163 V^0.64 | V m³ | "glacial dam failures" — Rickenmann 1999 Table II (compilation) | [V] |
| Qp = 0.293 V^0.56 | V m³ | "landslide dam failures" — Rickenmann 1999 | [V] |
| Qp = 75 V^0.67 | V 10⁶ m³ | Clague & Mathews 1973, J. Glaciol. 12:501–504 (ice-dammed, jökulhlaup) | [M] |
| Qp = 46 V^0.66 | V 10⁶ m³ | Walder & Costa 1996 (ice-dammed, tunnel drainage) | [M] |
| Qp = 2V/t, t = 1000 s (worst case, moraine) | | Huggel et al. 2002 (after Haeberli 1983) | [M] |
| Breach time Tb = 0.00254 V^0.53 Bd^−0.9 | **hours**, V m³ | Froehlich 1995b | [V]* (0.239 h = 860 s) |
| Tb = V^0.622 / (71 Bd^0.766) × 10⁶ | s, V Mm³ | Froehlich 2025 | [V]* (1,112 s) |

Breach geometry (embankment dams; use for moraine dams with caution):
* Froehlich 2008, J. Hydraul. Eng. 134(12):1708–1721, doi:10.1061/(ASCE)0733-9429(2008)134:12(1708):
  B_avg = 0.27 K₀ V^0.32 H_b^0.04, K₀ = 1.3 overtopping / 1.0 piping; side slope 1H:1V overtopping, 0.7H:1V piping
  [V for the B form and side slopes; K₀ values and t_f = 63.2 √(V/(g H_b²)) s are M].
* Froehlich 2016 (River Flow 2016 update): B_avg ≈ 0.23 k_M V^(1/3), k_M = 1.5 overtopping [M — verify].

Spread is the point: for the same Thame lake the nine relations give 182–1,648 m³/s (×9); the observed/modelled
peak at the outlet was 912 m³/s (Khadka et al. 2026, r.avaflow scenario A) [V].

### B.2 Walder & O'Connor (1997) — the physical framing

Walder J.S., O'Connor J.E. 1997, "Methods for predicting peak discharge of floods caused by failure of natural and
constructed earthen dams", Water Resour. Res. 33(10):2337–2348, doi:10.1029/97WR01616 [V abstract]:
hydrograph governed by **η = k V₀ / (g^½ d^{7/2})**, k = mean breach downcutting rate (m/s), d = lake-level drop;
Q*p = Qp/(g^½ d^{5/2}). Two asymptotes: η ≫ 1 (large lake / fast erosion → Qp set by final breach geometry, lake
level barely drops), η ≪ 1 (small lake / slow erosion → Qp set by erosion rate). The commonly quoted η ≪ 1 form
Qp ≈ 1.51 (g^½ d^{5/2})^0.06 (k V₀)^0.94 and the k range 10–100 m/h for moraine dams are **[M — not re-verified]**;
the ODE below reproduces that behaviour without needing the asymptote constants.

### B.3 Default model: weir flow + linear downcutting ODE (implement this)

State: lake volume V(t). Lake geometry: V(s) = V₀ (s/d)^p, s = water level above final breach base,
p ∈ [1, 2] (1 = vertical walls; 1.5 default; derive p from the DEM/lake hypsometry when the lake is in a baked tile).

Breach: bottom height above base z_b(t) = max(0, z_b0 − k·t), crest at d (z_b0 = d − 0.5 m: a 0.5 m overtopping head
starts the run); bottom width b(t) = max(b₀, r·(d − z_b)); side slope m (H:V).

Outflow (broad-crested trapezoidal weir, SI; coefficients as in Fread's NWS-BREACH/DAMBRK) [M for coefficients]:

```
H  = max(0, s − z_b)
Q  = 1.7·b·H^1.5 + 1.35·m·H^2.5           (m³/s)
dV/dt = Q_in − Q                           (Q_in: inflow to the lake, usually ≪ Q; include for avalanche-dam lakes)
s = d·(V/V₀)^(1/p)
```

Integrate with RK2/Heun at dt = 1 s (stable: Q·dt ≪ V for all cases below) until V < 10⁻⁴ V₀ or t > 12 h.

Defaults: k = 30 m/h (ensemble 10 / 30 / 100), r = 2 (B/H; Froehlich's B_avg gives ~3 for Dig Tsho), m = 1, p = 1.5,
b₀ = 1 m. Ice-cored or freshly deposited avalanche dams: k = 100–300 m/h. Bedrock-dammed lakes: no erosion
(k = 0) — outflow is then overtopping only (displacement wave, C.2).

Behaviour of this model ([C], `docs/research/breach-check.mjs`):

| Case | V₀ (m³) | d (m) | k = 10 m/h | k = 30 m/h | k = 100 m/h | Observed / published |
|---|---|---|---|---|---|---|
| Thame lower lake 2024 | 3.6e5 | 12 | 128 m³/s, tp 36 min | 360, 18 min | **1,043, 7 min** | 912 m³/s at ~13 min (r.avaflow, Khadka 2026) |
| Gongbatongsha 2016 | 1.2e5 | 9 | 57 | 161 | 476 | 618 obs / 620 modelled, peak at 30 s, emptied in 6 min (Sattar 2022) |
| Dig Tsho 1985 | 5e6 | 18 (assumed) | 1,102 | **2,893** | 4,968 | 2,350 at 7.1 km (Cenderelli & Wohl 2001) |
| South Lhonak 2023 | 5e7 | 40 (assumed) | 5,121 | **14,204** | 31,192 | 7,355 (HEC-RAS) – 14,673 at Chungthang (modelled, various) |
| Tsho Rolpa (what-if) | 8.6e7 | 30 (assumed) | 10,075 | 17,117 | 21,225 | 7,759–90,296 from empirical eqs (IJECE 5(2):123, 2012) [S] |

Reading: small lakes triggered by a surge (Thame, Gongbatongsha) need k ≈ 100 m/h or more — they are effectively
"instant"; large moraine lakes sit near k ≈ 30 m/h. Use k = 30 m/h default, k = 100 m/h for trigger-driven
(displacement wave / debris inflow) failures.

### B.4 Parametric fallback (when only Qp and V are known, e.g. from a published reconstruction)

Gamma-shaped hydrograph (smooth, single peak, exact volume):

```
Q(t) = Qp · (t/tp)^a · exp(a·(1 − t/tp)),       ∫Q dt = Qp·tp·e^a·Γ(a+1)/a^(a+1)
a = 3  ⇒  V = 1.488·Qp·tp   ⇒  tp = V / (1.488·Qp)
(a = 2: 1.847;  a = 4: 1.280;  a = 6: 1.038)  [C]
```

Triangular alternative: base T = 2V/Qp, tp = T/4 to T/3 (steep rise). Always pass `V` and enforce Σ Q·Δt = V
after resampling to the forcing table (mirror the `stopAfter` exactness logic in `src/sim/forcing.ts`).

---------------------------------------------------------------------------------------------------------------------

## C. Mass movements: into lakes, into rivers, and debris flows

### C.1 Runout of the avalanche itself (does it reach the lake/river?)

* Scheidegger 1973 rock avalanches: log₁₀(H/L) = −0.15666 log₁₀V + 0.62419 (V m³) [M]. Gives H/L ≈ 0.29 at
  27 Mm³ and ≈ 0.24 at 100 Mm³.
* Observed ice-rich events are far more mobile: Chamoli 2021 **H/L = 0.16** to Tapovan, ~3,700 m drop
  (Shugar et al. 2021, Science 373:300–306, doi:10.1126/science.abh4455) [V].
* Ice avalanches: Alean 1985 (J. Glaciol. 31:324–333) — runout angle depends on volume; most events 10⁴–10⁶ m³ [S];
  the often-quoted minimum average slope ≈ 17° (H/L ≈ 0.31) for small ice avalanches is [M].
* Debris flows: Rickenmann 1999 (Nat. Hazards 19:47–77, doi:10.1023/A:1008064220727) [V]:
  L = 1.9 M^0.16 H_e^0.83 (total travel distance, m; M m³, H_e m) and L = 30 (M·H_e)^0.25; fan runout L_f = 15 M^(1/3).
* GLOF-induced debris flows stop where the **average slope from source reaches 11°** (H/L ≈ 0.19): Huggel et al. 2003,
  NHESS 3:647–662 (applied in their GIS model) [V]. Hyperconcentrated/water floods continue far beyond.
* Implementation: H/L test along the D8 thalweg in the bake/worker; it only decides "reaches lake/river: yes/no";
  everything downstream of the impact is hydraulics (C.2/C.3/E).

### C.2 Mass movement into a lake → displacement wave → overtopping

Heller & Hager 2010 (J. Waterway Port Coastal Ocean Eng. 136(3):145–155) impulse product parameter [V for P]:

```
F = v_s/√(g h)   S = s/h   M = m_s/(ρ_w b h²)      (v_s slide impact velocity, s slide thickness, m_s slide mass,
P = F · S^½ · M^¼ · {cos[(6/7)α]}^½                  b slide width, h still-water depth, α slide impact angle)
a_M/h = (4/9) P^(4/5)        H_M/h = (5/9) P^(4/5)          (max amplitude / height, near field)        [V]
a(x)/h = (3/5) [P·X^(−1/3)]^(4/5),  H(x)/h = (3/4)[P·X^(−1/3)]^(4/5),  X = x/h  (decay)                   [V]
```

[V] since Oct 2026 against Evers et al. 2019 (SFOE manual, 2nd ed. v2.1, eqs. 3.13–3.19). These are the FLUME (2-D)
equations; a lake spreads the wave (manual §4.2.1, Ruffini et al. 2019), and the dam is overtopped by the crest
amplitude a, not the height H — see §G.9 for what the engine does with that.

Impact velocity from energy line: v_s ≈ √(2 g (H_fall − μ_eff L_path)), μ_eff ≈ H/L from C.1, cap at 60 m/s.

Use in Deluge: wave height at the dam H(x_dam) vs freeboard f:
* H < f → no overtopping; trigger fails (show "lake survived" — a valid outcome).
* H ≥ f → overtopping volume V_ot ≈ (H − f)·A_lake·c_ot with c_ot ≈ 0.3 [heuristic, flag], released as a short
  pulse (Q = V_ot / 60 s), AND start the B.3 breach with z_b0 = d − (H − f) and k = 100 m/h (erosive surge).
* Validation anchor: South Lhonak 3 Oct 2023: 14.7 Mm³ frozen moraine failed into the lake at 22:13:20 IST,
  displacement wave ≈ 20 m, ~50 Mm³ (≈ half the lake) released (Sattar et al. 2025, Science, doi:10.1126/science.ads2659,
  via Newcastle Univ. press release and Petley/Eos) [S].
* If the lake is inside the 2-D domain (rare, but true for Thame-type small domains), skip the empirics: inject the
  slide as a moving mass+momentum source and let the GPU make the wave.

### C.3 Mass movement into a river → avalanche-dam outburst (the 2026 Lhende mechanism) or direct debris flow

Two branches, selectable per scenario:
1. **Transient dam** (Lhende 2026, Sedongpu 2018, Rishiganga lake 2021): deposit V_d in channel → dam height from
   valley section, H_d = solve( V_d = ∫ A_section(H) over deposit length L_d ), L_d default 1–2 km → impoundment fills
   at river baseflow Q_b (monsoon 100–300 m³/s) → overtop → B.3 breach with k = 100–300 m/h (ice-rich, uncompacted).
   For Lhende 2026: impoundment duration is disputed — "a few minutes" (YAE/KU rapid report) vs 18–19 h (IRDR
   hypothesis) [S]; default "minutes" (flood reached Rasuwagadhi ~3 min after the 08:37 seismic signal).
2. **Direct transformation** (Chamoli): the avalanche itself becomes a debris flow; water = melted ice + entrained
   water. Chamoli: ~26.9 Mm³ (95 % CI 26.5–27.3) detached, ~80 % rock / 20 % ice, ~5–6 Mm³ ice almost entirely melted
   by frictional heating; peak 8,200–14,200 m³/s at Raini, 10–20 min duration (Shugar 2021) [V].
   Hydrograph: Q_p from Rickenmann (C.4) with M = mobile volume, duration from V/Q_p shape (B.4, a = 3).

### C.4 Debris-flow peak discharge and velocity (Rickenmann 1999, [V])

| Relation | Notes |
|---|---|
| **Qp = 0.1 M^(5/6) = 0.1 M^0.833** | M = total debris-flow volume (m³), granular alpine debris flows; upper envelope character |
| Qp = 0.135 M^0.780 | granular, Japan (Mizuyama et al. 1992) |
| Qp = 0.0188 M^0.790 | muddy, Japan (Jitousono et al. 1996) |
| V = 2.1 Q^0.33 S^0.33 | mean velocity from discharge and slope |
| V = (1/n) H^(2/3) S^(1/2), **n ≈ 0.1 s/m^(1/3)** debris flows, 0.067 clear-water torrents | Manning-Strickler form |

### C.5 Bulking

* Volume/discharge bulking at volumetric concentration Cv: **Q_bulked = Q_w / (1 − Cv)**, V_total = V_w / (1 − Cv);
  ρ_m = ρ_w (1 − Cv) + ρ_s Cv, ρ_s = 2,650 kg/m³ [standard].
* Flow-type thresholds by Cv (FLO-2D / O'Brien convention [M]): water flood < 0.20; mud flood 0.20–0.45;
  mudflow 0.45–0.55; landslide > 0.55. (Costa 1988 by weight: water flood < 40 %, hyperconcentrated 40–70 %,
  debris flow > 70 % [M].)
* Physically based equilibrium concentration for erosion/deposition along the route (Takahashi 1978, J. Hydraul.
  Div. 104:1153–1169) [M]:
  `C∞(θ) = ρ_w tanθ / ((ρ_s − ρ_w)(tanφ − tanθ))`, φ ≈ 35°, capped at 0.9·C* (C* ≈ 0.65).
  → C∞ ≈ 0.20 at 10°, 0.38 at 15°, cap at ≥ 19° [C]. Below ~3–4° → ~0 (deposits out).
* Real bulking can far exceed what Cv implies, because entrained material is saturated and the river adds water:
  Gongbatongsha 2016 — 1.2×10⁵ m³ released, ~8.3×10⁶ m³ entrained (≈ 70×), peak rising from ~620 m³/s at the lake to
  ~4,123 m³/s at 6.5 km, then 1,611 m³/s at the Upper Bhote Koshi dam (23 km) (Sattar et al. 2022, Sci. Rep. 12:12421,
  doi:10.1038/s41598-022-16337-6) [V]. Chamoli: ~8 Mm³ deposited near the Ronti–Rishiganga confluence (Shugar 2021) [V].
  → Expose a "bulking ×" knob separate from Cv for the routing stage (default 1; Gongbatongsha-type 3–7 on the
  steep first reach).

---------------------------------------------------------------------------------------------------------------------

## D. Debris-flow rheology in Deluge's local-inertial momentum update

### D.1 Friction laws (S_f is the friction slope; the momentum equation for unit discharge q = u·h carries −g·h·S_f)

| Law | S_f | −g·h·S_f in terms of q (what goes in the shader) |
|---|---|---|
| Manning (now) | n² u\|u\| / h^{4/3} | −g n² q\|q\| / h^{7/3} |
| **Voellmy** (RAMMS) | μ cosθ + u\|u\|/(ξ h) | −μ g h cosθ · sgn(q) − (g/ξ) q\|q\| / h² |
| **O'Brien–Julien quadratic** (FLO-2D) | τ_y/(γ_m h) + K η u/(8 γ_m h²) + n_td² u\|u\|/h^{4/3} | −(τ_y/ρ_m) sgn(q) − (K η/(8 ρ_m)) q/h² − g n_td² q\|q\|/h^{7/3} |
| **Bingham** (laminar, sheet approx.) | (1.5 τ_y + 3 μ_B u/h)/(γ_m h) | −(1.5 τ_y/ρ_m) sgn(q) − (3 μ_B/ρ_m) q/h² |

Sources: O'Brien, Julien & Fullerton 1993, J. Hydraul. Eng. 119(2):244–261 — eqs. (6)–(9) S_f = S_y + S_v + S_td,
S_v = Kη V/(8 γ_m h²), S_td = n² V²/h^{4/3} [V]; K = 24 for smooth wide laminar channels, "increases with roughness"
[V]; FLO-2D default K = 2,285 when unknown [M]. Dispersive Manning: **n_td = n_t (1 + 0.0538 e^{6.0896 Cv})** [V]
(Lin, Wang & Huang 2005, NHESS 5:439–445, eq. 7). Note: with K = 24 the O'Brien viscous term equals the Bingham
3μu/h term — one shader path covers both.

Yield stress and viscosity vs Cv (O'Brien & Julien 1988, J. Hydraul. Eng. 114(8):877–887; table reproduced in
Lin et al. 2005 Table 1 [V]): τ_y = α₂ e^{β₂ Cv} (dyn/cm² = 0.1 Pa), η = α₁ e^{β₁ Cv} (poise = 0.1 Pa·s).

| Material | α₂ | β₂ | α₁ | β₁ |
|---|---|---|---|---|
| Aspen Pit 1 | 0.181 | 25.7 | 0.0360 | 22.1 |
| Aspen Pit 4 | 2.72 | 10.4 | 0.0538 | 14.5 |
| Aspen Natural Soil | 0.152 | 18.7 | 0.00136 | 28.4 |
| Aspen Mine Fill | 0.0473 | 21.1 | 0.128 | 12.0 |
| Aspen Watershed | 0.0383 | 19.6 | 0.000495 | 27.1 |
| Aspen Mine Source | 0.291 | 14.3 | 0.000201 | 33.1 |
| Glenwood 1 | 0.0345 | 20.1 | 0.00283 | 23.0 |
| Glenwood 2 | 0.0765 | 16.9 | 0.0648 | 6.20 |
| Glenwood 3 | 0.000707 | 29.8 | 0.00632 | 19.9 |
| Glenwood 4 | 0.00172 | 29.5 | 0.000602 | 33.1 |

(Row/column pairing reconstructed from a mangled PDF table; the β₁ column order and the α/β pairs match the
widely reproduced FLO-2D manual table — treat as [S]; spot-check against the FLO-2D Data Input Manual.)

What these give ([C]; ρ_m from Cv; S_y at h = 2 m):

| | Cv 0.3 | Cv 0.4 | Cv 0.5 |
|---|---|---|---|
| Aspen Pit 1 (stiff) | τ_y 40 Pa, η 2.7 Pa·s | 528 Pa, 25 Pa·s, S_y 0.016 | 6.9 kPa, 227 Pa·s, **S_y 0.19 (stops below ~11°)** |
| Glenwood 1 (fluid) | 1.4 Pa, 0.28 Pa·s | 11 Pa, 2.8 Pa·s | 80 Pa, 28 Pa·s, S_y 0.002 |

→ Rheology only changes Deluge's answer materially for Cv ≥ 0.4 with a stiff material. For GLOFs/debris *floods*
(Cv 0.1–0.35) the dominant effect is the dispersive Manning n_td and the density of the mixture, not yield.

Voellmy parameters (RAMMS::DEBRISFLOW) — no universal default; calibrated ranges [S/V]:
* Review range μ ≈ 0.05–0.45, ξ ≈ 15–1,000 m/s² (Cesca & D'Agostino 2008 Dolomites: μ 0.18–0.45) [S].
* GLOF routing (Gongbatongsha): **μ = 0.08, ξ = 500 m/s²**, ρ = 1,550 kg/m³; trigger debris flow μ 0.2, ξ 500
  (Sattar 2022) [V]. Himalayan debris flows: μ 0.10 / ξ 400; μ 0.01 / ξ 100 [S].
* Recommended Deluge presets: "debris flood" μ = 0.05, ξ = 500; "debris flow" μ = 0.15, ξ = 300; "stiff" μ = 0.25, ξ = 200.
* Cross-check with Manning: the ξ-term equals Manning when ξ = h^{1/3}/n² → n = 0.05 ≙ ξ ≈ 400–680 for h = 1–5 m;
  n = 0.1 ≙ ξ ≈ 100–170 [C]. So "Voellmy with μ = 0" ≈ Manning with a depth-independent roughness — a good sanity test.

### D.2 Semi-implicit treatment in `momentum()` (concrete)

Current code (robust branch):
`q = (qt − dtm·adv − g·hf·dtm·slope) / (1 + g·dtm·n²·|q|/hf^{7/3})`, then cap.

Proposed (all new uniforms are per-scenario constants; `cosθ` from the face bed slope):

```wgsl
// 1. explicit predictor without resistance
let qStar = qt - dtm*adv - sim.g*hf*dtm*slope;
// 2. velocity-dependent resistance -> implicit denominator (always >= 1, unconditionally damping)
let lin  = sim.viscK / (hf*hf);                 // viscK = K*eta/(8*rho_m) or 3*muB/rho_m  [m²/s]; lin [1/s]
let quad = (sim.g*sim.n2eff/hf73 + sim.gOverXi/(hf*hf)) * qmag;   // n2eff = n_td²; gOverXi = g/ξ (0 if unused)
let denom = 1.0 + dtm*(lin + quad);
// 3. rate-independent resistance (yield / Coulomb): magnitude per unit width
let tauStop = dtm * (sim.tauYoverRho + sim.muC*sim.g*hf*cosTheta);   // tauYoverRho = c_y*τy/ρ_m (c_y = 1 O'Brien, 1.5 Bingham)
let qsMag = sqrt(qStar*qStar + qPerp*qPerp);                        // vector magnitude, same qPerp as Manning uses
var q = 0.0;
if (qsMag > tauStop) { q = qStar * (1.0 - tauStop/qsMag); }          // "stop-or-reduce" projection, never reverses flow
q = q / denom;
```

Properties: (i) dividing by denom ≥ 1 can only slow water (same guarantee as today); (ii) the yield/Coulomb step is
the standard projection for plastic friction — it can bring a face to exact rest and never overshoots through zero,
for any dt (needed: an explicit sgn(q) term chatters); (iii) at rest, a deposit with surface slope g·h·|∂η/∂x| <
τ_y/ρ_m stays put → deposition emerges. Apply on the face as is done for Manning (qPerp already available).

Notes:
* Hydrostatic pressure term g·h·∂η is density-independent for uniform Cv — no change needed. With a spatially
  varying Cv tracer, the baroclinic term (h²/2)∇ρ/ρ is neglected [flag].
* The 8·√(g h) Froude cap stays; raise `uMax` per scenario (`ScenarioPreset.solver.uMax`, default 15, debris
  presets 25 m/s) — observed fronts: Chamoli 25 m/s near Raini, 16 m/s before Tapovan, 12 m/s after (Shugar 2021) [V];
  Rasuwagadhi→Betrawati 56 km in ~40 min ≈ 23 m/s (ICIMOD compiled page) [S]; Thame ~10 m/s at the village (Khadka 2026) [V].
  Check the CFL/timestep logic (§3.6 of ARCHITECTURE) uses the same uMax.
* Thin films: keep the hMin wet threshold; add `if (hf < hRheo) use Manning only` with hRheo = 0.05 m to avoid
  the 1/h² viscous term dominating spray fronts.

### D.3 Uniform Cv vs. tracer

* **v1: uniform Cv per scenario** (from the routing stage's Cv at the boundary, time-averaged over the peak).
  Acceptable because (a) 8–16 km domains are short relative to the bulking/debulking length scales, (b) the
  rheological coefficients are themselves uncertain ×10, (c) zero new textures.
* **v2: passive tracer c = Cv·h** (one `r32float` texture pair, ~+25 % bandwidth in continuity): advected with the
  same donor-limited fluxes in `continuity.ts` (c_new = c + dt/dx·Σ(F·Cv_donor)) — conservative, positivity
  preserved by the existing k-limiter. Inflow carries Cv(t) from routing; mixing with clear tributary water then
  dilutes naturally (useful at Betrawati: Phalakhu/Salankhu confluences). Per-face Cv = donor Cv for the rheology.
* v3 (not recommended now): erosion/deposition exchange with the bed (moves `z`, interacts with walls/levee code).

---------------------------------------------------------------------------------------------------------------------

## E. Downstream routing over 10–100 km

### E.1 Observed celerities and attenuation (validation targets)

| Event | Reach | Observation | Implied speed | Tag |
|---|---|---|---|---|
| Lhende/Bhote Koshi 26 Aug 2026 | source → Rasuwagadhi (~20 km) | avalanche ~08:37 (seismic), flood at Rasuwagadhi ~08:40 | "tens of m/s"; one estimate 190 km/h over first 22 km — implausible, treat as order-of-magnitude | [S] |
| same | Syafrubesi gauge | stopped transmitting 08:50, last stage 1.62 m | — | [V] NDRRMA SitRep 1 |
| same | Rasuwagadhi → Betrawati (56 km) | 08:40 → 09:20 | ≈ 23 m/s (84 km/h) | [S] |
| same | Betrawati → Galchhi → Malekhu → Mugling → Devghat | 09:20 → 10:28 → 11:50 → 13:00 → 15:20 (peak Devghat 16:00, 5,850 m³/s, stage 6.57 m; total 57.40 Mm³ of which 19.96 Mm³ excess) | ~4–10 m/s in the wider Trishuli; "4–6 m/s" quoted | [V] NDRRMA SitRep 1 (01 Sep 2026) |
| same | Galchhi / Malekhu stage | +9 m in ~30 min / +7 m | — | [V] YAE/KU rapid report |
| Chamoli 2021 | Raini (15 km from source) → Joshimath (+16 km) | front 25 m/s at Raini; 16 m/s before Tapovan; 12 m/s below; mean ≈ 10 m/s Raini→Joshimath | 36–90 km/h | [V] Shugar 2021 |
| Chamoli 2021 (seismic) | release 04:51:10 UTC → Ronti Gad–Rishiganga confluence → Rishiganga HEP → Tapovan → Joshimath bridge | 04:54 / 04:57 / 05:07 (2nd wave 05:12) / 10:58:33 IST = 3 / 6 / 16 / 37.5 min | ~55 m/s to the confluence, ~27 m/s to Raini, ~13 m/s to Tapovan | [V] Tiwari et al. 2022, Sci. Rep. 12:3733; Joshimath [S] Cook et al. 2021 via GFZ |
| Chamoli 2021 | Raini → below Tapovan (~11 km) | 8,200–14,200 → 2,900–4,900 m³/s | peak ÷ ~3 in 11 km (incl. Tapovan reservoir) | [V] |
| Gongbatongsha 2016 | lake → confluence (6.5 km) → UBK dam (23 km) | arrival at confluence ~20 min, peak ~47 min; 620 → 4,123 → 1,611 m³/s | mean ~5.5 m/s (seismic ~5 m/s), debris-flow front 20–25 m/s before confluence | [V] Sattar 2022 |
| Thame 2024 | upper lake → Thame village (~9 km) | onset ~13:00, Thame ~13:30 LT (20–25 min); modelled 1,300 s; 912 → 574 m³/s | ~6–7 m/s; ~10 m/s at village | [V] Khadka 2026 |
| South Lhonak 2023 | lake → Chungthang/Teesta-III (62–68 km) | moraine failure 22:12–22:13 IST; Chungthang reported ≈ 00:35 (≈ 2 h 22 min; 00:30 is the paper’s HEC-RAS result) | ≈ 8 m/s (29 km/h) | [V] Sattar 2025 accepted manuscript (§G.9) |
| Dig Tsho 1985 | 7.1 km → 27 km | 2,350 → 1,375 m³/s (−41 % over 20 km) | — | [S] Cenderelli & Wohl 2001, Geomorphology 40:57–90, doi:10.1016/S0169-555X(01)00037-X |
| Nare 1977 | 8.6 km | 1,900 m³/s | — | [S] same |
| Imja (modelled, 2007) | 45 km | attenuates to ~2,000 m³/s at buffer-zone edge | — | [S] Bajracharya et al. 2007, MRD 27(4) |

Rules of thumb for the UI copy (flag as ranges, not predictions): GLOF/debris-flood fronts travel 5–25 m/s
(20–90 km/h) in Himalayan gorges, slower (4–8 m/s) in wide valleys and reservoirs; peaks drop by ~30–70 % in
the first 20–30 km unless bulking dominates (then they *grow* first, as at Gongbatongsha). An exponential fit
Q(x) = Q₀ e^{−x/λ} gives λ ≈ 37 km (Dig Tsho) and ≈ 10 km (Chamoli incl. a reservoir) [C].

### E.2 Recommended solver for the 1-D stage

**Primary: 1-D local-inertial on a DEM-derived thalweg (same physics family as the 2-D solver).** Muskingum–Cunge is
diffusion-wave based and cannot represent the bore-like rising limb of a breach wave nor storage in reservoirs;
kinematic wave has no attenuation at all except through the prismatic storage. The 1-D local-inertial with Δx =
100 m and adaptive dt (CFL 0.7) for 100 km = 1,000 nodes × ~7,000 steps ≈ 7M updates ≈ 10–30 ms in JS [estimate].

```
A_i(s_i)  wetted area from the stage–area table of node i (baked)
Q_{i+½}^{n+1} = [Q − g·A_f·dt·(η_{i+1} − η_i)/Δx − dt·adv] / [1 + dt·g·n_eff²·|Q|/(A_f·R_f^{4/3})]
              (+ the same rheology split as D.2, with h → R = A/P)
A_i^{n+1} = A_i^n + dt/Δx·(Q_{i−½} − Q_{i+½}) + q_lat·dt      (tributary baseflow as q_lat, optional)
```

Cross-sections: at every node, a perpendicular transect ±600 m sampled from Copernicus GLO-30, converted to
stage–width–area–perimeter tables (0–60 m above thalweg, 0.5 m steps). Manning n: 0.05 (bouldery mountain river,
clear water), × (1 + 0.0538 e^{6.0896 Cv}) for debris (D.1); optionally, per preset, Ferguson's (2007) variable-power
law on the bed's D84 instead of a constant n (§G.9, second pass — Nepal and Chamoli use it). DEM pits along the thalweg: carve monotone (the bake
already burns rivers). Reservoirs/barrages (Tapovan, Teesta-III, Trishuli-3A…): add as weir nodes with storage
(crest elevation + spillway width) — they matter (Tapovan slowed Chamoli from 16 to 12 m/s).

**Fallback: variable-parameter Muskingum–Cunge** (Ponce & Yevjevich 1978, J. Hydraul. Div. 104(12):1663–1667 [M]),
useful for long low-gradient tails (Mugling → Devghat):

```
c = (5/3)·v  (wide channel)      K = Δx/c      X = ½·(1 − Q/(B·S₀·c·Δx))
D = Δt + 2K(1−X):  C0 = (Δt − 2KX)/D   C1 = (Δt + 2KX)/D   C2 = (2K(1−X) − Δt)/D
O_{j+1} = C0·I_{j+1} + C1·I_j + C2·O_j       (recompute c, X each step from the current Q)
```

**Sediment along the route**: carry Cv per node, relaxed toward C∞(θ_local) (C.5) over a length L_r = 1 km:
dCv/dx = (C∞ − Cv)/L_r (upwind in space, one sweep per step). Water volume is conserved; the bulked volume and
Q follow 1/(1−Cv). Plus the optional "bulking ×" knob on the first steep reach.

**Outputs to the 2-D stage and UI**: Q(t) and Cv(t) at the domain-edge node; at named stations (gauges,
towns, dams): front arrival (first Q > Q_base + 10 %), peak time, peak Q, max stage. "Lead time" for a location =
t_arrival(location) − (t_detect + t_alert), with t_detect at a chosen sensor node (e.g. DHM Syafrubesi gauge,
a Raini-type sensor) and t_alert a latency (2026: SMS 09:15 vs flood start 08:40; Bhutan sirens fire within
15 min of detection [S]; Shugar 2021 estimated 6–10 min of possible warning at Tapovan, up to 20 min with a
source-area sensor [V]).

---------------------------------------------------------------------------------------------------------------------

## F. Glacier melt under heatwaves / climate scenarios

### F.1 Degree-day model

```
T(z, t)  = T_ref(t) + Γ·(z − z_ref) + ΔT_scenario
M_k(t)   = DDF_k · max(0, T(z_k, t))                (mm w.e. d⁻¹ per elevation band k)
ΔQ(t)    = Σ_k (M_k(t) − M_k,clim(t)) · A_k / (1000·86,400)     (m³/s of EXTRA runoff vs climatology)
```

Bands: 50 m elevation bands from DEM × RGI 7.0 glacier mask; surface class per band: snow (above the transient
snowline), clean ice, debris-covered ice.

Parameters:

| Parameter | Value | Source | Tag |
|---|---|---|---|
| DDF snow | 5 (< 5,000 m), 6.5 (> 5,000 m) mm °C⁻¹ d⁻¹ | Parajuli, Chand, Kayastha, Shea, Mool 2015, Lirung Glacier, Langtang, PIAHS 368:409–414, doi:10.5194/piahs-368-409-2015 | [V] |
| DDF clean ice | 6 (< 5,000 m), 7.5 (> 5,000 m) | same | [V] |
| DDF debris-covered | clean-ice DDF × 0.5 (melt reduction factor) | same, after Kayastha et al. 2000 | [V] |
| Debris-thickness dependence | bare ice 16.9; 10 cm debris 11.1; 40 cm 5.3 mm °C⁻¹ d⁻¹; ablation enhanced below ~0.3–5 cm, retarded above 5 cm | Kayastha et al. 2000, IAHS Publ. 264:71–81 (Khumbu) | [V] |
| Dokriani (Garhwal) | snow 5.75 (dusted 6.41); ice 7.33 (dusted 7.97) | field study [S] | [S] |
| Lapse rate Γ | **−5.4 °C/km annual mean** (Langtang); premonsoon −6.4, monsoon −4.6, post-monsoon −4.9, winter −5.8 | Immerzeel et al. 2014, Water Resour. Res. 50:2212–2226 | [V] |
| ELR (fallback) | −6.5 °C/km | standard | — |

Sizing example ([C]): 100 km² of glacier, DDF 7 mm °C⁻¹ d⁻¹, +3 °C heatwave anomaly → 21 mm d⁻¹ → 2.1×10⁶ m³ d⁻¹ ≈ 24
m³/s extra. Langtang-scale catchments: tens of m³/s.

### F.2 What melt is for in Deluge (be honest on screen)

Heatwave melt is a **slow** forcing (tens of m³/s over days), not a flash flood. It enters the chain in three ways:
1. **Baseflow** in the 1-D routing and the river at the domain edge (river stage before the surge).
2. **Lake filling → trigger**: dV_lake/dt = ΔQ_glacier_to_lake → freeboard shrinks → overtopping/breach threshold
   (pre-event context: Thame 2024 followed the warmest 17 Jul–15 Aug window on record and > 10 wet days [V];
   Langtang Lirung summer temps 1.5–2 °C above record before 2026 [S]).
3. **Scenario framing** (e.g., "+2 °C summer" increases baseflow and lake inflow), not a separate flood type.

Do not present melt-driven runoff as the cause of an outburst; present it as a modifier of probability/baseline.

---------------------------------------------------------------------------------------------------------------------

## G. Case studies (numbers for presets and validation)

Coordinates: **[V]** where read from a source; **≈** where estimated by this research from known geography (verify in
the bake from OSM/DEM before display).

### G.1 Lirung ice-rock avalanche → Lhende / Bhote Koshi / Trishuli, 26 Aug 2026 (Nepal; the existing preset)

* Source: north face of Langtang Lirung (7,227 m), failure zone ~5,000–5,500 m; fell ~1,200 m into Lhende Khola
  (ICIMOD compiled page [S]); YAE/KU: fell 5,200 → 3,800 m, struck the debris-covered ablation zone, reached the
  Lhende at ~2,900 m [V]. Langtang Lirung summit ≈ 28.256 N, 85.520 E (≈). Source ~20 km upstream (NE) of
  Rasuwagadhi (NDRRMA) [V]. Rasuwagadhi/Timure ≈ 28.271 N, 85.380 E (≈); Syafrubesi ≈ 28.159 N, 85.343 E (≈);
  Betrawati = domain centre 27.99 N, 85.186 E [V meta.json].
* Mechanism: ice-rock avalanche, entrainment, brief channel blockage → "avalanche-dam outburst"; not a GLOF
  (ICIMOD; severe-weather.eu citing satellite evidence) [S]. Seismic: USGS M 5.2 landslide signal (us7000tbwb), GFZ
  Mw 5.7; initially reported as M 4.4 quake [S].
* Volumes: NDRRMA "~1 km² section of rock-glacier material" [V]; YAE/KU rough estimate 113 Mm³ collapse + 29.4 Mm³
  eroded = > 142 Mm³ solids/ice (assumed depths, "field verification required") [V]; HEC-RAS with 121 Mm³ gave
  23,000 m³/s at Syafrubesi, 15 m/s, 15 m depth [V — model, likely high]. Excess water at Devghat 19.96 Mm³ (DHM) [V].
  Chinese side barrier lake ~2 Mm³ (CCTV via Kathmandu Post) [S].
* Timeline [V NDRRMA/YAE]: 08:37 failure; ~08:40 Rasuwagadhi (= the last NORMAL gauge reading, 1.62 m at 08:40 — DHM; §G.9 third pass); 08:50 Syafrubesi gauge data stop; 09:00–09:16 DHM
  warnings, 632,295–679,295 SMS; ~09:20 Betrawati (= when gauge 447 stopped transmitting; last reading 3.55 m); 10:28 Galchhi; 11:50 Malekhu; 13:00
  Mugling; 15:20 Devghat, peak 16:00 = 5,850 m³/s.
* Losses: 14 hydropower projects damaged, 748 MW (354 MW operating + 394 MW under construction; IPPAN) — named:
  Rasuwagadhi 111 MW, Upper Trishuli-1 216 MW (u/c), Rasuwa Bhotekoshi 120 MW (u/c), Chilime, Trishuli-3A/3B, Upper
  Trishuli 2, Mailung Khola, Langtang Khola, Middle Trishuli Ganga Nadi, Trishuli, Devighat, Super Trishuli; NDRRMA
  total affected 783.385 MW incl. solar [V]; ~431 MW offline (~10 % of grid); Trishuli 220 kV 3B hub substation
  destroyed [V YAE]. 894–934 hydropower-linked people missing (late Aug) [S]. Transport: 41 motorable bridges washed
  away + 4 damaged (NDRRMA 01 Sep) [V]; YAE: 35 motorable + 33 suspension bridges, 40–45 km of Betrawati–Rasuwagadhi
  road [V]. Economic: infrastructure ≈ NPR 200 bn (USD 1.3–1.5 bn) + hydropower ≈ USD 0.97 bn; reconstruction
  USD 4–5 bn [V YAE]; "Rs 408.28 bn" loss figure also reported [S]. Deaths: provisional, rising (1,455 / 5,285 missing
  per NDRRMA via Friday Times, Oct 2026) — the repo's policy of not showing casualty numbers should stay.
* Precursor: 8 Jul 2025 Purepu (Pyurepu) supraglacial-lake GLOF from Tibet, lake at ~5,150 m ~36 km upstream of
  the border, 0.68 km², 9.09 Mm³, ~7.22 Mm³ released over ~35 h (Zhang T.-G. et al. 2026, ACCR) [V]; alternative DEM
  estimate 3.55 Mm³ (Xu et al., EGUsphere-2026-4065) [V]; flood at ~03:00 NPT, +3.5 m at Timure, Friendship Bridge
  destroyed, 11 dead/18 missing (NDRRMA) [S], 4–11 hydropower projects damaged (counts vary) [S].

### G.2 Thame GLOF, 16 Aug 2024 (Khumbu, Nepal) — Khadka et al. 2026, NHESS 26:4131–4152 [V]

* Cascade: upper Ngole lake (4,890 m, bedrock+moraine dam, 0.11 km² before) → lower Ngole Pokhari (4,718 m, moraine,
  0.048 km²). Drained 4.1×10⁵ + 3.6×10⁵ = 7.7×10⁵ m³ (drone DEM). Lake drops 4.6 m / 12 m; breach ~21 m / incision ~30 m.
* Peak: 912 m³/s at lower-lake outlet ~800 s after breach (scenario A; B: 1,240 at 240 s); 574 → ~548 m³/s at Thame;
  flow depth up to 4 m, ~10 m/s at the village. Onset ~13:00, Thame ~13:30 (20–25 min); modelled 1,300 s. Upper lake
  ~9 km upstream of Thame; Thame–Namche ~5 km; erosion effects up to 50 km downstream.
* Losses: USD 6.18 M (Khumbu Pasang Lhamu RM), 135 displaced, no deaths; school, teahouses, ~500 m trail; 930 kW
  village hydro (no damage reported). Thame village ≈ 27.83 N, 86.65 E (≈).
* Model: r.avaflow v4.0G, 10 m HMA-DEM, entrainment coefficient 10^−5.7; F1 0.78.

### G.3 South Lhonak GLOF, 3–4 Oct 2023 (Sikkim) — Sattar et al. 2025, Science, doi:10.1126/science.ads2659 [S]

* Lake 27.9125 N, 88.1964 E [S Eos], ~5,200 m [S NCL]. Trigger: 14.7 Mm³ frozen lateral moraine failure 22:13:20 IST;
  ~20 m displacement wave; ~50 Mm³ released (≈ half the lake); ~270 Mm³ sediment mobilised; flood 11 m high ~1 km
  below; reached Chungthang (Teesta-III, 1,200 MW, 60 m dam, destroyed) ~68 km downstream ≈ 2 h 20 min later (~00:35 reported; ~00:30 in their own HEC-RAS run — §G.9 third pass);
  4 other dams impacted; 55 dead + 74 missing; ~25,900 buildings damaged; 31 major bridges; 276 km² farmland; effects
  to 385 km. Chungthang ≈ 27.60 N, 88.64 E (≈).
* Peaks (modelled, inconsistent): 7,355 m³/s at Chungthang and 8,282 at Gazoldoba (HEC-HMS/RAS, Nat. Hazards 2025,
  doi:10.1007/s11069-025-07350-9; Gazoldoba observed ~8,252) vs other studies 10,282–14,673 at Chungthang Dam [S].
  Pre-event modelling (Sattar et al. 2021, Geomorphology, S0169555X21001914) predicted 25–30 m depth and 6–9 m/s at
  Chungthang for a large scenario [S] — a nice "the warning existed" story beat.

### G.4 Chamoli, 7 Feb 2021 (Uttarakhand) — Shugar et al. 2021, Science 373:300–306 [V]

* 04:51 UTC (10:21 IST): 26.9 Mm³ rock+ice (≈ 80/20 %) from Ronti Peak north face at ~5,500 m; slab up to ~550 m
  wide, ~80 m thick; ~3,700 m vertical drop to Tapovan; H/L = 0.16; runup 220 m; ~8 Mm³ deposited at the Ronti
  Gad–Rishiganga confluence; ~40 m thick dam formed a lake ~700 m long.
* Flow: front ~25 m/s near Rishiganga HPP (Raini, ~15 km from source); ~16 m/s just upstream of Tapovan (~10 km
  further); ~12 m/s below Tapovan (26 km); ~10 m/s mean Raini→Joshimath (16 km). Mean discharge 8,200–14,200 m³/s at
  Rishiganga HPP, 2,900–4,900 below Tapovan; duration 10–20 min at Rishiganga.
* Losses: 204 dead/missing (190 were hydropower workers); Rishiganga 13.2 MW and Tapovan-Vishnugad 520 MW; direct
  damage to the two projects > USD 223 M; warning potential 6–10 min (20 min with source-area sensor).
* Coords ≈: Raini 30.52 N, 79.61 E; Tapovan barrage 30.49 N, 79.65 E; Joshimath 30.56 N, 79.56 E (≈ — verify).

### G.5 Dig Tsho, 4 Aug 1985 (Khumbu)

* Ice avalanche from Langmoche Glacier into Dig Tsho; ~5 Mm³ released (Vuichard & Zimmermann 1987, MRD 7(2):91–110)
  [S]; peak ~2,000 m³/s initial [S], 2,350 m³/s at 7.1 km and 1,375 at 27 km (Cenderelli & Wohl 2001) [S]. Destroyed
  the nearly complete Namche small hydropower plant (Thame), 14 bridges, ~30 houses [S]. Dig Tsho ≈ 27.87 N, 86.58 E (≈).

### G.6 Gongbatongsha Tsho, 5 Jul 2016 (Poiqu/Bhote Koshi, Tibet → Nepal) — Sattar et al. 2022, Sci. Rep. 12:12421 [V]

* Lake 28°04′41″ N, 86°04′12″ E, 4,623 m, 1.7×10⁴ m²; 3,000–6,000 m³ debris flow into lake → overtopping; released
  1.1–1.7×10⁵ m³ (model 1.2×10⁵). Breach 27 m wide × 9 m deep. 618 m³/s at the lake (peak at 30 s, 6 min to empty);
  ~4,123 at the Zhangzangbo–Bhote Koshi confluence (6.5 km); ~1,611 at Upper Bhote Koshi HPP (45 MW; ~23 km).
  Entrained ~8.3 Mm³ (max erosion 7 m); losses > USD 70 M (66.35–77.34 M); Arniko Highway cut. Also cited: Cook et al.
  2018, Science 362:53–57, doi:10.1126/science.aat4981 (GLOFs as erosion drivers) [M for bibliographic detail].

### G.7 Hazard lakes and mitigation

* **Tsho Rolpa** (Rolwaling → Tamakoshi): 1.537 km², 85.94 Mm³, 4,580 m [S Wikipedia/ICIMOD]; centroid code
  GL086476E27861N → 86.476 E, 27.861 N [V ICIMOD 2020 ID]; lowered by 3 m in 2000 via a 70 m canal [S]. Downstream
  Upper Tamakoshi HEP (456 MW) [M]. Empirical Qp estimates span 7,759–90,296 m³/s (IJECE 2012) [S].
* **Imja Tsho**: 61.7 ± 3.7 Mm³ (Sept 2012 sonar), lake growing ~0.04 km²/yr, glacier retreat ~52 m/yr
  (Somos-Valenzuela et al. 2014, The Cryosphere 8:1661–1671) [S]; lowered 3.4 m in 2016 (ICIMOD/UNDP 2020) [V];
  centroid GL086925E27898N [V]; exposed value USD 35.5 M [V ICIMOD 2020].
* ICIMOD/UNDP 2020 inventory (Koshi, Gandaki, Karnali): 47 PDGLs — 25 in TAR, 21 Nepal, 1 India; 31 Rank I [V].
* Oct 2026: Nepal to lower Thulagi (GL084485E28488N), Lower Barun, Lumding Tsho, Hongu II — USD 50 M (GCF/UNDP/GoN),
  up to 6 years, gated outlets (Reuters via The Star, 3 Oct 2026) [S].

### G.8 Blatten, 28 May 2025 (Lötschental, Switzerland)

* Kleines Nesthorn rockfalls (19–28 May) loaded the Birch Glacier; collapse ~9–10 Mm³ rock+ice (EGU26 abstracts:
  ~5.5 Mm³ progressive rock then ~8.3 Mm³ mixed; total "> 9 Mm³"), ~40 s, ~200 km/h, deposits up to 32 m on the
  village, Lonza dammed into a lake; ~300 residents evacuated 9 days earlier; 1 death [S]. Damage estimates
  CHF 200–500 M from a low-reliability page [S — do not show]. Blatten ≈ 46.42 N, 7.82 E (≈). A good "warning worked"
  counterexample but outside the Himalayan data pipeline.

### G.9 Calibration of the chain engine against G.1 and G.3 (October 2026)

What was changed, why, and what is left. Every number below is reproduced by `npx tsx scripts/bake-chain.ts &&
npx tsx scripts/bake-chain-result.ts` and asserted in tests/hazard/calibration.test.ts.

* **Profile (both presets, scripts/chain-profile.ts).** (a) The bed was a plain isotonic fit — a staircase (Nepal 158 of
  638 faces flat, steps to 45 m per node; Chungthang 63 flat). Now: isotonic fit → linear interpolation between the
  pooled blocks' centroids → ±300 m moving average; exactly monotone, no flat face, RMS 6 m from the median-filtered
  DEM samples. (b) Gorge sections were slots (3 m wide at 5 m of stage): every floor is widened to one DEM cell, 25 m
  [H — a resolution floor; bankfull relations w ≈ 4–5·Q^0.5 give 45–80 m here, so it errs narrow]. 318 / 639 Nepal
  and 271 / 729 Chungthang sections were widened.
* **Nepal trigger.** `transientDam` at s = 0 had no valley above it to pond: a 10.5 h fill, 3.8 Mm³ at ~500 m³/s,
  Betrawati after ~15 h. Switched to `directFlow` (C.3 branch 2): every timing source has the flood within minutes,
  and the melt water (20.7 Mm³) matches DHM's 19.96 Mm³ excess at Devghat. Moving s = 0 upstream would invent a lake.
* **Avalanche travel.** The clock is the collapse's seismic signal; the mass needs pathLength / v to reach the river
  (MassMovement.travelSpeed, default 50 m/s — OPRI's "roughly fifty metres a second" [S]): 4.3 min for Nepal, added
  to the source, not absorbed by the routing.
* **Debris-flow resistance.** Considered, NOT changed: lowering the resistance of a debris flood is not supported —
  Rickenmann 1999 gives n ≈ 0.1 for debris flows against 0.067 for clear-water torrents, consistent with the router's
  Lin et al. (2005) dispersive factor (×1.5 at Cv 0.4). Manning n stays 0.05.
* **Impulse wave (C.2).** Checked against the primary text — Evers, Heller, Fuchs, Hager & Boes, *Landslide-generated
  Impulse Waves in Reservoirs — Basics and Computation*, 2nd ed. v2.1 (SFOE, 2023): H_M = (5/9)P^(4/5)h (3.13),
  x_M = (11/2)P^½h (3.14), a = (4/5)H (3.16), H(x) = (3/4)(P·X^(−1/3))^(4/5)h (3.19), T(x) = 9P^¼X^(5/16)√(h/g)
  (3.20): the coefficients above were RIGHT, now [V]. What was wrong was their use: they are the laterally confined
  (flume) case, and the overtopping test used the height H, not the crest amplitude a (manual: a > f). The engine now
  applies Ruffini et al. 2019's spreading (manual §4.2.1, eqs. 4.2–4.4: H = κ·H_M·(b/l_w)^½·cos²(2γ′/3), l_w =
  b + 2r′β), compares a with the freeboard, and caps a at 0.78 h (non-breaking solitary wave, manual §3.3.3). South
  Lhonak with the lateral-moraine geometry (outlet 1.33 km away, 77° off the slide axis — built from the published
  centroid, outlet, area and length): H = 15 m against ~20 m observed; the flume value is 46 m. M ≈ 14 lies above the
  manual's tested 10 and the engine says so.
* **2-D rheology.** Voellmy μ 0.05 / ξ 500 stalled the 2-D surge (Coulomb term stops flow below ~2.9° of surface
  slope; the Trishuli floor falls ~2 %). Both presets now use O'Brien–Julien quadratic, Cv 0.3, Glenwood 1 [C].
* **The presets use the chain.** meta.json's inflow is the routed entry hydrograph of the ensemble's median member
  (scripts/bake-chain-result.ts), and chain-result.json (BakedChainResult) carries fronts, peaks, bands and lead times.

| Station (model = ensemble median member; band = p10–p90) | before | after | observed |
|---|---|---|---|
| Nepal, Rasuwagadhi front | 667 min (dam) / 18 min (direct flow, old profile) | 18 min (16–20) | ~3 min NDRRMA, ~7 min CCTV |
| Nepal, Syafrubesi gauge front | 739 / 42 min | 34 min (30–40) | ≤ 13 min (gauge dead at 08:50) |
| Nepal, Betrawati front | 884 / 104 min | 75 min (63–90) | 43 min NDRRMA, ~23 min OPRI |
| Chungthang front | 80 min | 109 min (99–156) | ~137 min |
| Chungthang peak | 18,177 m³/s | 9,829 m³/s (4,133–15,318) | 7,355–14,673 (reconstructions) |
| South Lhonak wave at the outlet | 46 m (H vs freeboard) | 15 m H, 8 m crest | ~20 m |

**Residual, honestly:** Nepal's front is still ~75 % late at Betrawati and the first two observations are out of
reach. Diagnosis: on this DEM profile even a SUSTAINED 20,000 m³/s step reaches Betrawati only after 71 min (its mean
velocity at n = 0.05 is ~15 m/s), while the reports imply ~20 m/s from Rasuwagadhi down and ~40–50 m/s above it — the
speed of the avalanche-born debris flow itself (OPRI). Lowering n to 0.035 would close much of the gap and is
exactly the fudge this calibration refused; what would justify it is a flood-stage resistance law or surveyed gorge
sections. Chungthang is within its band.

**Bed resistance: Ferguson's variable-power equation (second pass, October 2026).** The flood-stage resistance law
the residual above asked for, implemented and tested; the result is a modest gain, not a fix.

* *Law.* Ferguson (2007), "Flow resistance equations for gravel- and boulder-bed streams", WRR 43, W05427,
  doi:10.1029/2006WR005422: U/u* = √(8/f) = a1·a2·(R/D84) / √(a1² + a2²·(R/D84)^{5/3}), a1 = 6.5, a2 = 2.5 — his
  compromise coefficients for absolute and relative velocity error on 376 field measurements, calibrated on R/D84
  (restated by Ferguson & Recking 2025, WRR, doi:10.1029/2024WR038852; Rickenmann & Recking 2011, WRR 47, W07538,
  doi:10.1029/2010WR009793, found the VPE the least biased of the published laws; a refit of 6.1 / 2.4 is in ESurf
  9:379, 2021) [V for the form and the coefficients via those secondary sources; the 2007 PDF itself was not
  retrievable]. Deep limb: U/u* → a1·(R/D84)^{1/6}, i.e. Manning–Strickler with n = D84^{1/6}/(a1·√g); shallow limb:
  U/u* → a2·R/D84 (roughness layer).
* *Implementation* (src/hazard/resistance.ts, routing.ts; HazardChainSpec.routing.resistance, additive — absent means
  Manning bit for bit). The VPE enters the router as its equivalent n_eq(R) = R^{1/6}/(√g·U/u*), so the friction
  term g·n_eq²·|Q|/(A·R^{4/3}) = Cf·|Q|/(A·R) with Cf = (u*/U)²: the existing semi-implicit denominator, a positive
  coefficient that can only slow the flow. n_eq is tabulated per node on the geometry's depth grid (one extra
  interpolation per face), used for the outlet and the baseflow normal depth too; the dispersive factor for Cv
  multiplies it as it multiplied n. Tests (tests/hazard/resistance.test.ts): the curve at sample R/D84, both limbs,
  the VPE normal depth of a prismatic channel, and bounded / positive / deterministic / exactly conservative runs on
  5, 10, 20 and 30 % beds, dry and wet.
* *D84.* No surveyed D84 for the Bhote Koshi / Trishuli, Lachen Chu or Rishiganga was found (Huber et al. 2020, ESurf
  8:769, survey 4.5–30 m flood boulders in the Trishuli and Sunkoshi channels but give no bed grain-size
  distribution). 0.5 m — the middle of the 0.3–1 m range for boulder-bed mountain rivers — is an ASSUMPTION [H]
  (src/hazard/defaults.ts VPE_D84_HIMALAYA), chosen before the comparison and the same for every preset; the table
  below shows what 0.2–1 m would have given, so the sensitivity is on the record rather than tuned away.
* *What it can and cannot do.* At high submergence the VPE IS a Manning–Strickler law: over a 0.5 m bed n_eq ≈ 0.047
  at R = 5 m and 0.044 at 15 m — 6–12 % less resistance than n = 0.05, so 6–12 % more speed at the same slope and
  depth. It raises resistance at shallow depth (n_eq > 0.1 below R ≈ 0.5 m), which slows the thin leading edge and
  the baseflow. It cannot close a 60 % timing gap.

Median member (the baked deterministic run), front in minutes after the collapse / peak in m³/s; sensitivity runs
are the same member with only D84 changed:

| Station | Manning n 0.05 | VPE D84 0.2 m | 0.3 m | **0.5 m** | 1.0 m | observed |
|---|---|---|---|---|---|---|
| Nepal, Rasuwagadhi front | 17.6 | 16.1 | 16.4 | **16.9** | 17.9 | ~3 (NDRRMA), ~7 (CCTV) |
| Nepal, Syafrubesi gauge front | 34.4 | 30.1 | 31.0 | **32.3** | 35.0 | ≤ 13 |
| Nepal, Betrawati front | 75.5 | 63.0 | 65.7 | **69.7** | 77.5 | 43 (NDRRMA), ~23 (OPRI) |
| Chungthang front | 108.5 | 90.7 | 95.5 | 103.3 | 120.0 | ~137 |
| Chungthang peak | 9,829 | 10,837 | 10,532 | 9,957 | 8,624 | 7,355–14,673 |
| Chamoli, Raini peak | 10,435 | 11,712 | 11,535 | **10,882** | 9,727 | 8,200–14,200 |
| Chamoli, Tapovan barrage front | 22.3 | 18.8 | 19.6 | **20.9** | 23.6 | ~15 (seismic) |
| Chamoli, below Tapovan peak | 5,365 | 7,389 | 6,712 | **5,917** | 4,752 | 2,900–4,900 |
| Chamoli, Joshimath front | 38.7 | 31.7 | 33.4 | **36.0** | 41.8 | ~27 (derived from 10 m/s) |

Ensembles with the adopted laws (p10–p90): Betrawati 58–83 min (was 63–90), Syafrubesi 29–37 (30–40), Rasuwagadhi
16–19 (16–20); Tapovan barrage 18–25 (19–27). The 30 m/s routing speed cap binds on 0.34 % of node updates in the
Nepal run with the VPE (0.17 % with Manning), 0.16 % (0.07 %) at Chamoli — still a safety net, not the clock.

*Decision, per preset.*
* **Nepal: adopted.** Every station moves toward its observation (Betrawati +76 % → +62 % late of NDRRMA's 43 min);
  the peak at the map edge rises 11,446 → 12,173 m³/s (no measured peak to compare). The SMS-lead story in
  BUSINESS.md was recomputed (Betrawati front 09:52 → 09:46).
* **Chamoli: adopted, with a cost stated.** The one timed observation improves (Tapovan barrage +49 % → +39 % late),
  the Raini peak stays inside the reconstruction, the derived Joshimath time improves — but the peak below Tapovan
  rises from 9 % to 21 % above the top of its reconstructed band. That miss is attenuation the profile cannot make
  (no barrage structure, no deposition at Tapovan), not the bed law.
* **Chungthang: NOT adopted — Manning n 0.05 stays.** The model is already early there (−21 %); the VPE at the same
  0.5 m makes it earlier (−24 %, a ratio of 0.756 against the regression test's 0.75 floor). A 1 m bed would bring it
  to −12 %, but choosing the Lachen Chu's D84 by its arrival time is the tuning this calibration refuses. The two
  biases (Nepal and Chamoli late, Chungthang early) cannot both be resistance: one law that speeds the first two must
  speed the third. The likelier culprits are elsewhere — the sources (the Nepal avalanche's own debris-flow speed of
  ~40–50 m/s above Rasuwagadhi, which no water-routing law gives; the South Lhonak breach hydrograph) and the 30 m DEM
  sections — and this per-preset choice is a statement of where the model stands, not a finding that the Lachen Chu
  is rougher.

**Third pass: the sources, the river and the observations (October 2026).** The second pass ended by naming four
suspects for the residuals: (a) the source models, (b) the DEM's gorge sections, (c) the South Lhonak breach and the
Teesta-III reservoir, (d) what the observed times actually are. Each was checked against evidence; four changes were
adopted, each on physics or a measurement and never on the clock, and two were tried and refused.

*What the observations are (d).* Read again, three of the "arrival times" are not sightings of the front:
* Nepal. The DHM Flood Forecasting Division's technical report (27 Aug 2026, via Onlinekhabar [V for the article]):
  the Bhotekoshi–Syafrubesi gauge's **last reading was 1.62 m at 08:40** (warning level 6 m — a normal river) and its
  **data stopped at 08:50**; Betrawati (station 447) **stopped transmitting at 09:20**, last reading 3.55 m (warning
  4.1 m). NDRRMA's "~08:40 at Rasuwagadhi" coincides with that last normal reading (Nepali Times places the 1.62 m
  gauge at the border [S]); 13 km of path plus 15 km of river in 3 min would be ~150 m/s, so it is most likely the
  gauge timestamp, not the flood. "09:20 at Betrawati" is when the gauge went silent — an upper bound on the front if
  the flood destroyed it, no bound if the telemetry failed first. The OPRI reconstruction (S. Rauniyar, "The Langtang
  Collapse", SPF OPRI, 3 Sep 2026 [V, not peer-reviewed]) adds "~08:50, surge crosses at Rasuwagadhi–Timure and
  reaches Syabrubesi … in roughly ten minutes" (Timure ~13 min, Syafrubesi ~23 min), and its CCTV 08:44 at Gyirong
  Port; ICIMOD via AFP gives ~20 km in ~7 min [S]. These are now on the stations with their provenance.
* South Lhonak. Sattar et al. 2025 (accepted manuscript, eprints.whiterose.ac.uk/224098 [V]): their HEC-RAS run (water
  only, n = 0.05) puts the flood at Chungthang at "~00:30:00 IST … in line with the reported arrival time (~00:35)".
  **00:30 — the observation the chain was compared with — was their model result**; the report is ~00:35 (8,500 s
  from the 22:13:20 clock zero; their own main text has the collapse at 22:12:20), source not stated. Their modelled
  Chungthang peak is 5,340 m³/s (first arrival + ~6 min), a fourth reconstruction beside 7,355 and 10,282–14,673.
* Chamoli. Tiwari et al. 2022 (Sci. Rep. 12:3733, doi:10.1038/s41598-022-07491-y [V]) time it from seismic records:
  release 04:51:10 UTC; debris at the Ronti Gad–Rishiganga confluence 04:54 ("~55 m/s from the source"); Rishiganga
  HEP damaged 04:57 (6 min; "~27 m/s, verified with available videos"); first wave at Tapovan 05:07 (16 min), a
  second at 05:12; ~13 m/s Raini → Tapovan. Cook et al. 2021 (via the GFZ press release [S]): the flood at the bridge
  near Joshimath at 10:58:33 IST — 37.5 min, replacing the derived "~27 min from 10 m/s".
* The front rule (first Q above baseflow + max(10 m³/s, 5 % of the peak excess), or 0.5 m of stage) is kept: a
  destroyed gauge or a camera records the destructive surge, which in the model comes seconds to minutes after the 5 %
  front, so switching to the peak would make every late station later. It is not where the gap is.

*The source models (a).*
* **Debris-flow surge — adopted for Nepal and Chamoli.** The direct-flow hydrograph was the §B.4 gamma curve (a = 3), a
  breach's shape: it put the peak 11 min (Nepal) and 6.6 min (Chamoli) after the mass reached the river, and the 5 %
  front waited for its slow rising limb. A mass that hits the river at tens of m/s is already a surge, with its
  highest discharge at the front (Iverson 1997, Rev. Geophys. 35:245 [M]). `shape: 'surge'` (src/hazard/mass.ts
  surgeHydrograph) keeps the peak (Jitousono) and the volume, rises over the avalanche body's length over its speed
  (ℓ = 2·V^(1/3), Chamoli ≈ 600 m — the slab of Shugar et al. implies ≈ 610 m [C]; ≈ 12–20 s) and falls linearly to
  T = 2V/Qp (Chamoli ≈ 15 min, Shugar's "10–20 min" at Raini [V]). On a prismatic channel the router's front into a
  low baseflow moves at ~1.1 × the mean velocity of the flow behind it (a shock: (Q₂ − Q₁)/(A₂ − A₁)) [C], which is
  why the front's speed is set by the discharge right behind it.
* **Sliding-block runout — adopted for Chamoli only.** src/hazard/runout.ts: a Voellmy–Salm block (v dv/ds = g(sinθ −
  μcosθ) − g v²/(ξh), integrated exactly per reach; h the depth at which the section passes the surge's Qp at the
  block's speed) from the detachment, down the path and the profile, handing over to the routed flood where the
  flood's normal-flow velocity at Qp catches up. Friction pair: μ 0.12, ξ 2,500 m/s² from Zhang, Yin, Li et al. 2022
  (J. Rock Mech. Geotech. Eng. 15:296, doi:10.1016/j.jrmge.2022.04.003), the RAMMS back-analysis of THIS event [S —
  via a secondary source; the primary was not retrievable], inside Allen et al. 2009's compilation for large rock–ice
  avalanches (μ 0.05–0.2, ξ 1,500–4,500 m/s²; NHESS 9:481 [V]). Independent checks: mean speed on the path 52 m/s
  (the chain's default 50; ~55 m/s source → confluence, Tiwari); run on to rest the block stops at ~8.8 km, the 6 %
  stretch 1.6 km above the Ronti Gad–Rishiganga confluence where Shugar et al. mapped ~8 Mm³ of deposit. It hands
  over at 3.4 km, 2.7 min after the collapse. For Nepal no back-analysed pair exists; with Chamoli's the block reaches
  the river at a mean 40 m/s (slower than OPRI's ~50) and stops within 1.5 km (consistent with the reported brief
  blockage of the Lhende), and it makes Rasuwagadhi 1.4 min LATER: not adopted. Only μ ≈ 0.05 (Allen's most mobile
  end, Kolka-type) would carry the mass toward Rasuwagadhi at the reported speeds; choosing it for that is the tuning
  this calibration refuses.
* **The river's own flow — adopted for Nepal.** The routing ran the flood down a river carrying only the Lhende's
  assumed 100 m³/s. The Trishuli's **mean August flow is 621.8 m³/s at Betrawati** (557.8 at the Upper Trishuli-1
  intake = Betrawati × 0.8971; DHM station 447, 1967–2010; ESSA Technologies 2014, Environmental Flows Assessment,
  Supplemental ESIA Upper Trishuli-1, Appendix E, Table 5-2 [V]), and the Betrawati gauge read 3.55 m against a 4.1 m
  warning level before it was lost. `HazardChainSpec.routing.tributaries`: +458 m³/s at the Rasuwagadhi confluence
  (the Kerung) and +64 at the Upper Trishuli-1 site [H for the split]. For Chungthang (October) and Chamoli (February)
  no flow record was found; their baseflows stay as they were (sensitivity below).
* **South Lhonak breach — adopted.** Sattar et al. 2025 [V]: the lake level fell **28 m**; the 55 m breach was complete
  by ~22:24 (~11 min); outflow steady after ~18 min; peak 4.85×10⁴ m³/s of water at the lake; 50 ± 1.8 Mm³ released.
  finalDepth 40 m (the spec's assumption) → 28 m; k = 100 m/h agrees with the ~11 min breach (k = 30, which would put
  the front on the reported time, does not — refused). 43 Mm³ drains (the slide's 14.7 Mm³ of displaced water is not
  modelled). The impulse-wave pulse lasted ~3 min in their reconstruction against the engine's 60 s [H]; tested at
  180 s, it changes nothing below the lake (not changed). The Teesta-III reservoir held ~5 Mm³ (Sattar et al.) and is
  already a storage curve in the profile; they model no delay by it.

*Gorge sections (b) — tried, not adopted.* A hydraulic-geometry floor — bedrock-channel width w ∝ Q^0.38 (Craddock et
al. 2007, JGR 112, F03007 [S]; w ≈ 6.2·Q^0.38 m in one restatement [S, unverified]), ≈ 70 m for Nepal's 558 m³/s —
in place of the 25 m resolution floor, and a plain 50 m floor, both move Nepal EARLIER (−5 to −6 min at Betrawati:
wider floors attenuate the peak less), but Chungthang earlier too and Chamoli LATER (+1 min at Tapovan): the same
geometry rule cannot be chosen per preset by the sign it gives, and nothing surveyed says which floor is right.

Median member, front in minutes after the trigger / peak in m³/s (each row the adopted configuration with one change):

| Nepal | Rasuwagadhi | Timure | Syafrubesi gauge | Betrawati |
|---|---|---|---|---|
| second pass (gamma, Lhende baseflow only) | 16.9 / 24,836 | 20.4 | 32.3 | 69.7 / 10,872 |
| + surge only | 14.0 | 17.7 | 30.2 | 68.1 |
| + August flow only | 16.9 | 20.1 | 31.5 | 66.5 |
| **adopted (surge + August flow)** | **14.0 / 21,266** | **17.4** | **29.3** | **64.9 / 12,075** |
| 458 m³/s joining at Syafrubesi instead | 14.0 | 17.7 | 30.2 | 65.7 |
| + sliding block μ 0.12, ξ 2,500 | 15.4 | 18.8 | 30.7 | 66.2 |
| + sliding block μ 0.05, ξ 4,500 | 10.5 | 14.0 | 26.4 | 60.6 |
| floor 50 m / 70 m | 13.7 / 13.8 | 16.6 | 27.3 / 27.0 | 59.6 / 59.2 |
| Manning n 0.05 (no VPE) | 14.8 | 18.5 | 31.4 | 70.4 |
| observed | ~3 (gauge timestamp), ~7 (CCTV) | ~13 (OPRI) | ≤ 13 (gauge lost) / ~23 (OPRI) | ≤ 43 (gauge lost) / ~23 (OPRI) |

| South Lhonak | Lachen | Chungthang | Teesta-III dam |
|---|---|---|---|
| second pass (finalDepth 40 m) | 82.7 / 11,832 | 108.5 / 9,829 | 109.8 |
| **adopted (28 m, Sattar)** | **90.7 / 6,508** | **121.2 / 5,622** | **122.6** |
| k 30 m/h | 107.0 | 138.9 / 5,495 | 140.3 |
| VPE D84 0.5 m | 88.7 | 117.6 | 119.0 |
| baseflow 100 m³/s (not 20) | 88.3 | 117.5 | 119.0 |
| floor 50 m | 90.7 | 119.0 / 7,235 | 120.4 |
| observed | — | ~142 (reported 00:35); peak 5,340–14,673 (models) | — |

| Chamoli | Raini | Tapovan barrage | below Tapovan | Joshimath |
|---|---|---|---|---|
| second pass (gamma at the stream head) | 13.8 / 10,882 | 20.9 | 21.4 / 5,917 | 36.0 |
| + surge only | 12.0 / 8,869 | 19.4 | 20.0 / 5,253 | 35.0 |
| **adopted (surge + block μ 0.12, ξ 2,500)** | **11.4 / 9,412** | **18.8** | **19.3 / 5,568** | **34.1** |
| block μ 0.05 / 0.20 (ξ 2,500) | 9.7 / 12.2 | 16.7 / 19.6 | 6,279 / 5,326 | 31.6 / 35.1 |
| block ξ 1,500 / 4,500 (μ 0.12) | 12.0 / 10.7 | 19.5 / 18.1 | 5,333 / 5,821 | 35.0 / 33.2 |
| floor 50 m | 12.1 | 20.0 | 5,938 | 34.9 |
| observed | 6 (seismic); 8,200–14,200 | 15–16 (seismic) | 2,900–4,900 | 37.5 (seismic) |

Ensembles (p10–p90): Betrawati 55–76 min (was 58–83); Chungthang 110–156 (contains ~142); Tapovan barrage 16–23.
The baked Chungthang median member is now the high-volume one (×1.25: 121.3 min, 5,663 m³/s).

*Decision, per preset, and what remains.*
* **Nepal**: surge + August flow. Every station moves toward its observations (Betrawati +62 % → +51 % of NDRRMA's
  43 min; Rasuwagadhi 17 → 14). STILL UNEXPLAINED: ~22 min at Betrawati. The router's mean speed Rasuwagadhi →
  Betrawati is ~13 m/s; the reports imply ~19 m/s (NDRRMA) to ~45 m/s (OPRI) — the latter physically implausible for
  a 2.6 % channel at any published roughness, and YAE/KU's own HEC-RAS gave ~15 m/s at Syafrubesi, as this model does.
  Either the reported times are early (both lower-valley "arrivals" are gauge-loss times, and telemetry failure need
  not wait for the water), or the avalanche itself — not its melt water — ran far down the Bhote Koshi at Kolka-like
  speeds (μ ≈ 0.05), which no back-analysis of this event yet supports.
* **Chamoli**: surge + sliding block. Raini 13.8 → 11.4 min (seismic 6), Tapovan barrage 20.9 → 18.8 (15–16), below-
  Tapovan peak 5,917 → 5,568 (top of band 4,900), Raini peak still inside its band — but Joshimath 36.0 → 34.1 against
  a now-timed 37.5 min. UNEXPLAINED: the mass reached the confluence in ~3 min (~55 m/s) where the block, with its
  published friction, is at 2.7 min only 3.4 km down the profile, so Raini is still 5 min late; and below Tapovan the
  model is too fast (Tapovan → Joshimath 15 min against ~21) and too high — the barrage, its reservoir and the mud the
  flow left there are not in the profile.
* **Chungthang**: Sattar's drawdown. 108.5 → 121.2 min against ~142 (−23 % → −14 %), inside the band; peak 9,829 →
  5,622, beside Sattar's own 5,340. Manning n 0.05 still (the VPE makes it earlier). UNEXPLAINED: ~20 min — with the
  same n, Sattar et al.'s HEC-RAS reached Chungthang ~16 min later than this model; the obvious candidates are their
  2-D floodplain storage in the wide upper valleys against these 1-D DEM sections, and the debris load, which this
  router relaxes to a Takahashi equilibrium of ~0.04 at 2–4 % slopes.

**Fourth pass: is Nepal's remaining gap in the routing? (October 2026).** Three candidates were checked — the wave
celerity of the 1-D scheme, the channel widths, the source timing — each against something published, never against
the clock. Result: none closes it defensibly; **nothing was changed**, and every number in the tables above stands.

*An independent speed check.* Rickenmann (1999, Nat. Hazards 19:47, [V] §C.4) fitted the mean velocity of debris
flows to discharge and slope alone, V = 2.1·Q^0.33·S^0.33 — no section, no roughness, no momentum scheme. Applied to
the baked median run (station chainages and fronts from chain-result.json, the bed slope between stations from
chain.json, Q the geometric mean of the two stations' routed peaks) [C]:

| Reach (median run) | km | slope | routed front | Rickenmann V at the routed Q | ratio |
|---|---|---|---|---|---|
| Nepal, Rasuwagadhi → Syafrubesi | 14.7 | 2.61 % | 16.1 m/s | 16.4 m/s (19,269 m³/s) | 0.98 |
| Nepal, Syafrubesi → Upper Trishuli-1 | 17.5 | 2.87 % | 15.5 | 15.8 (15,738) | 0.98 |
| Nepal, Rasuwagadhi → Betrawati | 45.3 | 2.65 % | 14.8 | 15.5 (16,025) | 0.96 |
| Nepal, Lhende source → Rasuwagadhi | 15.0 | 7.2 % | 26.3 | 26.9 (31,624) | 0.98 |
| Chamoli, Raini → Tapovan barrage | 6.3 | 2.48 % | 14.2 | 11.8 (7,592) | 1.20 |
| Chamoli, Tapovan → Joshimath | 9.4 | 3.64 % | 10.7 | 11.6 (4,840) | 0.92 |
| Chungthang, Lachen → Chungthang | 19.5 | 4.88 % | 10.7 | 13.8 (6,091) | 0.78 |

So on the Bhote Koshi and Trishuli the router already runs at the empirical debris-flow speed for the discharge it
carries (pinned by tests/hazard/calibration.test.ts within ±15 %). To reach Betrawati at 43 min with the front at
Rasuwagadhi at 7 min (CCTV, the earliest credible), the 45 km would need 21 m/s, i.e. Q ≈ 40,000 m³/s held over the
whole reach — 1.9× the routed Rasuwagadhi peak and 1.6× the ensemble's p90 at Betrawati. At OPRI's 23 min it would be
several times more. (Chamoli: fast below Raini and Chungthang slow by this yardstick — the other signs §G.9 already
reports; Chungthang is a water outburst, for which a debris-flow relation is only indicative.)

*Celerity (a).* The router is local-inertial (no advection term). Behind a surge front in a steep channel the flow is
close to uniform, where the advection term vanishes, and the front into a low baseflow is a shock whose speed is set
by continuity, (Q₂ − Q₁)/(A₂ − A₁) ≈ 1.1 × the mean velocity behind it for a wide Manning section with Q₁/Q₂ ≈ 0.05
[C]. A full dynamic-wave router would move it at the same speed; a kinematic celerity of 5/3·u is the speed of a small
disturbance on the peak, not of the front, and only bounds how fast the peak can catch the front. Not a 22-minute
term.

*Channel geometry (b).* Narrower sections would deepen the flow and speed it — but the routed speed is already at a
width-free empirical relation, so narrowing would put it above it, and the third pass found that wider floors move
Nepal one way and Chamoli the other. No surveyed sections exist (§G.9 third pass). Not changed.

*Source timing (c).* The clock (08:37, seismic) and the avalanche's travel (4.3 min at 50 m/s) are already in.
Upstream of Rasuwagadhi the model is ~7 min behind the CCTV time; below it, at least ~15 min (51 model minutes for
45 km against ≤ 36). A faster source cannot buy the lower reach, which runs on the routed discharge; only a much
larger discharge or the avalanche mass itself travelling down the Bhote Koshi (a Kolka-type μ ≈ 0.05, §G.9 third
pass) could — neither is supported by a back-analysis of this event.

*The observation, read again.* The Flood Forecasting Division's report (via Onlinekhabar, 27 Aug 2026 [V for the
article]) gives Syafrubesi's **last reading at 08:40 and its data stopping at 08:50**, and for Betrawati only that it
**stopped transmitting at 09:20** with a last reading of 3.55 m (below the 4.1 m warning). If Betrawati reported on
the same ten-minute pattern, its last good reading was ~09:10 and the front arrived between 09:10 and 09:20 — so
the gap is 22–32 min, not "about 20"; if the telemetry failed before the water came, 09:20 bounds nothing. The same
report has the station's staff among those reporting the flood **entering** the Bhote Koshi at 09:00 — not its
arrival at Betrawati, which is why 09:00 is not used as a Betrawati time.

Before / after the fourth pass (median member; unchanged because nothing was adopted):

| Station | before | after | observed |
|---|---|---|---|
| Nepal, Betrawati front | 64.9 min (09:41) | 64.9 min | ≤ 43 (gauge lost 09:20) / ~23 (OPRI) |
| Nepal, Syafrubesi front | 29.3 | 29.3 | ≤ 13 (gauge lost) / ~23 (OPRI) |
| Chamoli, Tapovan barrage front | 18.8 | 18.8 | 15–16 (seismic) |
| Chamoli, Joshimath front | 34.1 | 34.1 | 37.5 (seismic) |
| Chungthang front | 121.3 | 121.3 | ~142 (reported 00:35) |

---------------------------------------------------------------------------------------------------------------------

## H. Data sources for the bake pipeline

| Dataset | What | Access | Licence | Tag |
|---|---|---|---|---|
| Copernicus DEM GLO-30 | Terrain, corridor profiles | s3 `copernicus-dem-30m` (already used by `src/data/demGlobal.ts`) | Copernicus DEM licence, attribution | [V repo] |
| RGI 7.0 (NSIDC-0770) | Glacier outlines (melt bands, avalanche source areas) | doi:10.5067/f6jmovy5navz; nsidc.org/data/nsidc-0770 | CC BY 4.0 per RGI user guide (catalog metadata inconsistent — check NSIDC page) | [S] |
| Wang X. et al. 2020 HMA glacial lake inventory 1990/2018 | 30,121 lakes, 2,080 km² (2018), Landsat, ≥ 10 km glacier buffer | paper ESSD 12:2169, doi:10.5194/essd-12-2169-2020; data doi:10.12072/casnw.064.2019.db | paper CC BY 4.0; dataset licence not confirmed | [V] |
| Zhang G. greater-Himalaya inventory 1990–2020 | lake outlines 5 epochs | figshare 21708590 | not confirmed (figshare default is often CC BY 4.0) | [S] |
| Zhang et al. 2024 (Nat. Commun.) global glacial lake outlines 1990/2020 | 71,508 lakes in 2020 (as counted by ESSD 2026) | via paper's data statement | not confirmed | [S] |
| **Veh et al. 2025 lake volumes** | per-lake volume (median + 68 % HDI), dam type, downstream population | Zenodo doi:10.5281/zenodo.17896427 (16.9 GB total; take `03_global_lake_volume`) | **CC BY 4.0** | [V] |
| ICIMOD/UNDP 2020 inventory (Koshi/Gandaki/Karnali) | 47 PDGLs, ranks, lake IDs encode centroids (GLxxxxxxEyyyyyN) | report PDF (nepal.un.org); RDS: rds.icimod.org | **CC BY-NC-ND 4.0** → cite, do not redistribute derived shapes | [S] |
| HMAGLOFDB (Shrestha et al. 2023) | 682 dated GLOFs in HMA, version-controlled | ESSD 15:3941–3961 | (check) | [S] |
| Lützow, Veh & Korup 2023 | global historic GLOF database | ESSD 15:2983 | (check) | [S] |
| OSM | bridges (`bridge=*`), dams/weirs (`waterway=dam/weir`), power plants (`power=plant`, `plant:source=hydro`) | Overpass/API 0.6 (as used) | ODbL | [V repo] |
| Copernicus EMS EMSR927 | observed 2026 flood delineation | mapping.emergency.copernicus.eu | Copernicus EMS terms | [V repo] |

Pipeline notes: lakes and glaciers are needed only at bake time; ship per preset a `chain.json` (≤ 100 KB):
lake record(s) with V band, the thalweg profile + section tables, station list, assets list, and the precomputed
default hydrograph — so the browser never fetches the inventories.

---------------------------------------------------------------------------------------------------------------------

## I. Recommended design for Deluge

### I.1 Data model (TypeScript sketch; additions to `src/contracts.ts`)

```ts
/** New WaterSource variant: time-varying inflow. Exactly ∫Q dt is delivered (same frame-straddle logic as stopAfter). */
export type HydrographSource = {
  id: string; type: 'hydrograph';
  gx: number; gy: number; radius: number;
  /** Piecewise-linear (t s, Q m³/s); t relative to scenario clock zero. Q = 0 outside the table. */
  series: Array<[number, number]>;
  /** Optional sediment concentration (t, Cv); drives uniform rheology in v1, tracer inflow in v2. */
  cv?: Array<[number, number]>;
  /** Unit vector of the river direction at the edge; if set, inject momentum q = Q/W along it. */
  direction?: { dx: number; dy: number };
  label?: string;
  provenance: 'observed' | 'reconstructed' | 'modelled' | 'scenario';
};

export type Rheology =
  | { kind: 'water' }                                         // current behaviour
  | { kind: 'voellmy'; mu: number; xi: number }               // ξ m/s²
  | { kind: 'quadratic'; cv: number; material: RheoMaterial; K?: number; nTurb?: number }  // O'Brien–Julien
  | { kind: 'bingham'; tauY: number; muB: number; rho: number };
export interface RheoMaterial { name: string; a2: number; b2: number; a1: number; b1: number } // dyn/cm², poise

export interface GlacialLake {
  id: string; name: string; lat: number; lon: number; elevation: number;
  area: number;                                   // m²
  volume: { median: number; lo: number; hi: number; method: 'bathymetry' | 'veh2025' | 'empirical' };
  damType: 'moraine' | 'ice' | 'bedrock' | 'supraglacial' | 'landslide';
  damHeight?: number; freeboard?: number;         // m
  inventoryRef?: string;                          // e.g. 'ICIMOD2020:GL086476E27861N'
}

export type HazardTrigger =
  | { kind: 'breach'; lake: GlacialLake; breach: BreachParams }
  | { kind: 'massIntoLake'; lake: GlacialLake; mass: MassMovement; breach: BreachParams }
  | { kind: 'massIntoRiver'; mass: MassMovement; mode: 'transientDam' | 'directFlow'; damLength?: number; baseflow: number }
  | { kind: 'meltAnomaly'; catchment: GlacierCatchment; deltaT: number; days: number }
  | { kind: 'given'; hydrograph: Array<[number, number]>; volume: number };      // published reconstruction

export interface BreachParams {
  model: 'weirErosion' | 'gamma' | 'empirical';
  erosionRate: number;   // m/h (default 30; trigger-driven 100)
  finalDepth: number;    // d, m
  widthRatio: number;    // r = B/H (2)
  sideSlope: number;     // m H:V (1)
  hypsometry: number;    // p (1.5)
  empiricalEq?: 'froehlich2025' | 'popov1991' | 'evans1986' | 'costa1985' | 'walderCosta1996';
}
export interface MassMovement { volume: number; iceFraction: number; fallHeight: number; pathLength: number; impactAngleDeg: number; thickness: number; width: number }

export interface RoutingProfile {                 // baked into chain.json
  s: Float32Array;                                // chainage, m (0 = source)
  zBed: Float32Array;
  sections: Array<{ stage: Float32Array; area: Float32Array; width: Float32Array; perimeter: Float32Array }>;
  n: Float32Array;
  structures: Array<{ s: number; kind: 'weir' | 'dam'; crest: number; width: number; storage?: [number, number][] }>;
  stations: Array<{ s: number; name: string; kind: 'gauge' | 'town' | 'hydro' | 'bridge' | 'domainEdge'; lat: number; lon: number }>;
}

export interface ChainResult {
  source: { t: Float32Array; Q: Float32Array; volume: number; peak: number; tPeak: number };
  stations: Array<{ name: string; tFront: number; tPeak: number; Qpeak: number; stageMax: number; cv: number }>;
  boundary: HydrographSource;                     // what the GPU gets
  leadTime?: { sensor: string; alertLatency: number; perStation: Record<string, number> };
  ensemble?: { qPeak: [number, number, number]; tFront: [number, number, number] };   // p10/p50/p90 at domain edge
}

export interface HazardChainSpec {               // ScenarioPreset.hazardChain (optional)
  trigger: HazardTrigger;
  clockZero: string;                              // ISO time of t = 0 (e.g. '2026-08-26T08:37+05:45')
  profile: string;                                // file name of the baked chain.json
  rheology: Rheology;
  solver?: { uMax?: number };                     // per-scenario speed cap (25 m/s for debris presets)
  observations?: Array<{ station: string; tFront?: number; Qpeak?: number; note: string; source: string }>;
}
```

### I.2 CPU vs GPU split

| Stage | Where | Cost | Notes |
|---|---|---|---|
| V–A, mass-movement empirics, impulse wave | CPU (worker) | µs | pure functions in `src/hazard/` with unit tests against Tables A.2/B.3 |
| Breach ODE (B.3) | CPU (worker) | < 1 ms (dt 1 s, ≤ 12 h) | |
| 1-D routing (E.2) | CPU (worker) | ~10–30 ms / member; 27-member ensemble < 1 s | recompute on slider change; stream progress |
| Hydrograph forcing | CPU → uniform buffer each frame | negligible | extend `src/sim/forcing.ts` (piecewise-linear integral over the frame, exact volume) |
| Rheology | GPU, `momentum.ts` | ~+5–10 % of momentum pass (ALU only) | new uniforms in `common.ts` SimUniforms |
| Cv tracer (v2) | GPU, `continuity.ts` | +1 r32float ping-pong; ~+25 % continuity bandwidth | |
| Envelopes h_max, v_max, (h·v²)_max, t_arrive | GPU, folded into continuity or a tiny pass | 1 rgba32float texture | t_arrive = first t with h > 0.1 m |
| Impacts | CPU worker on readback (like `protectionWorker.ts`) | ~ms | buildings, road edges, bridges, assets |

### I.3 Default parameters (one place: `src/hazard/defaults.ts`)

```
V–A: geometric mean of Huggel02, C&Q #6, Sakai12; band ×/÷2 (supraglacial: C&Q #7, ×/÷2.5)
Breach: k = 30 m/h (trigger-driven 100; avalanche dam 150), r = 2, m = 1, p = 1.5, start head 0.5 m
Gamma hydrograph: a = 3 (tp = V / 1.488 Qp)
Impulse wave: Heller & Hager; overtopping coefficient 0.3 (heuristic)
Routing: Δx = 100 m, CFL 0.7, n = 0.05 (clear), structures as weirs; Cv relaxation L_r = 1 km, φ = 35°, C* = 0.65
Rheology presets: water (Manning n per preset) | debris flood: Voellmy μ 0.05 ξ 500 | debris flow: quadratic,
  Cv 0.45, Glenwood 1, K 2285 | stiff: quadratic Cv 0.5 Aspen Pit 1
ρ_s = 2650 kg/m³; uMax 25 m/s for debris presets (15 otherwise)
Melt: DDF snow 5/6.5, ice 6/7.5 (split at 5,000 m), debris × 0.5, Γ seasonal Langtang (−6.4/−4.6/−4.9/−5.8 °C/km)
Impact thresholds (flag as indicative): buildings — h·v² ≥ 1 m³/s² damage, ≥ ~24 m³/s² complete for unreinforced
  masonry (Prieto et al. 2018, momentum flux) [S]; impact pressure > 30 kPa destroys non-RC buildings
  (Nat. Hazards 80:1475, 2016) [S]; I_DF = h v² classes per Jakob, Stein & Ulmi 2012, Nat. Hazards 60:241
  (doi:10.1007/s11069-011-0007-2; class boundaries not retrieved) [S]. Bridges — "lost" when the water surface
  reaches the deck (deck elevation = road elevation from DEM/OSM) or when h·v² at abutment cells > 10 m³/s²
  (heuristic). Hydropower — intake/dam overtopped or h·v² > threshold at the asset → offline; revenue at risk =
  MW × capacity factor × days offline × tariff (user-editable; no default tariff shipped).
```

### I.4 Solver changes, in order

1. `type: 'hydrograph'` source + exact-volume forcing (tests: Σ delivered = ∫Q dt to 1e-6; arbitrary frame sizes).
2. `ScenarioPreset.hazardChain.solver.uMax` plumbed into the momentum cap and the CFL estimate.
3. Rheology term (D.2) behind a uniform `rheoKind` (0 water → existing code path byte-identical; regression suite
   must stay green). Tests: (a) Voellmy μ = 0, ξ = h^{1/3}/n² reproduces Manning normal depth within 2 %;
   (b) Bingham slab on an incline stops when g h sinθ < τ_y/ρ (analytic); (c) dam-break with yield stress deposits
   with surface slope = τ_y/(ρ g h) (analytic plug).
4. Envelope texture + impacts worker.
5. Optional momentum injection at hydrograph sources (direction + Q/W), to stop the 2-D front from starting at rest.
6. v2: Cv tracer.

### I.5 Uncertainty presentation

Run the chain as a 3×3×3 ensemble (V lo/med/hi × k 10/30/100 m/h × Cv 0/0.2/0.4) in the worker; show p10–p90
of peak Q and front arrival at the domain edge and at each station as bands; the GPU runs the median member and
lets the user pick another. Text on screen must say which numbers are observed (G-tables) and which are model.

### I.6 Recommended presets (ranked by story value × data availability)

**1. Betrawati v2 — "From Lirung to Betrawati" (upgrade of the existing `nepal` preset).**
* Same 8 km domain; upstream chain = Lhende avalanche → transient dam ("minutes") → Bhote Koshi → Trishuli,
  routed ~20 km (source → Rasuwagadhi) + 56 km (→ Betrawati); boundary hydrograph replaces the constant 11,100 m³/s.
* Volume constraint: 19.96 Mm³ excess at Devghat (lower bound at the source — water lost to storage/deposition
  upstream); calibrate the source so the routed front reaches Rasuwagadhi ~08:40 and Betrawati ~09:20 and the peak
  at Devghat ≈ 5,850 m³/s at ~16:00 (extend the 1-D profile to Devghat for validation only). Galchhi rise ≈ 9 m in
  30 min is a second stage check. The YAE 23,000 m³/s at Syafrubesi is a modelled upper bound.
* Story: the clock becomes real (t₀ = 08:37 NPT), lead time is shown (SMS at 09:15, water at ~09:20 → ~5 min),
  hydropower assets (Rasuwagadhi 111 MW, Upper Trishuli-1 216 MW, Chilime, Trishuli-3A/3B) light up as the front
  passes them in the 1-D strip; then the 2-D shows the bridge. Data: all in hand (meta.json, NDRRMA, YAE, ICIMOD).
* Required: uMax ≥ 20 m/s for this preset, or the on-screen caveat stays.

**2. Chungthang / Teesta-III — South Lhonak 2023.**
* 2-D domain 8–12 km centred on Chungthang (≈ 27.60 N, 88.64 E) incl. the Teesta-III dam and town; chain: moraine
  collapse 14.7 Mm³ → 20 m displacement wave → breach (k = 100 m/h) → ~50 Mm³ → 1-D routing 62–68 km → boundary.
  Validate arrival ≈ 2 h 15 min after 22:13 IST and Qp 7,400–14,700 m³/s at Chungthang (band). Rheology "debris
  flood" (270 Mm³ of sediment mobilised).
* Story: a 1,200 MW concrete dam fails to a lake 68 km away; the 2021 paper had predicted 6–9 m/s and 25–30 m
  depth at Chungthang. Data: Copernicus DEM (steep, same caveats as Nepal), OSM, published reconstructions.

**3. Raini–Tapovan — Chamoli 2021.**
* 2-D domain 12–16 km from Raini (Rishiganga HPP) to below Tapovan; chain: 26.9 Mm³ rock/ice → direct
  transformation → Rickenmann/Shugar hydrograph (8,200–14,200 m³/s, 10–20 min) at the Rishiganga confluence; mostly
  inside the 2-D domain, so the 1-D stage is short (Ronti Gad, ~15 km).
* Validation: front 25 → 16 → 12 m/s; 2,900–4,900 m³/s below Tapovan; impounding effect of the barrage.
  Rheology "debris flow" (quadratic, Cv 0.45) — the best showcase for D.
* Story: 190 of 204 victims were hydropower workers; 6–10 min of potential warning. Data: excellent (Science paper
  + supplementary), Copernicus DEM.

Alternates: **Thame 2024** (8 km domain contains most of the chain; best small-scale validation with drone-DEM
volumes and r.avaflow outputs; low losses so less story); **Tsho Rolpa what-if** (Na village/Rolwaling →
Tamakoshi; mitigation story: lowering 3 m removes 1.537 km² × 3 m ≈ 4.6 Mm³ ≈ 5 % of volume — small effect on
Qp but +3 m freeboard against displacement waves; honest, quantitative "what mitigation buys" beat).

---------------------------------------------------------------------------------------------------------------------

## J. Known gaps / things to verify before shipping numbers

1. Walder & O'Connor asymptote constants and the 10–100 m/h k range ([M]); the ODE does not depend on them.
2. Muñoz et al. 2020 coefficients (not retrieved).
3. Heller & Hager amplitude/decay coefficients ([M]); P definition verified.
4. FLO-2D K = 2,285 default and the α/β row pairing (spot-check against the FLO-2D Data Input Manual).
5. Froehlich 2008 K₀ and t_f constant; Froehlich 2016 coefficients ([M]).
6. South Lhonak peak discharges are model-dependent (7,355–14,673 m³/s); Science paper numbers not read directly.
7. 2026 event: all figures preliminary; casualty figures rising — keep them off screen (repo policy).
8. Licences: Wang 2020 dataset, Zhang 2024 global outlines, HMAGLOFDB — confirm before baking any derived file;
   ICIMOD 2020 is NC-ND (cite only).
9. Station coordinates marked ≈ must come from OSM/DEM in the bake.

## K. Source list (primary first)

* Cook & Quincey 2015, ESurf 3:559 — doi:10.5194/esurf-3-559-2015 (PDF read)
* Huggel et al. 2002, Can. Geotech. J. 39:316 — doi:10.1139/t01-099
* Huggel et al. 2003, NHESS 3:647 — doi:10.5194/nhess-3-647-2003 (PDF read: 11° average slope)
* Khadka et al. 2026, NHESS 26:4131 — doi:10.5194/nhess-26-4131-2026 (+ supplement, read)
* Veh et al. 2025, Nature Water — data doi:10.5281/zenodo.17896427
* Walder & O'Connor 1997, WRR 33:2337 — doi:10.1029/97WR01616 (abstract)
* Froehlich 2008, J. Hydraul. Eng. 134:1708 — doi:10.1061/(ASCE)0733-9429(2008)134:12(1708); Froehlich 2025 Nat. Hazards Rev. 26:04025047
* Rickenmann 1999, Nat. Hazards 19:47 — doi:10.1023/A:1008064220727 (PDF read)
* O'Brien, Julien & Fullerton 1993, J. Hydraul. Eng. 119:244 (PDF read); Lin, Wang & Huang 2005, NHESS 5:439 (PDF read)
* Heller & Hager 2010, J. Waterway Port Coastal Ocean Eng. 136:145
* Shugar et al. 2021, Science 373:300 — doi:10.1126/science.abh4455 (accepted MS read: eprints.whiterose.ac.uk/175202)
* Sattar et al. 2022, Sci. Rep. 12:12421 — doi:10.1038/s41598-022-16337-6 (read)
* Sattar et al. 2025, Science — doi:10.1126/science.ads2659 (via eos.org/thelandslideblog/sikkim-glof-october-2023, ncl.ac.uk press; accepted MS read Oct 2026: eprints.whiterose.ac.uk/224098)
* Tiwari et al. 2022, Sci. Rep. 12:3733 — doi:10.1038/s41598-022-07491-y (read: Chamoli seismic timeline)
* Cook et al. 2021, Science 374:87 — doi:10.1126/science.abj1227 (via the GFZ press release and The Landslide Blog)
* Zhang, Yin, Li et al. 2022, J. Rock Mech. Geotech. Eng. 15:296 — doi:10.1016/j.jrmge.2022.04.003 (Chamoli RAMMS; μ/ξ via a secondary source)
* Allen, Schneider & Owens 2009, NHESS 9:481 — doi:10.5194/nhess-9-481-2009 (read: Voellmy back-analyses of rock–ice avalanches)
* Huggel et al. 2005, NHESS 5:173 (Kolka–Karmadon speeds, read); Craddock et al. 2007, JGR 112, F03007 — doi:10.1029/2006JF000589 (abstract)
* ESSA Technologies 2014, Environmental Flows Assessment, Supplemental ESIA Upper Trishuli-1 HEP, Appendix E (IFC project 35701; read: Table 5-2)
* DHM Flood Forecasting Division technical report, 27 Aug 2026 — via english.onlinekhabar.com/technical-report-rasuwa-flood.html (read)
* S. Rauniyar, "The Langtang Collapse", SPF Ocean Policy Research Institute, 3 Sep 2026 (read; not peer-reviewed)
* Cenderelli & Wohl 2001, Geomorphology 40:57 — doi:10.1016/S0169-555X(01)00037-X
* Immerzeel et al. 2014, WRR 50:2212 (PDF read); Parajuli et al. 2015 PIAHS 368:409 (read); Kayastha et al. 2000 IAHS 264:71 (read)
* NDRRMA Situation Report #01, 01 Sep 2026 — ndrrma.gov.np/mediafiles/rasuwa/Rasuwa_Flood_SitRep_Temp_ENG_01_01092026.pdf (read)
* Chand, Kayastha et al. 2026, YAE/HiCCDRC/KU Rapid Situation Report, 31 Aug 2026 — yae.org.np (read)
* ICIMOD compiled page — icimod.org/kyirong-rasuwa-flood-2026-nepal-china-border; ICIMOD experts meeting — icimod.org/icimod-rasuwa-gyirong-flood-experts
* Kathmandu Post 27 Aug 2026 — kathmandupost.com/national/2026/08/27/bhotekoshi-flood-what-happened-in-nepal-s-himalayas-and-what-comes-next
* Spotlight Nepal / IPPAN hydropower damage — spotlightnepal.com/2026/08/26/700-mw-hydropower-solar-projects-damaged-bhotekoshi-floods/
* Zhang T.-G. et al. 2026, ACCR — doi:10.1016/j.accre.2026.06.022 (Purepu/Nielangpu 2025); Xu et al. EGUsphere-2026-4065
* ICIMOD/UNDP 2020, Inventory of glacial lakes and identification of PDGLs (Koshi, Gandaki, Karnali) — nepal.un.org PDF (read)
* Reuters via The Star, 3 Oct 2026 — Nepal to drain four glacial lakes
* Wang X. et al. 2020, ESSD 12:2169 — doi:10.5194/essd-12-2169-2020; RGI 7.0 — doi:10.5067/f6jmovy5navz
* Shrestha et al. 2023 ESSD 15:3941 (HMAGLOFDB); Lützow et al. 2023 ESSD 15:2983

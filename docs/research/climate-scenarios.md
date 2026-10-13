# Deluge — Future-climate scenarios: sources and method

What the **Future climate** control (Weather & rivers) and the Site check's **Today vs future** comparison do, and
where every number comes from. Implemented in [`src/climate`](../../src/climate) (pure tables and arithmetic), applied
by [`src/app/climate.ts`](../../src/app/climate.ts) and [`src/app/simSync.ts`](../../src/app/simSync.ts), and shown
by [`src/ui/climatePanel.ts`](../../src/ui/climatePanel.ts) and [`src/ui/siteClimate.ts`](../../src/ui/siteClimate.ts).
Tested in `tests/climate`, end to end in `scripts/e2e.mjs` flow 18. Research done in October 2026.

Tags as in the other research notes: **[V]** read in the primary source (IPCC / NOAA / USACE text, tables or API
JSON), **[S]** secondary (abstract, agency summary, news), **[M]** a modelling assumption made here, **[C]** computed
from tagged numbers.

## 0. What it is, and what it is not

Businesses that build or lend for 30–50 years are asked "what does this site look like in 2050 / 2080?" (IFRS S2
scenario analysis; lender and insurer questionnaires — see [business-case.md](business-case.md) §A.2–A.3).

Deluge answers it by **scaling the forcing, not the flood**: today's storm, rain-fed river inflow or tide is scaled by
a published sensitivity to a future warming level, and the 2-D solver produces the flood. It is **not** a downscaled
climate projection, it does not re-fit return periods, and it never scales a river **stage** (§C).

| Forcing | What the control does | Where |
| --- | --- | --- |
| Uniform rain, storm cells | × (1 + α)^ΔT, ΔT = global warming since 1995–2014 | every scene |
| Rain-fed inflows (discharge and hydrograph) | × the same multiplier [M] | Houston, Asheville, Ellicott City, Boulder, Johnstown's Stonycreek, live areas |
| Dam-break / hazard-chain inflows | unchanged | Johnstown's 1889 surge, Nepal, Chungthang |
| Sea boundary | + NOAA 2022 relative sea-level rise at the gauge, on top of the stage slider | Fort Myers |
| River stage boundary | unchanged (slider still sets it) | Pittsburgh, Nashville |
| Glacial lake behind a chain | area grown with warming → volume (V–A) → chain re-run | Chungthang (South Lhonak) |
| Glacier melt | shown (degree-day), not applied | Himalayan presets |

The layer sits between the store and the solver: the rain slider, the inflow list and the stage slider keep showing
**today's** values, a line under the rain slider says the map gets more, and the Future climate block lists every
modified quantity with its source ("applied" vs "context only").

## A. Warming and extreme rain

### A.1 Global warming by pathway and horizon

AR6 WG1 Table SPM.1 (relative to 1850–1900, best estimate [very likely range]) [V]:

| Scenario | 2021–2040 | 2041–2060 | 2081–2100 |
| --- | --- | --- | --- |
| SSP2-4.5 | 1.5 [1.2–1.8] | 2.0 [1.6–2.5] | 2.7 [2.1–3.5] |
| SSP5-8.5 | 1.6 [1.3–1.9] | 2.4 [1.9–3.0] | 4.4 [3.3–5.7] |

Source: https://www.ipcc.ch/report/ar6/wg1/downloads/report/IPCC_AR6_WGI_SPM.pdf (same values in TS Box TS.1 Table 1).

**Baseline.** Deluge's "Today" is the scenario as it ships, whose storms, gauge levels and return periods come from
records of recent decades. Warming is therefore counted from AR6's recent-past reference period **1995–2014, 0.85 °C
above 1850–1900** [V, AR6 SPM/TS]. For context: 2011–2020 was 1.09 [0.95–1.20] °C (land 1.59 °C) [V, SPM A.1.2];
2015–2024 averaged 1.24 [1.11–1.35] °C and is warming at 0.27 °C/decade [S, Forster et al. 2025, ESSD 17:2641].
So ~0.4 °C of the warming counted here has already happened; "Today" is slightly milder than 2026's climate.

**Horizons** [C]: 2050 = 2041–2060; 2100 = the 2081–2100 mean (the single year 2100 is warmer: linear extrapolation
gives ≈ 2.9 / 4.9 °C above 1850–1900); 2080 is interpolated between the 2050 and 2090 period centres
(mid + 0.75 × (long − mid)).

### A.2 Rain scaling

* AR6 SPM B.2.4 [V]: "extreme daily precipitation events are projected to intensify by about 7 % for each 1 °C of
  global warming (high confidence)". Ch. 11 Executive Summary [V]: the CMIP6 land median for the 50-yr Rx1day is
  "close to 7 % per 1 °C".
* Fig. SPM.6, 10-yr 1-day event over land, vs 1850–1900 [V]: intensity +6.7 % at 1 °C, +10.5 % at 1.5 °C, +14.0 % at
  2 °C, +30.2 % at 4 °C (frequency 1.3×, 1.5×, 1.7×, 2.7×). 1.07^ΔT reproduces these within 1 pp (tested).
* Sub-daily: AR6 Ch. 11 §11.4 [V] — observed "apparent scaling" lies "between the C-C and two-times the C-C rate", with
  the caveat that it mixes thermodynamic and dynamic effects. Lenderink & van Meijgaard 2008 (Nat. Geosci. 1:511)
  ≈ 14 %/°C for hourly extremes above ~12 °C [S]; Fowler et al. 2021 (Nat. Rev. Earth Environ. 2:107) ~7 %/K with
  super-CC in some regions [S].
* Harvey (the Houston preset) for scale: rainfall increased ≥ 18.8 %, best 37.7 % (Risser & Wehner 2017, GRL) and
  ~15 % (8–19 %) (van Oldenborgh et al. 2017, ERL) [S] — both above the 6–7 % CC would give for the ~1 °C of Gulf
  warming, which is why the super-CC options exist.

The control offers **7 %/°C (CC, default)**, **10 %/°C** and **14 %/°C (2×CC)**. The rain multiplier uses **global**
ΔT, because AR6 states the 7 % per degree of global warming; the regional factor (§A.3) is not applied to rain.

### A.3 Regional temperature (readout and melt only)

* Land vs global: AR6's "1.4 to 1.7 times" (SPM B.2.1) is land vs **ocean** [V]. The observed land/global ratio is
  1.59 / 1.09 = **1.46** [C from V]; used for every US preset. NCA5 regional values could not be retrieved for this
  release (site unreachable), so no region-specific US factor is claimed.
* Hindu Kush Himalaya: 1.5 °C global → 1.80 ± 0.40 °C in the HKH, ≥ 0.7 °C more in the NW Himalaya / Karakoram (HKH
  Assessment 2019, ch. 3) [V] → **1.2×**. Kraaijenbrink et al. 2017 (Nature 549:257): 2.1 °C in High Mountain Asia at
  1.5 °C (1.4×); glacier ice loss by 2100 36 % at 1.5 °C, 49 ± 7 % RCP4.5, 64 ± 5 % RCP8.5 [S].

### A.4 The table the app uses [C]

ΔT since 1995–2014 (very likely range) and rain multipliers (1+α)^ΔT:

| Horizon · pathway | ΔT °C | × at 7 % | × at 10 % | × at 14 % | Fort Myers SLR m | South Lhonak (from 1.674 km²) | Extra ice melt mm w.e./d |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2050 SSP2-4.5 | 1.15 (0.75–1.65) | 1.081 | 1.116 | 1.163 | 0.28 | 2.94 km² ×1.76 → V ×2.28 | 10.3 |
| 2080 SSP2-4.5 | 1.68 (1.13–2.40) | 1.120 | 1.174 | 1.246 | 0.49 | 3.35 km² ×2.00 (cap) → V ×2.75 | 15.1 |
| 2100 SSP2-4.5 | 1.85 (1.25–2.65) | 1.133 | 1.193 | 1.274 | 0.62 | cap | 16.7 |
| 2050 SSP5-8.5 | 1.55 (1.05–2.15) | 1.111 | 1.159 | 1.225 | 0.32 | cap | 13.9 |
| 2080 SSP5-8.5 | 3.05 (2.10–4.18) | 1.229 | 1.337 | 1.491 | 0.70 | cap | 27.4 |
| 2100 SSP5-8.5 | 3.55 (2.45–4.85) | 1.271 | 1.403 | 1.592 | 1.10 | cap | 31.9 |

The panel shows the multiplier's range over the very likely ΔT range (e.g. 2050 SSP5-8.5 at 7 %: 1.07–1.16).

NOAA Atlas 15 (nonstationary precipitation frequency, with future "adjustment factors" in Volume 2) is not yet
usable here: Montana pilot released 26 Sep 2024; CONUS preliminary estimates "no earlier than September 2026",
published no earlier than September 2027 [V HDSC progress report May 2026; S water.noaa.gov/about/atlas15]. When it
lands, its adjustment factors should replace §A.2 for US rain.

## B. Sea level (Fort Myers)

NOAA 2022 Technical Report (Sweet et al., NOS 01) [V]: contiguous-US relative SLR in 2050 0.31–0.52 m and in 2100
0.6–2.2 m across Low…High (2000 baseline); GMSL 2100 0.3 / 0.5 / 1.0 / 1.5 / 2.0 m. Eastern Gulf 2100 medians 0.6 /
0.8 / 1.2 / 1.7 / 2.2 m (Table 2.5) [V].

Station medians from the CO-OPS API (`slr_projections`, station 8725520, report_year 2022, metric), in m [V]:

| Scenario | 2050 | 2080 | 2100 |
| --- | --- | --- | --- |
| Low | 0.24 | 0.36 | 0.43 |
| Intermediate-Low | 0.28 | 0.49 | 0.62 |
| Intermediate | 0.32 | 0.70 | 1.10 |
| Intermediate-High | 0.38 | 1.00 | 1.58 |
| High | 0.45 | 1.33 | 2.09 |

Naples 8725110 agrees within 1 cm. **The API series is zeroed at 2005**, though the report text says a 2000 baseline
(the difference is ~2–4 cm here) [V/M]; Deluge uses the API values from 2005 and interpolates linearly between years.

**Pathway mapping.** Report pp. 20–21 [V]: 2 °C in 2081–2100 → 2100 GMSL median ~0.5 m, "consistent with the
Intermediate-Low scenario"; 4 °C → ~0.7 m, "between the Intermediate-Low and Intermediate scenarios, with the upper
end of the likely range approaching the Intermediate"; Intermediate-High and High need "deeply uncertain ice-sheet
processes". Deluge maps **SSP2-4.5 → Intermediate-Low** and **SSP5-8.5 → Intermediate** — the latter deliberately at
the cautious end of the 4–5 °C likely range [M] (an interpolated SSP5-8.5 median would be ≈ 0.92 m at Fort Myers in
2100 [C]). Intermediate-High is a stress case the control does not offer.

**How it is applied.** The rise is an offset on the Gulf stage boundaries on top of the stage slider
(`App.climate.stageShift`, added to the applied stage offset the solver and the channel lift see), so a rise lifts the
connected water at once, like a stage raise; the slider and its gauge readout keep today's meaning. In the Site check
the tide ladder (NOAA Extreme Water Levels, src/loss/ladders.ts) is re-run with the sea that much higher: today's
1-in-T surge on a higher sea. The EWL statistics sit on the 1983–2001 tidal epoch, a decade before the 2005 zero, so
the future rise is if anything slightly understated.

## C. Rivers: why no stage is scaled

A river stage is the hydraulics' answer, not a forcing. AR6 Ch. 11 [V]: increases in extreme rainfall "may not always
result in an increase in river floods". Rating curves are nonlinear — for a wide channel under Manning, h ∝ Q^0.6, so
+20 % discharge is ≈ +11.6 % depth in bank and less once the water spreads overbank [C] — and Pittsburgh's and
Nashville's crests are also set by flood-control reservoirs (ladders.ts). So:

* Pittsburgh and Nashville: the climate control scales their rain only; the stage slider and the stage ladders are
  unchanged, and the Site check refuses a today-vs-future comparison on a stage ladder (it says why).
* Published basin projections, for reference only: USACE Ohio River Basin Climate Change Pilot Report (May 2017, CWTS
  2017-01) [V] — flows through 2040 "within the range of historic base conditions" (autumn −5 to −15 %); 2040–2099
  "increases … in the mean and mean maximum flows, generally in the 10–40 % range", up to +50 % in sub-basins NE, E and
  S of the Ohio, up to −50 % N and W; annual-maximum flows +15–35 % at some local protection projects for 2011–2040.
  CMIP3 / SRES A1B–A2, no 100-yr discharges given. A future version could raise an inflow-driven Ohio scenario by
  these, but not the stage.
* Rain-fed inflows elsewhere are scaled with the rain [M]: peak discharge is taken to follow the rain that makes it.
  A saturated catchment passes extra rain on nearly 1:1; a dry one less — and storage and dynamics can go either way.

## D. Glacial lakes and melt

### D.1 Observed growth

| Lake | Area time series | Source |
| --- | --- | --- |
| South Lhonak (Sikkim) | 0.175 km² (1977); ≈ 0.99 km² (2008, +81.1 ha); 0.42 → 1.35 km² (1990 → 2019); 1.674 km² on 28 Sep 2023 → 0.603 km² on 4 Oct 2023 after the GLOF | Raj et al. 2013 via Wikipedia [S]; news [S]; NRSC via SANDRP [S] |
| Imja Tsho | ~0.03 km² ponds (1962); ~0.8 (2000); 1.055 (2009); 1.33 km² (2017); +0.04 km²/yr; volume 35.8 → 61.7 Mm³ (2002 → 2012) | Wikipedia [S]; Haritashya et al. 2018 [S]; Somos-Valenzuela et al. 2014 [S] |
| Tsho Rolpa | ~0.23 km² (1959); 1.4 (1993); 1.53 (2000, after lowering); 1.61 km² (2019) | Himal [S]; ISPRS Annals V-3-2020:633 [V] |
| Thulagi (Dona) | 0.76 (1995) → 0.94 km² (2009); 0.89 km² (2017), "almost stable for about two decades" | ICIMOD blog [S]; Haritashya 2018 [S] |
| High Mountain Asia | 1,806 → 2,080 km² (1990 → 2018, +15.1 %) | Wang et al. 2020, ESSD 12:2169 [S] |
| Global | lake volume +48 % to 156.5 km³ (1990–2018) | Shugar et al. 2020, Nat. Clim. Change 10:939 [S] |

GLOF risk in the Third Pole "will potentially almost triple" (Zheng et al. 2021, Nat. Clim. Change 11:411) [S].

### D.2 The model [M]

South Lhonak grew ≈ 0.046 km²/yr over 2008–2023 [C] while the world warmed ≈ 0.025 °C/yr [S]. Lake growth follows
glacier retreat, which follows temperature, so the area grows **in proportion to warming**:
ΔA = (0.046 / 0.025) km² per °C × ΔT(2023 → horizon) — 1.84 km² per °C, where ΔT is read off the pathway's warming
curve (piecewise linear through the AR6 periods). No survey of the overdeepened basin the lake could fill is published,
so growth is **capped at 2× the 2023 area** [M]; the cap is reached by 2050 under SSP5-8.5 and by ~2080 under SSP2-4.5
(table A.4). Volume follows from the same V–A relations the chain uses (geometric mean of Huggel 2002, Cook & Quincey
2015 and Sakai 2012; V ∝ A^1.38–1.53 [V Cook & Quincey 2015 Tables 1–2]): ×1.76 area → ×2.28 volume, ×2 → ×2.75.

That factor multiplies the chain's source volume **on top of** the baked member and the chain panel's what-if, and the
chain is re-run through the existing controller (`HazardChainController.setClimateVolumeFactor`): the routed wave,
the inflow on the map and the ensemble bands all follow. It is a what-if — the real lake drained to 0.6 km² in 2023
— answering "had the lake kept growing".

Nepal (Lirung ice-rock avalanche into the river) has no lake: nothing in its chain is scaled.

### D.3 Melt (context only)

Degree-day factor for clean ice above 5,000 m 7.5 mm w.e. °C⁻¹ d⁻¹ (Parajuli et al. 2015 [V], as in
glacier-hazard-chain.md §F); Dokriani 7.33, Khumbu bare ice up to 16.9 [S/V]. The panel shows DDF × local ΔT (HKH
1.2× global): +14 mm w.e./day in the melt season at 2050 SSP5-8.5 — roughly +2 m w.e. a year over a 150-day season
[C]. Melt is a slow forcing (baseflow, lake filling), not a flood wave (glacier-hazard-chain.md §F.2), so it is not
added to the flood.

## E. Site check: EAL today vs future

**Today vs future** runs the ticked ladder twice — the climate layer at Today, then at the selected climate — and
shows per level the loss today and in the future, and "EAL today $X → 2050 · SSP5-8.5 $Y (+Z %)". Return periods are
**today's**: the future run is "today's 1-in-T event with this climate's forcing", not a re-fitted frequency curve
(which is what makes an EAL change honest only as a forcing-scaled indication). Available on forcing ladders (rain /
inflows) and the Fort Myers tide ladder; not on river-stage ladders (§C) or chain presets (the chain re-runs
asynchronously — apply the climate and sweep instead). The comparison also goes into the printed / HTML site report.

Measured (e2e flow 18, Houston, a lot under ~1.2 m after 10 min of Harvey's 173 mm/hr, ladder × 0.5 = 10-yr and
× 1 = 100-yr as user inputs, 10 sim-min per level, 7 %/°C): EAL today $163 k–$200 k a year → 2050 · SSP5-8.5
$166 k–$203 k (+2 %); the 100-yr level's loss $3.6 M → $3.7 M. Small, because the lot is already deep under today's
storm; a lot at the flood's edge moves much more.

**Run-length noise.** Each headless sweep run overshoots the asked time by up to a readback (measured: 614–696 s for
600 s asked), and a rain-driven loss keeps growing with time, so at 2050 the overshoot can move a level's loss as much
as the climate does (repeat runs of the same comparison gave +2 %, +18 % and, once, −30 %). The block shows a warning
when a level's two runs differ in length by more than 5 %; longer levels shrink the effect. A fix belongs in the
sweep machinery (stop stepping once the asked time is reached), not here.

## F. Known gaps

* No downscaling, no change in storm frequency, track or duration; no compound rain + surge in one run.
* Inflow ∝ rain is an assumption; real basins can amplify or damp it.
* The 1995–2014 baseline understates the change from 2026 by ~0.4 °C of warming already realised (i.e. the 2050
  multiplier is the change since the reference period, not since today).
* NCA5 US regional warming factors not verified (the land average is used); Atlas 15 not yet integrated.
* South Lhonak's growth law and 2× cap are assumptions; no basin survey.
* NOAA station series zero (2005) vs report baseline (2000) unresolved in the documentation.

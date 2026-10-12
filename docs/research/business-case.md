# Deluge for Business: implementation-ready spec and business case

*Research date: 2026-10-12. Scope: market, competitors, loss-model methods (with numeric tables ready to paste into TypeScript), building valuation, product concept, customer stories, pitch.*

**Confidence key:** [V] = verified against a primary source in this session (for example, values extracted directly from the JRC spreadsheet). [S] = secondary source (press, blog, law-firm alert, market-research summary). [M] = from domain memory, not re-verified this session, so **verify before shipping**. [I] = illustrative assumption I made up for a worked example.

---

## 0. TL;DR recommendations

1. **Position Deluge as "the flood what-if engine", not "another risk score".** Incumbents (First Street, Jupiter, Fathom, XDI, Moody's RMS, Verisk) sell precomputed hazard layers and scores. None of them lets a non-specialist **draw a levee, re-run the flood in seconds and see the dollars change** in a browser tab. Own the *mitigation design + communication* moment: the board meeting, the grant application, the lender Q&A.
2. **Ship a loss layer first. It is about 1–2 weeks of TypeScript.** The JRC global depth–damage curves (Section C.1, extracted verbatim from the official spreadsheet) give per-continent and per-occupancy damage fractions. The JRC country construction costs (C.1.3) turn footprints into dollars. The GPU solver already stores max depth (`stateTexture.a`). Add max velocity, max d·v, first-wet time and wet duration as accumulators.
3. **Every asset gets six numbers:** max depth, max velocity, hazard class (AIDR H1–H6 and the UK HR), first-wet time (lead time), damage %/$, and downtime days. A portfolio rolls up to loss, EAL and "top 10 assets at risk".
4. **Mitigation ROI is the killer feature.** Draw a levee, then compute avoided loss, EAL delta, NPV at 7% (the FEMA default again since June 2025) and 3.1%, and the BCR. Export it as a FEMA-BCA-style appendix. A worked Houston example (Section E.4) gives BCR ≈ 1.9 for a permanent wall and ≈ 8.7 for deployable barriers.
5. **GLOF/glacier cascades are a defensible wedge.** No mainstream commercial vendor offers interactive GLOF routing for hydropower. Recent events are large: Teesta-III 1,200 MW destroyed (2023; ₹11,400 cr claim reported [S]), Chamoli 2021 (₹1,500 cr at Tapovan [S]), Nepal Aug-2026 (431 MW of generation severely damaged, $4–5 B reconstruction estimate [S]). A 2016 study found 177 of ~257 Himalayan hydropower plants on GLOF paths [S].
6. **Pricing hypothesis:** free public scenarios; Pro at $149–$399/seat/month; Team/Enterprise at $25k–$90k/yr (anchored under ICEYE's €34k entry tier and Climate X's $31.5k/yr [S]); per-project "Grant/BCA pack" at $5k–$15k; API/ensemble at metered prices.
7. **Be honest about regulation.** The SEC climate rule is dead and California SB 261 has been enjoined since Nov 2025. CSRD scope shrank to companies with >1,000 employees and >€450 M turnover. The ISSB/IFRS S2 tailwind is international (35 jurisdictions adopted as of Jul 2026 [S]). Don't lead with compliance in the US; lead with **avoided loss, lender/insurer questions and grant money**. BRIC was court-restored, with a $1 B NOFO that closed Jul 2026 [S].

---

## A. Market: who buys flood and physical-risk analytics, and why

### A.1 Market size (all figures [S]; definitions differ widely, so quote ranges, not a single number)

| Segment | Figure | Source |
|---|---|---|
| Climate risk analytics (narrow) | $1.80 B (2025) → $7.7 B (2034), 17.6% CAGR | Fortune Business Insights — https://www.fortunebusinessinsights.com/markt-f-r-klimarisikoanalysen-116031 |
| Climate financial data & analytics (buyer spend, more conservative) | $751 M (2025) → $1.1 B (2031), 7% CAGR | Verdantix — https://www.verdantix.com/insights/report/market-size-and-forecast--climate-financial-data-and-analytics-2025-2031-global |
| Climate risk management (broad) | $7.4 B (2025) → $30.3 B (2035), 14.8% CAGR | GMI — https://www.gminsights.com/industry-analysis/climate-risk-management-market |
| Climate risk management, physical-risk share | ~66% of a $3.85 B (2025) market | NextMSC — https://www.nextmsc.com/report/climate-risk-management-market-ic5516 |
| Climate risk analytics platforms | +$1.15 B incremental 2025–2030, 17.8% CAGR | Technavio — https://www.technavio.com/report/climate-risk-analytics-platforms-market-industry-analysis |
| Parametric insurance | $18.2–19.4 B GWP (2025); Mordor gives $3.5 B (narrow definition) | GMI https://www.gminsights.com/industry-analysis/parametric-insurance-market ; DataM https://www.datamintelligence.com/research-report/parametric-insurance-market |
| Modeled global insured nat-cat AAL (the loss pool cat models price) | $152 B (2025 report) → $171 B (2026 report) | Verisk — https://www.verisk.com/company/newsroom/$152-billion-and-rising-new-report-shows-insurance-industry-facing-growing-average-annual-losses-from-natural-catastrophes/ ; https://www.verisk.com/4a5589/siteassets/media/campaigns/gated/catastrophe-and-risk-solutions/verisk-2026-global-modeled-catastrophe-losses-report.pdf |

**Take-away:** the realistic software spend pool for *physical climate analytics* is **~$0.75–1.8 B/yr in 2025, growing 7–18%/yr**. It sits on top of a ~$150–170 B/yr modeled insured loss pool. Flood is typically the #1 or #2 peril by count.

### A.2 Buyer segments and their concrete "job to be done"

| Segment | Why they buy | What Deluge must output | Fit for Deluge (1–5) |
|---|---|---|---|
| **Insurers / reinsurers / MGAs** | Underwriting (per-address depth), accumulation (portfolio in footprint), event response (claims triage), pricing of flood where NFIP take-up is tiny (WNC: ~1–5% of homes insured for Helene [S]) | Per-asset depth/damage, event footprints, ensembles → EP curve | 3 (they own cat models; buy *event response* and *new-region* views) |
| **Parametric insurers / brokers** (Floodbase, Descartes, FloodFlash, Aon) | Trigger design and basis-risk analysis: "if the gauge reads X, what floods?" | Fast ensembles mapping trigger metric → depth at insured sites | 4 |
| **Banks & asset managers** | ISSB/IFRS S2 (35 jurisdictions [S]), ECB/PRA supervisory expectations, CSRD/ESRS E1 (now >1,000 employees and >€450 M turnover, FY2027+ [S]), GRESB for real assets | Portfolio physical-risk metrics, scenario narrative, asset-level explainability | 3 (need scale and climate-scenario conditioning) |
| **Real estate / REITs / developers** | Acquisition due diligence, capex planning, lender/insurer questions, GRESB | Site-level depth/velocity, mitigation ROI, visual report | **5** |
| **Utilities & hydropower** | GLOF/flash-flood exposure of headworks, powerhouses, substations; dam safety; lender E&S (IFC PS4) | Arrival time, peak depth/velocity at each structure, cascade scenarios | **5 (wedge)** |
| **Logistics / supply chain / manufacturing** | Site selection, BI and contingent-BI (Baxter North Cove: 60% of US IV fluids, $100–190 M Q4-2024 revenue hit estimated [S]) | Downtime, access loss (flooded roads), lead time | **5** |
| **Data centers** | Site selection, substation/fiber access, uptime SLAs | Depth at critical equipment elevations, access routes | 4 |
| **Municipalities / counties / engineers** | FEMA HMA/BRIC/FMA grants need a BCA; BRIC restored by court order, $1 B FY24/25 NOFO, applications closed 2026-07-23 [S] | Before/after mitigation loss, BCR at 7% and 3.1%, maps for public meetings | **5** |
| **Hospitals / health systems** | CMS emergency-preparedness rule, continuity, water/power/access | Access routes, utility exposure, lead time | 4 |

### A.3 Regulatory status as of Oct 2026 (state it accurately in sales material)

- **US SEC climate rule:** the SEC voted in March 2025 to stop defending it, so it is effectively dead [M].
- **California SB 261** (biennial climate-risk report, >$500 M revenue): the **Ninth Circuit enjoined enforcement on 2025-11-18** and heard oral argument on 2026-01-09. No merits ruling turned up in the search, so check the docket (No. 25-5327). SB 253 (emissions) proceeds, with a first deadline of 2026-08-10. Sources: https://www.whitecase.com/insight-alert/california-climate-disclosure-laws-ninth-circuit-temporarily-halts-sb-261-and-carb ; https://www.foley.com/insights/publications/2026/01/ninth-circuit-hears-oral-argument-in-challenge-to-california-climate-disclosure-l/
- **EU CSRD (Omnibus I):** political agreement 2025-12-09. Scope is EU companies with **>1,000 employees and >€450 M turnover**, and non-EU groups with >€450 M EU turnover; it applies from FY starting 2027-01-01. ESRS is being simplified, so the E1 physical-risk datapoints may shrink. Sources: https://www.mofo.com/resources/insights/251222-eu-sustainability-omnibus-i-detailed-omnibus ; https://www.aoshearman.com/en/insights/agreement-on-the-csrd-cs3d-omnibus-package-key-changes-and-implications
- **ISSB / IFRS S2:** 35 jurisdictions adopted (voluntary or mandatory) as of 2026-07-22, with 11 more planning to [S]. S2 requires physical-risk disclosure and scenario analysis. https://www.spglobal.com/sustainable1/en/insights/research-reports/issb-q3-2026
- **FEMA BCA:** OMB revoked the 2024 A-94 update on 2025-04-08. The BCA Toolkit default **reverted from 3.1% to 7%** on 2025-06-04 for HMA projects not yet awarded. https://www.floods.org/?p=306755 ; https://iem.com/?p=39773
- **FEMA BRIC:** termination was ruled unlawful (D. Mass., 2025-12-11) and an enforcement order followed in Mar-2026. The FY24+FY25 NOFO of $1 B closed 2026-07-23. https://www.everycrsreport.com/files/2026-03-10_IN12609_78ea9dfb9eb809875111eb861d2febebe5da2eee.html ; https://www.gza.com/insights/femas-building-resilient-infrastructure-and-communities-bric-grants-ordered-be-restored

**Implication:** in the US, sell on **economics** (avoided loss, insurance and lender questions, grant capture). In the EU, UK, Australia, Singapore and Japan, ISSB/S2 is a real but slower tailwind.

---

## B. Competitors and positioning

Public pricing is rare. Data points found: **ICEYE Flood Insights from €34,000/yr** (insurers with <€300 M nat-cat GWP) [S, https://www.iceye.com/solutions/insurance/flood-rapid-impact]; **Climate X Spectra $31,500/yr**, Regrid ~$12k/yr/state [S, https://batchdata.io/blog/climate-risk-real-estate-apis-buyer-guide]; ClimateCheck gives free consumer ratings with enterprise pricing undisclosed [S]; ProtectMyZip sells a $12 consumer report [S].

| Vendor | What it is | Positioning / notes | Where Deluge differs |
|---|---|---|---|
| **Fathom (Swiss Re, acq. Dec-2023)** | Global flood hazard maps (fluvial/pluvial/coastal), US flood map, cat models | Reinsurance-grade data; keeps its brand inside Swiss Re Reinsurance Solutions. https://www.swissre.com/press-release/Swiss-Re-acquires-Fathom-a-leader-in-water-risk-intelligence/4af5e0d7-e065-404a-b80d-6f32955f0fbe | Static return-period rasters; no interactive mitigation |
| **First Street** | US (now global) property-level Risk Factor scores, Climate Risk API, Enterprise API, Raster Map API | Mortgage, real-estate and insurance data; pricing behind sales. https://apis.io/providers/first-street/ | Scores, not what-if. Deluge can *explain* a First Street score visually |
| **Jupiter Intelligence** | ClimateScore Global, asset-level multi-peril, scenario-conditioned | Banks, PE, GRESB; added an "avoided loss / ROI across 10+ adaptation strategies" tool (Jul-2025). https://www.businesswire.com/news/home/20250723646042/en/Jupiter-Intelligence-Establishes-New-Standard-for-Investment-Grade-Climate-Analytics | Closest on adaptation ROI, but parametric/statistical. Deluge shows *physics* of the specific wall |
| **ICEYE** | SAR-satellite observed flood extent and depth within hours of peak | Insurers' claims and event response; from €34k/yr | Observation, not prediction. Deluge = before the event + what-if; ICEYE = after |
| **Moody's RMS** (acq. 2021, ~$2 B [M]) / **Verisk (ex-AIR)** | Probabilistic cat models (NA inland flood, etc.), Touchstone / Intelligent Risk Platform | Regulatory-grade EP curves; six- to seven-figure licenses [M, not public] | Deluge is not a cat model. Complement it with visualization of specific events and mitigation |
| **KatRisk** | US and global inland flood and surge hazard/cat models (SpatialKat, SoloKat) | Insurer/MGA pricing [M] | Same |
| **JBA Risk Management** | Global flood maps and cat models, strong in UK/EU/Asia | Insurers, banks, governments [M] | Same; JBA has Asia coverage. Deluge's GLOF cascade is a gap for JBA |
| **Floodbase (ex-Cloud to Street)** | Satellite flood monitoring and parametric flood triggers; 9,000+ policies, 40+ countries; $5 M raise Feb-2025, ~$17 M total | Parametric programs with Swiss Re CorSo, Liberty Mutual Re, AXA Climate. https://fintech.global/2025/02/25/floodbase-raises-5m-to-expand-data-driven-flood-insurance-solutions/ | Deluge can do *trigger design* (simulate what a gauge reading means spatially) |
| **7Analytics** (Norway) | Pluvial/flash-flood and ground-water risk for insurers and municipalities, ML + hydrology [M] | Nordic insurers, real estate | Deluge is interactive and global DEM |
| **XDI (Cross Dependency Initiative)** | Asset-level physical-risk ratings for banks and governments (Australia origin) [M] | Bank/mortgage portfolios, sovereign | Scores; no hydrodynamics |
| **ClimateCheck** | Consumer and enterprise property climate ratings; integrations (e.g., Dye & Durham UK) [S] | Real-estate / environmental due diligence | Scores |
| **Engineering tools** (HEC-RAS 2D, TUFLOW, MIKE, InfoWorks ICM, Flood Modeller) | Professional hydraulic models | Desktop, expert-only, hours per run, licenses | Deluge = minutes, browser, no install, non-expert UX; *not* a replacement for a design-grade study |

### B.1 Gaps Deluge can own

1. **Interactive what-if mitigation in the browser.** Draw a levee, berm or wall; the flood re-runs live; avoided loss, BCR and "protected land" update. Nobody in the score vendors does this, and engineers do it in HEC-RAS over days.
2. **GPU speed makes ensembles cheap.** Run 50–200 variants (stage, rain intensity, Manning n, breach location, GLOF volume) on one laptop GPU to produce an exceedance curve and uncertainty bands per asset. It explains uncertainty instead of hiding it.
3. **Glacier and GLOF cascades** (ice/rock avalanche → lake → dam break → downstream run-out) on Copernicus DEM, routed to hydropower structures, with arrival time. 2023 Sikkim, 2021 Chamoli, 2025 Rasuwa and 2026 Bhote Koshi/Trishuli show the demand; commercial supply is near zero.
4. **Explainability and visual communication.** 3D city, water moving between real buildings, evacuation routes re-planning. This works for boards, councils, lenders and grant reviewers.
5. **No install, private by design.** Static site, offline-capable, and the portfolio CSV never leaves the browser. That is a security story for banks and insurers ("your asset list never touches our servers").
6. **Lead time / first-wet arrival time** per asset is rarely provided by score vendors and is directly actionable: shut gates, move inventory, evacuate.

**Honest limits** (put these in the product): Deluge is a 2D shallow-water screening model. DEM resolution, missing channel bathymetry, culverts/storm drains and the levees that already exist drive error. It is not a FEMA FIRM, not a regulatory study and not a probabilistic cat model with a validated stochastic event catalog. Present outputs as *scenario* results, with stated uncertainty.

---

## C. Loss-modelling methods implementable client-side (TypeScript)

### C.1 JRC global depth–damage functions (Huizinga, de Moel & Szewczyk 2017) [V]

Source: *Global flood depth-damage functions: Methodology and the database with guidelines*, EUR 28552 EN, doi:10.2760/16510. Spreadsheet: https://publications.jrc.ec.europa.eu/repository/bitstream/JRC105688/copy_of_global_flood_depth-damage_functions__30102017.xlsx (landing page https://publications.jrc.ec.europa.eu/repository/handle/JRC105688). **The values below were extracted programmatically from the "Damage functions" tab of that file in this session, rounded to 4 dp.**

Damage fraction (0–1) of the **maximum damage value** at depth d (m). "—" means no curve exists for that continent; fall back to GLOBAL, then EUROPE. NA residential is non-zero at 0 m because it derives from HAZUS (first-floor offset). Clamp to 0 when the asset is dry.

Depths: `[0, 0.5, 1, 1.5, 2, 3, 4, 5, 6]`

**Residential buildings**
| Continent | 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|---|---|
| Europe | 0 | 0.25 | 0.40 | 0.50 | 0.60 | 0.75 | 0.85 | 0.95 | 1 |
| North America | 0.2018 | 0.4433 | 0.5828 | 0.6825 | 0.7840 | 0.8543 | 0.9237 | 0.9585 | 1 |
| Centr. & S. America | 0 | 0.4909 | 0.7113 | 0.8420 | 0.9494 | 0.9836 | 1 | 1 | 1 |
| Asia | 0 | 0.3266 | 0.4941 | 0.6166 | 0.7207 | 0.8695 | 0.9315 | 0.9836 | 1 |
| Africa | 0 | 0.2199 | 0.3782 | 0.5306 | 0.6356 | 0.8169 | 0.9034 | 0.9572 | 1 |
| Oceania | 0 | 0.4754 | 0.6404 | 0.7146 | 0.7877 | 0.9288 | 0.9674 | 0.9828 | 1 |
| Global | — | | | | | | | | |

**Commercial buildings**
| Continent | 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|---|---|
| Europe | 0 | 0.15 | 0.30 | 0.45 | 0.55 | 0.75 | 0.90 | 1 | 1 |
| North America | 0.0184 | 0.2393 | 0.3742 | 0.4663 | 0.5521 | 0.6871 | 0.8221 | 0.9080 | 1 |
| Centr. & S. America | 0 | 0.6115 | 0.8395 | 0.9236 | 0.9920 | 1 | 1 | 1 | 1 |
| Asia | 0 | 0.3768 | 0.5377 | 0.6593 | 0.7628 | 0.8833 | 0.9419 | 0.9808 | 1 |
| Oceania | 0 | 0.2390 | 0.4812 | 0.6738 | 0.8646 | 1 | 1 | 1 | 1 |
| Global | 0 | 0.3233 | 0.5065 | 0.6346 | 0.7443 | 0.8641 | 0.9328 | 0.9777 | 1 |

**Industrial buildings**
| Continent | 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|---|---|
| Europe | 0 | 0.15 | 0.27 | 0.40 | 0.52 | 0.70 | 0.85 | 1 | 1 |
| North America | 0.0257 | 0.3229 | 0.5114 | 0.6371 | 0.7400 | 0.8600 | 0.9371 | 0.9800 | 1 |
| Centr. & S. America | 0 | 0.6670 | 0.8887 | 0.9467 | 1 | 1 | 1 | 1 | 1 |
| Asia | 0 | 0.2832 | 0.4816 | 0.6292 | 0.7172 | 0.8567 | 0.9086 | 0.9553 | 1 |
| Africa | 0 | 0.0627 | 0.2472 | 0.4033 | 0.4945 | 0.6847 | 0.9186 | 1 | 1 |
| Global | 0 | 0.2971 | 0.4798 | 0.6033 | 0.6943 | 0.8203 | 0.9229 | 0.9871 | 1 |

**Transport** (roads/rail land use)
| Continent | 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|---|---|
| Europe | 0 | 0.3167 | 0.5417 | 0.7017 | 0.8317 | 1 | 1 | 1 | 1 |
| Centr. & S. America | 0 | 0.0877 | 0.1754 | 0.5965 | 0.8421 | 1 | 1 | 1 | 1 |
| Asia | 0 | 0.3575 | 0.5719 | 0.7333 | 0.8472 | 1 | 1 | 1 | 1 |
| Global | 0 | 0.2540 | 0.4297 | 0.6772 | 0.8403 | 1 | 1 | 1 | 1 |

**Infrastructure – roads**
| Continent | 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|---|---|
| Europe | 0 | 0.25 | 0.42 | 0.55 | 0.65 | 0.80 | 0.90 | 1 | 1 |
| Asia | 0 | 0.2144 | 0.3728 | 0.6039 | 0.7097 | 0.8084 | 0.8872 | 0.9688 | 1 |
| Global | 0 | 0.2322 | 0.3964 | 0.5770 | 0.6798 | 0.8042 | 0.8936 | 0.9844 | 1 |

**Agriculture**
| Continent | 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|---|---|
| Europe | 0 | 0.30 | 0.55 | 0.65 | 0.75 | 0.85 | 0.95 | 1 | 1 |
| North America | 0.0186 | 0.2678 | 0.4737 | 0.5506 | 0.6022 | 0.7601 | 0.8741 | 0.9541 | 1 |
| Asia | 0 | 0.1350 | 0.3700 | 0.5240 | 0.5580 | 0.6600 | 0.8340 | 0.9880 | 1 |
| Africa | 0 | 0.2429 | 0.4718 | 0.7414 | 0.9167 | 1 | 1 | 1 | 1 |
| Global | 0 | 0.2364 | 0.4664 | 0.6165 | 0.7067 | 0.8175 | 0.9145 | 0.9855 | 1 |

**Uncertainty (1σ, same depths)** is in the sheet. Asia residential σ ≈ 0.25, 0.22, 0.21, 0.21, 0.17, 0.12, 0.05, 0 at 0.5…6 m; NA residential σ ≈ 0.14–0.17. Use these for P10/P90 damage bands in ensemble mode.

> Note: some libraries (e.g., OS-Climate physrisk) multiply these curves by 0.6 to express damage as a fraction of *total insured value* rather than of the JRC "max damage" (https://physrisk.readthedocs.io/en/latest/user_guide/vulnerability/vulnerability_functions/inundation_jrc/onboard.html). Don't double-apply: pick one basis (C.1.3).

#### C.1.2 JRC max-damage values by country (2010 €/m², building-based) [V]

From tabs MaxDamage-Residential/Commercial/Industrial. "Structure" already equals **Construction Cost (CC) × 0.6 (depreciation) × (1 − 0.4 undamageable share)**, as confirmed from the cell formula `CC*Adj!C5*(1-Adj!C17)*Adj!I17`. Content = structure × 0.5 (RES), × 1.0 (COM), × 1.5 (IND).

| Country | RES structure | RES content | RES total | COM structure | COM content | COM total | IND structure | IND content | IND total |
|---|---|---|---|---|---|---|---|---|---|
| **United States** | 552.65 | 276.32 | **828.97** | 572.10 | 572.10 | **1,144.21** | 369.17 | 553.76 | **922.94** |
| **India** | 141.85 | 70.93 | **212.78** | 161.99 | 161.99 | **323.98** | 117.24 | 175.86 | **293.10** |
| **Nepal** | 101.60 | 50.80 | **152.40** | 118.85 | 118.85 | **237.70** | 88.47 | 132.71 | **221.18** |
| Bhutan | 168.38 | 84.19 | 252.57 | 189.92 | 189.92 | 379.83 | 135.48 | 203.22 | 338.70 |
| Pakistan | 125.13 | 62.56 | 187.69 | 144.19 | 144.19 | 288.39 | 105.47 | 158.20 | 263.67 |
| China | 220.11 | 110.06 | 330.17 | 243.52 | 243.52 | 487.03 | 169.83 | 254.75 | 424.58 |

Underlying **construction cost (2010 €/m²)**, from tab MaxDamage-Data: CC = a·GDPpc^b with RES (a=24.078, b=0.3852), COM (33.642, 0.3574), IND (30.824, 0.3249).

| Country | GDP/cap 2010 US$ | RES CC | COM CC | IND CC |
|---|---|---|---|---|
| United States | 48,377 | 1,535.1 | 1,589.2 | 1,025.5 |
| India | 1,417 | 394.0 | 450.0 | 325.7 |
| Nepal | 596 | 282.2 | 330.1 | 245.8 |

**Transport and infrastructure max damage** (€/m² of land use, 2010) use continent average × GDPpc(country) / GDPpc(continent avg) [V formula; my arithmetic]:
- Infrastructure-roads: USA 245 €/m² (given directly). Asia avg 4 €/m² @ $1,913 → India ≈ 2.96, Nepal ≈ 1.25 €/m². This looks implausibly low for Asian roads, so prefer a per-km road replacement cost.
- Transport: Asia avg 209 €/m² @ $2,834 → India ≈ 104.5, Nepal ≈ 43.9. US has no NA value, so the global value applies: 391.7 × 48,377/18,970 ≈ 999 €/m².

Agriculture: value added €/ha (2010): US 320, India 1,147, Nepal 950.

JRC 90% CI on max damage: RES −28%/+53%, COM −31%/+35%, IND −30%/+53%. The spreadsheet's material adjustment factors are mud walls ×0.2, corrugated ×0.6, informal/slum ×0.125, rural ×0.33. **Use these for Nepal/India rural portfolios.**

#### C.1.3 Converting to 2026 USD and choosing a basis

- FX: the sheet uses 0.77 € per US$ (2010) → ×1.30. US CPI-U 2010→2025 ≈ ×1.48 [M]. **Combined US escalator ≈ ×1.9** (flag as approximate).
  - US RES CC ≈ $2,950/m² (≈$274/ft²), COM ≈ $3,050/m², IND ≈ $1,970/m². These are *high* versus 2025 market ranges (warehouse $70–150/ft², retail $120–300/ft², office $150–440/ft², healthcare $250–1,018/ft² [S, contractor blogs, e.g. https://www.clarisdesignbuild.com/2025-update-commercial-construction-cost-per-square-foot-in-the-us]).
- For **India/Nepal, don't escalate by US CPI**, because the INR/NPR depreciated sharply. Market cross-checks:
  - Nepal residential finished cost is NPR 2,200–5,500/ft² (standard NPR 2,800–3,600) ≈ $225–290/m² standard [S, https://gharbanaunecompany.lovable.app/house-construction-cost-nepal ; Kathmandu Post 2026 reports +14% YoY https://kathmandupost.com/money/2026/07/12/what-s-the-cost-of-building-a-home-it-s-getting-more-expensive].
  - India CPWD plinth-area residential is ~₹19,000/m² civil only, plus 15–25% for services ≈ $260–290/m² [S, conflicting sources].
  - JRC×1.9 would give $540–760/m², roughly 2× the market, so **calibrate locally**.
- **Two bases (make it a toggle):**
  - **Economic / JRC (default for public-sector BCA and ESG):** `loss = f(d) × MD_jrc × area`, where MD_jrc already includes depreciation and the undamageable share.
  - **Insurance / replacement cost:** `loss = f(d) × RV × (1 − u)`, where RV = replacement value and u = undamageable share (0.4 for masonry/concrete, 0 for wood/mud). Add contents separately with `f_contents(d) × CV`.

**Recommended Deluge defaults (2026 USD per m² of gross floor area, user-overridable)** [I, derived from the above]

| Occupancy | US | India | Nepal |
|---|---|---|---|
| Residential (house/apartments) | 2,000 | 300 | 270 |
| Retail / commercial | 2,300 | 350 | 320 |
| Office | 3,000 | 450 | 380 |
| Industrial / warehouse | 1,250 | 300 | 250 |
| Hospital | 4,300 | 700 | 550 |
| School / civic / church | 2,700 | 350 | 300 |
| Contents factor (× structure RV) | RES 0.5, COM 1.0, IND 1.5 (JRC) | same | same |

### C.2 US-specific curves (HAZUS / USACE) [M, verify]

Use JRC NA (which is HAZUS-derived) as the default. For US residential "detail mode", the USACE **EGM 01-03** (2000) generic curves are standard. Depth is relative to the **first floor** (feet), so first-floor height (FFH) is needed; default slab 1 ft, crawlspace 3 ft. The values below are from memory and **must be checked** against EGM 01-03 Tables 1–2 before shipping. This session could not retrieve the PDF (FEMA/USACE PDFs were blocked).

| Depth above first floor (ft) | −1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1-story no basement, structure % | 2.5 | 13.4 | 23.3 | 32.1 | 40.1 | 47.1 | 53.2 | 58.6 | 67.2 | 73.2 | 77.2 |
| 1-story no basement, contents % | 2.4 | 8.1 | 13.3 | 17.9 | 22.0 | 25.7 | 28.8 | 31.5 | 35.7 | 38.4 | 39.7 |
| 2-story no basement, structure % | 3.0 | 9.3 | 15.2 | 20.9 | 26.3 | 31.2 | 35.9 | 40.0 | 47.3 | 53.2 | 58.0 |

Sanity anchor [S]: FIA 1970 Curve 01 (1-story no basement) reads ≈22/30/35/39% at 1/2/3/4 ft (https://dnrweblink.state.co.us/CWCB/0/doc/56223/Page28.aspx). Hazus commercial curves (COM1 retail, COM4 office, IND2 light industrial) are in the Hazus Flood Model Technical Manual and the FAST tool (https://www.fema.gov/sites/default/files/documents/fema_flood-assessment-structure-tool.pdf). **Action:** import them from FEMA's open-source `HazusFloodDDF` / FAST CSVs, which ship the DDF lookup tables.

Empirical value of elevation [S]: in Ian (Fort Myers area), NFIP average claim was **$50,287 for elevated vs $158,291 for non-elevated** structures (https://www.insurancejournal.com/news/southeast/2024/02/06/759600.htm via search summary). That is a great "first-floor elevation matters" talking point.

### C.3 Velocity and debris adjustments (structural failure)

Rules, applied per building after the depth curve:

| Condition (depth d m, velocity v m/s, dv m²/s) | Effect | Source / confidence |
|---|---|---|
| dv < 3 or v < 2 (masonry/concrete/brick) | Inundation damage only (depth curve) | Clausen & Clark 1990, as widely cited (e.g., RESCDAM) [M] |
| 3 ≤ dv < 7 **and** v ≥ 2 | Partial structural damage: set damage ≥ max(f(d), 0.5) | Clausen & Clark 1990 [M] |
| dv ≥ 7 **and** v ≥ 2 | Total destruction: damage = 1.0 (structure + contents) | Clausen & Clark 1990 [M]. TU Delft summary: "all types of residences … collapse before hv reaches 7 m²/s" (Clausen 1989) [S, https://repository.tudelft.nl/file/File_2fae8e61-de65-4d41-9166-da81ae93504f] |
| dv 1.5–3 | First structural damage (generic) | GFZ flood damage model notes [S, https://hub.docker.com/r/gfzriesgos/flooddamage] |
| Timber / light frame / informal | Use thresholds ×0.5 (dv ≥ 3 → collapse) | Conservative heuristic [I]. RESCDAM wood-frame thresholds are lower [M] |
| Wall moment failure without velocity | d ≥ 1.2 m (older masonry), 1.8 m (newer); ~0.9 m with v = 2 m/s | Dutch study citing Clausen [S, TU Delft link above] |
| AIDR H5 (dv ≤ 4, d ≤ 4, v ≤ 4) | "All buildings vulnerable to structural damage; some less robust subject to failure" | AIDR 2017 / Smith et al. 2014 [S] |
| AIDR H6 (dv > 4) | "All building types vulnerable to failure" | same |
| Debris-laden flow (GLOF, debris flow) | Multiply effective dv by 1.5 (debris/boulder impact) and treat dv ≥ 3 as collapse for anything not reinforced concrete | Heuristic [I]. Justified by the 2023/2026 Himalayan events where surface powerhouses failed and underground ones survived [S] |

Implementation: the GPU accumulator stores per-cell `maxDV`, plus `maxV`, plus `vAtMaxDV`. Per building, sample the max over its footprint cells.

### C.4 Human hazard ratings

**UK DEFRA/EA FD2321 (Risk to People, 2006):** `HR = d × (v + 0.5) + DF`. Formula confirmed [S, https://help.floodmodeller.com/docs/hazard-mapping]. Debris-factor table and classes below are [M]; they are standard but were not re-retrieved.

| Depth | Pasture/arable | Woodland | Urban |
|---|---|---|---|
| 0 – 0.25 m | 0 | 0 | 0 |
| 0.25 – 0.75 m | 0 | 0.5 | 1 |
| d > 0.75 m and/or v > 2 m/s | 0.5 | 1 | 1 |

A simplified variant used in practice: DF = 0 if d ≤ 0.25, else 1 [S, Flood Modeller risk-to-life page]. Note that the EA 2008 supplementary note recommends the FD2320 simplified approach for development control [S].

| HR | Class | Description |
|---|---|---|
| < 0.75 | Low | "Caution – flood zone with shallow flowing water or deep standing water" |
| 0.75 – 1.25 | Moderate | "Danger for some – includes children, the elderly and the infirm" |
| 1.25 – 2.0 | Significant | "Danger for most – includes the general public" |
| > 2.0 | Extreme | "Danger for all – includes the emergency services" |

**Australian AIDR 2017 / ARR 2019 Book 6 Ch 7 (Smith et al. 2014)** [S, table reproduced in https://egusphere.copernicus.org/preprints/2026/egusphere-2026-4699/egusphere-2026-4699-supplement.pdf and verified by text extraction]:

| Class | Max d (m) | Max v (m/s) | d·v limit (m²/s) | Meaning |
|---|---|---|---|---|
| H1 | 0.3 | 2.0 | ≤ 0.3 | Generally safe for vehicles, people, buildings |
| H2 | 0.5 | 2.0 | ≤ 0.6 | Unsafe for small vehicles |
| H3 | 1.2 | 2.0 | ≤ 0.6 | Unsafe for vehicles, children, elderly |
| H4 | 2.0 | 2.0 | ≤ 1.0 | Unsafe for vehicles and people |
| H5 | 4.0 | 4.0 | ≤ 4.0 | + all buildings vulnerable to structural damage; some less robust fail |
| H6 | — | — | > 4.0 | All building types vulnerable to failure |

Classify as the **lowest class whose three limits are all satisfied**. Show both AIDR (global audiences, buildings) and HR (UK/EU).

```ts
export function aidrClass(d: number, v: number): 1|2|3|4|5|6 {
  const dv = d * v;
  if (d <= 0.3 && v <= 2 && dv <= 0.3) return 1;
  if (d <= 0.5 && v <= 2 && dv <= 0.6) return 2;
  if (d <= 1.2 && v <= 2 && dv <= 0.6) return 3;
  if (d <= 2.0 && v <= 2 && dv <= 1.0) return 4;
  if (d <= 4.0 && v <= 4 && dv <= 4.0) return 5;
  return 6;
}
export function fd2321HR(d: number, v: number, land: 'pasture'|'woodland'|'urban' = 'urban'): number {
  let df = 0;
  if (d > 0.75 || v > 2) df = land === 'pasture' ? 0.5 : 1;
  else if (d > 0.25) df = land === 'pasture' ? 0 : land === 'woodland' ? 0.5 : 1;
  return d * (v + 0.5) + df;
}
```

### C.5 Business interruption (BI) and downtime

The Hazus restoration-time tables were not retrievable (FEMA PDFs blocked). The model below is a transparent heuristic in the Hazus spirit [I]. Show it to users as editable assumptions.

```
downtime_days = max(access_days, site_days)
site_days     = cleanup(d) + repair_frac(damage) × T_rebuild[occ] + utility_days
cleanup(d)    = 0 if d < 0.05; 7 if d < 0.3; 21 if d < 1.0; 45 if d < 2.0; 90 otherwise
repair_frac   = damage fraction (0–1) after velocity adjustment
T_rebuild     = RES 360, COM 270, office 300, IND/warehouse 240, hospital 540, school 360, hydropower 540–720 (days)
access_days   = (from routing) time until a route from the asset to the nearest highway node has all edges
                with d < 0.3 m (passable to trucks); approximate as wet_duration of the worst link
                on the best path + 2 days of debris clearing
utility_days  = user input (e.g., 6+ days municipal water outage, as at Mission Hospital Asheville after Helene)
BI_loss       = downtime_days × daily_gross_profit × (1 − recapture[occ])
recapture     = retail 0.1, office 0.6, industrial 0.4 (Hazus-style) [M]
```

Anchors:
- Harvey: warehouses, refineries and petrochemical plants closed ~1 month; a 1-week closure of a major port ≈ $2.5 B loss [S, UNCTAD https://resilientmaritimelogistics.unctad.org/fr/node/309].
- Hazus county runs show BI ≈ 31–40% of building-related loss [S].
- Baxter North Cove (Helene): ~$2.5 M/day revenue impact estimated by BofA [S, https://www.streetinsider.com/Investing/What+could+Hurricane+Helene+mean+for+BAX/23780047.html].

Deluge already routes evacuations over a `RoadNetwork` with per-edge flood status. Reuse it to compute **access loss** (the edge is impassable when its max depth > 0.3 m for trucks, 0.15 m for cars) and **time-to-reopen** (from the wet-duration accumulator).

### C.6 Expected Annual Loss (EAL) from return-period scenarios

Given N scenarios with return periods T₁ < T₂ < … < T_N, exceedance probabilities pᵢ = 1/Tᵢ (descending), and losses Lᵢ (ascending):

```
EAL = Σ_{i=1}^{N-1} ½ (Lᵢ + Lᵢ₊₁) (pᵢ − pᵢ₊₁)   +   L_N · p_N         (tail: assume loss stays at L_N beyond rarest event)
      + optional low-end term: ½ L₁ · (p₀ − p₁) where p₀ = probability at which damage starts (e.g., 1/2 or the protection standard)
```

- Use a log-spaced set, e.g. T = 2, 5, 10, 25, 50, 100, 250, 500 (8 GPU runs).
- Report the **EAL range** across the tail assumptions (lower bound: tail = 0; upper bound: L_N · p_N).
- Ensemble mode: for each T, run k variants (Manning n ±20%, DEM bias ±0.3 m, peak ±15%) to get P10/P50/P90 loss and EAL bands.
- Warn when the scenario-to-T mapping comes from the user ("I think 46 ft is the 100-yr stage") rather than from a gauge frequency analysis (USGS StreamStats / Bulletin 17C).

```ts
export function eal(points: {T: number; loss: number}[], tail = true): number {
  const s = [...points].sort((a, b) => a.T - b.T);           // frequent → rare
  let e = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const p1 = 1 / s[i].T, p2 = 1 / s[i + 1].T;
    e += 0.5 * (s[i].loss + s[i + 1].loss) * (p1 - p2);
  }
  if (tail) e += s[s.length - 1].loss / s[s.length - 1].T;
  return e;
}
```

### C.7 Benefit–cost ratio of mitigation (FEMA-BCA style)

```
BCR = PV(avoided losses) / PV(costs)
PV(avoided) = Σ_{t=1}^{n} ΔEAL_t / (1+r)^t      (ΔEAL = EAL_before − EAL_after; include BI, contents, displacement, life-safety if quantified)
PV(costs)   = CapEx + Σ_{t=1}^{n} O&M_t / (1+r)^t
Constant ΔEAL → PV = ΔEAL × UPV(r,n),  UPV = (1 − (1+r)^−n) / r
```

Precomputed UPV [V arithmetic]:

| r \ n | 30 yr | 50 yr | 100 yr |
|---|---|---|---|
| 7% (FEMA default since Jun-2025; OMB A-94 1992) | 12.41 | 13.80 | 14.27 |
| 3.1% (A-94 2024 update, revoked Apr-2025; still selectable) | 19.35 | 25.25 | 30.73 |

- FEMA BCA defaults: project useful life is ~50 yr for floodwalls/levees and 100 yr for acquisitions [M; check the BCA Reference Guide]. BCR ≥ 1.0 is required.
- Show BCR at **both** 7% and 3.1%, plus an optional climate-trend uplift (ΔEAL grows g %/yr; replace UPV with Σ (1+g)^t/(1+r)^t).
- Benchmarks: NIBS *Mitigation Saves 2019* puts riverine-flood federal grants (buyouts) at **7:1**, adopting flood code requirements at **6:1** and building 5 ft above code at **~5:1** [S, https://www.nibs.org/files/pdfs/ms_v3_grants_flood.pdf ; https://www.NIBS.org/files/pdfs/ms_v3_adopts_flood.pdf].

**Mitigation unit costs**

| Measure | Cost | Source |
|---|---|---|
| Floodwall, US municipal (Fargo planning, 2017) | **$2,600–5,000 per linear ft** (≈ $8,500–16,400/m) incl. 30% contingency | [S] https://download.fargond.gov/0/1_3_17_cc_presentation.pdf |
| Small site floodwall, generic (2–6 ft) | $92–195/ft (≈ $300–640/m); DNREC "$200+/ft" | [S] https://documents.dnrec.delaware.gov/I-ADAPT/AdaptationStrategies/Floodwall.pdf |
| T-wall floodwall (New Orleans) | **€4.9–11.8 M per km per m of height** (2009 €) | Jonkman et al. 2013 via 2024 compilation [S] https://media.springernature.com/original/springer-static/esm/art%3A10.1038%2Fs43247-024-01753-5/MediaObjects/43247_2024_1753_MOESM2_ESM.pdf |
| Dike raising, rural NL / urban NL / California | €4.5–12.4 M / €15.5–22.4 M / €0.6–2.7 M per km per m (2009 €) | same |
| Large USACE system (West Shore Lake Pontchartrain) | ~$3.7 B for ~18 mi ≈ $128 M/km (levees + walls + pumps) | [S] https://www.fox8live.com/2023/07/15/levee-project-cost-13-billion-more-than-anticipated |
| Nepal earthen embankment (low-end tender) | **NPR 15,000/m** (~$110–137/m; ~3 m wide × 1.5 m high) | [S] https://dialogue.earth/en/2018/08/16/embankments-enter-nepal/ |
| Nepal gabion-faced embankment | NPR 30,000–35,000/m (~$220–260/m) | same |
| India (Bihar) embankment program | ₹1.56 B/yr (~$20 M) budget, no per-km rate | [S] https://dialogue.earth/en/water/3800-kilometres-of-embankments-worsen-floods-in-bihar-2/ |

**Deluge default for the levee tool** [I]: cost/m = base × height^1.3, with US base ≈ $2,500/m per m height for an earthen levee and $6,000/m per m for a concrete floodwall (calibrated so a 1.5 m urban wall ≈ $9–10k/m, matching Fargo). South Asia: earthen ≈ $90/m per m, gabion ≈ $170/m per m. These are all editable; show a ±50% band.

---

## D. Building value when only footprints are known

### D.1 Formula

```
GFA_m2      = footprint_area_m2 × floors
floors      = building:levels tag ?? round(height_m / storey_h) ?? default_by_kind
storey_h    = 3.2 m low-rise, 3.95 m for ≥4 levels  (Deluge's own fit: src/data/buildings.ts LEVEL_HEIGHT_LOW/HIGH)
RV_structure = GFA_m2 × unit_cost[occ][country] × regional_factor
RV_contents  = RV_structure × content_factor[occ]       (JRC: RES 0.5, COM 1.0, IND 1.5)
```

**Flood damage on multi-storey buildings** (avoid over-counting upper floors):
```
for each storey i = 0..floors-1 (i=0 ground; −1 basement if tagged):
   d_i = depth_at_building − (FFH + i × storey_h)
   if d_i > 0: loss += f(d_i) × (RV_structure / floors) × (1 − u) + f_c(d_i) × (RV_contents × share_i)
contents share: ground floor gets 1/floors by default; warehouses (single storey) get 100%
```
A storey that is fully submerged reaches f(d_i ≥ storey_h). This keeps a 30-storey tower with 1 m of water from showing a 50% loss.

Sources: footprints from OSM, Microsoft Global ML Building Footprints (1.4 B footprints, heights for a subset, refreshed 2026-08 [S, https://github.com/microsoft/globalmlbuildingfootprints]) and Overture. **GFZ OpenBuildingMap** already infers occupancy and storeys from OSM land use and POIs on top of the Microsoft footprints [S, https://datapub.gfz.de/download/10.5880.GFZ.LKUT.2025.002-Caweb/2025-002_Oostwegel-et-al_OpenBuildingMap_data-description.pdf], so it is a candidate data source for non-US presets.

### D.2 Occupancy from OSM tags (priority order) [M; OSM wiki Key:building / Key:amenity]

1. `building=*` on the footprint:
   - house, detached, semidetached_house, terrace, bungalow → RES1
   - apartments, residential, dormitory → RES (multi)
   - retail, supermarket, kiosk → COM-retail
   - commercial, office → COM-office
   - industrial, warehouse, factory, manufacture → IND
   - hospital → HOSP; school, university, college, kindergarten → EDU
   - church, mosque, temple, cathedral → REL
   - civic, government, public, fire_station, police → GOV
   - parking → PARK (low value: structure only)
   - shed, roof, garage(s), hut, cabin, barn, farm_auxiliary → minor (value × 0.2)
   - stadium, sports_hall → ASSEMBLY
   - train_station, transportation → TRANSPORT
2. If `building=yes`: use a POI inside the footprint (`amenity=hospital|clinic|school|...`, `shop=*` → retail, `office=*` → office, `craft=*` / `industrial=*` → IND, `tourism=hotel` → COM-lodging).
3. Otherwise use the enclosing `landuse=*` polygon: residential → RES, commercial/retail → COM, industrial → IND, farmyard → AG.
4. Otherwise apply a size heuristic: footprint < 250 m² → RES; 250–5,000 m² → COM; > 5,000 m² and single storey → IND/warehouse [I].
5. Store a `valueConfidence` flag (tagged / POI / landuse / heuristic), as Deluge already does for `heightSource`.

Deluge's current `BUILDING_KINDS` (other, house, residential, apartments, commercial, retail, office, industrial, civic, school, church, stadium, parking, shed, roof) maps almost 1:1. Add `hospital`, `warehouse`, `hotel`, `utility/powerhouse` and `agricultural`.

---

## E. Product concept: "Deluge for Business"

### E.1 Asset portfolio CSV schema (parsed client-side; nothing uploaded)

| Column | Type | Required | Notes |
|---|---|---|---|
| `asset_id` | string | yes | |
| `name` | string | no | |
| `lat`, `lon` | float | yes* | *or `wkt` polygon |
| `wkt` | WKT polygon | no | Overrides the footprint match |
| `occupancy` | enum | no | res, apt, retail, office, warehouse, industrial, hospital, school, datacenter, substation, hydropower_headworks, hydropower_powerhouse, bridge, road, other |
| `replacement_value` | number | no | Structure; if empty, estimate per D.1 |
| `contents_value` | number | no | Inventory/equipment |
| `currency` | ISO 4217 | no | Default from country |
| `floors`, `gfa_m2` | number | no | |
| `first_floor_height_m` | number | no | Default 0.3 slab / 0.9 crawl |
| `critical_elev_m` | number | no | Elevation of the critical equipment above grade (switchgear, servers, turbines) |
| `basement` | bool | no | |
| `construction` | enum | no | concrete, masonry, steel, timber, mud, informal (selects velocity thresholds and JRC material factor) |
| `daily_revenue`, `gross_margin` | number | no | For BI |
| `recapture` | 0–1 | no | |
| `deductible`, `limit` | number | no | Insured loss = clamp(loss − deductible, 0, limit) |
| `tags` | string | no | Portfolio grouping |

### E.2 Per-asset metrics (all computable from GPU accumulators + JS)

| Metric | Definition |
|---|---|
| `max_depth_m` | max over footprint cells of `stateTexture.a` (already stored) |
| `max_velocity_ms` | new accumulator: max ‖(u,v)‖ while h > 0.05 m |
| `max_dv` | new accumulator: max h·‖u‖ |
| `first_wet_s` / **lead time** | new accumulator: first sim time h > 0.15 m (and > critical_elev). Lead time = first_wet − warning_time (scenario start or user-set alert time) |
| `wet_duration_h` | new accumulator: seconds with h > 0.15 m |
| `hazard_class` | AIDR H1–H6 at (max d, v at max dv); FD2321 HR |
| `damage_pct` | JRC/HAZUS curve × velocity override × per-storey rule |
| `loss_structure`, `loss_contents`, `loss_bi`, `loss_total`, `loss_insured` | per C.5 |
| `downtime_days`, `access_lost_days` | per C.5 with road graph |
| `ranking` | by loss and by lead time |

GPU implementation: one extra `rgba32float` texture `hazardAccum` (r = maxSpeed, g = maxDV, b = firstWetTime, a = wetSeconds), updated in the existing step shader or as a cheap per-substep pass. It is reset with `reset()`, mirroring how `stateTexture.a` holds max depth. Read it back at ~1 Hz with the snapshot. Sample per building with a precomputed CPU list of footprint cell indices (rasterization already exists for `heightRaster`).

### E.3 Portfolio summary and mitigation workflow

- **Portfolio cards:** total exposed value, # assets wet, # in H5–H6, scenario loss (P50, with P10–P90 band in ensemble mode), EAL, the top 10 assets, and the earliest-wetting asset (minimum lead time).
- **Charts:** loss-exceedance curve, loss by occupancy, depth histogram, and a lead-time waterfall.
- **Mitigation mode:** the user draws a levee/wall (existing tool) and picks a type (earthen, floodwall, deployable) and height. Cost comes from the unit-cost table. Deluge re-runs every return-period scenario (8 runs × a few seconds of GPU each), then shows the ΔEAL, the NPV at 7%/3.1%, the BCR and protected land/assets, alongside the "residual risk" (overtopping scenario) and "transferred risk" (who gets wetter downstream). That last one is crucial for municipal approval and a unique visual.
- **Export:** a print-to-PDF report (CSS print stylesheet; no server) with map snapshots, per-asset table, assumptions/uncertainty, and a methods appendix (JRC citation, AIDR/FD2321, BCA formula), plus a CSV/GeoJSON of results. The "BCA appendix" lists the FEMA BCA Toolkit inputs (project useful life, discount rate, damages before/after per RP), so the engineer can transcribe them.

### E.4 Three customer stories

**1) Hydropower operator below a glacial lake (Nepal/Sikkim-type)** [I, with real anchors]

- Asset: a 100 MW run-of-river plant with surface powerhouse and desander, 25 km below a moraine-dammed lake. Revenue ≈ 100 MW × 8,760 h × 0.55 CF × $0.07/kWh ≈ **$33.7 M/yr** [I].
- Deluge scenario: 20 M m³ released over 30 min (the existing Nepal preset volume). Output (illustrative): flood front reaches the headworks at **T+38 min** and the powerhouse at T+52 min, with peak depth 9 m, v 6 m/s, dv 54 (H6). The velocity override sets the structure to total loss.
- Loss: civil + E&M ≈ $1.1 M/MW (Teesta-III's ₹11,400 cr claim for 1,200 MW ≈ $1.14 M/MW [S]). Powerhouse + headworks share 60% ≈ $66 M, plus 24 months BI ≈ $67 M, **≈ $130 M per event**. At an annual probability of 1/100, EAL ≈ $1.3 M/yr.
- Mitigation compared in-app:
  - (a) Early-warning system + gate-closure/evacuation protocol: ~$1–2 M [I], buys ~38 min of lead time for ~300 staff. Aug-2026 had 900+ workers trapped in blocked tunnels [S].
  - (b) Raise or relocate the desander and switch to an underground powerhouse at the design stage. In 2026, underground powerhouses "fared markedly better" [S].
  - (c) A deflection berm drawn in Deluge.
- Buyer value: lender E&S diligence (IFC PS4), insurer GLOF sub-limit negotiation (reinsurers reportedly capped GLOF liability at ₹500 cr for Teesta-III [S, weak]), and design choice.

**2) Logistics warehouse in Houston (Harvey-type)** [computed in this session; inputs are I]

- Asset: 500,000 ft² (46,450 m²) single-storey DC. Building RV at $1,250/m² = $58 M (60% damageable). Inventory is $40 M and daily gross profit $250k.
- Scenario set (JRC NA industrial curve):

| RP (yr) | Depth at DC (m) | Damage fraction | Downtime (d) | Loss ($M) |
|---|---|---|---|---|
| 10 | 0 | 0 | 0 | 0 |
| 25 | 0.15 | 0.115 | 3 | 9.4 |
| 50 | 0.40 | 0.263 | 10 | 22.2 |
| 100 | 0.80 | 0.436 | 30 | 40.1 |
| 500 | 1.50 | 0.637 | 60 | 62.7 |

- **EAL ≈ $1.44 M/yr** (trapezoid + tail).
- Option A: a 900 m perimeter floodwall at Fargo-mid $3,500/ft ≈ **$10.3 M**, protecting to the 500-yr event. BCR = $1.44 M × 13.80 / $10.3 M ≈ **1.9 at 7%** (3.5 at 3.1%).
- Option B: deployable barriers + an inventory-raise protocol at $1.5 M + $20k/yr O&M, 85% effective. BCR ≈ **8.7 at 7%** (12.6 at 3.1%). The flooded-road graph also shows when trucks can't get in or out, which is where Harvey's month-long closures came from [S].
- Sales hook: "a $10 M wall vs a $1.5 M plan, and the 3D model shows the 40 cm of water is the access road, not the dock."

**3) Hospital in Asheville (Helene-type), plus a supply-chain twin** [S anchors]

- Facts: Helene cost $79.6 B (NOAA, 219 deaths) [S, https://www.climate.gov/news-features/blogs/beyond-data/2024-active-year-us-billion-dollar-weather-and-climate-disasters]. Flood insurance take-up in WNC was ~1–5% of homes, with just 1,295 NFIP policies in Buncombe County [S, https://www.insurancejournal.com/news/southeast/2024/09/30/794914.htm ; https://ncnewsline.com/2025/04/22/few-were-insured-against-helenes-floods-those-that-were-faced-long-claims-frustrating-hurdles/]. Mission Hospital went without running water for 6+ days and needed 20+ tankers and 200,000 gal/day; road closures kept staff away [S, https://www.healthcaredive.com/news/hca-mission-hurricane-helene-recovery-north-carolina/728653/].
- Deluge use: run the Asheville preset at Helene rainfall, mark the hospital, water-treatment intake and main access corridors as assets. The output is the hours until each access route closes, which routes stay open (ambulance/staff routing), and the hours until the utility asset wets.
- Value is **lead time and continuity**, not structural loss: e.g., "I-240/Swannanoa corridor impassable 6 h before the hospital campus is cut off" [I].
- Supply-chain twin: Baxter North Cove (Marion, NC) supplies ~60% of US IV solutions; analysts estimated a **$100–190 M** Q4-2024 revenue impact and hospitals were put on 40–50% allocations [S, https://bnnbloomberg.ca/investing/2024/09/30/baxters-largest-plant-closed-as-helene-damages-inventory]. A hospital system's procurement team can screen its single-source suppliers' plants with the same CSV.

### E.5 Pricing tiers (hypotheses to test)

| Tier | Price | Includes |
|---|---|---|
| **Public / Explorer** | Free | Presets, live areas, levee tool, shareable links; no portfolio upload |
| **Pro** (consultants, engineers, single-site owners) | $149–$399/seat/mo | CSV up to 500 assets, loss layer, mitigation BCR, PDF export, custom curves |
| **Grant/BCA Pack** (municipalities, engineers) | $5k–$15k per project | Return-period suite, BCA appendix, public-meeting visuals, 1 h of methodology support |
| **Team / Enterprise** (REITs, logistics, utilities, hydropower) | $25k–$90k/yr | Unlimited assets, ensembles (P10/P90), SSO, private deployments (static bundle on their intranet), GLOF module |
| **API / Ensemble compute** | metered, e.g. $0.50–$5 per asset per scenario-suite, or GPU-hour | Headless runs (Node + Dawn/WebGPU, or a native wgpu port), batch portfolios, parametric trigger studies |

Anchors: ICEYE from €34k/yr, Climate X $31.5k/yr [S]. Keep enterprise under these to win pilots, then expand.

### E.6 API and ensemble ideas

- `POST /runs`: {bbox | preset, forcing (stage/hydrograph/rain/GLOF volume+location), mitigation geometries, ensemble spec} → returns per-asset metrics JSON + COG rasters (max depth, max v, arrival time).
- Ensemble spec: Latin-hypercube over Manning n, DEM vertical bias, inflow peak, breach timing and GLOF volume (lognormal from lake area via Huggel/Evans-style empirical relations [M]). It returns per-asset distributions and an EP curve.
- **Parametric trigger designer:** sweep the gauge stage → % of insured sites with depth > threshold, and report basis risk = P(trigger fires but no loss) and P(loss but no trigger).
- Webhook / "watch mode": ingest NWS/GloFAS forecasts → auto-run → alert the asset owners with the lead time.

---

## F. Pitch narrative (5–8 bullets)

1. **Floods are the most expensive disasters we have, and the bill is rising.** Harvey ≈ $125 B nominal / ~$160 B CPI-adjusted; Ian ≈ $113–120 B; Helene ≈ $79.6 B with 219 deaths (NOAA NCEI; 2025-updated values via climate.gov and press [S]). Modeled global insured nat-cat AAL is now **$171 B/yr** (Verisk 2026 [S]).
2. **Most of it is uninsured, so it lands on your balance sheet.** Helene's insured loss was ~$6–14 B against ~$80 B in damage; only ~1–5% of WNC homes carried flood cover [S]. Ian's NFIP paid $3.9 B against $50–67 B insured overall [S].
3. **Downtime, not drywall, is what kills a business.** Harvey shut Houston warehouses and refineries for ~a month [S]. One flooded plant (Baxter, Marion NC) cut ~60% of US IV-fluid supply and an estimated $100–190 M of revenue in a quarter [S].
4. **Mountains are the new flood frontier.**
   - **Sikkim 2023**: South Lhonak GLOF destroyed the 1,200 MW Teesta-III dam in minutes, with a ₹11,400 cr (~$1.4 B) claim reported [S].
   - **Chamoli 2021**: ₹1,500 cr (~$206 M) loss at NTPC Tapovan, 200+ dead [S].
   - **Nepal Aug-2026**: Bhote Koshi/Trishuli flood severely damaged 431 MW of generation (12 sites; ~12% of national capacity) and 470 MW under construction, with a $4–5 B reconstruction estimate and ~1,000 dead (counts vary) [S, https://www.energypolicy.columbia.edu/nepal-floods-test-resilience-of-its-hydropower-dependent-economy/].
   - 177 of ~257 Himalayan hydropower plants sit on potential GLOF paths [S, Schwanghart et al. 2016, ERL].
5. **Mitigation pays, if you can prove it.** NIBS finds $6–7 saved per $1 on riverine flood mitigation [S]. In Ian, elevated homes averaged $50k NFIP claims vs $158k for non-elevated [S]. FEMA demands a BCR ≥ 1 at a 7% discount rate. Deluge computes it while you draw the wall.
6. **Minutes matter.** Deluge gives every asset a **first-wet arrival time**. In 2025 Nepali officials didn't know a GLOF was coming until it reached Betrawati [S]. In 2026, 900+ workers were trapped in tunnels [S]. Lead time turns a catastrophe into an evacuation.
7. **No install, no data leaves your laptop.** Real terrain, real buildings, GPU physics in a browser tab. Run 100 what-ifs before your consultant opens HEC-RAS, then hand them the scenario.
8. **Built to be checked.** Open, cited curves (JRC 2017, AIDR 2017, FD2321), stated uncertainty bands, mass-conservation shown on screen. Every number in the report traces to a formula.

---

## G. Implementation checklist (ordered)

1. `src/loss/curves.ts`: JRC tables (C.1) + σ, `interpCurve(curve, d)`, continent lookup by ISO country (JRC ISO_Table), plus HAZUS/EGM placeholders behind a flag until verified.
2. `src/loss/value.ts`: occupancy mapping (D.2), unit-cost table (C.1.3 defaults), per-storey damage (D.1), JRC basis vs replacement basis toggle.
3. `src/sim/shaders`: `hazardAccum` texture (maxSpeed, maxDV, firstWet, wetSeconds), reset with water; expose `getHazardSnapshot()` on `FloodSolver`.
4. `src/loss/hazard.ts`: AIDR, FD2321, velocity override (C.3), downtime/BI (C.5) using `EvacuationRouter` for access loss.
5. `src/loss/portfolio.ts`: CSV parser (E.1, Papaparse-free hand parser OK), footprint matching (point-in-polygon on `BuildingSet`; nearest within 30 m otherwise), aggregation, EAL (C.6), BCR (C.7).
6. UI: Business panel (portfolio table, cards, LEC chart), mitigation compare (before/after), print stylesheet report.
7. Scenario suite runner: queue 8 RPs × k ensemble members headless at max `timeScale`, cache results per mitigation hash.
8. Validation: reproduce published numbers (e.g., Ian elevated vs non-elevated ratio; JRC curves unit tests; mass balance); document limits in-app.

---

## H. Source list (key URLs)

- JRC damage functions (spreadsheet, extracted): https://publications.jrc.ec.europa.eu/repository/bitstream/JRC105688/copy_of_global_flood_depth-damage_functions__30102017.xlsx ; report: https://publications.jrc.ec.europa.eu/repository/handle/JRC105688
- physrisk JRC onboarding: https://physrisk.readthedocs.io/en/latest/user_guide/vulnerability/vulnerability_functions/inundation_jrc/onboard.html
- AIDR H1–H6 table: https://egusphere.copernicus.org/preprints/2026/egusphere-2026-4699/egusphere-2026-4699-supplement.pdf ; ARR Book 6 Ch 7 reference: https://www.planning.tas.gov.au/__data/assets/pdf_file/0011/709643/Submission-Planning-authority-1-June-2023.pdf
- FD2321 HR formula: https://help.floodmodeller.com/docs/hazard-mapping ; EA 2008 supplementary note: https://help2.innovyze.com/infoworksicm/Content/HTML/ICM_IL/References/FD2320_FD2321_Explanatory_Note.htm
- dv collapse thresholds (secondary): https://repository.tudelft.nl/file/File_2fae8e61-de65-4d41-9166-da81ae93504f ; https://hub.docker.com/r/gfzriesgos/flooddamage
- FEMA BCA discount rate: https://www.floods.org/?p=306755 ; https://iem.com/?p=39773
- BRIC: https://www.everycrsreport.com/files/2026-03-10_IN12609_78ea9dfb9eb809875111eb861d2febebe5da2eee.html
- NIBS Mitigation Saves: https://www.nibs.org/files/pdfs/ms_v3_grants_flood.pdf
- Levee/floodwall costs: https://download.fargond.gov/0/1_3_17_cc_presentation.pdf ; https://documents.dnrec.delaware.gov/I-ADAPT/AdaptationStrategies/Floodwall.pdf ; Jonkman 2013 via https://media.springernature.com/original/springer-static/esm/art%3A10.1038%2Fs43247-024-01753-5/MediaObjects/43247_2024_1753_MOESM2_ESM.pdf ; Nepal: https://dialogue.earth/en/2018/08/16/embankments-enter-nepal/
- Regulations: https://www.whitecase.com/insight-alert/california-climate-disclosure-laws-ninth-circuit-temporarily-halts-sb-261-and-carb ; https://www.foley.com/insights/publications/2026/01/ninth-circuit-hears-oral-argument-in-challenge-to-california-climate-disclosure-l/ ; https://www.mofo.com/resources/insights/251222-eu-sustainability-omnibus-i-detailed-omnibus ; https://www.spglobal.com/sustainable1/en/insights/research-reports/issb-q3-2026
- Market: see the table in A.1.
- Competitors: https://www.swissre.com/press-release/Swiss-Re-acquires-Fathom-a-leader-in-water-risk-intelligence/4af5e0d7-e065-404a-b80d-6f32955f0fbe ; https://www.iceye.com/solutions/insurance/flood-rapid-impact ; https://batchdata.io/blog/climate-risk-real-estate-apis-buyer-guide ; https://fintech.global/2025/02/25/floodbase-raises-5m-to-expand-data-driven-flood-insurance-solutions/ ; https://www.businesswire.com/news/home/20250723646042/en/Jupiter-Intelligence-Establishes-New-Standard-for-Investment-Grade-Climate-Analytics ; https://apis.io/providers/first-street/
- Events:
  - Helene: https://www.climate.gov/news-features/blogs/beyond-data/2024-active-year-us-billion-dollar-weather-and-climate-disasters
  - Ian/Harvey CPI-adjusted: https://www.foxnews.com/us/americas-most-expensive-natural-disasters-recent-decades.print
  - Ian NFIP: https://propertycasualty360.com/2023/05/09/nfip-paid-out-nearly-4b-in-hurricane-ian-flood-claims
  - Harvey: https://www.verisk.com/insurance/visualize/air-releases-estimates-for-total-property-damage-insured-losses-from-harvey ; https://resilientmaritimelogistics.unctad.org/fr/node/309
  - Teesta-III: https://sandrp.in/2023/12/11/2023-accidents-damages-to-hydro-dam-projects-in-india/ ; https://india.mongabay.com/2023/10/no-early-warning-system-and-insufficient-dam-safety-turned-sikkim-flood-deadly/
  - Chamoli: https://en.wikipedia.org/wiki/2021_Uttarakhand_flood
  - Nepal 2025: https://www.stimson.org/2025/investigating-an-emerging-climate-hazard-transboundary-glacial-floods-on-the-china-nepal-border/ ; https://sandrp.in/2025/07/24/july-2025-glof-disaster-impact-ten-heps-in-nepal/
  - Nepal 2026: https://www.energypolicy.columbia.edu/nepal-floods-test-resilience-of-its-hydropower-dependent-economy/ ; https://www.borderlens.com/2026/08/26/massive-flash-flood-from-tibet-devastates-nepals-rasuwa-district-nepals-deepening-climate-challenge/
  - GLOF exposure of hydropower: https://india.mongabay.com/2023/10/glacial-lake-outburst-floods-are-a-growing-threat-to-hydropower-plants/
  - Baxter: https://bnnbloomberg.ca/investing/2024/09/30/baxters-largest-plant-closed-as-helene-damages-inventory
  - Mission Hospital: https://www.healthcaredive.com/news/hca-mission-hurricane-helene-recovery-north-carolina/728653/

### Open uncertainties to resolve before external use
- The USACE EGM 01-03 curve values (C.2) are from memory. Verify them, or import FAST/Hazus DDF CSVs.
- The Clausen & Clark 1990 thresholds (3 and 7 m²/s with v ≥ 2 m/s) are as commonly cited; the primary paper was not retrieved.
- The FD2321 debris-factor table and class labels are standard but were not re-retrieved this session.
- The Hazus BI restoration tables were not retrievable. C.5 is a documented heuristic.
- The Teesta-III ₹11,400 cr claim and ₹500 cr GLOF reinsurance cap come from a weak mirror source. Nepal-2026 death tolls conflict (469 → ~1,000 confirmed; up to 4,000 missing).
- Market-size figures vary 10× by definition. Use ranges.
- Check SB 261 status on the Ninth Circuit docket. No ruling was found as of the search.

# Deluge — real-time flood simulation on real terrain

![Pittsburgh at the 1936 St. Patrick's Day crest: downtown, the North Shore and the Strip District under water](docs/hero-1936-crest.jpg)

Deluge loads real elevation data — USGS 3DEP in the US, Copernicus GLO-30 elsewhere — and solves the 2-D
shallow-water equations on the GPU with WebGPU compute shaders, live in a browser tab. Raise the rivers to the 1936
crest, build a levee and see the land it keeps dry, crank the rain, and watch an evacuation route re-plan as roads go
under.

Beyond rising water:

* **Glacier hazards.** A rock-ice avalanche or a glacial-lake outburst high in the Himalaya, its breach hydrograph,
  the wave routed tens of kilometres down the valley past hydropower plants and towns, then the debris flood on the
  2-D map — on three real events (Nepal 2026, Sikkim 2023, Chamoli 2021), each run against what was observed.
  An early-warning designer shows how many minutes a sensor upstream would buy each town and plant.
  [Glacier hazards](#glacier-hazards) below.
* **What it costs, and what to do about it.** Damage and dollar loss per building, a parcel-level **Site check**
  for developers and lenders (depth, warning time, when the escape route closes, indicative floor height, what a
  wall or a raised floor would save), portfolio CSVs, expected annual loss and benefit–cost ratios.
* **How sure it is.** Flood-probability maps from a GPU ensemble of perturbed runs, and **future climate** (2050 /
  2080 / 2100 rain, sea level and glacial-lake growth).
* **Dam breaches and coastal surge, anywhere in the US.** Pick any of ~55,000 dams in the National Inventory of Dams,
  breach it (sunny-day or flood-induced; eight published breach relations as a low / central / high band, the central
  one chosen on 21 historical failures) and watch the wave arrive down the valley; or put a coastal
  site against NOAA's 1- to 100-year tide-gauge water levels, today and with 2022 sea-level rise.
  [Dam breaches and coastal surge](#dam-breaches-and-coastal-surge) below.

Built for SteelHacks, *No Wrapper* track: no language models anywhere in the product. How it works in depth:
[ARCHITECTURE.md](ARCHITECTURE.md). Module contracts: [src/contracts.ts](src/contracts.ts). The business case — site
due diligence, portfolios, glacier risk for hydropower, with worked numbers from the app — is in
[BUSINESS.md](BUSINESS.md).

## Run it — three ways

Needs Node 20.19+ or 22.12+. The two browser paths need a WebGPU browser: Chrome, Edge or Brave 113+, Safari 26+
(Safari 18 has WebGPU behind *Develop → Feature Flags*), or Firefox 141+ on Windows / 147+ on Apple-silicon Macs. All
four built-in scenarios run with no network at all; only live areas and the location picker use the internet.

```bash
npm ci                        # the only step that needs the network
```

**1 · Dev server** — hot reload and `window.__deluge` in the console:

```bash
npm run dev                   # http://localhost:5173
```

**2 · `npm run demo`** — the production build, served locally. This is the offline demo path:

```bash
npm run demo                  # builds, then serves http://localhost:4173
npm run demo -- --port 5000   # if 4173 is busy
```

**3 · `Deluge.app`** — a macOS desktop build, for presenting without a terminal or a browser on screen:

```bash
npm run app:build             # typecheck, build, package → release/Deluge.app (ad-hoc signed, ~330 MB)
open release/Deluge.app
npm run app:dev               # the wrapper on the current build, without packaging
```

The wrapper (`electron/`) is an Electron main process with no preload, no IPC, no Node in the renderer and no
listening port. It serves the same static build over a privileged `app://deluge/` origin, sends the CSP —
`frame-ancestors 'none'` included, which a hosted copy cannot — as real response headers, allows network requests
only to the seven data endpoints, denies every permission the page could ask for, and holds the display awake from
the main process, so the venue screen cannot sleep mid-pitch even on a Mac whose browser has no Wake Lock API.
`npm run app:check` is its release gate; the app is not committed (`release/` is ignored), so build it on the
machine that will present.

In a browser, Deluge asks for a **Screen Wake Lock** instead, which holds the display awake in Chrome and Brave with
nothing to switch on. Safari has no such API — see [DEMO.md](DEMO.md) for the `caffeinate -dis` fallback.

Presenting to judges? [DEMO.md](DEMO.md) has the pre-demo checklist, pitch scripts and a Q&A crib sheet.

`npm run build` writes a static site to `dist/` with relative URLs, so any static host works, including under a
sub-path (`.github/workflows/pages.yml` publishes it to GitHub Pages once the repository is public and Pages is set to
"GitHub Actions"). A hosted copy still needs WebGPU; keep `npm run demo` as the offline path.

URL options: `?preset=pittsburgh|johnstown|ellicott|asheville|nashville|houston|boulder|sandbox` (the full list is
under *Scenario → Change*, and in [Ten scenarios, offline](#ten-scenarios-offline) below), or any US area with
`?live=<lat>,<lon>,<km>`
(e.g. `?live=29.95,-90.07,6` for New Orleans; this needs the internet for USGS, Esri and Census TIGERweb).
`?usecase=site|glacier|portfolio` opens one of the business use cases below, set up with its demo data;
`?usecase=address&at=<lat>,<lon>` checks a site at that point (a 5 km live area, so it needs the internet; the link
carries coordinates only — never an address or a name).
`?usecase=dam&nid=<NID id>&breach=sunny|flood` breaches that dam on the valley below it (e.g. `nid=MI00549`, Edenville
Dam; `&method=low|high|parametric` for a case other than the central one); `?usecase=surge&at=<lat>,<lon>` sets a coastal site up against NOAA's extreme water levels (an 8 km live area).
Both need the internet for the terrain; the dam index and the tide-station table ship with the app.
`?story=nepal-2026|pittsburgh-1936|houston-harvey|sikkim-2023|chamoli-2021` plays a narrated story (also *Watch the
story* in the Scenario section, and the stories row under Use cases): the camera, the simulation and a caption card
with sourced facts move together beat by beat (`Space` pause, `←`/`→` previous/next, `Esc` exit). The stories are data
in [src/story/stories](src/story/stories); model times in captions are read live from the app, never typed in.
`node scripts/record-story.mjs [--story=<id>|--all]` records one as a 1080p MP4 into `artifacts/stories/`.

## Try this (30 seconds)

1. Pittsburgh loads with full rivers. Click **Raise to 1936 record** in the *Try it* strip. The rivers rise to 46 ft
   along their whole length over a few simulated minutes (a time-lapse: the real 1936 rise took ~30 hours), and the
   Point, the North Shore and the Strip District go under.
2. Click **Evacuate** (or press **8** and click a street): the route to the nearest dry shelter re-plans, or turns red,
   as roads flood.
3. Click **Build a levee**: a floodwall goes up along the North Shore and the 1936 rise replays with it in place. The
   land it keeps dry turns green and the strip counts it (about 139 acres and 11 km of streets at the crest), while
   the evacuation route re-plans as the water comes back. Or press **2** and drag your own wall, tying both ends into
   high ground; press **V** to step through Depth / Max depth / Speed / Arrival (minutes until the water came) /
   Hazard (AIDR H1–H6 classes from depth × speed), or scroll the side panel to View.

![The one-click levee along the North Shore at the 1936 crest: the land it keeps dry is green, the Try-it strip counts the acres and streets it saves](docs/levee-north-shore.jpg)

On a live area with no river crossing the map edge (picked with *Pick any US location*), the first button drops a
thunderstorm over the view instead.

Keys: `1`–`0` tools, `Space` pause, `R` reset water, `V` next water view, `?` help. **On a laptop,** plug in: the app
adapts solver substeps and render resolution to measured frame time and GPU latency, and detects browser 30 fps caps on
battery, but 60 fps needs mains power. On an Apple M4 the 1936 crest flood with extreme rain runs at 60 fps (p95 frame 19 ms) and
~70× real time at 1600×1000 (numbers and the MacBook Air expectation: [ARCHITECTURE.md §8.1](ARCHITECTURE.md#81-performance-budget-measured)).

## Impact & loss

The side panel's **Impact & loss** section (collapsed; nothing in it runs until asked) turns the flood on screen into
what it does to the buildings under it: buildings reached, damaged and destroyed, an estimated dollar loss with its
range, AIDR H1–H6 hazard classes, the first arrival at a building, and buildings whose access road went under. It
reads the solver's per-cell maxima (`FloodSolver.readHazardFields`); a solver without them gets a depth-only fallback
that says so. Damage comes from the JRC global depth–damage curves (Huizinga et al. 2017) applied storey by storey,
values from footprint area × storeys × a per-country unit cost (US, India, Nepal; 2026 USD), and fast water from the
Clausen & Clark depth × velocity thresholds. **Set as baseline**, build a wall, replay and recompute for avoided loss,
buildings the wall makes wetter, wall cost and a single-event benefit–cost ratio at 7 % and 3.1 %. A sites / portfolio
CSV (`asset_id, lat, lon` or a WKT polygon, plus optional values, floors, revenue …) is parsed in the tab — never
uploaded — and exported results come as a CSV or a print-ready report with the methods and sources. Everything
behind it is pure TypeScript in [`src/loss`](src/loss), every assumption a named constant with its source, tested in
`tests/loss`.

**Site check** (the panel section of the same name, and the Site tool, `S`) is the due-diligence view of one parcel:
click to drop a site or drag around the parcel to outline it, describe the planned building (use, floors, value,
first-floor height, critical equipment), and it reports depth at grade and above the planned floor, speed, AIDR class,
arrival and time under water, damage and loss, and **egress** — when the last road route from the site to a shelter
closes, against when the water arrives (the evacuation router over the flood rebuilt from the run's arrival times),
and **who actually gets out by road**: departures spread over the hours after the alert by a published flood-warning
response curve, cars queuing at the route's bottleneck, and "X % of occupants out before the last route closes",
"clearance time Y min vs route window Z min" (*Leaving by road*, below).
**Run sweep** replays the scenario headless at full speed for a ladder of levels — NWS flood categories, FEMA / NOAA
1 %-type levels and historic crests for Pittsburgh, Nashville and Fort Myers, each with its source
([src/loss/ladders.ts](src/loss/ladders.ts)), or multiples of the rain and inflows elsewhere — then puts the user's
scenario back and adds EAL with a loss-exceedance chart, an indicative finished-floor elevation (design water + ASCE
24-14 freeboard), wall / levee / elevation / dry-floodproofing options with BCR, and a verdict in plain sentences. Return
periods are only filled in where published; the rest are the user's input and labelled so. Sites stay in the tab
(**Share link** writes them to `?sites=` on request) and export as a print / HTML "Site assessment". On Pittsburgh, a
3-storey office pinned at the Point (40.4425, −80.0085) stays dry up to the 2004 Ivan crest, takes 0.98 m at FEMA's
1 % level (35.4 ft) and 4.5 m at the 1936 crest, and loses its last dry route to a shelter as the water arrives; the
indicative floor is 1.28 m above grade. Indicative screening, not engineering advice.

**Any US address.** *Check an address* (in Site check, or the fourth use-case card) takes a street address — through
the same Nominatim geocoder as the location picker, or a typed `lat, lon` — loads a 5 km live area centred on it
(USGS 3DEP, Esri imagery, Census roads), drops a site on the point, and opens Site check on a **rain return-period
ladder from NOAA Atlas 14**: the 1-hour rain intensity at 2, 10, 25, 100 and 500 years at the map centre, each level
rained uniformly over the whole map for one hour and then left to run off (120 simulated minutes per level by
default). The return periods are NOAA's, so the sweep ends in an expected annual loss with no input from the user.
At Houston City Hall that ladder reads 57 / 82 / 98 / 123 / 162 mm/h (NOAA's PFDS gives the same five numbers for
that point); the five levels ran in 265 s on a GTX 1660 Ti. Why 1 hour: a live area is 1–20 km across, and the small
urban catchments inside one respond in well under an hour — the regime where the 1-hour intensity is the design rain.
Read it for what it is: **rain only** (live areas hold their rivers at a fixed level — there is no river inflow or
storm surge in this ladder, so it is surface-water flooding, not the Buffalo Bayou or a hurricane surge), uniform
rain over the map with no run-on from outside it, no storm drains, and **stationary** — Atlas 14 is fitted to the
historical record; Today vs future (*Weather & rivers → Future climate*) scales the same ladder's rain for 2050–2100.
The same ladder is offered on any US preset (it is the default where the scenario is rain-led, e.g. Houston), and the
picker under *Event ladder* switches between it, a river or tide ladder, and the forcing multipliers.

*Where the numbers come from.* NOAA's Precipitation Frequency Data Server answers point queries
(`hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py`) but sends no CORS headers (checked October 2026: none on a GET with an
`Origin`, HTTP 500 on a preflight), so a page cannot call it — and the CSP stays without it. Instead
[`scripts/bake-atlas14.ts`](scripts/bake-atlas14.ts) resamples NOAA's own Atlas 14 GIS grids (30″, partial-duration
series, 60-minute duration, Volumes 1–4 and 6–12) to 1/12° over CONUS (1/24° Hawaii and Puerto Rico, 1/6° Alaska) into
one 0.73 MB gzip file served from the app's own origin, `public/atlas14/pf60m-pds.bin`; at eleven test points across
every volume it is within 3.4 % of the PFDS point answer (the PFDS answers are kept as test fixtures). Coverage is
Atlas 14's: not western Washington or Oregon (still NOAA Atlas 2), where the app says so and offers no rain ladder.
The PDS recurrence intervals are converted to annual chance for the EAL with Langbein's relation, AEP = 1 − e^(−1/ARI),
so "100-yr" is booked at 1 in 100.5 years and "2-yr" at 1 in 2.5. NOAA Atlas 15 will supersede Atlas 14, but as of
October 2026 only a Montana pilot is out (CONUS published estimates "no earlier than September 2027").

Every headless run (sweep levels, ensemble members, today-vs-future pairs) runs **exactly** the simulated time asked
— the solver lands on it with a short last substep instead of running on until a readback catches up (600 s used to
end anywhere in 614–706 s) — and repeats agree: the hazard maxima are sampled every 5 simulated seconds rather than
whenever a frame happened to render, and the river stage rises on a fixed simulated-time grid rather than in
frame-sized steps. The fast-water collapse rule reads the 90th percentile of the footprint's cells, not its single
worst one, and ramps from the depth curve to total loss across 5–9 m²/s (the cited 7 m²/s at its centre) — both
labelled heuristics. The North Shore demo parcel at the 1936 crest, whose damage used to flip between 15 % and
100 % from one sweep to the next, now reads 79–81 % ($39.2–40.1 M) across fourteen sweeps, and Houston's today-vs-2050 loss for the 100-yr level read $2.7 M → $3.2 M in four of four repeats (the change used to come out anywhere from −30 % to +18 %). Choosing a design event other
than the 1 % level says so, and what the 1 % level that was also run gives at the site.

**Uncertainty** (its own panel section) turns "this street floods" into "this street floods in 9 of 12 plausible
versions of this event". It re-runs the scenario on screen N times (12 by default, 3–32) headless at full speed — the
Site check machinery: render hold, progress with an ETA, Cancel, your scenario put back afterwards — with its
uncertain inputs nudged within stated bands, drawn by Latin hypercube from a seed (the same seed gives the same
members): inflow ± 20 % (on a glacier-chain preset, the chain's own ensemble members instead), rain ± 25 %, river
stage ± 0.3 m, Manning n 0.025–0.05 log-uniform, and the terrain itself — a smooth random bed error of σ 0.2 m on
USGS 3DEP, 2.5 m on Copernicus GLO-30, zero under the water that was there at the start so the rivers stay at rest.
Each member's max depth is folded into a per-cell tally on the GPU (no full-grid readback for the map), and one
hazard readback per member feeds the loss model. Out come a **Flood probability** water view (share of members
deeper than 15 cm, or 50 cm: < 10 / 10–30 / 30–50 / 50–70 / 70–90 / > 90 %, drawn on the deepest water any member
reached), flooded area, buildings reached and loss as p10 / p50 / p90, and per Site check site and portfolio asset
"floods in k of N members" (also on the Site check card). On the GTX 1660 Ti here, 12 members × 30 simulated minutes
took 48 s at the 1936 Pittsburgh crest and 58 s for Houston under Harvey's rain — **12–15 members a minute** (8–10 on a
cold first run). Read it for what it is: **sensitivity to the stated input bands, not a calibrated probability of the
real event** — every band is a labelled assumption, members are equally weighted, and everything the model leaves out
(drains, buildings, bathymetry) is the same in every member, so the real uncertainty is wider. Details:
[ARCHITECTURE.md §3.10](ARCHITECTURE.md#310-ensembles-flood-probability-under-stated-input-uncertainty).

**Use cases** (top bar, or *For business* in the Try-it strip; `?usecase=` links) set the business questions up in
one click: *check a site before you build* (Pittsburgh, two demo parcels in Site check — a North Shore lot and
one on the higher ground of Allegheny Center), *glacier risk for hydropower* (Nepal 2026, the hazard chain and its
early-warning designer), *portfolio exposure* (Houston under Harvey's rain, with a demo portfolio loaded into Impact
& loss), *check any US address* (above), and *dam-breach inundation* and *coastal surge exposure* ([below](#dam-breaches-and-coastal-surge)). The same dialog has a printable one-page brief of what the app computes for a business and where those
numbers stop. The demo portfolio, [public/demo/houston-portfolio.csv](public/demo/houston-portfolio.csv), is
**fictional**: 19 made-up assets named "Demo …" and tagged `fictional-demo`, pinned to real building footprints with
invented values (the CSV reader has no comment rows, so the note lives here). Worked numbers from all three:
[BUSINESS.md §4](BUSINESS.md#4-three-worked-stories-with-the-apps-own-numbers).

On the 1936 crest (30 simulated minutes, depth-only fallback) the panel books about 1,330 of Pittsburgh's 45,000
buildings reached and **$5.5 B** (±1σ curve range $3.8–7.0 B); the one-click levee avoids about $1.0 B of it. These
are screening numbers for one simulated event on bare-earth terrain: not a flood study, not an insurance valuation,
not a catastrophe model, and the real uncertainty is wider than the band (values, terrain, missing drains).

**People on foot.** Site check's card also answers "how do the people in this building get out?": occupants (the
IBC design load by default — an upper bound; type the real number) leave through the exits at the SFPE flow rate
after a pre-movement time and walk the streets, in both directions, to the nearest refuge — a shelter that stays safe
or any ground that stays dry above the water — while each street closes once its water is unsafe for people (FD2321
hazard rating 0.75 or AIDR H3, from the moment water first arrives there). Out come *everyone out by T+x and at a
refuge by T+y if the alert goes out at T0*, *X of N reach safety*, the latest safe departure per walking group (able
adults 1.22 m/s, older adults 0.91, mobility-impaired 0.6), *vertical evacuation feasible: yes/no (floor k)*, and the
route drawn dashed on the map (orange when the flood closed it). The scenarios are time-lapses — Pittsburgh's 1936
rise plays in minutes — so on the North Shore nobody walks out after a 10-minute pre-movement; that is the point of
the alert-time input, which also takes a warning issued before the run starts (T−180 min). Details: [ARCHITECTURE.md §7.1](ARCHITECTURE.md#71-evacuation-on-foot-srcroutingpedestriants-pedestrianevacts).

**Leaving by road.** The same card says how many of the occupants get out by car before the
way out closes, instead of only whether a route exists. Three transparent steps, every default sourced and editable
per site: (1) the *latest safe departure* — each shelter's closure (its last road cut, or the shelter itself under
0.3 m) minus the drive there, so a shelter that floods before the cars arrive does not count; (2) *departures after
the alert* follow Sorensen & Mileti's (2015b, USACE) protective-action-initiation curves for dam and levee floods,
P(t) = m·(1 − e^(−t²/(a·b²))) — by default the most likely curve for an unprepared population that sees the threat as
likely (a 1.79, b 111.8 min; 74.3 % act within 8 h; p10–p90 49 min – 3 h 47 min after the warning), with the
prepared, threat-unlikely and fastest published curves to pick from (coefficients as tabulated in Silva et al. 2025,
NHESS 25:1501); (3) *a queue at the bottleneck* — occupants become cars (2.0 per car at home, 1.18 at work) and pass the
site exit (1 lane) or the weakest road on the route at lanes × a per-lane rate: 500 cars/h for a local street joining
at a stop sign (HCM two-way-stop capacity), 950 for a signalised road (HCM's 1,900 pc/h/ln saturation flow × half the
green), 1,600 for a highway (peak flows in the Hurricane Floyd evacuation). Out come *X % of occupants out before the
last route closes (p10–p90 of the departure curve)*, how many are still inside or still in the queue, and *clearance
time Y min vs route window Z min*, in the card, the verdict, the report and `deluge site` (`--occupants`,
`--alert-min`, `--departure`, `--persons-per-car`, `--exit-lanes`). On the North Shore demo parcel A at the 1936 crest
(a 6-storey apartment block: 2,494 occupants by the IBC load, 1,247 cars) the last route closes at T+3 min: with the
alert at T+0 under 1 % are out; with it 3 h before the run, 57 % (clearance 5 h 22 min vs a 3 h 01 min window); for a
prepared population, 89 %. A bottleneck queue, not a traffic simulation: neighbours evacuating on the same roads are
not counted, so the clearance is a lower bound. Details: [ARCHITECTURE.md §7.3](ARCHITECTURE.md#73-leaving-by-road-departures-and-the-queue-srcroutingdeparturets-bottleneckts-srclossegresstimingts).

**Infrastructure** (its own panel section) checks the scenario's substations, power plants, hospitals, clinics, fire
and police stations, water and wastewater works, telecom exchanges, major-road bridges and fuel stations
(OpenStreetMap, baked per scenario) against the flood: out of service / impaired / operational by screening depth
thresholds per type, and from when, with status-coloured icons on the map. Site check lists what each site depends
on: "power: Substation X floods at T+42 min (approximate service area)", the nearest hospital and fire station by
road with flooded roads closed, flags such as *site dry but its substation floods* or *nearest hospital unreachable*,
each shelter on the map with its own flooding and its substation (*shelter stays dry but its substation floods — no
grid power there*; a shelter that floods is already left out of the evacuation routing), and the longer
business-interruption downtime that follows (a labelled heuristic). At the 1936 crest after 30
simulated minutes, 53 of Pittsburgh's 193 mapped facilities are out of service (mostly bridge approaches); under
Harvey's rain after 20 minutes, 27 of Houston's 279 are out and 104 impaired. Live areas have no facilities (the
selective OpenStreetMap query is not an allowed endpoint). Details: [ARCHITECTURE.md §7.2](ARCHITECTURE.md#72-infrastructure-dependencies-srcdatafacilitiests-srclossinfrats-infradepsts).

## Dam breaches and coastal surge

Two more use cases (top bar → **Use cases**), each on a live area anywhere in the US, each with its data baked into the
app's own origin for the same reason as Atlas 14 — the upstream service either cannot be called from a page or need
not be — so neither adds an endpoint to the CSP.

**Dam-breach inundation** (`?usecase=dam&nid=<NID id>`). Dam owners must map what a failure would flood (FEMA P-946,
state dam-safety rules, Emergency Action Plans); downstream owners want to know when the wave arrives. Search any of
**55,276 dams** from the USACE **National Inventory of Dams** by name, NID id or distance from the map — every dam of at
least 1,000 acre-ft, or 6 m high over 50 acre-ft (`public/dams/nid-index.bin`, 1.32 MB gzip; the NID API sends no
CORS headers, so [`scripts/bake-nid.ts`](scripts/bake-nid.ts) bakes its public GeoPackage export). Pick one and a
scenario:

* **Sunny-day** — the normal pool fails by piping; **flood-induced** — the maximum pool overtops, with the NID's
  maximum spillway discharge flowing underneath the wave.
* **Breach — eight published relations, not one.** Published relations for one dam disagree by a factor of two or
  more, so the card shows all of them ([`src/dams/breachRelations.ts`](src/dams/breachRelations.ts), each formula
  checked against USBR's compilations — Wahl 1998, DSO-98-004, and Wahl 2004, J. Hydraul. Eng. 130(5) — and cited in
  the code): three **breach-parameter** relations (Froehlich 2008, Froehlich 1995, Von Thun & Gillette 1990) whose
  width and formation time are routed through the reservoir by the hazard chain's weir-flow ODE
  (`src/hazard/breach.ts`), the breach growing linearly to that width over that time and the reservoir drawing down by
  a storage curve fitted to the NID's own area and storage; and five **peak regressions** (MacDonald &
  Langridge-Monopolis 1984, Froehlich 1995, Froehlich 2016, Xu & Zhang 2009, Pierce et al. 2010). Their lowest and
  highest peaks are the **low / high** band; the **central** case is the relation that best reproduces the record
  (below). The hydrograph sent to the map is the central case by default (a gamma shape with that peak and the exact
  volume); *low*, *high* and the routed Froehlich 2008 breach (`parametric`, the default until this band existed) are
  one click away, and `method=` in the link.
* **Scored on 21 documented failures.** [`src/dams/historicalFailures.ts`](src/dams/historicalFailures.ts) holds every
  case in Wahl 1998 Table A1 with an observed peak, a volume, a head and a failure mode, except peaks whose method is
  "unknown", heads given only as a bound, and the two Wahl flags as unfit — 21 failures from 7,400 m³ (Ireland No. 5)
  to 310 million m³ (Teton), including Teton 1976, Lawn Lake 1982, Kelly Barnes 1977, Buffalo Creek 1972, Baldwin
  Hills 1963, Johnstown 1889 and Swift 1964. Errors are log₁₀(predicted / observed)
  (`tests/dams/breachRelations.test.ts`; `npx deluge dam --history` prints it):

  | Relation | n | Mean error (bias) | RMS error | Within ×2 | Teton (pred / obs) |
  | --- | --- | --- | --- | --- | --- |
  | **Froehlich 1995 peak** (central) | 21 | −0.07 (−16 %) | **0.15** | **100 %** | 0.66 |
  | Froehlich 1995 breach, routed | 21 | +0.07 | 0.19 | 81 % | 1.51 |
  | Froehlich 2008 breach, routed (earlier default) | 21 | +0.08 | 0.20 | 86 % | 1.64 |
  | Froehlich 2016 peak | 21 | −0.09 | 0.20 | 81 % | 1.22 |
  | Xu & Zhang 2009 peak | 20 | −0.17 | 0.26 | 75 % | 1.16 |
  | MacDonald & Langridge-Monopolis 1984 | 21 | +0.03 | 0.29 | 71 % | 0.34 |
  | Von Thun & Gillette 1990 breach, routed | 21 | +0.19 | 0.30 | 67 % | 1.27 |
  | Pierce et al. 2010 peak | 21 | −0.29 | 0.38 | 48 % | 0.53 |

  Froehlich 1995's regression is the central case on that evidence — Wahl 2004 found the same on 32 cases (the
  smallest mean error and the narrowest band of every peak equation he tested). It is **not** the best on Teton: there
  it is a third low (43,000 vs **65,120 m³/s**), while the routed Froehlich 2008 breach is 64 % high (107,000) and the
  band (22,000–107,000) holds the observed peak. The band holds 17 of the 21 observed peaks; every relation is low on
  Baldwin Hills (by 9 %), Buffalo Creek and Laurel Run, and high on Lower Latham (by 4 %). Caveats: the check is
  in-sample (most relations were fitted to many of these failures), Xu & Zhang's coefficients are taken at medium
  erodibility (the NID says nothing about it) and are not applied to concrete-faced rockfill, and Walder & O'Connor
  1997 is left out because it needs a breach erosion rate the NID does not have.
* **Arrival spread.** Next to each arrival time the readout gives the range it would have at the band's high and low
  peaks — not simulated, but the arrival read off the map rescaled by the kinematic-wave rule (travel time ∝ peak^−0.4,
  Manning flow in a wide channel) and labelled so. To see a case on the map, run it.
* **On the map**: Deluge first reads a 64 × 64 elevation probe around the dam to see which way the valley falls, then
  loads the live area (12 km by default) with the dam near its upstream edge, and sends the hydrograph in as an
  **inflow at the toe of the dam** — the lowest ground within a few dam-heights of the NID point — delivering exactly
  its volume (`src/sim/forcing.ts`, as the glacier chain does). Not a reservoir behind a wall: 3DEP is hydro-flattened,
  so over a reservoir it holds the water surface, not the lake bed, and a lake "filled" on it would hold almost none of
  the NID storage (the procedural sandbox can breach a real wall because it owns its terrain). The Arrival view comes
  on, and **Read arrivals** gives arrival time and peak depth at 0.5–12 km along the steepest-descent path below the
  dam. Site check, Impact & loss and evacuation work on it as on any scene; the climate layer never scales the wave.

Edenville Dam, Michigan (NID MI00549; it failed in May 2020), flood-induced, against the real services (e2e flow 28,
GTX 1660 Ti, measured with the routed Froehlich 2008 breach, the default at the time): the card gives 81.7 million m³
behind 17.4 m, a breach 134 m wide forming over 2.9 h, a routed peak of **11,700 m³/s** after 170 min; the valley
loaded in 11–16 s; in the first 90 simulated minutes (16 s of wall time) the wave reached 0.5 / 1 / 2 / 3 / 5 / 8 km
below the dam at 3 / 6 / 13 / 25 / 56 / 76 min, 9.0–3.9 m deep in the channel (river included). The band for
Edenville is **4,520–12,080 m³/s** (`npx deluge dam --nid MI00549 --breach flood`): the three routed breaches give
11,500–12,100 (the reservoir is wide and shallow, so its head holds up while the breach widens), the five regressions
4,520–6,810, and the central case is the lowest, Froehlich 1995's 4,520 m³/s, which is now what the map receives by
default (flow 28 has not been re-run on it). No measured outflow for Edenville is quoted here. Honest limits, in the panel: the reservoir is the NID's storage and area, not a
survey; spillways, gates, outlet works and downstream dams are not modelled; the relations were fitted mostly to
earth and rockfill dams (a concrete dam is flagged as indicative), and a dam larger than Teton is flagged as an
extrapolation. Screening for planning, not an EAP inundation map.

**Coastal surge exposure** (`?usecase=surge&at=<lat>,<lon>`). For a coastal developer or lender the question is how
often the sea reaches the site. A **surge return-period ladder** in Site check, like the Atlas 14 rain ladder: the
**NOAA CO-OPS Extreme Water Levels** at the nearest long-term tide gauge — the annual exceedance probability levels
(99 %, 50 %, 10 %, 2 %, 1 %, i.e. 1- to 100-year) of a GEV fit to the gauge's annual maxima — put on the map's datum
with the station's MHHW above NAVD88. [`scripts/bake-surge.ts`](scripts/bake-surge.ts) baked 125 stations, with their
datums and NOAA 2022 sea-level-rise scenarios, into `public/surge/ewl-stations.json` (38.5 kB; the CO-OPS APIs do allow
CORS, but a 38 kB table works offline and adds no endpoint). NOAA's SLOSH MOMs were the other candidate and were not
used: they are per hurricane category (no annual chance, so no EAL), and the public maps are binned depths above
ground rather than water levels. The set-up loads 8 km around the point, finds the **seaward edges** — water the
loader pre-filled near sea level that reaches the map edge — puts the sea boundary on them at MHHW (other edge
boundaries are dropped, so the rivers don't rise with the sea), drops a site, and ticks the five levels (90 simulated
minutes each by default: the sea has to cross the low ground). Return periods are NOAA's, so the sweep ends in an EAL;
**Today vs future** adds NOAA's 2022 Intermediate-Low / Intermediate rise at the same gauge (the climate layer reads
it from the scenario). *Use this map* does the same on any live area already on screen.

Fort Myers is the check: station 8725520 reproduces the Fort Myers preset's hand-transcribed ladder to the centimetre
(1 % level 2.05 m NAVD88, 90 % CI 1.47–3.47) and its sea-level-rise record equals the climate layer's. At **Fort Myers
Beach** (26.4515, −81.9506, a slab-on-grade building), against the real services (e2e flow 29): the nearest analysed
gauge is Fort Myers, 23 km up the Caloosahatchee; the site is dry to the 50-year level and takes 0.25 m at the 1 %
level (6.7 ft NAVD88), its last road out closes 2 minutes before the water arrives, and the EAL is **$6,090–$18 k a
year**; under 2050 SSP5-8.5 (NOAA Intermediate, +0.32 m at the gauge) the same sweep gives **$51 k–$76 k** (×4–5,
a small level change on flat ground). Hurricane Ian put 12.92 ft (station datum, 2.29 m NAVD88) on that gauge and far more on the
beach — which is the honest caveat: one gauge, possibly in a different bay, stands for the whole map, and the levels
are still water (tide + surge + gauge-felt setup), with no wave run-up. Stations with no NAVD88 tie (Hawaii, the
islands, much of Alaska) fall back to MSL and say so. Every surge result says which gauge stands for the sea and how
far it is from the map centre, and when the gauge lies off the loaded map, that it is possibly in another bay or up
another estuary (`src/surge/coastal.ts` `gaugeNote`: in the set-up notice, the Site check sweep and the surge caveats).
The levels themselves are not adjusted for it.

## Glacier hazards

Three Himalayan scenarios start their flood upstream of the map, in a **hazard chain** (`src/hazard/`, design in
[docs/research/glacier-hazard-chain.md](docs/research/glacier-hazard-chain.md)): a source (lake volume from its area,
a moraine breach eroding at a set rate, or a rock-ice avalanche and the ice it melts) → its outflow hydrograph → a
1-D routing of the wave down a valley profile baked from the DEM (`chain.json`: 32–73 km of thalweg and
cross-sections, with hydropower plants, towns and gauges on it) → the routed hydrograph enters the 2-D map as an
inflow that delivers exactly its volume → the 2-D solver runs it with a **debris-flow rheology** (O'Brien–Julien,
Voellmy or Bingham, ARCHITECTURE.md §3.9) and a 25 m/s speed cap. The chain runs in a Web Worker in about a second,
plus a 27-member ensemble for p10–p90 bands; each preset also ships the calibrated run it was baked with.

The **valley timeline** under the map shows the profile, the front moving down it in step with the simulation clock,
each station lighting up as it passes with its modelled and observed arrival in the event's own clock ("09:41 NPT"),
and the hydrograph at the source and at the map edge. The **Early warning** designer places sensors on that profile
(gauge, trip-wire, camera, seismic; detection and alert latencies) and gives each town and plant its lead time, the
best single sensor site, and the lead time against sensor position. `?usecase=glacier` opens it on Nepal.

| Scenario | Event | Model vs observed (median run) |
| --- | --- | --- |
| **Betrawati — Trishuli** (`nepal`) | 26 Aug 2026: Langtang Lirung rock-ice avalanche → Bhote Koshi → Trishuli; ~20 Mm³ of excess water, the Betrawati bridge lost | front at Betrawati **65 min** after the avalanche vs **43 min** reported (when its gauge went silent) — the model is late; Syafrubesi 29 vs 13–23 min |
| **Chungthang — Teesta** (`chungthang`) | 3–4 Oct 2023: South Lhonak lake outburst, 68 km upstream; the 1,200 MW Teesta-III dam destroyed | front at Chungthang **121 min** vs **~142 min** reported (00:35); peak **~5,700 m³/s** vs 5,340–14,673 reconstructed |
| **Raini–Tapovan** (`chamoli`) | 7 Feb 2021: Ronti peak collapse → debris flow; Rishiganga (13.2 MW) and Tapovan-Vishnugad (520 MW) plants hit | front at Raini **11 min** vs **6**, at the Tapovan barrage **19 min** vs **15–16**, at Joshimath **34 min** vs **37.5** (seismic); peak at Raini **~9,400 m³/s** vs 8,200–14,200 |

These are honest residuals, not fits: the calibration changed physics (trigger mechanism, a smoothed bed, a minimum
channel width, the avalanche's own travel time, Ferguson's boulder-bed resistance law with a literature grain size;
then a debris-flow surge whose peak rides its front, the river's own monsoon flow, a sliding-block runout with a
published friction pair for Chamoli, the measured lake drawdown for South Lhonak) and refused to tune Manning n, a
grain size, a breach rate or a friction pair to the clock. Some of the gap was the observations: Nepal's "08:40 at
Rasuwagadhi", "08:50 at Syafrubesi" and "09:20 at Betrawati" are gauge timestamps (a last normal reading, data lost),
and Chungthang's "00:30" was a published model's answer, not a sighting. What is left — Nepal still ~50 % late,
Chamoli late above Tapovan and early below it, Chungthang ~14 % early — is listed with its suspects in
[§G.9](docs/research/glacier-hazard-chain.md). Nepal's gap is not in the routing: below Rasuwagadhi the routed front
moves at Rickenmann's (1999) empirical debris-flow velocity for the discharge it carries (14.8 against 15.5 m/s over
the 45 km to Betrawati; a test pins it within ±15 %), and the reported time would need about 40,000 m³/s held over
those 45 km — 1.6× the ensemble's p90 peak. No published celerity, width or resistance closes it, so the model was
left as it is. Every scenario's on-screen text gives its own error. Lead times from the
designer are therefore best read as differences between sensor designs, not absolute minutes.

## Future climate

Anyone building or lending for 30–50 years gets asked what the site looks like in 2050 or 2080 (IFRS S2 scenario
analysis, lender questionnaires). **Weather & rivers → Future climate** picks a horizon — Today, 2050, 2080, 2100 — and
a pathway — SSP2-4.5 (middle of the road) or SSP5-8.5 (high) — and scales this scene's *forcing*; the solver then
makes the flood:

* **Rain and storm cells** × (1 + α)^ΔT, with ΔT the global warming since 1995–2014 from IPCC AR6 Table SPM.1 and α =
  7 %/°C (Clausius–Clapeyron, AR6's figure for daily extremes) or 10 / 14 %/°C (the observed super-CC band for hourly
  bursts). 2050 SSP5-8.5 at 7 %: ΔT 1.55 °C, rain × 1.11 (Harvey's 173 mm/hr → 192); 2100 SSP5-8.5: × 1.27.
* **Rain-fed inflows** × the same factor; a dam-break surge (Johnstown 1889) and a hazard-chain wave are left alone.
* **Sea level** at Fort Myers: + NOAA 2022 relative rise at gauge 8725520 (SSP2-4.5 → Intermediate-Low 0.28 / 0.49 /
  0.62 m, SSP5-8.5 → Intermediate 0.32 / 0.70 / 1.10 m in 2050 / 2080 / 2100), on top of the stage slider.
* **River stages** (Pittsburgh, Nashville) are not scaled — a stage is the hydraulics' answer, not a forcing.
* **Glacial lakes**: South Lhonak's area grows with warming along its 2008–2023 trend (capped at 2×), its volume
  follows from the chain's V–A relations, and the hazard chain re-runs with it.

It is a layer on what the solver receives: the rain slider, the inflow list and the stage slider keep showing
today's values, and the block lists every modified number with its source. In **Site check**, **Today vs future**
runs the ladder twice and reports "EAL today $X → 2050 · SSP5-8.5 $Y" with per-level losses, in the panel and the
report (return periods stay today's). Both runs of a level are exactly as long as asked, so the difference is the
climate, not run length. Forcing-scaled, not downscaled projections; method, sources and gaps in
[docs/research/climate-scenarios.md](docs/research/climate-scenarios.md), code in [`src/climate`](src/climate).

## Saved projects and design comparison

**Project** (panel section) saves everything on screen as a `<name>.deluge.json` file and opens it again: the scene (a
preset id, or the live-area request that reloads the same grid), your scenario changes (river stage, rain, Manning n
and the other user-facing solver parameters, sources, storm cells, shelters, the evacuation start, future climate, a
glacier chain's what-if), the walls, levees and digging, the Site check sites and sweep settings, the ensemble
settings, the designs below, camera and water view — and, only when ticked, the portfolio CSV (it may be sensitive)
and the last comparison's numbers. **Share link** puts a small project into the address bar as `?project=` (gzip +
base64url, at most 6,000 characters — a levee, a site and two designs on Pittsburgh is ~2,200); a larger one says so
and asks for the file. Links never carry names or a portfolio.

The format is versioned (`"format": "deluge-project", "version": 1`) and documented field by field in
[src/project/format.ts](src/project/format.ts). Walls are kept as their **edit log** — each drawn wall or levee is one
polyline with a height per segment, followed by erases and dig / raise strokes in order — because the solver builds
its barrier raster from capsule brush ops with a soft edge that cannot be turned back into ops; replaying the log
rebuilds the same barrier (`tests/project`). Reading is strict: size, nesting and value-count caps, `__proto__` /
`constructor` / `prototype` keys refused, every number range-checked, every enum from its list, every string cleaned
and only ever written as text, unknown keys ignored, and fixed error sentences that never echo the file.

**Compare designs** (panel section) puts 2–3 mitigation designs side by side. Capture the walls on the map as Design
A (the one-click levee, or anything drawn), **Clear walls**, draw Design B, capture it, then **Compare**: the baseline
(no walls) and every design run the chosen ladder — the Site check river / tide ladder, the NOAA Atlas 14 rain ladder,
forcing multipliers, or the scenario on screen — headless, with the designs swapped in by replaying their logs and
your own walls put back afterwards. Per design: loss per level, EAL, ΔEAL against the baseline, cost (the eal.ts unit
costs per metre × height^1.3 summed along the drawn segments, by type, or your own figure and O&M), NPV and BCR over
the design's useful life at 7 % and 3.1 %, buildings protected, and **who gets wetter** — buildings newly reached or
more than 10 cm deeper, land newly flooded or deeper — with a map of the change in max depth per design. It exports as
a print / HTML report and travels in the project file.

Pittsburgh, the one-click North Shore levee against its upstream half (a shorter wall, 1.1 km at the same crest), on
FEMA's 1 % level and the 1936 crest (500-yr typed as the user's return period), 30 simulated minutes per level — six
runs in 44 s here:

| | Baseline | One-click levee | Shorter wall |
| --- | --- | --- | --- |
| Loss, FEMA 1 % / 1936 crest | $793 M / $12.6 B | $742 M / $10.7 B | $792 M / $12.0 B |
| EAL · ΔEAL | $78.6 M | $67.0 M · **$11.7 M/yr** | $75.2 M · $3.4 M/yr |
| Cost (floodwall unit costs) | | $190 M (2,415 m × 7.2 m) | $106 M (1,133 m × 8.3 m) |
| NPV 7 % · 3.1 % | | −$29 M · +$105 M | −$59 M · −$19 M |
| BCR 7 % · 3.1 % | | 0.85 · **1.55** | 0.45 · 0.82 |
| Buildings protected · newly reached · deeper | | 87 · 1 · 5 | 11 · 2 · 23 |
| Land newly flooded or deeper | | 34 acres | 77 acres |

The shorter wall costs more than half as much and buys a quarter of the benefit, and it pushes more water onto its
neighbours than the full levee does. Screening numbers on bare-earth terrain, like everything above.

**Benefit–cost.** Below the table, each design gets an investment view at a discount rate you set (default **7 %**
real: OMB Circular A-94 (1992), which OMB reinstated on 8 April 2025 when it revoked the 2023 update's 3.1 %; FEMA's
BCA Toolkit has defaulted to 7 % again since its 4 June 2025 release) over a **useful life** per design (default
FEMA's standard value for its type from the BCA Reference Guide, Appendix D: 50 years for flood walls and levees,
with 30 for residential elevation, 25 for non-residential elevation and dry floodproofing, and 100 for acquisition in
the same table), with its cost and annual O&M on the design's card and an analysis year. It shows the avoided EAL (the
same trapezoid over the same ladder as the EAL rows), the present value of benefits and of construction + O&M, the
**BCR with its range**, the net benefit, the **break-even construction cost** (the most it can cost for BCR 1) and a
verdict that says "pays" only when the whole range clears 1. A BCR is never shown on its own. The range is taken over
every corner of the damage curves at ±1σ (before and after together), the unit-cost band (±50 %, none for a typed
figure), the EAL with and without its tail (two levels or more), and, once a flood-probability **ensemble** has run on
the scene (Uncertainty), its loss p10 / p90 as ratios to its p50 — the ensemble ran on the scenario on screen, not on
each design and level, and the note under the block says so. Return periods, what the model leaves out, and the
discount rate and useful life themselves are never in the range. Changing a cost, a useful life or the rate recomputes
at once without a re-run. Same run as the table, at 7 %:

| | One-click levee | Shorter wall |
| --- | --- | --- |
| Avoided EAL (range) | $11.7 M/yr ($7.8–11.8 M) | $3.4 M/yr ($1.9–4.3 M) |
| PV benefits · PV costs (50 yr) | $161 M · $190 M | $47.6 M · $106 M |
| BCR (range) | **0.85 (0.38–1.72)** | 0.45 (0.16–1.13) |
| Net benefit (range) | −$29 M (−$176 M to +$68 M) | −$59 M (−$134 M to +$7 M) |
| Break-even construction cost | $161 M | $47.6 M |
| Verdict | uncertain: the range straddles 1 | uncertain: the range straddles 1 |

With a 3-member ensemble of the bare scene at the 1936 crest (loss p10 / p50 / p90 $11.9 / 12.4 / 14.7 B) and the
levee compared on that level alone (500-yr), the levee's BCR at 7 % is 0.26 / 0.27 / 0.32 at the ensemble's p10 / p50
/ p90, inside an overall range of 0.17–0.66 (e2e flow 45). The pure math is in [src/loss/bca.ts](src/loss/bca.ts)
(`analyzeBca`, `bca`, `avoidedEal`; tests in `tests/loss/bca.test.ts`), usable outside the panel; the CLI has no
compare command yet.

The report adds the same block and an **Appendix — FEMA BCA Toolkit inputs**: per design, the damages before and after
mitigation per recurrence interval (the Toolkit's Damage-Frequency Assessment), the project useful life with its
source, the construction cost and annual maintenance, the discount rate and the analysis year, with Deluge's own ΔEAL
and BCR to check the Toolkit's answer against. It says in so many words that it is **not a FEMA-accepted BCA**: the
damages are building structure and contents from a bare-earth screening model, for an engineer to check and
transcribe. Projects (and `?project=` links) keep the rate, the analysis year and each design's useful life, read
strictly like everything else: a rate outside 0–20 % or a year outside 1990–2200 drops the section with a fixed
warning, and a useful life that is not a whole number of years from 1 to 200 drops its design.

**Autosave** (off by default, under Project → Privacy) is the one thing in Deluge that writes to browser storage:
when switched on it keeps the project (never the portfolio) in this browser's localStorage and offers it back next
time; switching it off deletes the copy. It never overwrites that copy on its own: a session writes only after a real
change (or a restore), and its first write keeps the previous copy one step back (Project → Privacy → Restore the
earlier copy). The desktop app clears storage each time it starts, so there it lasts until you quit, and it blocks
downloads by design (Save says so; Share link still works). A `?project=` link opens its walls, sites and settings at
once but asks before applying its digging, and the reader refuses a project whose edits would take too long to replay.

## Batch / API

The same simulator without the browser, for portfolios, sweeps and scheduled jobs: `deluge` is a Node CLI
([`src/cli`](src/cli), launched by [`bin/deluge.mjs`](bin/deluge.mjs)) that runs the app's own TypeScript — solver,
scenario wiring, loss model — on the machine's GPU through Dawn (the `webgpu` package the GPU tests use: D3D12 on
Windows, Metal on macOS, Vulkan on Linux). Offline, nothing uploaded. After `npm ci`:

```bash
npx deluge presets --levels                       # the ten scenarios and their Site check levels (no GPU)
npx deluge run --preset houston --minutes 60 --rain 173 --out results/harvey
npx deluge run --preset pittsburgh --stage-ft 46 --out results/1936
npx deluge run --preset houston --climate 2050:ssp585 --out results/houston-2050
npx deluge portfolio --preset houston --csv public/demo/houston-portfolio.csv --minutes 60 --out results.csv
npx deluge portfolio --preset houston --csv assets.csv --members 12 --seed 7 --out results.csv --summary summary.json
npx deluge site --preset pittsburgh --at 40.4425,-80.0085 --use office --floors 3 --sweep --out report.json
npx deluge site --preset houston --at 29.7725,-95.3837 --scenario a14-100   # NOAA Atlas 14 100-yr 1-hour rain
npx deluge dam --nid MI00549 --breach flood       # a dam breach's peak band and hydrograph (no GPU)
npx deluge dam --history                          # the breach relations scored on 21 documented failures
npx deluge <command> --help                       # every option
```

(`npm run deluge -- …` works too.) Scenario options are shared: `--minutes` (default 30, as in the app), `--stage-ft`
(a gauge reading, as on the slider), `--rain` (mm/hr), `--scale k` (rain, storm cells and inflows × k), `--manning`,
`--climate 2050|2080|2100:ssp245|ssp585[:cc|super10|super14]`, and `--scenario <level>` for a rung of one of the
preset's Site check ladders (`rp100`, `record1936`, `a14-100`, `x0.5` …). The ladders are the app's, read from the same
files: a researched river / tide ladder, the NOAA Atlas 14 rain ladder (`a14-2` … `a14-500`, 1-hour rain at the map
centre from `public/atlas14/pf60m-pds.bin`, for presets Atlas 14 covers) and the forcing multipliers. An `a14-…` level
is rain only, as in the app: rivers at normal level, inflows and storm cells off, the level's intensity for one hour,
then run-off — 120 simulated minutes unless `--minutes` says otherwise.

* **`run`** writes four GeoTIFFs and `summary.json`. The rasters are the solver's hazard fields
  (`FloodSolver.readHazardFields`), single band, in **EPSG:3857** with the tie point on the grid's outer north-west
  corner — the grid is linear in Web Mercator ([src/contracts.ts](src/contracts.ts) `GeoBounds`), so QGIS / GDAL place
  them exactly: `max_depth_m.tif` and `max_speed_ms.tif` (Float32), `arrival_min.tif` (minutes until water first stood
  > 0.15 m on land dry at the start; nodata −9999), `hazard_aidr.tif` (AIDR H1–H6 on flooded land, UInt8, 0 = none).
  The summary has the scenario as run (stage levels, rain, climate multipliers, the hazard chain's routed peak),
  flooded area, area per hazard class, the mass ledger, buildings reached / damaged / destroyed and the dollar loss.
* **`portfolio`** reads the in-app portfolio CSV (`asset_id`, `lat`/`lon` or `wkt`, values, floors, revenue, policy
  terms …) and writes the **in-app export's columns** cell for cell — depth, speed, AIDR and FD2321 class, arrival,
  damage, loss with its ±1σ range, downtime, BI, insured loss, access road — plus an `outside` row for any asset off
  the map. `--members N` adds the Uncertainty panel's ensemble (Latin hypercube from `--seed`, the same bands, the
  terrain-error field): `ens_reached_members` ("floods in k of N"), depth and loss p10 / p50 / p90.
* **`site`** is the Site check card: for the scenario, or with `--sweep` across the ladder the app picks — a
  researched river / tide ladder, else the Atlas 14 rain ladder on a rain-led preset (Houston, Boulder), else the
  multipliers — and the levels it ticks by default (`--ladder stage|rain|scale` and `--levels` to choose,
  `--rp x0.5=10,x1=100` for return periods the ladder lacks), with egress, EAL, the
  loss-exceedance points, the indicative finished-floor elevation, mitigation options with BCR and the verdict
  sentences. Every run carries `egressTiming` — leaving by road: share of occupants out before the last route closes,
  clearance vs route window, the departure curve and the bottleneck — set with `--occupants`, `--alert-min` (negative:
  warned before the run), `--departure good-likely|poor-likely|poor-unlikely|fast`, `--persons-per-car` and
  `--exit-lanes`. The HTTP API takes them as `egress` on a site check.
* **`dam`** is the dam-breach card without the map (no GPU): for an NID dam (`--nid`, from the app's baked index) or a
  dam you describe (`--volume-m3 --head-m [--height-m] [--overtopping]`), sunny-day or flood-induced, the eight
  relations' peaks with citations, the low / central / high band, the hydrograph the map would receive
  (`--method central|low|high|parametric`; `--out` writes it as CSV), the indicative arrival spread and the
  assumptions; `--json` for all of it. `--history` prints the score table of
  [Dam breaches](#dam-breaches-and-coastal-surge).

**Same numbers as the browser.** A run is the app's headless run: the store, `SimSync`, the stage ramp, the crest fill
and the climate layer are the app's own classes; frames advance 1/60 s at 3600× and stop exactly on the target,
hazard maxima are sampled every 5 simulated seconds; the loss calls are the panels' calls. The one deliberate
difference is when the GPU is read back — every 60 *simulated* seconds instead of every 300 ms of wall clock — which
makes a CLI run **bit-identical when repeated** on the same machine, where two browser runs agree to millimetres
([§ Impact & loss](#impact--loss)); `--app-cadence` restores the browser's cadence. Checked two ways:
`tests/cli/parity.test.ts` feeds the commands and the loss module the same fields and compares the CSV and the report
cell for cell, and `tests/cli/smoke.test.ts` (GPU) reproduces the binary's portfolio CSV from an in-process run and
runs a sweep twice. Against the app's own published numbers: the 60-minute Harvey portfolio gives 14 of 19 assets
reached, **$17.1 M** (±1σ $8.8–25.9 M), insured $23.5 M (BUSINESS.md §4.2 has 14–15, $17.2–17.3 M, $23.6 M); the
Point office sweep gives 1.03 m at the FEMA 1 % level and 4.50 m at the 1936 crest, an indicative floor 1.33 m above
grade (the panel: 0.98 m, 4.5 m, 1.28 m).

**Speed on the GTX 1660 Ti here** (1024² grids, 2–6 s of the total is loading the preset): Pittsburgh at the 1936
crest, 30 simulated minutes in 4.5 s; Houston under Harvey's rain, 60 minutes in 13 s; the seven-level Point sweep in
48 s. Those are with the GPU to itself; with other GPU jobs on the machine the same runs took 2–4× longer.

Progress and notes go to stderr, results to files or stdout (`--out -`). Exit codes: 0 done, 1 the simulation or an
output failed, 2 bad arguments or input file (checked before the GPU starts), 3 no WebGPU adapter.

**HTTP job API.** `deluge serve` puts the same commands behind HTTP ([docs/api.md](docs/api.md) has the endpoints,
schemas, OpenAPI and security model):

```bash
npx deluge serve                                   # http://127.0.0.1:8787, this machine only
curl -s -X POST localhost:8787/v1/runs -H 'content-type: application/json' \
     -d '{"preset":"pittsburgh","scenario":{"stageFt":46,"minutes":10}}'      # → 202 {"id":"job_…","status":"queued",…}
curl -s localhost:8787/v1/jobs/job_…                                         # status, progress, engine, files
curl -s -O localhost:8787/v1/jobs/job_…/results/max_depth_m.tif
```

`POST /v1/runs`, `/v1/portfolio-assessments` and `/v1/site-checks` map a JSON body onto exactly the options of
`deluge run`, `portfolio` and `site` and run that command's handler in-process — no new physics, so an API raster is
the CLI's byte for byte (`tests/cli/server-gpu.test.ts`). They answer `202` with a job; one queue runs one job at a
time on the GPU; `GET /v1/jobs/:id` polls it and `GET /v1/jobs/:id/results/<file>` downloads `summary.json`,
`results.csv`, `report.json` or the GeoTIFFs; `DELETE` cancels or deletes. Everything the CLI checks before its GPU
starts is checked before queueing, by the same functions, so a bad preset, level, stage, climate, site or CSV is a
`400` at once — with a fixed sentence that never echoes the request. An `Idempotency-Key` returns the existing job;
each job records the engine version, git commit, GPU and the equivalent command line. It binds 127.0.0.1 by default
and refuses any other address without a bearer token (`DELUGE_API_TOKEN` or `--token-file`); it checks the `Host`
header against DNS rebinding, takes only `application/json`, caps bodies (64 KiB; 12 MiB for a portfolio, whose CSV
is then held to 5,000 rows and 5 M characters), serves only the seven result names of a job's own directory, makes no
outbound requests (no webhooks yet) and deletes finished jobs after `--retention-hours` (default 30 days).

## Ten scenarios, offline

Every scene is baked into the repo and needs no network. The seven US cities in the table below have real USGS
elevation, real NAIP photography, real Census streets, and a scenario built from that city's own gauge records (sources and licences:
[public/presets/SOURCES.txt](public/presets/SOURCES.txt)). Load time, frame rate and sim speed are measured in the
production build at 1470x956 DPR 2 on the demo MacBook Air M4, offline, with the scene's own camera and forcing —
one fresh browser context per scene, on a machine that was in Low Power Mode and sharing its GPU, so read them as an
upper bound on load time and a lower bound on speed. Sim speed is how many simulated seconds each wall-clock second
buys while the flood plays; it swings ±10 % run to run.

| Scene | Flood | Domain / cell | Photo | Streets | Cold load | fps | Sim speed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Pittsburgh — Three Rivers** | 1936 St Patrick's Day crest, 46 ft | 8.0 km / 7.81 m | 1.95 m/texel + 3.0 km inset at 0.73 | 11,053 | 744 ms | 60 | ~100× |
| **Johnstown — Conemaugh Valley** | 1889 South Fork Dam flood as a 3,730 m³/s inflow | 7.0 km / 6.84 m | 1.71 + 2.5 km inset at 0.61 | 4,903 | 687 ms | 60 | ~82× |
| **Ellicott City — Main Street** | 2016 flash-flood storm over the Tiber branch | 5.0 km / 4.88 m | 1.22 m/texel | 1,224 | 606 ms | 60 | ~53× |
| **Asheville — French Broad Valley** | Hurricane Helene, 27 Sep 2024: record crests on two rivers | 8.0 km / 7.81 m | 1.95 + 3.0 km inset at 0.73 | 3,556 | 705 ms | 60 | ~125× |
| **Nashville — Cumberland River** | May 2010 flood; the slider also holds 1937 and the 1927 record | 6.0 km / 5.86 m | 1.46 m/texel | 5,410 | 686 ms | 60 | ~85× |
| **Houston — Buffalo Bayou** | Hurricane Harvey, Aug 2017: 173 mm/hr over a dead-flat plain | 8.0 km / 7.81 m | 1.95 + 3.0 km inset at 0.73 | 10,529 | 691 ms | 60 | ~63× |
| **Boulder — Canyon Mouth** | 2013 Front Range flash flood out of Boulder Canyon | 5.0 km / 4.88 m | 1.22 m/texel | 1,749 | 636 ms | 60 | ~48× |

Also baked, and not in the M4 measurements above: **Fort Myers — Caloosahatchee** (Hurricane Ian's 2022 storm surge
up a tidal river, 8.0 km / 7.81 m), and the three Himalayan glacier scenarios of [Glacier hazards](#glacier-hazards)
— **Betrawati** and **Chungthang** (8.0 km / 7.81 m) and **Raini–Tapovan** (12.0 km / 11.72 m) — built from Copernicus
GLO-30 radar elevation through a bare-earth filter, OpenStreetMap roads and buildings, and no aerial photograph (each
licence is in SOURCES.txt). Plus a procedural **sandbox** (river town, reservoir and dam) that uses no external data
at all.

**The close-up inset.** Four of the domains are wide enough that a single 4096² photo lands at ~1.7–2.0 m/texel, which
is mush at street level — so those four carry a second 4096² NAIP photo over the middle 2.5–3.0 km, blended into the
base in the terrain shader with an 8-cell feather. It buys 2.4–2.7× the texel density exactly where the scenario
cameras fly, costs 89.5 MB of GPU memory and 3.5–5.1 MB on disk each, and measures free on both load (−23 ms,
interleaved A/B) and frame time (deltas inside sample noise, one of them negative). The other three domains are
already at 1.22–1.46 m/texel, close enough to NAIP's own ~1 m limit that an inset would add megabytes and no detail.
`public/presets` totals 121.6 MB across eleven presets against a 125 MB static-host budget enforced by
`tests/data/presets.test.ts`. A visitor never downloads that number — presets load one at a time, so the cost is the
largest single preset (Asheville, 17.1 MB), which a separate 25 MB per-preset cap holds down; the directory total is
a host-and-repo budget, and the rationale for where it sits is in
[ARCHITECTURE.md §5](ARCHITECTURE.md#5-data).

## Why this is hard

An explicit shallow-water solver on real terrain wants to explode: rivers are deep and fast, floodplains are
centimetre-thin films, walls and streets are one cell wide, and everything runs in Float32 on a GPU in parallel.
Four ingredients keep Deluge stable, exact and fast (details in [ARCHITECTURE.md §3](ARCHITECTURE.md#3-numerical-method)):

1. **CFL-adaptive timestep with the 2-D Courant number** `dt = Cr·dx / (√2·max(√(g·h) + |u|))`, from asynchronous
   readbacks inflated by what is known to be coming. A wave never jumps more than a cell.
2. **Semi-implicit friction:** dividing instead of subtracting, so friction on thin films can only slow water down.
3. **Positivity-preserving flux limiter:** a cell can't give away more water than it holds, so depth stays ≥ 0 without
   clamping. A per-cell ledger books every change to the water — even the GPU's own Float32 rounding — so the HUD's
   mass-balance error stays ≈ 10⁻⁷ after hours of a crest with hurricane rain.
4. **Well-balanced face depths:** a lake at rest on steep, rough terrain stays at rest.

On top of that: minmod-limited θ-smoothing that damps grid-scale noise but not flow along staircase banks, open
boundaries that let rivers leave at their own depth, water-level boundaries that hold no momentum, and a river stage
that rises in simulated time instead of dam-breaking along every bank.

### Validation

From `npm test` (the solver tests run on a real GPU through Dawn); the grid-convergence rows from
`npx tsx scripts/reference-run.ts`, also on the real GPU:

| Check | Result |
| --- | --- |
| Lake at rest on rough terrain, 2000 steps ([wellbalanced](tests/sim/wellbalanced.test.ts)) | max \|u\| = 9.3·10⁻⁵ m/s |
| Dam break vs the Ritter analytic solution ([dambreak](tests/sim/dambreak.test.ts)) | profile error 1.6 % (L1) |
| Closed domain mass conservation ([conservation](tests/sim/conservation.test.ts)) | mass error 7·10⁻⁹ (volume change 2.5·10⁻⁶, all booked rounding) |
| Open domain with rain, storms, inflow, stage, infiltration ([conservation](tests/sim/conservation.test.ts)) | mass error ≤ 9.1·10⁻⁸ |
| Deep river with rain and a stage boundary, 3 sim-hours ([conservation](tests/sim/conservation.test.ts)) | mass error 5.9·10⁻⁷ |
| Rain on a tilted plane at steady state ([boundary](tests/sim/boundary.test.ts)) | outflow / rain = 1.000 |
| Channels at 0–60° to the grid ([channel](tests/sim/channel.test.ts)) | depth within 6 % of Manning's normal depth (0.98–1.05) |
| GPU (Float32, parallel) vs Float64 CPU reference, 5 cases × 400 steps ([reference](tests/sim/reference.test.ts)) | max \|Δh\| ≤ 4.3·10⁻⁵ m |
| Grid convergence, 1936 crest: the 1024² demo grid vs a 4096² run of the same solver, 16× the cells, 30 sim-min ([reference-run](scripts/reference-run.ts)) | flooded area −0.92 %, flood-extent IoU 98.0 %, max-depth RMSE 0.29 m (median 6 cm), landmark arrivals within 2.2 % |
| The same under 100 mm/hr rain ([reference-run](scripts/reference-run.ts)) | flooded area −0.55 %, flood-extent IoU 78.2 %, max-depth RMSE 0.22 m (median 5 cm) |
| All seven baked cities in the production build, offline, at 1470x956 DPR 2 ([e2e](scripts/e2e.mjs) flow 7, [presets](tests/data/presets.test.ts)) | load 606–744 ms, 58.7–60 fps, sim 48–134× real time, mass error ≤ 6·10⁻⁸, no console or WebGPU errors, zero network requests |
| Every scene's streets, shelters and evacuation routing ([e2e](scripts/e2e.mjs) flow 5) | 1,224–11,053 road edges, 4–5 shelters, a route plans dry and re-plans as streets flood, on all seven |
| Optional land-surface layers: off or neutral they are the old solver bit for bit; GPU vs Float64 CPU reference with buildings, a roughness map and drains; drains booked exactly ([landSurface](tests/sim/landSurface.test.ts)) | bit-identical; max \|Δh\| 1.2·10⁻⁴ m; mass error ≤ 1.4·10⁻⁷ in every evaluation run |

In the running app the HUD's mass-balance error stays below 0.001 % at the 1936 crest, with or without hurricane rain.

**The flood is not an artefact of the cell size.** The same solver on the same scenario at 7.81, 3.91 and 1.95 m cells
(34 minutes of GPU time on this laptop — the 4096² reference run needed no rented GPU) agrees to about 1 % in flooded
area, and halving the cell size halves the error. It converges *less* well where you would expect: rain puts water in
noticeably different places at 7.8 m (78 % overlap against the reference, against 98 % for the river crest), the worst
1 % of flooded cells differ by more than 1.3 m — those are flood-margin and street-width flow paths — and the area with
*any* water (1 cm) under rain does not converge at all. What this does and does not prove, in detail:
[ARCHITECTURE.md §9.1](ARCHITECTURE.md#91-grid-convergence-the-demo-grid-against-a-16-finer-reference). Short version:
it bounds the solver's discretisation error; it says nothing about whether a 7.8 m bare-earth DEM is the right terrain,
and nothing about accuracy against the real flood.

**Checked against the National Weather Service.** NWS impact statements for the Point gauge (PTTP1), against Deluge
holding each stage for 15 simulated minutes:

| NWS impact | NWS stage | Deluge |
| --- | --- | --- |
| Point State Park flooded to the Portal Bridge | 30 ft | dry at 30 ft, wet at 31 ft |
| PNC Park field flooded | 31 ft | dry at 31 ft, 1 m deep at 35 ft |
| Federal Street at PNC Park flooded | 40 ft | dry at 36 ft, wet at 40 ft |
| Up to 15 ft of water in the Golden Triangle | 46 ft | 15.7 ft at Point State Park |
| Acrisure Stadium field; Station Square tracks | 30 ft; 31 ft | first wet at 40 ft (both) |
| Wood Street T station; Parkway "bathtub"; Fort Pitt Blvd | 28; 25; 28 ft | wet only at 46 ft; dry at 46 ft; dry at 46 ft |

The water surface at the Point stays within 3 cm of the gauge reading at every stage. River-level and open-ground
impacts match within a few feet; the misses flood through what bare-earth elevation doesn't contain (storm drains,
underpasses, depressed roadways, underground stations). Full table: [ARCHITECTURE.md §4](ARCHITECTURE.md#4-rivers-stages-and-crests).

**Checked against real floods.** Every scene is re-run on the GPU and scored against what was observed — USGS
high-water marks and gauge peaks, the FEMA 1 % flood zone at FEMA's own 1 % river level, Copernicus EMS damage
grading, Metro Nashville's May 2010 damage survey — by `npx tsx scripts/validate.ts`, pinned by a regression test,
and shown in the app's Scenario section.
Full report, with the misses and why: [docs/VALIDATION.md](docs/VALIDATION.md).

| Scene | Observed | Deluge |
| --- | --- | --- |
| Fort Myers, Hurricane Ian | 25 USGS high-water-mark sites (tide set to the gauged peak) | bias +0.07 m, RMSE 0.14 m, all within ±0.3 m |
| Fort Myers / Nashville / Pittsburgh | FEMA 1 % zone at FEMA's 1 % level | CSI 88 % / 82 % / 61 % |
| Nashville, May 2010 | Metro Nashville's survey of damaged parcels, against 13,668 building footprints (river at the gauged 52.55 ft crest) | reaches 31 % of the damaged buildings — 98 % of those the river could reach; 70 % of the recorded damage is out of its reach (creeks, rain, drains); 14 % of the buildings it floods were not recorded |
| Asheville, Helene | USGS peak stage at 2 gauges | 1.44 m and 1.22 m too low |
| Houston, Harvey | 9 USGS high-water-mark sites (the scene is 1 hour of a 4-day flood) | 1.85 m too low on average |
| Betrawati, Nepal | Copernicus EMS EMSR927 damage grading | reaches 40 % of destroyed/damaged buildings, no false alarms on undamaged roads |

## How a frame works

```
solver.step ─▶ N substeps in one compute pass:  momentum pass ─▶ continuity pass   (CFL dt each)
renderer    ─▶ (every other frame) export pass (h, u, v, max depth; hazard accumulators) + prep ──▶ MSAA HDR → ACES
every ~300 ms, never blocking: stats reduction pass ─▶ mapAsync ─▶ HUD + road flood status ─▶ evacuation route
```

| Module | |
| --- | --- |
| [`src/sim`](src/sim) | GPU solver (WGSL in `shaders/`), forcing, brush edits, Float64 CPU reference |
| [`src/render`](src/render) | terrain LOD, water, hazard maps, walls, roads/route ribbons, camera, picking |
| [`src/data`](src/data) | USGS 3DEP / imagery / roads loaders, hydro-conditioning, presets, live areas |
| [`src/routing`](src/routing) | road graph, flood status per edge, travel-time Dijkstra |
| [`src/loss`](src/loss) | impact & loss: damage curves, values, hazard classes, access loss, sites/portfolio CSV, EAL/BCR, site check (egress timing, event ladders, FFE, verdict), ensemble sampling and aggregation (pure, no DOM) |
| [`src/climate`](src/climate) | future-climate tables (AR6 warming, rain scaling, NOAA sea level, lake growth) and the forcing transforms (pure, no DOM) |
| [`src/project`](src/project) | saved projects: the `.deluge.json` format, its strict reader, the terrain edit log, `?project=` links, opt-in autosave, design-comparison arithmetic (pure, no DOM) |
| [`src/ui`](src/ui) | panels, tools, HUD, How it works, location picker |
| [`src/app`](src/app) | scene loading, store → solver sync, stage ramp, protected-land analysis, frame pacing, screen wake lock, debug API (`window.__deluge`, dev and flagged builds only) |

## Repo tour

* `src/<module>/` — the app, one folder per module, integrated through [`src/contracts.ts`](src/contracts.ts).
* `tests/<module>/` — `node:test` suites (sim, render and the CLI smoke test on a real GPU through Dawn).
* `src/cli/`, `bin/deluge.mjs` — the headless batch CLI and its HTTP job API, `deluge serve` ([Batch / API](#batch--api)).
* `scripts/bake-presets.ts` — bakes `public/presets/*` (raw downloads cached in `artifacts/bake-cache`);
  `scripts/e2e.mjs` — end-to-end demo flows in headless Chromium on the real GPU; `scripts/bench.mjs` — the
  performance benchmark (`npm run demo`, then `npm run bench -- --scenario=pgh`); `scripts/shot.mjs` — screenshots.
* Dev harnesses (run `npm run dev`, then open): `dev/render.html` (the renderer on a synthetic valley with analytic
  mock water, or `?preset=<id>` with the real solver), `dev/sim.html` (solver), `dev/data.html` (data loaders),
  `dev/ui.html` (UI on a fake store), `tests/routing/harness.html` (routing).

## Testing

Deluge ships seven test layers. The first two are pure CPU and run anywhere; the rest drive a real GPU through
headless Chromium (or a real Electron build) and want a machine with WebGPU — the demo MacBook Air.

| Command | What it guards | Time |
| --- | --- | --- |
| `npm run typecheck` | TypeScript, no emit | ~5 s |
| `npm test` | 954 unit tests (solver, data, routing, UI, loss, render helpers, validation regression) | ~10 min |
| `npm run e2e` | 25 end-to-end app flows in a real browser, hermetic (`-- --prod` for the built bundle; `-- --live` adds the four that use the real network: a live area, Check an address, a dam breach and a coastal surge sweep) | ~15 min |
| `npm run test:perf` | **No lag** — fps, frame times, sim speed, input latency, drift | ~10 min |
| `npm run test:visual` | **No graphics glitches** — golden images + baseline-free detectors | ~20 min |
| `npm run test:security` | **No security regressions** — the penetration test's cases, automated | ~8 min |
| `npm run app:check` | **The desktop build** — 43 checks against a packaged, fused `Deluge.app` | ~12 min |

On a machine that has never run them, install the browser once with `npx playwright install chromium` (Playwright
itself is already a devDependency; the suites need its bundled Chromium for WebGPU). `npm run test:unit` is the
subset of `npm test` that needs no GPU; `npm run test:all` is everything at full length.

Each of the three suites builds its own production bundle, serves it on its own port (5701/5702/5703), writes a JSON
report under `artifacts/`, prints a table and exits non-zero on a regression. All take `--quick` for a fast subset,
and `--url=<url>` to measure an already-running or hosted copy instead. `npm run test:suites` runs all three in quick
mode and is the recommended pre-demo gate.

Those times assume a quiet machine on AC power with Low Power Mode off. Everything here is GPU work: with Low Power
Mode on, a background Spotlight reindex, or another browser open, the same runs take two to three times longer — and
the perf numbers stop meaning anything (see below).

```sh
npm run test:suites                     # fast gate, all three
npm run test:perf -- --quick            # one suite, fast
npm run test:visual -- --scene=bridge  # one scene
npm run test:security -- --case=CAP     # one group of cases
```

### `npm run test:perf` — the lag suite

Six scenarios (idle Pittsburgh, crest raise, crest + 100 mm/hr rain at 300×, Johnstown inflow, a levee built with
real pointer drags, and a live-area load that is skipped when offline) at both the demo viewport (1470×956 @ DPR 2)
and 1600×1000 @ DPR 1. Per scenario it asserts mean and p95-low fps, frame-time p50/p95/p99, the count of frames over
34 ms and 50 ms, achieved sim speed (absolute and as a fraction of what was asked), main-thread CPU ms per frame, GPU
queue latency, input latency (a real pointer drag, measured to the first frame that shows the new camera),
time-to-interactive, and — once — a 60-second sustain run checked for drift.

Thresholds come in two tiers. **Floors** are "the demo is visibly broken" and are always fatal. **Targets** are what
this machine actually measures today plus headroom; they are fatal on a quiet machine and advisory when the run is
noisy. Every threshold is overridable: `DELUGE_PERF_MIN_FPS=50 npm run test:perf`.

The suite records `pmset` power state and the busy processes with every run. **Low Power Mode changes the answer**:
on the demo Air the same scenario measured 162× sim speed with it off and 27× with it on. A run with Low Power Mode
on is therefore never fatal — it prints a banner telling you to turn it off and re-run. Plug in and turn Low Power
Mode off before believing any number here.

**Run this suite first, on a cool machine, not after the other two.** The Air is fanless. In the release run the
crest-and-rain scenario measured 44.6× and missed five *floors* after ~45 minutes of back-to-back GPU suites with a
macOS background-sync storm running; the same scenario on the same build minutes later, on a quieter machine,
measured 152× and passed every threshold with margin. Same binary, 3.4× apart. If a run fails, look at the `load`
and `power` lines it printed before you go looking in the renderer.

### `npm run test:visual` — the graphics-glitch suite

Fourteen scenes are frozen into an exactly reproducible state through `window.__deluge` — sim paused, advanced by an
exact number of simulated seconds with `runFor`, camera pose assigned rather than animated, and the adaptive quality
ladder pinned so render scale cannot drift — then captured at 1470×956 @ DPR 2. Scenes cover the default Pittsburgh
view, the 1936 crest, the demo levee with its protected-land glow, all three hazard modes, each other preset's own
camera, a close-up shoreline, a drawn wall, a bridge, top-down and a low grazing angle.
The two transient toasts are hidden for the capture — they auto-dismiss on a wall-clock timer, so whether one is on
screen depends on how long the machine took, which is worth ~3 % of the frame and nothing to do with rendering.

Two honest limits on what these goldens catch. **They have no scene for Asheville, Nashville, Houston or Boulder** —
those four are covered end to end by `npm run e2e` (flow 7 reads the city list off `public/presets`, so it cannot go
stale), not by a pixel baseline. And the goldens compare at **1/8 resolution** (`baselineShrink 8`), which is what
makes them robust to sub-pixel drift but also means they are **blind to imagery sharpness**: the close-up insets moved
them by nothing, and a future sharpness regression would not move them either. One scene is genuinely flaky —
`pittsburgh-velocity`, the only one comparing an instantaneous field rather than an accumulated one, measured 0.0051,
0.0163, 0.0215 and 0.0305 on four runs of identical code against a 0.02 threshold; see
[ARCHITECTURE.md §9](ARCHITECTURE.md#9-validation).

Two independent checks:

- **Golden images.** Each scene is compared with its committed baseline in `tests/visual/baselines/` using a
  perceptual (YIQ-weighted) diff; the tolerance is the fraction of pixels allowed to differ. When a rendering change
  is intentional, look at the diffs in `artifacts/visual/diff/`, then re-record with `node scripts/visual.mjs
  --update` and commit the updated PNGs.
- **Detectors that need no baseline** — the real regression net, because a stale baseline happily approves a glitch:
  black or blank frames, NaN-magenta pixels (the blown-up-cell sentinel colour, which nothing a user can do
  reaches — that it *is* painted for non-finite state is covered by `tests/render/prep.test.ts`), water standing
  unsupported above terrain (a hydrostatic check against the solver's own arrays), shoreline stair-stepping,
  z-fighting flicker (repeat captures of a frozen scene must be identical), missing aerial imagery, UI panels running
  off the canvas edges, and legend-vs-pixels colour agreement — the water mask is obtained by re-rendering the same
  frozen scene in another hazard mode, so the check needs no tuned colour threshold and fails if a mode is ever wired
  to the wrong ramp.

### `npm run test:security` — the security regression suite

This one builds the **released** bundle — a plain `vite build`, with no debug API — and drives it through the DOM
only, because one of the things it checks is that `window.__deluge` is not there. Every third-party host is
intercepted, so the run is hermetic and behaves identically offline.

It automates the findings of this project's own penetration test: link-parameter spoofing through `?name=`,
`?preset=` and an invalid `?live=` (the attacker's sentence must never appear in the app's chrome, and no bidi
control character may reach the DOM); XSS through hostile Nominatim results, preset metadata and road data
(`window.__pwned` must stay unset); the Content-Security-Policy present in the built `index.html`, restrictive, ahead
of the first script tag, and raising zero violations across the main flows; response byte caps refusing an oversized
body, a forged `Content-Length` and a gzip bomb without exhausting memory; no source maps, build-machine paths or
debug surfaces in `dist/`; and a clean `npm audit --omit=dev`. A case whose fix has not landed, or that could not be
exercised in this build, is reported **PENDING** rather than passing silently; `--strict` makes pending fatal.

### `npm run app:check` — the desktop build's release gate

`electron/verify-renderer.mjs` then `electron/verify-packaged.mjs`: 43 checks (23 + 20) over the wrapper's rules — no Node,
bridge or IPC in the renderer, the `app://deluge` origin and a real WebGPU adapter, the CSP on every response,
path-traversal attempts refused, navigation and new windows blocked, the network allowlist proven independently of
CSP, every permission denied, a self-signed data host rejected, the R11 fuse wire, a tampered `app.asar` refusing to
start, no listening socket, no DevTools, no debug API in the packaged asar, and the display-sleep blocker running.
The packaged, fused app cannot be driven from outside (that is two of the checks), so it reports on itself through a
hook that `electron/package.mjs` stages **only** into the differently-named verification bundle; the shipped
`Deluge.app` does not contain that code at all.

**Driving the app from automation.** The e2e flows, `scripts/bench.mjs` and `scripts/shot.mjs --ready=…` all steer the
app through `window.__deluge`, which a released build no longer contains: it is compiled out unless the build sets
`DELUGE_DEBUG_API=1` (`vite.config.ts`, `src/env.d.ts`), so a copy handed to anyone else exposes no automation surface.
`npm run dev` keeps it, and `npm run e2e` sets the variable before it builds, so neither needs anything. A server you
start yourself for those tools needs it too:

```bash
DELUGE_DEBUG_API=1 npm run demo   # same as npm run demo, plus window.__deluge for bench / shot
```

Routing timing bounds are asserted in `tests/routing/perf.test.ts` (normalised for machine load); `PERF=1` also checks
them in the real-data Pittsburgh test.

## Security

No accounts, no backend, no analytics and nothing stored (unless you switch on project autosave, which is off by
default and deletes its copy when switched off): the app is static files plus the seven public data
endpoints it fetches terrain, imagery, roads and place names from. A released build contains no automation surface
(`window.__deluge` is compiled out), and its Content-Security-Policy is `default-src 'none'` with `script-src 'self'`
— no `unsafe-inline`, no `unsafe-eval` — restricting `connect-src` to exactly those seven endpoints
([`src/data/csp.ts`](src/data/csp.ts) is the single source of truth, mirrored into the desktop wrapper and guarded by
a test that fails if a new host appears). `npm run test:security` re-runs this project's own penetration-test cases
against the built bundle, and `npm run app:check` re-runs the desktop wrapper's — including that a renderer can
leave nothing behind (localStorage, IndexedDB, service workers, cache storage and the Origin Private File System
are cleared before the window opens) and that a packaged build refuses to start if its command line asks it to
drop TLS validation or the sandbox.

*Check an address* adds no endpoint: addresses go to the Nominatim search the picker already uses (one capped,
rate-limited call, results validated and shown as text), NOAA Atlas 14 is a same-origin file (`'self'`), and its
decoder trusts nothing — a 4 MB download cap, an 8 MB cap on what the gzip layer may inflate to (a gzip bomb stops
there), an exact-length binary header with bounded counts, and every cell range-checked and required to rise with
return period. Its deep link reads only `at=<lat>,<lon>` through a strict number pattern inside US coverage; no text
from the link reaches the page, and the app never writes the typed address into the address bar.
`npm run test:security` covers both (SPOOF-ADDRESS-*, XSS-ADDRESS-GEOCODER, CAP-ATLAS14-*).

*Saved projects* add no endpoint either: a project file is generated and read in the tab, and a `?project=` link is
someone else's text when it arrives, so it is decoded with a 6,000-character cap, a 256 KB cap on what its gzip may
inflate to, and the same strict reader as a file — and none of its names (project, designs, sites, shelters, source
labels) reach the page: the app names those itself. `npm run test:security` covers it (SPOOF-PROJECT-LINK,
XSS-PROJECT-LINK, SPOOF-PROJECT-POLLUTE, CAP-PROJECT-LINK-BOMB, PROJECT-FILE-HOSTILE).

*Dam breaches and coastal surge* add no endpoint either: the dam index and the tide-station table are same-origin
files, decoded under the same rules (download and inflate caps, an exact-length header, bounded counts, every record
or station range-checked and dropped rather than guessed, names stripped of control, bidi and markup characters), and
the one extra request — a 64 × 64 3DEP probe below the dam — goes to the elevation host already in the policy. The
links read `nid=` (an NID id pattern), `breach=` / `method=` (fixed words) and `at=` (numbers) only. Tests assert
that the NID and CO-OPS hosts stay out of the CSP and the desktop allowlist; the suite adds SPOOF-DAM-NID,
SPOOF-SURGE-AT, CAP-NID-* and CAP-SURGE-*.

**Accepted risk, stated on purpose:** a copy hosted on GitHub Pages can be framed by any other origin. Pages cannot
send a `Content-Security-Policy` header and `frame-ancestors` is ignored in a `<meta>` tag, so there is no way to
forbid it from a static host. The impact is limited to what a framed copy could do: there is nothing to click-jack
into — no accounts, no state-changing requests, nothing persisted — so the worst case is a misleading presentation of
a simulation. `Deluge.app` serves the same build with `frame-ancestors 'none'` as a real header
([ARCHITECTURE.md §10](ARCHITECTURE.md#10-shipping-browser-desktop-app-and-the-test-suites)).

## Known limitations

* **Hydro-flattened elevation.** 3DEP has no river bathymetry, so channels are burned to a nominal depth (6 m for
  Pittsburgh's rivers); river volumes and speeds are approximate.
* **Bare-earth terrain by default.** Bridge decks and culverts are not in the DEM, so water flows under viaducts, and
  road and highway embankments dam small creeks: under heavy rain water ponds several metres deep behind them (8.5 m
  behind I-376 in Pittsburgh's Saw Mill Run valley at 100 mm/hr; up to 14 m in a pit beside US 40 after an hour of
  Ellicott City's storm), which also sets the HUD's max depth. Buildings, a land-cover roughness map and storm drains
  are optional layers (Advanced → *Land surface*), **off by default**: run against the observed floods of
  [docs/VALIDATION.md](docs/VALIDATION.md), none improves every like-for-like score (FEMA 1 % zones at Fort Myers,
  Nashville and Pittsburgh, Ian's high-water marks, Helene's gauges) — buildings cost 0.4–2.1 CSI points, the
  roughness map 1.8–7.0
  ([ARCHITECTURE.md §3.11](ARCHITECTURE.md#311-land-surface-buildings-as-obstacles-a-roughness-map-storm-drains)):
  * *Buildings block flow* makes a cell 90 % or more under roofs a block and gives every partly covered cell an
    integral porosity (its open share stores water; the open share of each face carries it), so side yards narrower
    than a cell stay passable; roof rain goes down the downspouts — into the storm drains when they are on, onto the
    ground beside the building when not. It brings Helene's Swannanoa gauge 0.7 m closer (−1.22 → −0.49 m) but loses
    extent where it slows the water within the scenes' fixed hold, and blocks are watertight: at Nashville 651 cells
    of FEMA's zone are pockets the buildings shut off and that stay dry, where a real flood would get in through
    doors and courtyards.
  * *Land-cover roughness* takes Manning's n from NLCD 2021 (US) or ESA WorldCover 2021; the values are mid-range
    literature values, not calibrated, and they change loss through flow speed (Pittsburgh's crest loss −54 % with the
    map alone). Checked for misapplication (registration on the grid, rivers kept at the scenes' n): none found. Most
    of its CSI loss is the fixed hold — with holds three times as long it shrinks to 0.6–1.2 points.
  * *Storm drains* remove standing water on developed land at the rate the sewers were designed for (runoff coefficient
    × NOAA Atlas 14's 2-year 1-hour rain): a spread-out sink, not a pipe network — no inlets, no pipe limits, and it
    keeps draining when a flooded river would back the outfalls up. Without them a 2-year storm floods ~100 km of
    Houston's streets more than 30 cm deep; with them, ~7 km. US presets and live areas in the lower 48 (NLCD fetched
    at load); live areas elsewhere have no land cover.
* **Protected land is a still-water estimate.** The green "kept dry" land and its acres compare the water level held
  back by the walls with and without them; they ignore how long water leaking through a gap would take to fill the
  land behind it.
* **Time-lapse rise.** Raising the river is ~600–850× faster than the 1936 rise; the flood that follows is solved at
  its real speed. Evacuation windows on these presets are therefore minutes, not hours: set the alert before the run
  starts (a negative alert time) to read Site check's "leaving by road" for a real warning.
* **Evacuation timing is a queue, not traffic.** Road egress closes roads for flooding only (no debris on bridges, no
  police closures). Departures follow a published average curve for flood warnings (Sorensen & Mileti 2015b) that
  starts when the warning reaches people — getting the warning out is the alert time you enter — and one building's
  occupants can be faster or slower than the average. Cars queue at one bottleneck with lane counts assumed by road
  class; other evacuating traffic on the same roads is not counted, so the clearance time is a lower bound. Buses,
  ambulances and people who cannot drive are outside it; occupants default to the IBC design load, an upper bound.
* **Scheme.** Local-inertial with first-order upwind advection: excellent for floodplain inundation, less so for
  strongly supercritical flow (hydraulic jumps, violent dam breaks).
* **Debris flows are one uniform material.** A hazard-chain preset swaps Manning for its debris-flow friction law
  (Voellmy, O'Brien–Julien or Bingham; ARCHITECTURE.md §3.9) and raises the speed cap from 15 to 25 m/s, but the
  material is the same everywhere and for the whole run: no sediment is carried, picked up or dropped, clear tributary
  water does not dilute it, and the bed never changes. Yield stress and Coulomb friction stop flow on gentle ground —
  that is how deposits form, and also why a Coulomb coefficient set for steep gorges (Voellmy μ 0.05 stops flow below
  ~3°) holds a surge back on a flatter valley floor.
* **Glacier flood times are model times.** The hazard chain's front reaches Betrawati 65 min after the avalanche,
  against ≤ 43 min reported (when the gauge went silent; about 22 minutes late), and Chungthang ~14 % early. The Nepal
  residual is not the 1-D routing — its front moves at Rickenmann's (1999) empirical debris-flow velocity for its own
  discharge — but either a source mechanism no back-analysis yet supports (the avalanche itself running far down the
  Bhote Koshi) or observations that are telemetry losses rather than the flood. Lead times are best read as
  differences between sensor designs ([§G.9](docs/research/glacier-hazard-chain.md)).
* **Boundaries.** River stages are imposed where rivers cross the domain edge, with a small head that keeps the
  rivers flowing downstream; discharges at the 1936 crest are lower than the historic record.
* **Coverage.** Live areas are US-only at full quality (USGS 3DEP); elsewhere the coarse Terrarium fallback is used.
* **The rain ladder is pluvial only.** The NOAA Atlas 14 ladder rains a uniform 1-hour storm on the map with the rivers
  held at their normal level: no river flood, no surge, no run-on from outside the map, no storm drains, and a
  stationary (historical) climate. A site that floods from a river needs a river ladder (presets) or your own return
  periods; the Atlas 14 values are read at the map centre from a 1/12° resampling (within a few per cent of NOAA's
  point values), and western Washington and Oregon have none.
* **Dam breaches are regressions on an NID reservoir.** Eight published relations, a storage curve fitted to two NID
  numbers, no spillways, gates or downstream dams, and the wave entering at the toe as a discharge (the DEM holds the
  reservoir's surface, not its bed). The relations disagree by 2–5× for one dam, so the low–high band is shown; the
  central case (Froehlich 1995, the best of the eight on 21 documented failures, all within ×2, in-sample) is a third
  low on Teton 1976, and the band misses 4 of the 21 observed peaks. The arrival spread beside each simulated arrival
  is a kinematic-wave rescaling, not a run. Erodibility is unknown for every NID dam (Xu & Zhang at medium).
* **The surge ladder is still water at one gauge.** NOAA's extreme water levels at the nearest analysed tide station
  (up to 120 km away, perhaps in another bay), held on the seaward edges of the map: no wave run-up, no sea-floor
  bathymetry, no seawalls unless drawn, stationary unless Today vs future adds NOAA's sea-level rise.

## Data and attribution

All seven baked cities use only public-domain U.S. government data — nothing in `public/presets` comes from a source
that forbids redistribution (details, per city, in [public/presets/SOURCES.txt](public/presets/SOURCES.txt)):

* Elevation: **USGS 3D Elevation Program (3DEP)**
* Imagery: **USDA NAIP** via USGS The National Map — both the base photo and the close-up inset
* Roads: **U.S. Census Bureau TIGER/Line** via TIGERweb
* River centrelines: **USGS National Hydrography Dataset** high-resolution flowlines
* Flood stages and historic crests: NOAA National Weather Service (gauges PTTP1, Nashville) and USGS annual peak-flow
  records (French Broad at Asheville 03451500, Swannanoa at Biltmore 03451000, Cumberland at Nashville 03431500,
  Buffalo Bayou at Houston 08074000, Boulder Creek 06730200, Stonycreek 03040000, Patapsco 01589000)
* Validation data (`public/validation`, [docs/VALIDATION.md](docs/VALIDATION.md)): **USGS** STN high-water marks and
  NWIS peaks, **FEMA** National Flood Hazard Layer (public domain); damage grading © European Union, 2026,
  **Copernicus Emergency Management Service** (EMSR927); the May 2010 parcel damage assessment of the **Metropolitan
  Government of Nashville and Davidson County** (MetroGIS, Metro Stormwater, Metro Codes; a public record, committed
  only as a rasterised mask — no owners, addresses or parcel IDs)
* Land cover: **NLCD 2021** (USGS / MRLC) for the US presets; the drain design rainfall from **NOAA Atlas 14**. The three
  Himalayan presets use **ESA WorldCover 2021** (© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel
  data (2021) processed by ESA WorldCover consortium, CC BY 4.0), credited on screen with the rest of their data

Rain return periods (Site check's rain ladder): **NOAA Atlas 14** precipitation-frequency estimates, Volumes 1–4 and
6–12 (NOAA / National Weather Service, Office of Water Prediction, Hydrometeorological Design Studies Center), public
domain ("no restrictions apply"; NOAA asks for acknowledgement, which every site report carries), resampled into
`public/atlas14/` by `scripts/bake-atlas14.ts` — provenance in
[public/atlas14/SOURCES.txt](public/atlas14/SOURCES.txt).

Critical facilities (`facilities.json`, every baked scenario): **OpenStreetMap** via the Overpass API, © OpenStreetMap
contributors, ODbL 1.0 — `scripts/bake-facilities.ts`, tags and caveats in
[public/presets/SOURCES.txt](public/presets/SOURCES.txt).

Dams: the **National Inventory of Dams** (U.S. Army Corps of Engineers; public fields of the national export),
baked into `public/dams/` by `scripts/bake-nid.ts` — provenance in [public/dams/SOURCES.txt](public/dams/SOURCES.txt).
Coastal water levels: **NOAA CO-OPS Extreme Water Levels**, tidal datums and the NOAA 2022 sea-level-rise scenarios
(Sweet et al. 2022) at 125 tide stations, public domain, baked into `public/surge/` by `scripts/bake-surge.ts` —
[public/surge/SOURCES.txt](public/surge/SOURCES.txt). Breach relations: Froehlich 2008 (*J. Water Resour. Plann.
Manage.* 134:217), Froehlich 2016 (*J. Hydraul. Eng.* 142:04015059), Froehlich 1995, MacDonald & Langridge-Monopolis
1984; Teton 1976 data from Wahl 1998 (USBR DSO-98-004).

Live areas and the location picker's basemap fetch **Esri World Imagery** at runtime (© Esri, Vantor, Earthstar
Geographics, and the GIS User Community; Esri's terms apply). Fallbacks: **Mapzen Terrarium** elevation tiles (AWS Open
Data) and **OpenStreetMap** roads (© OpenStreetMap contributors, ODbL). Place search and names: OpenStreetMap
Nominatim.

Method: Bates, Horritt & Fewtrell (2010), *J. Hydrology*; de Almeida, Bates, Freer & Souvignet (2012), *Water
Resources Research*.

## License

Code: MIT (see [LICENSE](LICENSE)). Data: see *Data and attribution* above.
Authors: Rohit K., Aryan G., Nikesh P., Saathvik G., Cursor

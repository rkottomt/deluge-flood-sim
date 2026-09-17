# Deluge — real-time flood simulation on real terrain

![Pittsburgh at the 1936 St. Patrick's Day crest: downtown, the North Shore and the Strip District under water](docs/hero-1936-crest.jpg)

Deluge loads real USGS elevation data for a place in the US and solves the 2-D shallow-water equations on the GPU with
WebGPU compute shaders, live in a browser tab. Raise the rivers to the 1936 crest, build a levee and see the land it
keeps dry, crank the rain, and watch an evacuation route re-plan as roads go under.

Built for SteelHacks, *No Wrapper* track: no language models anywhere in the product. How it works in depth:
[ARCHITECTURE.md](ARCHITECTURE.md). Module contracts: [src/contracts.ts](src/contracts.ts).

## Run it

Needs Node 20.19+ or 22.12+ and a WebGPU browser (Chrome / Edge 113+, Safari 26+). The built-in scenarios work
offline.

```bash
npm ci
npm run demo                  # production build at http://localhost:4173 (use this for a live demo)
npm run demo -- --port 5000   # if 4173 is busy
npm run dev                   # Vite dev server
```

Presenting to judges? [DEMO.md](DEMO.md) has the pre-demo checklist, pitch scripts and a Q&A crib sheet.

`npm run build` writes a static site to `dist/` with relative URLs, so any static host works, including under a
sub-path (`.github/workflows/pages.yml` publishes it to GitHub Pages once the repository is public and Pages is set to
"GitHub Actions"). A hosted copy still needs WebGPU; keep `npm run demo` as the offline path.

URL options: `?preset=pittsburgh|johnstown|ellicott|sandbox`, or any US area with `?live=<lat>,<lon>,<km>`
(e.g. `?live=29.95,-90.07,6` for New Orleans; this needs the internet for USGS, Esri and Census TIGERweb).

## Try this (30 seconds)

1. Pittsburgh loads with full rivers. Click **Raise to 1936 record** in the *Try it* strip. The rivers rise to 46 ft
   along their whole length over a few simulated minutes (a time-lapse: the real 1936 rise took ~30 hours), and the
   Point, the North Shore and the Strip District go under.
2. Click **Evacuate** (or press **8** and click a street): the route to the nearest dry shelter re-plans, or turns red,
   as roads flood.
3. Click **Build a levee**: a floodwall goes up along the North Shore and the 1936 rise replays with it in place. The
   land it keeps dry turns green and the strip counts it (about 139 acres and 11 km of streets at the crest), while
   the evacuation route re-plans as the water comes back. Or press **2** and drag your own wall, tying both ends into
   high ground; press **V** to step through Depth / Max depth / Speed (or scroll the side panel to View).
4. **Break it** (Try-it strip or How it works) swaps in a textbook explicit solver and drops one small splash mid-view;
   it blows up within seconds. **Restore** recovers.

![The one-click levee along the North Shore at the 1936 crest: the land it keeps dry is green, the Try-it strip counts the acres and streets it saves](docs/levee-north-shore.jpg)

On a live area with no river crossing the map edge (picked with *Pick any US location*), the first button drops a
thunderstorm over the view instead.

Keys: `1`–`0` tools, `Space` pause, `R` reset water, `V` next water view, `?` help. **On a laptop,** plug in: the app
adapts solver substeps and render resolution to measured frame time and GPU latency, and detects browser 30 fps caps on
battery, but 60 fps needs mains power. On an Apple M4 the 1936 crest flood with extreme rain runs at 60 fps (p95 frame 19 ms) and
~70× real time at 1600×1000 (numbers and the MacBook Air expectation: [ARCHITECTURE.md §8.1](ARCHITECTURE.md#81-performance-budget-measured)).

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

From `npm test` (the solver tests run on a real GPU through Dawn):

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

In the running app the HUD's mass-balance error stays below 0.001 % at the 1936 crest, with or without hurricane rain.

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

## How a frame works

```
solver.step ─▶ N substeps in one compute pass:  momentum pass ─▶ continuity pass   (CFL dt each)
renderer    ─▶ (every other frame) export pass (h, u, v, max depth) + prep ──▶ MSAA HDR → ACES
every ~300 ms, never blocking: stats reduction pass ─▶ mapAsync ─▶ HUD + road flood status ─▶ evacuation route
```

| Module | |
| --- | --- |
| [`src/sim`](src/sim) | GPU solver (WGSL in `shaders/`), forcing, brush edits, Float64 CPU reference |
| [`src/render`](src/render) | terrain LOD, water, hazard maps, walls, roads/route ribbons, camera, picking |
| [`src/data`](src/data) | USGS 3DEP / imagery / roads loaders, hydro-conditioning, presets, live areas |
| [`src/routing`](src/routing) | road graph, flood status per edge, travel-time Dijkstra |
| [`src/ui`](src/ui) | panels, tools, HUD, How it works, location picker |
| [`src/app`](src/app) | scene loading, store → solver sync, stage ramp, protected-land analysis, frame pacing, debug API (`window.__deluge`) |

## Repo tour

* `src/<module>/` — the app, one folder per module, integrated through [`src/contracts.ts`](src/contracts.ts).
* `tests/<module>/` — `node:test` suites (sim and render on a real GPU through Dawn).
* `scripts/bake-presets.ts` — bakes `public/presets/*` (raw downloads cached in `artifacts/bake-cache`);
  `scripts/e2e.mjs` — end-to-end demo flows in headless Chromium on the real GPU; `scripts/bench.mjs` — the
  performance benchmark (`npm run demo`, then `npm run bench -- --scenario=pgh`); `scripts/shot.mjs` — screenshots.
* Dev harnesses (run `npm run dev`, then open): `dev/render.html` (the renderer on a synthetic valley with analytic
  mock water, or `?preset=<id>` with the real solver), `dev/sim.html` (solver), `dev/data.html` (data loaders),
  `dev/ui.html` (UI on a fake store), `tests/routing/harness.html` (routing).

## Tests

Prerequisites: Node `^20.19` or `≥ 22.12`; for e2e, `npx playwright install chromium` once.

```bash
npm run typecheck
npm test                    # every unit suite, one file at a time (the GPU suites share one device), ~30 s
npm run test:unit           # the suites that need no GPU
npm run e2e                 # end-to-end demo flows in headless Chromium on the real GPU, offline
node scripts/e2e.mjs --prod # the same against the production build
```

Routing timing bounds are asserted in `tests/routing/perf.test.ts` (normalised for machine load); `PERF=1` also checks
them in the real-data Pittsburgh test.

## Known limitations

* **Hydro-flattened elevation.** 3DEP has no river bathymetry, so channels are burned to a nominal depth (6 m for
  Pittsburgh's rivers); river volumes and speeds are approximate.
* **Bare-earth terrain.** Buildings, bridge decks and culverts are not in the DEM; water flows through blocks and under
  viaducts, and storm drains are not modelled. Road and highway embankments therefore dam small creeks: under heavy
  rain water ponds several metres deep behind them (8.5 m behind I-376 in Pittsburgh's Saw Mill Run valley at
  100 mm/hr; up to 14 m in a pit beside US 40 after an hour of Ellicott City's storm), which also sets the HUD's max
  depth.
* **Uniform roughness.** One Manning's n for the whole map (0.035, adjustable under Advanced); no land-cover roughness
  map.
* **Protected land is a still-water estimate.** The green "kept dry" land and its acres compare the water level held
  back by the walls with and without them; they ignore how long water leaking through a gap would take to fill the
  land behind it.
* **Time-lapse rise.** Raising the river is ~600–850× faster than the 1936 rise; the flood that follows is solved at
  its real speed.
* **Scheme.** Local-inertial with first-order upwind advection: excellent for floodplain inundation, less so for
  strongly supercritical flow (hydraulic jumps, violent dam breaks).
* **Boundaries.** River stages are imposed where rivers cross the domain edge, with a small head that keeps the
  rivers flowing downstream; discharges at the 1936 crest are lower than the historic record.
* **Coverage.** Live areas are US-only at full quality (USGS 3DEP); elsewhere the coarse Terrarium fallback is used.

## Data and attribution

Baked presets use only public-domain U.S. government data (details in
[public/presets/SOURCES.txt](public/presets/SOURCES.txt)):

* Elevation: **USGS 3D Elevation Program (3DEP)**
* Imagery: **USDA NAIP** via USGS The National Map
* Roads: **U.S. Census Bureau TIGER/Line**
* Flood stages and historic crests: NOAA National Weather Service (gauge PTTP1) and USGS peak-flow records

Live areas and the location picker's basemap fetch **Esri World Imagery** at runtime (© Esri, Vantor, Earthstar
Geographics, and the GIS User Community; Esri's terms apply). Fallbacks: **Mapzen Terrarium** elevation tiles (AWS Open
Data) and **OpenStreetMap** roads (© OpenStreetMap contributors, ODbL). Place search and names: OpenStreetMap
Nominatim.

Method: Bates, Horritt & Fewtrell (2010), *J. Hydrology*; de Almeida, Bates, Freer & Souvignet (2012), *Water
Resources Research*.

## License

Code: MIT (see [LICENSE](LICENSE)). Data: see *Data and attribution* above.

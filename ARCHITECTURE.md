# Deluge — architecture and numerical method

Deluge solves the 2-D shallow-water equations on real terrain in a browser tab, on the GPU, fast enough to play with:
draw a levee and watch the water go around it, raise a river to a historic crest, crank the rain, and watch an
evacuation route re-plan as roads flood. This document explains how, and why it stays stable.

Contents: [1 Frame pipeline](#1-frame-pipeline) · [2 Module map](#2-module-map) ·
[3 Numerical method](#3-numerical-method) · [4 Rivers, stages and crests](#4-rivers-stages-and-crests) ·
[5 Data](#5-data) · [6 Rendering](#6-rendering) · [7 Evacuation routing](#7-evacuation-routing) ·
[8 App loop and pacing](#8-app-loop-and-pacing) · [9 Validation](#9-validation) · [10 Future work](#10-future-work)

---

## 1. Frame pipeline

```
 requestAnimationFrame
   │
   ├─ solver.step(realDt × timeScale)              one compute pass, N substeps:
   │     for each substep (dt from the CFL condition):
   │        Pass A  momentum     state ──▶ face fluxes      (slope, advection, friction, smoothing, caps)
   │        Pass B  continuity   state + fluxes ──▶ state   (limiter, ∂h/∂t, rain, sources, stages, boundaries,
   │                                                        mass ledger)
   │     Export     state ──▶ stateTexture (h, u, v, max depth), lazily: when the renderer reads it (the frames
   │                that refresh its water textures) or a stats readback needs it
   │
   ├─ every ~300 ms (never blocking): stats reduction pass + depth copy → mapAsync → Float64 statistics
   │        └─▶ HUD (flooded area, volume, max speed, mass-balance error, Courant) and road flood status
   │              └─▶ evacuation route (≤ 4 Hz)
   │
   ├─ stage ramp: the applied river stage moves toward the slider in simulated time (§4)
   │
   └─ renderer.render(): prep compute pass → terrain, water, overlays (MSAA HDR) → bloom → ACES tonemap
```

Everything the solver needs per substep is already on the GPU; the CPU only chooses `dt`, writes a 112-byte uniform
and submits. Statistics come back asynchronously and are a few hundred milliseconds old, which the timestep
selection accounts for (§3.6).

## 2. Module map

| Path | What it does |
| --- | --- |
| `src/contracts.ts` | The integration contract: grid conventions, every cross-module interface, documented extensions. |
| `src/sim/` | GPU solver (`Solver.ts`, WGSL in `shaders/`), forcing packing, brush edits, work budget, and a Float64 CPU reference implementation (`cpuReference.ts`) the tests compare against. |
| `src/render/` | WebGPU renderer: LOD terrain, water surface, hazard colour maps, road/route ribbons, walls, markers, camera, picking, adaptive quality. |
| `src/data/` | USGS 3DEP DEM, imagery and road loaders; hydro-conditioning (channel burning, water detection, ridge opening); baked presets; the synthetic sandbox; live areas (conditioning runs in a Web Worker). |
| `src/routing/` | Road graph, flood status per edge, multi-target Dijkstra with wet-road slowdowns and bridge handling. |
| `src/ui/` | Panels, toolbar and tools, HUD, "Try it" strip, How it works, location picker. Plain DOM + one CSS file. |
| `src/app/` | Orchestration: scene loading, store → solver sync, stage ramp and crest fill, frame driver, work budget / frame pacing, debug API (`window.__deluge`). |
| `scripts/` | `bake-presets.ts` (bakes `public/presets/*`), `e2e.mjs` (10 judge flows in headless Chromium on the real GPU), `shot.mjs` (screenshot tool). |
| `dev/` | Stand-alone harness pages per module: `render.html` (synthetic valley with analytic mock water, or `?preset=<id>` with the real solver), `sim.html`, `data.html`, `ui.html`; `tests/routing/harness.html` for routing. |
| `tests/<module>/` | `node:test` suites; the sim and render suites run on a real GPU through Dawn (`webgpu` package). |

Grid conventions (full version at the top of `src/contracts.ts`): cells `(i, j)` with `i` west → east and `j` north →
south, row-major arrays, `nx`, `ny` multiples of 16; grid coordinates `(gx, gy)` in cell units with centres at `+0.5`;
world space in metres with X east, Y up, Z south.

---

## 3. Numerical method

### 3.1 Equations

```
∂h/∂t + ∂qx/∂x + ∂qy/∂y = R − I + S
∂qx/∂t + ∂(qx·u)/∂x + ∂(qx·v)/∂y = −g·h·∂η/∂x − g·n²·qx·|q| / h^{7/3}          (and the same for qy)
```

`h` depth, `q = (qx, qy)` unit discharge (m²/s), `η = z + h` water surface, `z` bed (ground + walls), `n` Manning
roughness, `R` rain and storms, `I` infiltration, `S` inflow sources.

### 3.2 Scheme: local inertial plus upwind advection

The base is the local-inertial scheme used by LISFLOOD-FP-class flood models (Bates, Horritt & Fewtrell 2010;
de Almeida et al. 2012), extended with first-order upwind convective acceleration in conservative form. Without
advection a frictionless dam-break front advances at roughly half the true speed; with it the scheme reproduces the
Ritter solution (§9).

* **Staggered grid.** `h` at cell centres; `qx` of cell `i` lives on its east face, `qy` on its south face. State is an
  `rgba32float` texture `(h, qx, qy, z − z0)`, ping-ponged every substep; `z` is stored relative to the domain's lowest
  point so Float32 keeps ~10 µm resolution on high terrain.
* **Face depth (wetting/drying, well-balanced).** `hf = max(ηL, ηR) − max(zL, zR)`, written so bed differences cancel
  before depths are added. A face with `hf < 10⁻⁴ m` carries no flux. The surface slope is formed as
  `((zR − zL) + (hR − hL)) / dx`, so a lake at rest on arbitrary terrain has zero slope to rounding.
* **Momentum update (per face):**

  ```
  q_new = ( q̃ − dt·A − g·hf·dt·∂η/∂x ) / ( 1 + g·dt·n²·|q| / hf^{7/3} )
  q̃    = q + (1−θ)/2 · minmod(L, G)          θ = 0.8
  ```

  `A` is the upwind convective acceleration. `L` is de Almeida's 1-D Laplacian of `q` along the face normal (a much
  deeper neighbour is weighted down); `G` is the jump in discrete divergence between the two cells sharing the face.
  Taking `minmod(L, G)` damps divergent grid-scale modes (gravity-wave noise, the 2-D checkerboard) exactly as
  de Almeida's smoothing does, but not flow turning at the stair steps of a bank that is not aligned with the grid,
  which the plain Laplacian treated as drag (diagonal channels ran 3–5× too deep).
* **Advection next to walls.** A dry or blocked neighbour face contributes the face's own velocity (free slip), and
  faces whose stencil touches one keep only `wallAdvection = 0.1` of the term. Walled channels at 0–60° to the grid then
  run within ~7 % of Manning's normal depth, and grid-scale circulations along rough shorelines stay damped.
* **Semi-implicit friction.** An explicit Manning term is stiff on thin films (rate ∝ `h^{−4/3}`) and overshoots.
  Dividing by a factor ≥ 1 can only slow water down, for any `dt`.
* **Safety caps (robust mode).** `|q| ≤ hf · min(15 m/s, 8·√(g·hf))`. The Froude cap is 8, not ~2: a dam-break tip is
  legitimately strongly supercritical, and Fr ≤ 2 made the Ritter front 22 % slow.
* **Local Courant guard.** A face whose own Courant number exceeds the limit is advanced with a proportionally
  smaller effective `dt`, so one stale statistic cannot start a local instability.

### 3.3 Continuity and the positivity-preserving limiter

For every cell the volume that would leave in this substep is
`O = dt/dx · (max(qE,0) + max(−qW,0) + max(qS,0) + max(−qN,0))`, and `k = min(1, h/O)`. Every face flux is multiplied
by `k` of its **donor** (upwind) cell. A cell can never export more water than it holds, so `h ≥ 0` by construction —
no clamping, which would silently create water — and both cells of a face apply the same limited flux, so mass is
conserved to Float32 rounding. Computing a neighbour's `k` needs that neighbour's four faces, hence a 13-texel
stencil. Then `h_new = h + dt/dx·(qW − qE + qN − qS)`.

### 3.4 Forcing and boundaries

* **Rain and storms:** a global rate plus up to 8 storm cells (full intensity inside 0.3·R, smooth falloff to R).
  Infiltration only where there is water, never more than is there.
* **Inflow sources** (up to 16): a flat disc footprint with a one-cell smooth rim, weights normalised so exactly
  `Q·dt` is injected. Open-boundary outflow is switched off on edge cells within `radius + 24` cells of an inflow:
  an inflow sits on a river just inside the edge it enters through, and without the mask 20–58 % of a preset river's
  discharge left straight back out of that edge.
* **Stage sources** are water-level boundary conditions: discs covering a river's crossing of the domain edge, whose
  depth is set to `max(0, level − z)` every substep. Faces with both cells fully inside a disc also forget their
  discharge (a reservoir at rest). Without that, momentum coasted across a large flat disc and re-emerged at its
  rim as a jet with no surface slope behind it (8 m/s out of the Ohio disc at the 1936 crest before the other fixes).
* **Open boundaries** (outflow only, never inflow): the larger of normal flow `q = h^{5/3}·√S/n`, with `S` the smaller
  of the bed and surface slope toward the edge (at least 10⁻⁴), and transmissive flow `q = u_in·h`, with `u_in` the
  velocity arriving through the last interior face. Normal flow alone let rivers back up over their last ~2 km;
  using the arriving velocity (not discharge) keeps the edge depth pinned to its neighbour's. Capped at critical
  flow (Froude 1), since water cannot pour over a free edge faster than that. `'wall'` boundaries carry no flux.

### 3.5 Exact mass accounting

Every external change (rain, sources, stages, infiltration, open-boundary outflow, brush edits, in-place stage raises,
Float32 limiter residue) is measured as the actual Float32 difference it made to `h` and added to a per-cell
in/out accounting buffer. At each readback a reduction pass sums it per 16×16 block, and the buffer is copied and
zeroed **in the same command encoder**, so no substep is lost or counted twice; the CPU sums blocks in Float64:

```
massError = |V − (V0 + Vin − Vout)| / max(1 m³, V0, peak V since reset)
```

It is normalised by the most water ever held rather than by `V0 + Vin`, because stage boundaries can exchange many
times the domain's storage and would otherwise make the ratio shrink the longer the simulation ran.

### 3.6 Timestep

```
dt = Cr · dx / ( √2 · max over cells (√(g·h) + |u|) )
```

**Why √2.** The scheme updates `q` from the old `η`, then `η` from the new `q` (staggered forward–backward). A von
Neumann analysis for gravity waves gives amplification factors with `λ² − Tλ + s = 0`, `s = θ + (1−θ)·cos(k·dx)`; the
worst mode is the 2-D checkerboard, which needs `8·C₁² ≤ 4θ` with `C₁ = √(g·h)·dt/dx`. Defining the 2-D Courant number
`Cr = √2·C₁` makes the limit `Cr ≤ 1` for the plain scheme and `Cr ≤ √θ ≈ 0.89` with smoothing. Deluge targets 0.7 and
never exceeds 0.85. A 1-D formula at 0.7 sits right on the 2-D limit (tests/sim/stability.test.ts guards this).

The fastest wave `max(√(g·h) + |u|)` is the stats pass's per-cell maximum from the latest asynchronous readback, so
robust mode inflates it (×1.25 + 0.1 m/s) and combines it with what it knows is coming before a readback can show it:
the deepest water a stage source or brush stroke creates (×1.15 depth), the critical velocity at an inflow's rim, and a
dam-break speed `2·√(g·Δh)` for a stage raise (added to the deepest water, the conservative way). Taking the maximum
per cell rather than `√(g·h_max) + |u|_max` matters on real terrain: the deepest water (a river channel, a stage disc)
is rarely the fastest (a jet down a street); in Pittsburgh's 1936 flood the sum of the two maxima overstated the
fastest wave by ~50 % (the HUD read Courant 0.46 against 0.7) and cost as much sim speed. Faces a stale estimate
misses are held at the stability limit by the momentum pass's local Courant guard (§3.2). Naive mode keeps the textbook
`dt = C·dx/√(g·h_max)`.

### 3.7 GPU layout

Workgroups are 16×16 (8×8 and 32×8 measured the same on the M4); bind groups for both ping-pong parities are created
once; all substeps of a frame go into one compute pass. A host may ask for a fractional number of substeps per frame
(4.5 → alternately 4 and 5): a saturated GPU queue has a latency cliff between whole numbers. The export pass (about a
third of a substep) is lazy: `step()` only bumps `stateVersion`, and the first read of `stateTexture` encodes the
export in its own command buffer; the stats readback exports first if needed, so volume and ledger always describe the
same substep. Brush edits (walls, erasing, pouring water, digging) run a small compute pass over the edited rectangle
and apply the same math to CPU mirrors of ground and walls, which picking and routing read. `raiseWaterSurface` lifts
water in place for river crests (§4). The stats pass reduces the exported state per 16×16 block on the GPU, so a
readback costs a few milliseconds of main-thread time at 1024².

### 3.8 The stability demo ("Break it")

Naive mode removes semi-implicit friction, the limiter, the caps, the smoothing and the CFL margins, and runs at
Courant 1.8. It diverges within seconds, starting at the river inlets, and the solver keeps running through the NaNs
without validation errors; restoring robust mode rewrites every state texture.

---

## 4. Rivers, stages and crests

The Pittsburgh preset's river stage slider is in feet on the Point gauge (NWS PTTP1 / USGS 03085152): normal pool
≈ 16 ft, flood stage 22 ft, Agnes 1972 35.8 ft, the 1936 record 46 ft. Three stage discs sit where the Allegheny,
Monongahela and Ohio cross the domain edge.

* **Confluence head.** With every boundary at one level nothing drives the rivers, and at the 1936 crest floodplain
  drainage pulled all three backwards (the Ohio ran into downtown at ~2,500 m³/s). The upstream discs sit slightly
  above the gauge level and the downstream disc slightly below: ±0.075 m at normal pool, growing linearly to ±0.2 m at
  46 ft (`WaterSource.offsetScale`). All three rivers then flow downstream at every stage, and the Point stays within a
  few centimetres of the gauge reading.
* **Stage ramp** (`src/app/stageRamp.ts`). Applying a 9 m jump at once is a dam break along every bank: bores run at
  the 15 m/s cap. The applied stage follows the slider in simulated time with bounded rate (3 m per sim-minute) and
  acceleration, so the 1936 crest arrives in ~3.7 sim-minutes (a few seconds at 60×) with peak flood speeds of ~6 m/s.
* **Crest fill** (`src/app/crest.ts`). A real crest rises along the whole river at once, not as a wave from the domain
  edge. As the stage ramps up, water in the channels connected to a stage disc is raised in place to the new level
  (`raiseWaterSurface`, booked as inflow), a few centimetres per step, so overbank flooding starts from every bank.
  Reset water replays the rise from normal pool.

## 5. Data

* **Elevation:** USGS 3DEP ImageServer (1 m lidar where available, else ~10 m), Float32 GeoTIFF decoded with
  `geotiff`. Fallback: Mapzen Terrarium tiles on AWS Open Data. No-data filling, seam and zero-clamp repair.
* **Hydro-conditioning.** 3DEP rivers are hydro-flattened (no bathymetry), so channels are burned: presets use river
  centreline waypoints and a measured pool level; live areas detect flat water bodies, open narrow false ridges
  across rivers (keeping dams, islands and road causeways), and burn them. Live conditioning runs in a Web Worker.
* **Imagery:** baked presets use USDA NAIP (public domain) via USGS The National Map at 4096²; live areas use Esri
  World Imagery.
* **Roads:** US Census TIGER/Line via TIGERweb, fallback OpenStreetMap; noded into a graph in grid coordinates.
* **Presets** (`public/presets/<id>/`: `meta.json`, `elevation.f32`, `imagery.jpg`, `roads.json`) are baked by
  `npx tsx scripts/bake-presets.ts` and work fully offline: Pittsburgh (three rivers), Johnstown (Conemaugh valley,
  1936 peak inflows), Ellicott City (2016 flash flood), and a procedural sandbox.
* **Live areas** are cancellable. A download that stalls mid-transfer fails after 20 s without data, and the elevation
  has a 90 s overall deadline (the error then says the service can't be reached). Imagery, roads and the reverse-geocoded place name get 25 s once
  the elevation is ready (Esri renders a 2048² export for 5–12 s before sending a byte); after that the area loads without them.

## 6. Rendering

A prep compute pass derives vertex heights and filterable surface textures from the solver's state (every other frame
by default: `stateVersion` tells it whether the water changed without making the solver export; the per-vertex bed is
rebuilt only when `terrainVersion` changes); the main pass
renders to MSAA 4× HDR (`rgba16float`, reversed-Z `depth32float`): sky, LOD terrain with imagery, water surface (depth
absorption, Fresnel reflection, flow-advected ripples, muddy opaque floodwater on land that was dry at reset, a wet
edge at the flood front), drawn walls with a screen-space minimum width, road and route ribbons coloured by flood
status, markers and rain. Bloom and ACES tonemapping follow. Hazard maps (depth, max depth, speed) colour only land
that was dry at reset; their colours are solved through the tone mapper so the screen matches the legend. An
adaptive resolution controller keeps frame time on target; the app also tells it how hard the solver is pushing for GPU
time (§8), so it does not spend on pixels what the flood needs in substeps. Terrain and water are CDLOD meshes of
32×32-quad patches sized to ~4 px per quad by default: vertex work was half of the renderer's GPU time.

## 7. Evacuation routing

Each road edge is sampled about once per cell. On every readback (≤ 4 Hz) an edge is dry, wet (≥ 5 cm: passable at 30 %
speed) or flooded (≥ 30 cm, roughly where cars float: impassable). Road stretches over water present at load are
bridges and stay open until the water reaches their approaches. The start and shelters are snapped to the network,
and a multi-target Dijkstra on travel time (highway 25 m/s, major 15, minor 11, local 8) finds the nearest reachable
dry shelter. The result carries the street names (`via`), metres of wet road, and a reason and advice when the route
is blocked.

## 8. App loop and pacing

The store is the single source of truth; `SimSync` pushes parameter changes into the solver. A work budget
(`governor.ts`) caps substeps per frame (in half-substep steps) from measured frame time and GPU queue latency (median
over ~1 s), with different targets while the user interacts (28 ms), watches (34 ms: about two frames of queue, the
most that stays free of dropped frames) or automation runs; a render pacer drops to a heartbeat when nothing changes;
and a frame ceiling detector notices browser 30 fps caps (Chrome Energy Saver, macOS Low Power Mode) so neither budget
starves. The renderer's adaptive quality gets a *sim pressure* hint: while the solver is GPU-limited it holds the
default level (it neither climbs above it nor keeps a better level claimed while the sim kept up), and while hands-off
with the budget down to ≤ 3 substeps (a hot fanless laptop) it steps down, at most to 1 render pixel per CSS pixel, and
recovers 20 s after the starvation ends. GPU device loss shows a recovery card and reloads once. `window.__deluge`
exposes the debug API used by `scripts/e2e.mjs`.

### 8.1 Performance budget (measured)

Production build in headless Chromium on the Apple M4 GPU (the demo machine class), Pittsburgh raised to the 1936 crest
(46 ft) with 50 mm/hr rain, 1200× requested, hands-off (`artifacts/perf/bench.mjs`):

| | before | after |
| --- | --- | --- |
| 1600×1000: fps / p95 frame time / achieved speed | 56–58 fps / 27–34 ms / 60–69× | 60 fps / 18.7 ms / 68–73× |
| 1470×956 @ DPR 2 (renders 1882×1224) | 56 fps / 31 ms / 43–57× | 60 fps / 18.9 ms / 57–64× |
| 30 fps browser cap (Energy Saver) | 29.5 fps / 70× (quality dropped a level) | 29.5 fps / 93× (quality kept) |
| Johnstown, inflows ×3, 1200× | 57 fps / 31 ms / 41× | 60 fps / 18.4 ms / 43–50× |
| 10 minutes sustained (1600×1000) | — | 60 fps, p95 18.6–18.8 ms, 66–70× every minute |
| crest button → half of downtown under ≥ 30 cm | 3.8–4.6 s | 4.0–4.8 s (same: the old budget got there by overfilling the GPU queue) |

Where one heavy frame's GPU time goes (flood at 600 s, batched submit → onSubmittedWorkDone, 1600×1000): the renderer
5.2 ms (was 6.3: vertex work of the terrain and water meshes is ~half of it, fragments the rest; bloom, sky and the
tonemap pass together < 1 ms — the ~4 ms "post" timestamp query reading includes other GPU work queued in between), prep
2.3 ms per refresh (was 2.7) plus the 0.6 ms export, both every other frame (the export used to run every frame), and
1.6–2.0 ms per substep (momentum ~45 %, continuity ~55 %; in the continuity pass the per-cell ledger write and the
source loops together cost about half of it — baking the forcing into a texture is the next step). A fixed 5 substeps
per frame is the most this machine runs at a clean 60 fps.

**MacBook Air M4 (fanless).** Same GPU class, so a cool Air matches the table. Under sustained load it throttles; with
the GPU emulated ~35 % slower (extra compute each frame) the budget drops to 1–1.5 substeps within a second, frames stay
at 58–60 fps (p95 19–24 ms), sim speed falls to ~15–20× and quality steps down to 1 render pixel per CSS pixel; within
3 s of the load going away the budget is back to 6 substeps. Expectation (estimated, not measured on an Air): a cool
Air runs the crest flood like the table (~70× at 60 fps, ~90× under Chrome's 30 fps battery cap); as it heats up sim
speed degrades toward ~15–20× while the frame rate holds at 60 fps. Plug it in and keep it cool before judging.

## 9. Validation

From `npm test` (tests run on the real GPU through Dawn):

| Check | Result | Test |
| --- | --- | --- |
| Lake at rest on rough terrain, 2000 steps | max \|u\| = 1.9·10⁻⁵ m/s | `tests/sim/wellbalanced.test.ts` |
| Dam break vs the Ritter solution at t = 20 s | profile L1 error 1.6 %, front (5 % depth) ratio 1.01 | `tests/sim/dambreak.test.ts` |
| Closed domain mass conservation | \|ΔV\|/V0 = 2.0·10⁻⁷ | `tests/sim/conservation.test.ts` |
| Open domain with rain, storm, inflow, stage, infiltration | worst massError 1.9·10⁻⁶ | `tests/sim/conservation.test.ts` |
| Rain on a tilted plane, steady state | outflow / rain = 1.000 | `tests/sim/boundary.test.ts` |
| River sloping to an open edge | depth / normal depth = 1.000 at the outlet | `tests/sim/boundary.test.ts` |
| Walled channels at 0 / 30 / 45 / 60° to the grid | depth / Manning normal depth 0.98 – 1.05 | `tests/sim/channel.test.ts` |
| Inflow beside an open edge | 0.00 % leaks back out | `tests/sim/boundary.test.ts` |
| Stage discs | zero discharge inside, no water above the stage | `tests/sim/boundary.test.ts` |
| GPU (Float32, parallel) vs Float64 CPU reference, 5 cases × 400 steps | max \|Δh\| ≤ 3.4·10⁻⁵ m | `tests/sim/reference.test.ts` |
| Stale-CFL abuse, heavy rain on steep terrain | no NaN, no negative depth | `tests/sim/robustness.test.ts`, `stability.test.ts` |

`npm run e2e` drives the ten judge flows (load, raise to the crest, levee, rain, evacuation, break and recover,
presets, tools, frame rate, idle power; `--live` adds a live-area flow) in headless Chromium on the real GPU, offline.

## 10. Future work

* A second-order Kurganov–Petrova central-upwind solver (full shallow-water equations) as a selectable mode for
  dam-break and supercritical scenarios.
* Measured channel bathymetry instead of a nominal burned depth, and culverts/storm drains.
* Coverage beyond 3DEP (the Terrarium fallback works worldwide but is coarse).

References: Bates, Horritt & Fewtrell (2010), *J. Hydrology* 387; de Almeida, Bates, Freer & Souvignet (2012), *Water
Resources Research* 48; Ritter (1892) dam-break solution.

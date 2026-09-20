# Deluge — architecture and numerical method

Deluge solves the 2-D shallow-water equations on real terrain in a browser tab, on the GPU, fast enough to play with:
draw a levee and watch the water go around it, raise a river to a historic crest, crank the rain, and watch an
evacuation route re-plan as roads flood. This document explains how, and why it stays stable.

Contents: [1 Frame pipeline](#1-frame-pipeline) · [2 Module map](#2-module-map) ·
[3 Numerical method](#3-numerical-method) · [4 Rivers, stages and crests](#4-rivers-stages-and-crests) ·
[5 Data](#5-data) · [6 Rendering](#6-rendering) · [7 Evacuation routing](#7-evacuation-routing) ·
[8 App loop and pacing](#8-app-loop-and-pacing) · [9 Validation](#9-validation) ·
[10 Shipping: browser, desktop app and the test suites](#10-shipping-browser-desktop-app-and-the-test-suites) ·
[11 Future work](#11-future-work)

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
| `src/ui/` | Panels, toolbar and tools, HUD, "Try it" strip (with the one-click demo levee), How it works, location picker. Plain DOM + one CSS file. |
| `src/app/` | Orchestration: scene loading, store → solver sync, stage ramp and crest fill, protected-land analysis, frame driver, work budget / frame pacing, debug API (`window.__deluge`). |
| `scripts/` | `bake-presets.ts` (bakes `public/presets/*`), `e2e.mjs` (end-to-end demo flows in headless Chromium on the real GPU), `bench.mjs` (performance benchmark, §8.1), `shot.mjs` (screenshot tool), and the three regression suites `perf.mjs`, `visual.mjs`, `security-test.mjs` (§10.3). |
| `electron/` | The macOS desktop wrapper (§10.2): `main.js` (one hardened main process), `endpoints.js` (the CSP and network allowlist, mirrored from `src/data/csp.ts`), `package.mjs` (asar + fuses + ad-hoc signature), `check-endpoints.mjs`, `verify-renderer.mjs` / `verify-packaged.mjs` (the release gate), `smoke.js` (verification builds only). |
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
  run within 6 % of Manning's normal depth (0.98–1.05), and grid-scale circulations along rough shorelines stay damped.
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
conserved (and the Float32 rounding that remains is booked, §3.5). Computing a neighbour's `k` needs that neighbour's four faces, hence a 13-texel
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
Float32 limiter residue) is added to a per-cell in/out accounting buffer as exactly what it did to `h`. That cannot be
measured as `(h + Δ) − h` on the GPU: shader compilers (Metal) fold the expression into `Δ`, and after hours of a crest
the unbooked rounding on deep cells turned the HUD yellow. Instead every increment is snapped to the Float32 ULP grid
of the depth it changes (`SNAP_WGSL` in `shaders/common.ts`), so the snapped value is exactly what lands in `h`. Face
volumes `dt/dx·q` are one Float32 product that both neighbouring cells compute identically, so interior exchanges
cancel exactly; what the snaps remove (and the limiter residue) is booked as signed inflow, so `volumeIn` may be
slightly non-monotonic (≲ 10⁻⁶ of the stored volume). At each readback a reduction pass sums the buffer per 16×16
block exactly (a grid part plus a remainder, added in Float64 on the CPU), and the buffer is copied and zeroed **in
the same command encoder**, so no substep is lost or counted twice:

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
never exceeds 0.85; because of the safety margins below, the HUD usually reads ≈ 0.55. A 1-D formula at 0.7 sits right
on the 2-D limit (tests/sim/stability.test.ts guards this).

The fastest wave `max(√(g·h) + |u|)` is the stats pass's per-cell maximum from the latest asynchronous readback, so
robust mode inflates it (×1.25 + 0.1 m/s) and combines it with what it knows is coming before a readback can show it:
the deepest water a stage source or brush stroke creates (×1.15 depth), the critical velocity at an inflow's rim, and a
dam-break speed `2·√(g·Δh)` for a stage raise (added to the deepest water, the conservative way). Rain on dry ground
is anticipated too: while it rains the wave speed is floored at `SolverOptions.rainRunoffSpeed` (2 m/s at 100 mm/hr,
scaled by rate^0.4, Manning sheet flow on slopes), and hollows are assumed to fill 50× faster than the rain falls
during the readback lag (`rainPondingFactor`). Without that, a dry live area such as Houston ran its first rainy
readback window at dt = 5 s and showed Courant 4–19. Taking the maximum
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
Courant 1.8. The UI (`src/ui/stabilityDemo.ts`) drops a 2 m splash of water into the water nearest the camera
target, so it diverges mid-view within seconds and the NaNs run along the rivers; the clock is slowed to 3× until
divergence, then the user's speed returns. The solver keeps running through the NaNs without validation errors;
routing freezes on the last physical flood, and restoring robust mode rewrites every state texture.

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
  It is a time-lapse (~600–850× the 1936 rate, which took ~30 hours; the UI says so): the ~6 m/s peaks come from water
  spilling onto the floodplain and filling low basins, not from the rate (half the rate gave the same peaks). Moving the
  slider back past the applied stage turns the ramp around at once (no coasting).
* **Crest fill** (`src/app/crest.ts`). A real crest rises along the whole river at once, not as a wave from the domain
  edge. As the stage ramps up, water in the channels connected to a stage disc is raised in place to the new level
  (`raiseWaterSurface`, booked as inflow), a few centimetres per step, so overbank flooding starts from every bank.
  Reset water replays the rise from normal pool.
* **Checked against the National Weather Service.** NWS impact statements for gauge PTTP1, against Deluge holding each
  stage for 900 sim-s (bare-earth landmarks sampled on the grid):

  | NWS impact | NWS stage | Deluge |
  | --- | --- | --- |
  | Water surface at the Point | the gauge reading | within 3 cm of it at every stage from 28 to 46 ft |
  | Point State Park flooded to the Portal Bridge | 30 ft | dry at 30 ft, wet (0.11 m) at 31 ft |
  | PNC Park field flooded | 31 ft | dry at 31 ft, 0.98 m at 35 ft (field at 221.1 m ≈ 31.8 ft) |
  | Federal Street at PNC Park flooded | 40 ft | dry at 36 ft, 0.26 m at 40 ft |
  | Up to 15 ft of water in the Golden Triangle | 46 ft | 4.8 m (15.7 ft) at Point State Park |
  | Acrisure Stadium field | 30 ft | dry until 40 ft |
  | Station Square tracks | 31 ft | dry at 36 ft, wet at 40 ft |
  | Wood Street T station | 28 ft | wet only at 46 ft |
  | Tenth Street Bypass / Fort Pitt Blvd / Parkway "bathtub" | 22 / 28 / 25 ft | first water at 35–40 ft / dry at 46 ft / dry at 46 ft |
  | Rivers Casino floor | 37 ft | 1.26 m at 35 ft (early) |

  The river-level and open-ground impacts match within a few feet. The misses are water that arrives through what
  bare-earth elevation does not contain — storm drains, underpasses, depressed roadways, underground stations — and
  places sampled by approximate coordinates.
* **Protected land and the one-click levee** (`src/app/protection.ts`, `src/ui/levee.ts`). About once a second, while
  walls exist, a bathtub counterfactual on the latest readback: water pressing against a wall (a large body of water
  within two cells of it; its level capped at the 95th percentile of those cells + 0.15 m so run-up spray does not
  count) spreads over land below its level twice — over the bare ground, and over ground + walls. Land that would
  stand ≥ 0.3 m deep without the walls but not with them, and is dry now, is *protected*: the renderer tints it green,
  and the Try-it strip and wall card report the acres and streets. It ignores how long a gap would take to fill the land
  behind it. A run is ~2–3 ms of warm work on the land near the walls, but on the page's main thread it often took
  10–20 ms (a dropped frame about every other second during the levee demo), so it runs in a Web Worker
  (`src/app/protectionWorker.ts`): the page copies the depth field per run (~1–2 ms), and ground + barrier only after a
  terrain edit. Without walls nothing runs (one scan per terrain edit, stopping at the first wall); naive or diverged
  readbacks (Break it) are skipped, so the last physical answer stays up. A sudden collapse is confirmed by a second run
  before it is shown, and the one-time success notice waits until the river has arrived and two runs agree. Pittsburgh's scenario carries
  a demo levee (`ScenarioPreset.levee`, baked): a 2.4 km floodwall along the North Shore from bluff to bluff with its
  crest 1 m above the 1936 record. *Build a levee* resets the water if the flood is already out, raises it along its
  line in ~2 s (each ~40 m piece tall enough for the lowest ground under it), and replays the rise; at the crest it
  keeps ~0.56 km² (139 acres) and 11 km of streets dry while flooded land drops from 6.3 to 5.6 km²
  (`scripts/e2e.mjs` flow 13).

## 5. Data

* **Elevation:** USGS 3DEP ImageServer (1 m lidar where available, else ~10 m), Float32 GeoTIFF decoded with
  `geotiff`. Fallback: Mapzen Terrarium tiles on AWS Open Data. No-data filling, seam and zero-clamp repair.
* **Hydro-conditioning.** 3DEP rivers are hydro-flattened (no bathymetry), so channels are burned: presets use river
  centreline waypoints and a measured pool level; live areas detect flat water bodies, open narrow false ridges
  across rivers (keeping dams, islands and road causeways), and burn them. Live conditioning runs in a Web Worker.
* **Imagery:** baked presets use USDA NAIP (public domain) via USGS The National Map at 4096²; live areas use Esri
  World Imagery. **Esri imagery is never baked into the repo** — it is not redistributable, so `public/presets` holds
  NAIP only and `--imagery=esri` exists for local experiments, not for anything committed.
* **Close-up imagery inset.** A 4096² photo over an 8 km domain is 1.95 m/texel, which is mush once the camera drops
  to street level. Domains coarser than NAIP's own ~1 m limit carry a second 4096² NAIP photo (`imagery-detail.jpg`)
  covering the `imageryDetail` rectangle of `meta.json` — the middle 2.5–3.0 km, where the scenario cameras go — and
  the terrain shader blends it over the base with an 8-cell smoothstep feather, sampling both through the same
  trilinear/aniso-16 sampler in uniform control flow. It is an exact sub-rectangle of the base export bbox, so it
  registers to the pixel (measured best-fit shift 0 px in both axes; mean per-channel colour within 2 %, so the
  feathered edge shows no tonal step). Pittsburgh, Johnstown, Asheville and Houston have one (0.61–0.73 m/texel,
  2.4–2.7×); Ellicott City, Boulder and Nashville do not, because their smaller domains already give 1.22–1.46 m/texel.
  Cost: 89.5 MB of GPU memory and 3.5–5.1 MB on disk per inset, −23 ms on load (interleaved A/B: both photos fetch and
  decode concurrently and the upload is ~17 ms) and a main-pass delta inside sample noise. The alternatives were
  measured and rejected: an 8192² base costs 357.9 MB of GPU memory and still only reaches 0.98 m/texel; tiled
  streaming needs a pyramid, a residency policy and upload scheduling for a demo that flies between fixed poses; and
  KTX2/ASTC — which this M4 supports and which would cut 89.5 MB to ~5.6 MB — is the right long-term answer but needs
  an encoder and a container reader that the repo does not have.
* **Roads:** US Census TIGER/Line via TIGERweb, fallback OpenStreetMap; noded into a graph in grid coordinates.
* **Presets** (`public/presets/<id>/`: `meta.json`, `elevation.f32`, `imagery.jpg`, `roads.json`, and
  `imagery-detail.jpg` where the base photo is too coarse) are baked by `npx tsx scripts/bake-presets.ts` and work
  fully offline. Seven cities plus a procedural sandbox:

  | Preset | Domain / cell | Scenario forcing | Photo | Road edges |
  | --- | --- | --- | --- | --- |
  | `pittsburgh` | 8.0 km / 7.81 m | 1936 crest via the stage control, plus a demo levee | 1.95 + inset 0.73 | 11,053 |
  | `johnstown` | 7.0 km / 6.84 m | 1889 South Fork Dam flood as a lake-average 3,730 m³/s inflow on the Little Conemaugh | 1.71 + inset 0.61 | 4,903 |
  | `ellicott` | 5.0 km / 4.88 m | 2016 flash-flood storm over the Tiber–Hudson–New Cut watershed | 1.22 | 1,224 |
  | `asheville` | 8.0 km / 7.81 m | Helene 2024: 3,200 m³/s French Broad + 1,722 m³/s Swannanoa, sloping (no stage control) | 1.95 + inset 0.73 | 3,556 |
  | `nashville` | 6.0 km / 5.86 m | Cumberland stage control: 2010 (52.55 ft), 1937 (53.90), 1927 record (56.20) | 1.46 | 5,410 |
  | `houston` | 8.0 km / 7.81 m | Harvey 2017: 173 mm/hr over the whole domain, bayou at its 923 m³/s peak | 1.95 + inset 0.73 | 10,529 |
  | `boulder` | 5.0 km / 4.88 m | 2013 Front Range flood: 238 m³/s out of Boulder Canyon | 1.22 | 1,749 |

  River centrelines for the four 2024/2025 additions are traced from USGS NHD high-resolution flowlines; peak
  discharges, stages and gauge datums come from the USGS annual peak-flow files and NWIS site file. Everything in
  `public/presets` is public-domain U.S. government data, recorded per city in `public/presets/SOURCES.txt`.
* **Deploy budget.** `public/presets` is served from a public static host, so `tests/data/presets.test.ts` caps the
  whole directory at 120 MB and each preset at 25 MB. It currently stands at 87.8 MB — Asheville is the largest single
  city at 15.9 MB, and close-up insets account for 16.5 MB across four cities. The per-preset cap is the one that
  protects a visitor, who downloads one city and not the directory. The directory cap was 90 MB, which left 2.2 MB of
  headroom and no way to derive the number: the deploy target is GitHub Pages (`.github/workflows/pages.yml`), whose
  published-site limit is a hard 1 GB, and a full `vite build` of this repo measures 88.8 MB — about 9 % of what the
  host allows. It was raised to 120 MB (12 % of the limit) rather than buying 2–5 MB by re-encoding the seven 4096²
  base photos below the baker's quality 0.92 or by dropping an inset, either of which spends image quality — the most
  visible surface here — to respect a self-imposed number. Nashville qualifies for an inset on the texel-density rule
  and one was baked and measured (0.611 m/texel, 2.4×, 3.80 MB); it now fits, and the export is cached in
  `artifacts/bake-cache`, so re-adding it costs one bake.
* **Live areas** are cancellable. A download that stalls mid-transfer fails after 20 s without data, and the elevation
  has a 90 s overall deadline (the error then says the service can't be reached). Dead venue wifi often leaves requests
  hanging instead of failing: while no elevation has arrived, the loader checks every 9 s that the data hosts answer at
  all (a 3 s no-cors probe; a slow export still answers it) and gives up with the offline message when they do not
  (~12–15 s instead of 90 s). When the browser reports no network the load fails at once, and when the page's own probe
  just found the hosts unreachable (the picker's "You're offline" → *Offline — try anyway*) the first check runs right
  away; such failures are logged as warnings, not errors. Imagery, roads and the reverse-geocoded place name get 25 s once the elevation is ready
  (Esri renders a 2048² export for 5–12 s before sending a byte); after that the area loads without them. Cancelling a
  load with nothing on screen (a `?live=` link at startup) shows the offline default preset, points the address bar at
  it, and offers a retry. A live area with no river crossing its edge has no stage control; there *Play the flood*
  drops a 120 mm/hr storm cell over the view instead of only fast-forwarding.

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
most that stays free of dropped frames) or automation runs, and cuts the cap by 40 % ahead of known jumps in GPU work
(rain starting, a water reset, a solver switch) instead of waiting for the queue to back up; a render pacer drops to a
heartbeat when nothing changes;
and a frame ceiling detector notices browser 30 fps caps (Chrome Energy Saver, macOS Low Power Mode) so neither budget
starves. The renderer's adaptive quality gets a *sim pressure* hint: while the solver is GPU-limited it holds the
default level (it neither climbs above it nor keeps a better level claimed while the sim kept up), and while hands-off
with the budget down to ≤ 3 substeps (a hot fanless laptop) it steps down, at most to 1 render pixel per CSS pixel, and
recovers 20 s after the starvation ends. GPU device loss shows a recovery card and reloads by itself at most twice
per 10 minutes (never within a minute of the last automatic reload); a live area or large grid that keeps losing the
GPU restarts as the offline Pittsburgh preset, otherwise the card waits for the user. `window.__deluge` exposes the
debug API used by `scripts/e2e.mjs`.

### 8.1 Performance budget (measured)

Production build in headless Chromium on the Apple M4 GPU (the demo machine class), Pittsburgh raised to the 1936 crest
(46 ft) with 50 mm/hr rain, 1200× requested, hands-off (`npm run demo`, then `node scripts/bench.mjs --scenario=pgh`):

| | before | after |
| --- | --- | --- |
| 1600×1000: fps / p95 frame time / achieved speed | 56–58 fps / 27–34 ms / 60–69× | 60 fps / 18.7 ms / 68–73× |
| 1470×956 @ DPR 2 (renders 1882×1224) | 56 fps / 31 ms / 43–57× | 60 fps / 18.9 ms / 57–64× |
| 30 fps browser cap (Energy Saver) | 29.5 fps / 70× (quality dropped a level) | 29.5 fps / 93× (quality kept) |
| Johnstown, inflows ×3, 1200× (the earlier 1936 inflows, ~7,460 m³/s in total) | 57 fps / 31 ms / 41× | 60 fps / 18.4 ms / 43–50× |
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

From `npm test` (tests run on the real GPU through Dawn); the grid-convergence rows from
`npx tsx scripts/reference-run.ts` (§9.1), likewise on the real GPU:

| Check | Result | Test |
| --- | --- | --- |
| Lake at rest on rough terrain, 2000 steps | max \|u\| = 9.3·10⁻⁵ m/s | `tests/sim/wellbalanced.test.ts` |
| Dam break vs the Ritter solution at t = 20 s | profile L1 error 1.6 %, front (5 % depth) ratio 1.01 | `tests/sim/dambreak.test.ts` |
| Closed domain mass conservation | massError 7·10⁻⁹ (\|ΔV\|/V0 = 2.5·10⁻⁶, all of it booked Float32 rounding) | `tests/sim/conservation.test.ts` |
| Open domain with rain, storm, inflow, stage, infiltration | worst massError 9.1·10⁻⁸ | `tests/sim/conservation.test.ts` |
| Deep river with rain and a stage boundary, 3 sim-hours | worst massError 5.9·10⁻⁷ | `tests/sim/conservation.test.ts` |
| Rain on a tilted plane, steady state | outflow / rain = 1.000 | `tests/sim/boundary.test.ts` |
| River sloping to an open edge | depth / normal depth = 1.000 at the outlet | `tests/sim/boundary.test.ts` |
| Walled channels at 0 / 30 / 45 / 60° to the grid | depth / Manning normal depth 0.98 – 1.05 | `tests/sim/channel.test.ts` |
| Inflow beside an open edge | 0.00 % leaks back out | `tests/sim/boundary.test.ts` |
| Stage discs | zero discharge inside, no water above the stage | `tests/sim/boundary.test.ts` |
| GPU (Float32, parallel) vs Float64 CPU reference, 5 cases × 400 steps | max \|Δh\| ≤ 4.3·10⁻⁵ m | `tests/sim/reference.test.ts` |
| Stale-CFL abuse, heavy rain on steep terrain | no NaN, no negative depth | `tests/sim/robustness.test.ts`, `stability.test.ts` |
| Grid convergence, 1024² demo grid vs a 4096² reference (§9.1), Pittsburgh 1936 crest | flooded area −0.92 %, extent IoU 98.0 %, max-depth RMSE 0.29 m | `scripts/reference-run.ts` |
| The same, 100 mm/hr rain | flooded area −0.55 %, extent IoU 78.2 %, max-depth RMSE 0.22 m | `scripts/reference-run.ts` |
| The convergence harness's own arithmetic (refinement, masks, IoU, percentiles, arrival times) | 21 checks | `tests/sim/referenceMetrics.test.ts` |
| All seven baked cities in the production build, offline, 1470x956 DPR 2: cold load, scenario play, streets, routing | load 606–744 ms, 60 fps, sim 48–125× real time, mass error ≤ 6.6·10⁻⁸, 0 console/WebGPU errors, 0 network requests | `scripts/e2e.mjs` flow 7 |
| Each preset's files, grid, scenario, shelters on high ground, confined initial water, inset registration and deploy size | 7 cities × 5 checks | `tests/data/presets.test.ts` |

`npm run e2e` drives 14 end-to-end demo flows (load, raise to the crest, levee, rain, evacuation, break and recover,
presets, tools, frame rate, idle power, cancelling a stalled `?live=` link, the one-click levee, the screen wake
lock, and a GPU device loss mid-load; `--live` adds a live-area flow) in headless Chromium on the real GPU,
offline — every request to a non-local host is blocked and reported, so a flow that quietly needed the network
fails.

**Per-city verification.** `scripts/e2e.mjs` flow 7 reads the list of cities off `public/presets` rather than a
hard-coded array, so a city added by a bake cannot be forgotten by the suite. Every one of the seven is loaded cold in
the production build at the demo viewport, played with its own camera and forcing, and checked for finite stats, a
plausible maximum speed, zero console/WebGPU errors and zero network requests.

**One known-flaky golden.** `pittsburgh-velocity` is the only visual scene that compares an *instantaneous* field
(flow speed at exactly 600 simulated seconds of crest + 100 mm/hr rain) rather than an accumulated one. Its golden
diff measured 0.0051, 0.0163, 0.0215 and 0.0305 on four runs of identical code against a 0.02 threshold, with
187,512–193,610 wet cells at the same simulated time: with the adaptive budget off and `runFor` pinning sim time, what
still varies is the CFL readback latency under GPU contention, which changes the substep sequence and therefore the
trajectory. Every other scene sits at 0.0000–0.0051. The scene is worth keeping — it is the one that would catch a
velocity-shader regression — but its tolerance is not honest at 0.02 on a loaded machine.

### 9.1 Grid convergence: the demo grid against a 16× finer reference

Every check above is a small analytic problem or an exact accounting identity. None of them answers the question a
judge actually asks about the demo: *is the flood you are showing me an artefact of your 7.8 m cells?*
`scripts/reference-run.ts` answers it by running the **same** solver — `src/sim`, on the GPU through Dawn in Node — on
the **same** shipped Pittsburgh scenario at 1024², 2048² and 4096² over the same 8 km square (7.81, 3.91 and 1.95 m
cells), and comparing the results cell by cell. Two scenarios, 30 simulated minutes each:

* **crest** — the 1936 stage ramp of §4: the Point gauge rises to its record 46 ft at the app's 3 m per sim-minute
  rate (`src/app/stageRamp.ts`) with the channel raise of `src/app/crest.ts`, then holds.
* **rain** — 100 mm/hr over the whole domain with the rivers at normal pool. Centimetre-deep sheet flow down
  hillsides and streets is where cell size should hurt most, so this is the harder case of the two.

Everything but the cell size is held fixed. One DEM defines the bed and each grid samples that same surface at its own
cell centres; the wetted river footprint is taken once on the baked grid and replicated, then filled to the same
216.3 m surface; stage-source centres and radii scale with the grid while their levels, discharges and rain rates do
not; and the stage ramp and the readbacks are driven on a **simulated**-time cadence, because the solver's CFL estimate
reads back flow maxima and a wall-clock cadence would have handed the grids different timesteps for reasons that have
nothing to do with dx. What does change is the timestep: each grid runs at its own CFL limit, so the 4096² run takes
4× smaller steps and 64× the work of the demo grid.

| Grid | dx | Substeps (crest / rain) | Wall clock (crest / rain) | GPU memory | mass error (crest / rain) |
| --- | --- | --- | --- | --- | --- |
| 1024² (the demo) | 7.813 m | 8,882 / 5,560 | 26 s / 20 s | 0.13 GB | 1.2·10⁻⁸ / 6.6·10⁻⁹ |
| 2048² | 3.906 m | 16,119 / 11,905 | 1.9 min / 2.0 min | 0.44–0.45 GB | 1.2·10⁻⁸ / 1.3·10⁻⁸ |
| 4096² (reference) | 1.953 m | 32,159 / 23,940 | 13.1 min / 15.8 min | 1.75–1.81 GB | 7.5·10⁻⁹ / 4.1·10⁻¹⁰ |

The whole ladder is 34 minutes of GPU time on the fanless M4 — the reference run fits on the demo laptop, so nothing
here needed a rented GPU. Peak Node RSS was 1.3–1.9 GB at 4096² (Dawn's Metal heaps are on top of that).

**Agreement of the 1024² demo grid with the 4096² reference** (16× the cells, 4× smaller timestep):

| Measure | crest (1936) | rain (100 mm/hr) |
| --- | --- | --- |
| Newly flooded land, ≥ 0.15 m | 6.549 vs 6.609 km² (**−0.92 %**) | 3.155 vs 3.173 km² (**−0.55 %**) |
| Flood-extent IoU of those maps | **98.0 %** | **78.2 %** |
| Total wet extent incl. rivers, ≥ 0.15 m | 10.902 vs 10.957 km² (−0.50 %), IoU 98.9 % | 7.508 vs 7.519 km² (−0.14 %), IoU 90.1 % |
| Water held at the end | +0.11 % | +0.47 % |
| Max-depth error on flooded land (on the 4096² grid) | RMSE 0.288 m, L1 0.148 m, median 0.060 m, p90 0.368 m, p99 1.276 m | RMSE 0.220 m, L1 0.118 m, median 0.053 m, p90 0.289 m, p99 0.981 m |
| Max-depth error at 7.8 m resolution (4096² block-averaged down) | RMSE 0.106 m, median 0.038 m, p99 0.362 m | RMSE 0.150 m, median 0.037 m, p99 0.663 m |
| Arrival of 0.15 m at six flooded landmarks | −0.2 … +6.7 s on 155–313 s arrivals (≤ 2.2 %) | only one site reaches 0.15 m (+122 s on 1,582 s); at 0.05 m, four do: +21 … +142 s on 673–1,218 s arrivals |
| Three dry controls (Grant St ridge, Mt Washington, Oakland) | dry on both grids | dry on both grids |

Halving the cell size roughly halves the error, which is what a scheme with first-order upwind advection and
wetting/drying fronts should do. Against the 4096² reference, going 1024² → 2048² cuts the crest's flooded-area
difference 2.93×, its max-depth RMSE 2.29×, its p90 2.12× and its IoU shortfall 2.25×; for rain the RMSE, p90 and IoU
shortfall fall 2.30×, 2.35× and 2.10×. (Rain's flooded *area* difference does not: it is 0.55 % at 1024² and 1.03 % at
2048². A total area is a difference of two large numbers and cancels, so it can agree while the water sits somewhere
else — which is exactly what rain's IoU says. Read the IoU and the percentiles for placement, not the area.)

**Where the demo grid really does differ.** The averages are the flattering half of the story. On the crest, half the
flooded cells agree within 6 cm — but the worst 1 % differ by more than 1.28 m, and the single worst cell by 6.1 m.
Those cells are at the edges: restricted to land *both* grids flood, the worst cell drops to 3.8 m, so the extremes
are margin cells where a 7.8 m cell is wet-or-dry and 16 fine cells resolve a shoreline. Rain is worse in placement
(IoU 78 % against the reference, 0.38 km² wet only at 1024² and 0.40 km² only at 4096²) because runoff concentrates
into flow paths narrower than a coarse cell. And one quantity does **not** converge at all: the area with *any* water
(h > 1 cm) at the end of the rain case reads 25.3, 23.3 and 21.9 km² on the three grids, and with the bed replicated
rather than interpolated the 2048² run reads 32.8 km² — it moves by tens of per cent and not even in a consistent
direction. A 7.8 m cell cannot hold the rills that runoff collects into, so how much of a hillside is left as a
millimetre-to-centimetre sheet instead of a drained channel depends on the cell size and on how the micro-topography
is represented. So: anything reported at a centimetre threshold under rain is resolution-dependent and should not be
quoted as a converged number. The 0.15 m hazard bands the app actually draws are converged — that is the difference
between the 21.9 km² figure and the 7.519 km² one in the table above.

**How much of that is the bed, not the numerics.** Sampling the 7.8 m DEM at 3.9 m centres gives the finer grid a
slightly different (smoother) bed — visible as a 0.4 % difference in initial river volume. Re-running the 1024²/2048²
pair with the bed replicated instead of interpolated (`--bed=nearest`: identical piecewise-constant surface, initial
volume equal to the bit) drops the crest's max-depth RMSE from 0.126 m to 0.032 m and raises its IoU from 99.1 % to
99.6 %. So roughly three quarters of the apparent disagreement in the table above is the bed being re-sampled, not the
solver — the headline numbers are conservative in the honest direction.

**Cross-checks that the harness is running the demo and not something else.** Driven to 46 ft and held 15 simulated
minutes it puts 15.4 ft of water at Point State Park, against the 15.7 ft in the §4 NWS comparison (9 cm apart), and it
applies exactly 9.130 m of stage offset (46.00 ft). At 4 sim-minutes it floods 4.58 km², against the 4.2–4.3 km² noted
in `src/app/stageRamp.ts`; the ~8 % gap is that the app's figure came from a frame-paced run that drops backlog when
throttled, while the harness runs every CFL substep.

**What this proves.** That the flood the demo draws is converged in cell size. For the river crest — the scenario the
demo leads with — the outline a judge sees at 7.8 m is within 0.92 % in area and 98 % in overlap of what the same
equations say at 1.95 m, the depths agree to 6 cm for half the flooded area, and arrival at named landmarks agrees to
2 % or better. For 100 mm/hr rain the area still lands within 0.55 %, but only 78 % of the map overlaps: the coarse
grid floods about the right amount of ground and is noticeably less sure which ground. It also shows the mass ledger
holding at 10⁻⁸ over tens of thousands of substeps at three resolutions.

**What this does not prove.**

1. **Not accuracy against reality.** Grid convergence says the discretisation is near its own limit; it says nothing
   about whether that limit is the real 1936 flood. The only reality check in this repo is the NWS impact-stage
   comparison in §4, and that is against *statements about stages*, not a surveyed inundation map.
2. **Not DEM resolution.** The finer grids resample the same 7.8 m bare-earth DEM; they add no terrain detail. Real
   1 m lidar would add flood walls, embankments, road camber, kerbs and buildings that a 7.8 m DEM smooths away, and
   those move flood paths far more than the numerics do. This measurement is a lower bound on total uncertainty, not
   an estimate of it.
3. **Not the physics.** Both grids solve the same local-inertial shallow-water equations with one Manning's n, no
   buildings, no storm drains, no bridge piers, no infiltration. A missing process converges exactly as cleanly as a
   present one.
4. **Not a substitute for the analytic tests.** A grid-independent error in the scheme — a wrong friction term, say —
   would converge beautifully to the wrong answer. That is what the Ritter dam break, the lake at rest, Manning's
   normal depth and the exact mass ledger above are for. Convergence and correctness are different claims.
5. **Not a formal convergence order.** Two error pairs against one reference show a trend. A published order needs
   more grids, a reference far finer than the finest compared grid, and a smooth solution — and a flood front is not
   smooth. The ratios above are reported as ratios for that reason.

Re-run with `npx tsx scripts/reference-run.ts` (`--grids`, `--cases`, `--minutes`, `--bed`; `--compare-only` re-derives
every number from the saved fields without a GPU). Full tables, the per-threshold ladders and the landmark time series
land in `artifacts/reference-run/results.md` and `results.json`; the file header explains how to run the next rung
(8192², 64× the demo grid) on a rented GPU. The harness's own arithmetic is unit-tested in
`tests/sim/referenceMetrics.test.ts`.

### 9.2 Shipping the reference into the app: the "Reference (4096²)" overlay

The ladder above proves the demo grid is near its own limit, but it proves it in a table. `scripts/reference-run.ts
--export-overlay` writes the finest run's answer into the preset as data, so the app can *draw* the reference flood
edge over the live simulation and put the measured agreement beside it.

**The artifact.** `public/presets/pittsburgh/reference.json` (1.8 kB) + `reference.bin` (109 kB) — Pittsburgh only, and
only for the case the reference was actually computed for. It is not third-party data: it is this repo's own solver at
4096², resampled to the shipped 1024² grid by the same 4×4 block mean the convergence table uses, so the overlay and
the metrics are the *same* comparison and the renderer can index the field with the live simulation's own cell indices.

| File | Contents |
| --- | --- |
| `reference.json` | Manifest: grid (`nx`, `ny`, `cellSize`, `referenceGrid`, `refine`), the scenario each plane was computed for (stage offset and gauge feet, rain, storms, boundary, Manning's n, when the ramp arrived, duration), the measured `agreement` block lifted straight out of the same run's comparison, provenance (GPU, host, wall clock, mass error, sha256 of the binary), and one entry per plane with its byte range, quantisation, scale and *measured* worst-case round-trip error. |
| `reference.bin` | The planes' bytes concatenated. Each plane is `nx·ny` bytes of u8 — row-major, the same indexing as `elevation.f32` — gzip-compressed **independently**, so one fetch serves them all and the loader inflates only the plane it draws. `DecompressionStream` is a strictly weaker requirement than WebGPU. |

Two plane kinds, both reserving code 0 for "nothing here" so a missing value can never be read as a real one:

| Plane | Decode | Resolution | Shipped |
| --- | --- | --- | --- |
| `maxDepth` | `d = scale · (code/255)²`, `scale` 15.8 m | ≈1.2 cm per code at the 0.15 m hazard band, ≈12 cm at 15 m | yes (crest) |
| `arrival` | `t = (code−1)/254 · scale`, code 0 → NaN ("never reached the threshold") | linear, ≈7 s per code over 30 min | no — the format carries it, the shipped file does not |

Depth is sqrt-quantised rather than linear because a flat u8 step over 16 m is 6.3 cm, coarsest exactly where a flood
map is read; the curve spends its codes where the water is shallow and gives away precision at 15 m where nobody reads
the third digit. Any positive depth gets at least code 1, so a thin sheet never vanishes into the dry background. The
measured worst-case round-trip error is **6.2 cm** (`plane.quantMaxError`, written by the export, not asserted in a
comment) — an order of magnitude below the 0.13–0.29 m discretisation error the overlay exists to illustrate, so the
encoding is not what limits the comparison. 184,610 wet cells of 1,048,576 gzip to 109 kB; `public/presets` is 84 MB of
its 90 MB budget.

**Drawing it: a distance field, not a second tint.** `src/render/reference.ts` turns the decoded max-depth plane into
the *wet edge* of "max depth ≥ threshold" and ships it to the GPU as an exact two-pass Euclidean signed distance in
cells (Felzenszwalb & Huttenlocher), clamped to ±8 cells and quantised to u8 in an `r8unorm` texture. A binary mask
sampled per pixel gives a line whose width swims with the camera and breaks into dashes at a pixel per cell; a signed
distance has a gradient of one cell per cell everywhere, so the water shader draws a constant-width line (≈2.6 px core
with a 2 px dark halo, widths set in *pixels* from the camera's pixel footprint) at every zoom, anti-aliased, with no
marching squares, no geometry and no CPU work per frame. A translucent second tint over the live water only produces a
third colour nobody can attribute; an outline beside the live shoreline is readable in a second.

**It refuses rather than mislead.** The overlay is honest only over a live simulation that is still the scenario the
manifest records, so `referenceFit` (`src/data/referenceOverlay.ts`) compares the two and returns one of thirteen
mismatch reasons (`ReferenceMismatch` in `src/contracts.ts`): wrong `preset` or `grid`, the `naive` solver, terrain
`edits` (walls drawn or ground dug), `rain`, `storms`, wrong `stage`, still `rising`, a `late-crest` (right stage,
raised far later than the reference's own ramp — a different flood), different `friction` or `boundary`, and `early` or
`past` the reference's simulated time. The View-panel switch then disables itself and states the reason *and the fix*
in place of the readout. The control is absent entirely for a preset that ships no reference, and the readout and
legend are formatted from the manifest's numbers (`src/ui/referenceText.ts`), never from prose that can drift from the
data: `extent IoU 98.0 % · flooded area −0.9 % · max-depth RMSE 0.29 m · water held +0.1 %`.

Both the terrain and the water pass draw the same line, so it crosses the live shoreline without a break — which is the
whole point: where the two waterlines coincide, the line hugs the water's edge, and where they part you can see by how
much. In each pass it is composited **last**, after the hazard maps, contours and the protected-land wash, because it
is an annotation about the picture rather than part of it; the halo only darkens what is already there. Hazard-mode
colours and the default look are unchanged.

**Cost.** Off by default. The edge texture is allocated with the scene (1 MB at 1024², like the protected-land mask, so
the bind group never changes) and its bytes are uploaded once, the first time the overlay is switched on — the decode
and the distance transform run once on the CPU at that moment, not per frame. While it is off the uniform is zero, the
branch is skipped and `refTex` is never sampled.

## 10. Shipping: browser, desktop app and the test suites

### 10.1 Content-Security-Policy, one source of truth

`src/data/csp.ts` holds the policy and the endpoint list; `vite.config.ts` writes it into `dist/index.html` as a
`<meta http-equiv>` ahead of the first script tag. It is `default-src 'none'` with `script-src 'self'` — no
`unsafe-inline`, no `unsafe-eval`, no `wasm-unsafe-eval` (the DEM path is kept uncompressed on purpose, so geotiff
never needs its WASM decoders) — `worker-src 'self'`, `connect-src` limited to the seven data endpoints, `img-src`
adding only the Esri tile prefix and `data:`, `object-src`/`base-uri`/`form-action` `'none'`, and `style-src 'self'
'unsafe-inline'` because `index.html` and the unsupported-browser screen each insert a `<style>` block.

Two directives cannot be expressed in a meta tag, so they only exist where a real server sends headers: the desktop
wrapper adds `frame-ancestors 'none'` (§10.2). A copy hosted on GitHub Pages can therefore be framed by any origin;
the impact is limited to what a framed copy could do — there are no accounts, no state-changing server calls and
nothing stored — and it is called out in the README.

`electron/endpoints.js` mirrors the same list for the main process, and `electron/check-endpoints.mjs` fails the
desktop build if the two ever drift apart in either direction. `tests/data/csp.test.ts` fails if a new third-party
host appears in `src/data` without being added to the policy.

### 10.2 The desktop build (`electron/`)

`npm run app:build` typechecks, builds the same static `dist/`, and packages it into `release/Deluge.app`: one
`BrowserWindow`, no preload, no IPC, no Node in the renderer (`sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`), no listening TCP port, and no `file://` — the build is served from a privileged
`app://deluge/` scheme registered as `standard` + `secure`, which is what makes relative URLs, module workers,
`fetch('./presets/…')` and `isSecureContext` (a WebGPU requirement) all work. Every response, 404s included, carries
the CSP plus `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy` and
`Permissions-Policy`. The path served is resolved, dot-segment- and null-byte-checked, extension-allowlisted and
confined to the asar root. Navigation off the origin, new windows, webviews and downloads are refused; the only
external link the app will hand to the OS browser is the repository. Network requests are checked against the same
endpoint list independently of CSP, which also covers the workers, and every certificate error is fatal. Every
permission request is denied — including Screen Wake Lock, because the main process holds a `powerSaveBlocker`
instead, which is stronger and needs no page to be visible. macOS fuses turn off `ELECTRON_RUN_AS_NODE`,
`NODE_OPTIONS`, `--inspect` and `file://` extra privileges, require asar integrity and refuse to load an app from
anywhere but the asar; a packaged build also refuses to start if its command line asks it to disarm any of this
(`--ignore-certificate-errors`, `--disable-web-security`, `--remote-debugging-port`, …). Nothing a page writes
survives a relaunch: the session's localStorage, IndexedDB, service workers, cache storage and — the one that
actually matters, because a renderer can write real files there — the **Origin Private File System** are cleared
before the window opens. Cookies are pointedly *not* on that list: the app sets none, and asking Electron to clear
them opens the cookie store, which under the `EnableCookieEncryption` fuse creates a login-keychain item that an
ad-hoc-signed rebuild no longer matches — so the next launch asks the presenter for their password. Measured both
ways; `electron/main.js` records the evidence at the call. A renderer crash reloads with a back-off (three times inside a minute); the next
crash shows a static recovery page with a Restart button, rather than leaving a blank window with no message.

`npm run app:check` is the gate: 43 checks, the last 20 of them against the packaged, fused bundle. Because such a
bundle deliberately cannot be automated from outside, it reports on itself through a hook that `package.mjs` stages
only into the differently-named verification build.

### 10.3 The three regression suites

Beyond `npm test` and `npm run e2e`, three suites in `scripts/` each build their own production bundle, serve it on
their own port and drive it in headless Chromium on the real GPU:

| Suite | Asserts |
| --- | --- |
| `npm run test:perf` | fps, frame-time p50/p95/p99, achieved sim speed, CPU ms/frame, GPU queue latency, input latency, time-to-interactive and drift over a 60 s sustain run, across six scenarios and two viewports. Floors are always fatal; targets are advisory when the machine is noisy or in Low Power Mode (which moves the numbers by ~6×), and the power state is recorded with every run. |
| `npm run test:visual` | Fifteen exactly-frozen scenes at 1470×956 @ DPR 2, compared with committed golden images in `tests/visual/baselines/` **and** checked by baseline-free detectors: blank frames, NaN magenta, water unsupported above terrain, shoreline stair-stepping, z-fighting flicker, missing imagery, UI off the canvas, legend-vs-pixel colour agreement. |
| `npm run test:security` | The penetration test's cases against the *released* bundle (no debug API): link-parameter spoofing, XSS through hostile upstream bodies, the CSP and its violations, response byte caps, `dist/` hygiene, `npm audit`. |

## 11. Future work

* A second-order Kurganov–Petrova central-upwind solver (full shallow-water equations) as a selectable mode for
  dam-break and supercritical scenarios.
* Measured channel bathymetry instead of a nominal burned depth, and culverts/storm drains.
* Coverage beyond 3DEP (the Terrarium fallback works worldwide but is coarse).

References: Bates, Horritt & Fewtrell (2010), *J. Hydrology* 387; de Almeida, Bates, Freer & Souvignet (2012), *Water
Resources Research* 48; Ritter (1892) dam-break solution.

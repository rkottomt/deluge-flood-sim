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
   │                that refresh its water textures) or a stats readback needs it; also folds into the per-cell
   │                hazard accumulators (max speed, max depth × speed, arrival time, wet seconds; §3.7)
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
| `src/dams/` | Dam-breach use case: the baked NID index and its strict decoder (`nidIndex.ts`), eight published breach relations and the low / central / high band (`breachRelations.ts`), the 21 historical failures they are scored on (`historicalFailures.ts`, Wahl 1998), the breach hydrograph (`breachModel.ts`), where the wave enters the map (`placement.ts`, `scenario.ts`). |
| `src/surge/` | Coastal-surge use case: the baked NOAA CO-OPS extreme-water-level table (`stations.ts`) and the seaward-edge boundary with its ladder and gauge line (`coastal.ts`). |
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
∂h/∂t + ∂qx/∂x + ∂qy/∂y = R − I − D + S
∂qx/∂t + ∂(qx·u)/∂x + ∂(qx·v)/∂y = −g·h·∂η/∂x − g·n²·qx·|q| / h^{7/3}          (and the same for qy)
```

`h` depth, `q = (qx, qy)` unit discharge (m²/s), `η = z + h` water surface, `z` bed (ground + walls), `n` Manning
roughness (uniform, or per cell from land cover, §3.11), `R` rain and storms, `I` infiltration, `D` storm drains
(§3.11, off by default), `S` inflow sources. `z` includes building footprints when they are obstacles (§3.11).

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
* **Safety caps (robust mode).** `|q| ≤ hf · min(uMax, 8·√(g·hf))`, `uMax` = 15 m/s unless the scenario sets its own
  (`setRheology(…, { uMax })`, §3.9; the debris presets use 25 m/s). The Froude cap is 8, not ~2: a dam-break tip is
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

Every external change (rain, sources, stages, infiltration, storm drains, open-boundary outflow, brush edits, in-place
stage raises, Float32 limiter residue) is added to a per-cell in/out accounting buffer as exactly what it did to `h`. That cannot be
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

**Hazard accumulators.** What loss and impact models need beyond the current depth — per cell, the maximum speed while
wet, the maximum depth × speed, the time the water first stood deeper than 0.15 m (`ARRIVAL_DEPTH`) and the total time
it stayed that deep (`HazardFields` in `src/contracts.ts`) — is gathered by the export pass into one `vec4f` per cell
of a storage buffer, updated in place (`shaders/exportState.ts`; Float64 mirror in `src/sim/hazard.ts`). Not per
substep: that would add a 16-byte read, and on wet cells a write, to each of up to 256 substeps a frame (~20 % of a
substep at 1024², by the accounting buffer's measured cost). The export already loads the previous export's depth, so
the time a cell crosses 0.15 m is interpolated linearly between the two exports instead of stamped at the later one:
arrival times land within one export interval of the per-substep answer and ~¼ of one on average (a dam-break front,
`tests/sim/hazard.test.ts`, where every export is also replayed on the CPU and the front checked against Ritter). A
cell that wets and dries again between two exports is missed, and the maxima are sampled at exports, as max depth
always was. Cells dry now and at the last export with no flow skip the buffer entirely, so the export went from 0.21 to
0.23 ms at 1024² on a river valley (0.30 ms with every cell wet; Dawn on D3D12), and nothing changes per substep.
Exports otherwise follow the wall clock (a rendered frame, a readback), which under a headless sweep's render hold at
3600× left 60–120 simulated seconds between samples: a flood front crossing a building was recorded at whatever
moment happened to be sampled. So once `hazardSampleSeconds` (5 s) of simulated time have passed since the latest
export (of any kind — counted across frames, so a throttled run of many short frames is sampled as densely as one
long frame), a `step()` frame splits its substeps into compute passes and exports between them, in the same command buffer — each sample's export time comes
from a small uniform block copied over the Sim uniform before its export pass (`copyBufferToBuffer`), and the GPU
timing spans all the passes. Interactive play up to ~150× never advances 5 s in a frame; at high speed-ups it is one
export per ~10 substeps, a few %. `tests/sim/exactStop.test.ts` checks the in-frame samples equal hand-made exports
at the same substeps, bit for bit.
`readHazardFields()` copies the buffer and the exported state to its own staging buffers on demand (~32 B/cell),
independently of the stats readbacks; `hazardBuffer` hands it to the renderer (§6).

### 3.8 The naive reference mode, and surviving it

`SimParams.stabilityMode = 'naive'` is the textbook scheme with the four ingredients above taken out: explicit
friction, no flux limiter, no velocity cap, no θ-smoothing and no CFL margins, with `dt` computed from the requested
Courant number even above 1. It is an internal reference with no UI. Its only job is to make the safeguards
falsifiable: `tests/sim/robustness.test.ts` runs the same rough-terrain case in both modes and requires that naive
blows up (non-finite depths or speeds past 100 m/s) where robust stays finite and positive, and
`tests/sim/wellbalanced.test.ts` and `reference.test.ts` pin down which ingredient each result depends on.

Because the solver can produce NaN/±Inf in that mode, everything downstream is written to survive it, which is also
what protects the app from any future numerical accident: the solver keeps running without WebGPU validation errors
and `reset()` rewrites every state texture back to the initial condition (`tests/sim/robustness.test.ts`); the prep
pass substitutes a bounded spike for a blown-up cell so nothing non-finite reaches the geometry and flags it for the
magenta sentinel the water shader paints (`tests/render/prep.test.ts`); the HUD presents non-physical statistics as
"Diverged" instead of a plausible flood (`src/ui/stats.ts`); and routing, the protected-land analysis and the wall
check all freeze on the last physical readback rather than reading NaN depths as dry ground (`src/app/evac.ts`,
`protection.ts`, `tests/app/logic.test.ts`).

---

### 3.9 Debris-flow rheology and the per-scenario speed cap

`FloodSolver.setRheology(rheology, { uMax })` (`src/contracts.ts`, `src/hazard/types.ts` `Rheology`) swaps Manning for a
debris-flow friction law in the momentum pass, uniform over the map (no sediment tracer yet). The app calls it when a
preset loads (`applyScenarioRheology` in `src/app/scene.ts`): a preset with a `hazardChain` gets its rheology and speed
cap, everything else water at 15 m/s. The coefficients come from one function shared by the GPU solver and the CPU
reference (`src/sim/rheology.ts`); the research behind the laws is `docs/research/glacier-hazard-chain.md` §D.

Every law is a resistance per unit width on the face discharge, split by how it can be integrated stably:

```
∂q/∂t = … − g·hf·∂η/∂x − [ τ_y/ρ + μ·g·hf·cosθ ]·q/|q| − [ ν/hf² + (g·n_td²/hf^{7/3} + (g/ξ)/hf²)·|q| ]·q
                          rate-independent                   rate-dependent

Voellmy          μ, g/ξ                                   (S_f = μ·cosθ + u²/(ξ·h))
O'Brien–Julien   τ_y = 0.1·α₂·e^{β₂·Cv} Pa, η = 0.1·α₁·e^{β₁·Cv} Pa·s, ρ_m = 1000 + 1650·Cv,
                 ν = K·η/(8·ρ_m) (K = 2285 unless given), n_td = n·(1 + 0.0538·e^{6.09·Cv})/1.0538
Bingham          τ_y/ρ, ν = 3·μ_B/ρ                        (laminar sheet flow)
```

Per face, in robust mode (`rheoMomentum` in `shaders/momentum.ts`, `dt` the face's guarded timestep):

```
q*    = q̃ − dt·A − g·hf·dt·∂η/∂x                          explicit predictor, no resistance
τ     = dt·( τ_y/ρ + μ·g·hf·cosθ )                         cosθ = 1/√(1 + (Δz/dx)²), the face's bed slope
q'    = 0                     if √(q*² + q⊥²) ≤ τ           stop …
      = q*·(1 − τ/√(q*² + q⊥²))   otherwise                 … or reduce along the flow vector (q⊥ as Manning uses)
q_new = q' / ( 1 + dt·( ν/max(hf, 0.05 m)² + (g·n_td²/hf^{7/3} + (g/ξ)/hf²)·|q| ) )
```

then the usual cap. The rate-dependent terms sit in the semi-implicit denominator like Manning (≥ 1, stable for any
`dt`). The yield and Coulomb terms are the plastic projection ("stop-or-reduce"): an explicit `sgn(q)` term chatters
around zero, while the projection brings a face to exact rest, can never reverse the flow, and lets a deposit stand
wherever `g·hf·|∂η/∂x| ≤ τ_y/ρ + μ·g·hf·cosθ`. The driving slope is the face's surface slope, as for water, so a deposit
at rest is still well-balanced. The viscous term's depth is floored at 5 cm: the solver's wetting fronts are films a
millimetre thick, and a 1/h² law would freeze every one of them. Yield and Coulomb terms apply at every depth.
Bingham uses τ_y, not the 1.5·τ_y of the flowing sheet-flow approximation, so that material starts and stops at the
true yield criterion; a flowing layer therefore meets up to 0.5·τ_y less resistance than that approximation gives
(longer runout, the cautious direction for a hazard map). Naive mode ignores the rheology.

`rheoKind = 0` (water) skips all of it with one uniform branch: the water results are bit-identical to the solver
before this change (SHA-256 of the full state after 600 substeps of a rough-terrain run with rain and an inflow, open
and walled, unchanged), and `setRheology({ kind: 'water' })` after a debris law restores them exactly.

`uMax` (default 15 m/s, clamped to 1–100) is the cap of the momentum pass, the open-boundary outflow, the exported
speed and every speed the CFL estimate anticipates from sources (`forcingSpeedEstimate`, released stages and raises).

**Tests** (`tests/sim/rheology.test.ts`, GTX 1660 Ti / D3D12):

| Check | Result |
| --- | --- |
| GPU vs Float64 CPU reference, 5 laws (two Voellmy, two O'Brien–Julien, Bingham), 300 free-running steps of a dam break on rough terrain with rain and an inflow | max \|Δh\| 1.2·10⁻⁵ – 8.8·10⁻⁴ m; per step from the GPU state ~1·10⁻⁶ m |
| (a) Voellmy μ = 0, ξ = h_n^{1/3}/n², 0° walled channel, normal depth 2.843 m | 2.788 m vs Manning's 2.799 m on the same grid (0.996); 0.981 of the analytic normal depth |
| (b) Bingham slab, 1 m on a 0.1 slope, ρ·g·h·S = 0.8·τ_y | interior exactly at rest (q = 0), depth unchanged after 60 s |
| (b) same slab, ρ·g·h·S = 1.25·τ_y, μ_B 200 Pa·s | interior 0.652 m/s vs the sheet law's 0.654 m/s |
| (c) Bingham dam break (2 m × 40 m, τ_y 200 Pa), creeping (μ_B 200 Pa·s) | at rest (< 1 mm/s) after ~470 s; front 90 m vs the analytic plug's 89.1 m, depth at the wall 1.341 m vs 1.347 m, surface slope / (τ_y/(ρ·g·h)) 1.001 on average (max 1.009) |
| (c) same, inertial (μ_B 20 Pa·s) | exactly at rest after 54 s, slope ratio 0.43 on average and ≤ 0.89 everywhere: the slump overshoots the static plug, as inertia must |
| (d) extreme parameters (ξ → 0, μ 10, τ_y and μ_B 10¹², NaN, negative, unknown kind, frictionless at uMax 100) | finite, h ≥ 0, massError < 10⁻⁴ |
| (e) mass, every law, closed and open (rain, inflow) | closed: \|ΔV\|/V₀ < 10⁻⁴, nothing out; open: massError < 10⁻⁵ |
| (f) steep (0.25) dam break, n = 0.01 | peak speed 15.00 m/s at the default cap, 25.00 m/s with uMax 25, 21.6 m/s as a Voellmy debris flood with uMax 25 |

The analytic plug (c) is the quasi-static limit: `h·dh/dx = −τ_y/(ρ·g)`, so `h² = 2·τ_y/(ρ·g)·(x_f − x)` against a wall,
`x_f` from the volume. The tolerances (2 % on slope and wall depth, 3 % on the front) cover one cell of front position
and the face-depth convention (`hf` = the deeper side on a flat bed).

**Cost** (momentum pass alone, 1024², Dawn on D3D12, GTX 1660 Ti; median of 7 × 2000 dispatches):

| | river valley (mostly dry) | every cell wet |
| --- | --- | --- |
| before (water) | 0.129 ms | 0.168 ms |
| water | 0.129 ms | 0.169 ms |
| Voellmy | 0.129 ms | 0.172 ms (+2 %) |
| O'Brien–Julien | 0.129 ms | 0.175 ms (+4 %) |
| Bingham | 0.129 ms | 0.171 ms (+2 %) |

Water costs the same as before (the whole substep, `tests/sim/bench.ts 1024`: 2,374–2,411 substeps/s before, 2,361–2,367
after, within run-to-run noise). A debris law adds 2–4 % to the momentum pass on wet cells — under 2 % of a substep —
and nothing on dry ones; `node --import tsx tests/sim/bench.ts 1024 voellmy` (or `quadratic`, `bingham`) measures it.

**Caveat for the debris presets.** A Coulomb μ stops flow wherever the surface slope is below μ·cosθ. The Nepal and
Chungthang chains specify Voellmy μ 0.05, ξ 500 (research spec §I.3, "debris flood"): on the Trishuli valley floor,
which falls ~2 % across the map, that stalls the 11,100 m³/s surge about 2 km below the north edge (front row ~250 of
1024 after 25 simulated minutes; water reaches the south edge in ~20). Chungthang's slower hydrograph gets through,
but half as fast: front row 529 of 1024 after 4,700 s, where water reaches the south edge by ~4,400 s. Both measured
headless with the presets' own terrain and sources (n = 0.035). The spec's own §D.1 notes that for debris floods
(Cv 0.1–0.35) yield and Coulomb terms are minor and the dispersive roughness dominates; Voellmy μ = 0 with ξ 500, or
O'Brien–Julien Glenwood 1 at Cv 0.3, carry the surge down the valley at water-like speed (front rows 401 and 436 at
450 s, against 456 for water).

The Chamoli preset is the debris-FLOW case and specifies O'Brien–Julien Glenwood 1 at Cv 0.45 (τ_y ≈ 29 Pa,
η ≈ 8.9 Pa·s, K 2,285). Measured headless on its own terrain with the chain-routed inflow
(`artifacts/chamoli-build/tools/physics.mjs`): the front reaches the Tapovan barrage, 10 km of river into the map,
1,080 s after the solver starts, against 900 s for water and 960 s for Glenwood 1 at Cv 0.3 — 20 % slower than water,
and it runs on out of the map. Voellmy μ 0.05 stops ~1.3 km below Raini (μ exceeds the Dhauliganga's 2.3 % bed slope),
and the stiff end of the O'Brien–Julien table (Aspen Pit 1, τ_y ≈ 1.9 kPa, η ≈ 75 Pa·s at Cv 0.45) never reaches the
barrage: after 25 minutes its fastest cell moves at 2.6 m/s, 600 m short of it. The same runs found that the radar DSM's false sills in the Rishiganga slot gorge pond even clear water 48 m deep; the bake's gorge floor
(`RiverDef.carve`, public/presets/SOURCES.txt) is what lets any rheology through.

**Arrival times of the 1-D chain.** The surge that enters these maps is routed down 32–73 km of valley by the chain's
1-D local-inertial router (`src/hazard/routing.ts`), and its timing is checked against the events' published times in
`tests/hazard/calibration.test.ts` (research spec §G.9). Nepal is the outlier: the front reaches Betrawati 65 min
after the avalanche against ≤ 43 min reported. A fourth pass asked whether the router's celerity or channel widths
cause it, using a check that depends on neither — Rickenmann's (1999) empirical debris-flow mean velocity
V = 2.1·Q^0.33·S^0.33 (`debrisFlowVelocity` in `src/hazard/mass.ts`). Below Rasuwagadhi the routed front moves at
0.96–0.98 of it for the discharge the router carries (14.8 m/s over 45 km against 15.5), and the test pins that within
±15 %. A local-inertial front into a low baseflow is a shock whose speed continuity fixes, (Q₂ − Q₁)/(A₂ − A₁) ≈ 1.1×
the flow behind it, so neither the full dynamic wave (the advection term vanishes in the near-uniform flow behind the
front) nor a kinematic celerity of 5/3·u for the peak can move the front materially faster; narrower sections would
push the speed above an empirical relation that is width-free. The reported time would need ~40,000 m³/s held over
the whole 45 km, 1.6× the ensemble's p90 peak. The routing was left unchanged; the residual is attributed to the
source (the avalanche mass itself running far down the Bhote Koshi, which no back-analysis yet supports) or to the
observations (gauge-loss times, not sightings). Chamoli and Chungthang were not touched.

### 3.10 Ensembles: flood probability under stated input uncertainty

A single run answers "does this street flood?". A lender, insurer or developer asks "in how many plausible versions of
this event does it flood?". At 100–500× real time on a mid-range GPU, a dozen members of a 30-minute scenario take
about a minute, in the tab, so Deluge runs the ensemble rather than selling one precomputed map.

**What is perturbed** (`src/loss/ensemble.ts`; every default is editable in the Uncertainty section and stated in
`PERTURBATION_NOTES`, which the panel shows):

| Input | Default band | Where it comes from |
| --- | --- | --- |
| Inflow (discharge and hydrograph of every inflow) | × (1 ± 20 %) | assumption inside the ±10–25 % usually quoted for peak discharges from rating extrapolation or indirect measurement |
| Glacier-chain inflow (Nepal, Chungthang) | one chain member per 2-D member | the routed hydrograph's excess over baseflow scaled by the member's entry peak / the deterministic one, shifted by its front-time difference (`shiftScaleHydrograph`); the band's p10/p50/p90 (comonotonic) when members are missing |
| Rain (global rate and storm cells) | × (1 ± 25 %) | assumption: radar–gauge rainfall at hour / block scale |
| River stage target | ± 0.3 m, clamped to the slider | assumption: about a one-day stage-forecast miss on a large river |
| Manning n | 0.025–0.05, log-uniform | Chow (1959) ranges for grass, pavement, light brush; replaces the scenario's single n (inert under a debris-flow rheology) |
| Terrain | smooth random bed error, σ 0.2 m (3DEP), 2.5 m (Copernicus), 3 m (Terrarium), correlation length 200 m | 3DEP lidar RMSEz ≤ 0.1 m in the open, more under canopy and after resampling; Copernicus measured against lidar in `public/presets/SOURCES.txt`; the correlation length is an assumption |

**Sampling.** A Latin hypercube over (inflow, rain, stage, Manning) from the user's seed: in every dimension each
member falls in its own 1/N stratum (a seeded permutation, jittered within the stratum), so even 12 members span every
band and the same seed reproduces the same members (`tests/loss/ensemble.test.ts`). Each member also gets its own seed
for the terrain field. Members are equally weighted.

**The terrain perturbation** (`src/sim/demNoise.ts`, `GpuFloodSolver.setBedPerturbation`) is white Gaussian noise
smoothed by three separable box passes (≈ a Gaussian kernel at the correlation length), rescaled to exactly σ, then
masked: zero on water present at the start and fading in over 4 cells away from it, and a bank that stood above the
nearby water is never lowered below that water's surface. Without the mask every river would start sloshing — the
initial water is a lake at rest on the unperturbed bed — and a bank nudged under the river's level would spill it at
t = 0. With it the initial water stays at rest (max speed < 1 mm/s after 800 steps on a bowl lake with σ 0.3 m on its
banks) and the mass ledger is untouched: the initial volume is the initial depth, which a bed change does not move.
`setBedPerturbation` adds δ to the ground (subtracting the previous δ first, so the user's own dig/raise edits
survive), re-uploads bed and ground, invalidates the cached reset state and re-packs the forcing; walls stay a
separate barrier layer on top of whatever ground there is; `reset({ resetTerrain })` drops it, and the runner removes
it before putting the user's scenario back. Known bias: the bank clamp lifts some low bank cells, so near the initial
water the field is slightly positive on average; elsewhere it is unbiased, so a DEM's *systematic* error (Copernicus
reads valley floors 2–4 m high) is not represented.

**Running.** `src/ui/headless.ts` is the runner Site check's sweep and the ensemble share: pause, render hold (the 3-D
view drops to a heartbeat so the GPU goes to the solver), per case apply the forcing, reset the water, `runFor` the
duration in 300-s chunks (Cancel answers within one), collect, and finally put back forcing, stage, Manning n, the
water and the play state. Every case runs exactly its duration: with the user's flood paused, the frame driver caps
each frame at the runner's remaining time (`FloodSolver.step(realSeconds, maxSimSeconds)`, which lands on the cap with
one short final substep and carries nothing past it), stops stepping at the target and asks for a readback of that
moment (`requestReadback`). Before, a run kept stepping until a readback caught up — 600 s asked ended at 614–706 s —
and a today-vs-2050 comparison moved by as much from run length as from climate. While the river stage still ramps,
frames also end on a 5-s grid of simulated time (`RAMP_FRAME_S`): the app moves the stage once per frame, and a
minute-long frame at 3600× raised the river 3 m at once. With readbacks only where the runs force them, two identical
runs are bit-identical (`tests/sim/exactStop.test.ts`); at the app's 300-ms readback cadence the CFL timestep follows
whichever readback has arrived, and repeats differ by millimetres of depth. Per member (`src/ui/ensemble.ts`):

* **Map: a GPU accumulate pass, no readback.** `src/sim/ensemble.ts` folds the exported max depth (`stateTexture.a`)
  into a storage buffer of one vec4f per cell — members over 0.15 m, members over 0.5 m, Σ max depth, the largest
  max depth any member reached — one compute pass over the grid per member (not separately timed; it is lighter than
  the export pass). The alternative, reading every member's field back and
  re-uploading the tally, costs a full-grid map per member and holds N × 4 MB on the CPU for a map that lives on the
  GPU anyway. The app owns the buffer (`src/app/ensembleMap.ts`) and hands it to the renderer after every member, so
  the map fills in while the ensemble runs. Non-finite depths are detected from the bit pattern, never by comparison.
* **Loss and assets: one `readHazardFields()`** (~32 B/cell; 40–390 ms per member at 1024² on the GTX 1660 Ti,
  including the GPU work still queued) feeds `analyze()` — the same loss model as the Impact panel, 40–190 ms — the
  flooded area (land dry at the start whose max depth exceeded 0.15 / 0.5 m), every Site check site (`assessSiteRun`
  without egress routing) and every portfolio asset. Only the per-member summaries and per-asset depths are kept, not
  the fields. The terrain field costs ~330 ms of CPU per member (1024²), the run itself the rest.

**Results.** p10 / p50 / p90 across members (R type 7, the chain ensemble's `quantile`) of flooded area at both
thresholds, buildings reached and loss, plus the loss band widened by the damage curves' ±1σ (p10 of the members' low
ends to p90 of their high ends); per asset "floods (≥ 15 cm) in k of N members" with the p10/p50/p90 depth, also
shown on the Site check card (flagged if the site was edited since). **Probability view** (`WaterViewMode`
'probability'): the prep pass's field 3 reads the tally, colours the share of members over the chosen threshold
(`PROBABILITY_BANDS`, < 10 / 10–30 / 30–50 / 50–70 / 70–90 / > 90 %; pale green → indigo, the only
lightness-sequential run left ≥ 45 sRGB units from every other mode's swatches, outside the NaN-magenta detector and
inside the tone mapper's gamut — `tests/render/picking.test.ts`, `tonemap.test.ts`) and draws it on the envelope — the
deepest water any member reached — rather than the user's own run, which the runner has reset by then. Normal water
stays muted as in the other hazard views; with no ensemble nothing is coloured and the View section hides the button.

**Measured** (GTX 1660 Ti, Chromium/Dawn D3D12, 12 members × 30 simulated minutes, render hold): Pittsburgh at the
1936 crest 48 s (15 members/min; flooded area p10/p50/p90 6.47 / 6.53 / 6.56 km², loss $10.1 / 11.7 / 13.6 B);
Houston under Harvey's hour 58 s (12.4 members/min; 10.0 / 12.4 / 14.2 km², $2.1 / 2.6 / 2.9 B). A cold first run
measured 8.4 and 9.7 members/min (6 members). The crest's spread is narrow because the stage boundaries pin the
river; Houston's rain-driven flood spreads more.

**What it is not.** The members are one model with nudged inputs. The share is the *sensitivity of the map to the
stated bands*, not a calibrated probability of the real event: the bands are screening assumptions, there is no
weighting by likelihood, inputs are sampled independently (except the chain's peak and front), and the structural
error — bare-earth terrain, no drains, nominal bathymetry, the scheme — is identical in every member, so the real
uncertainty is wider than the spread. The panel says so next to every result (`ENSEMBLE_CAVEAT`).

Tests: sampling and aggregation (`tests/loss/ensemble.test.ts`), the GPU tally against its CPU mirror with identical
members (probability exactly 0 or 1 everywhere) and a known perturbation on a synthetic valley (intermediate
probabilities at the flood's edges), and the bed perturbation's lake-at-rest / restore behaviour
(`tests/sim/ensemble.test.ts`), the prep pass's field 3 (`tests/render/prep.test.ts`), and e2e flow 17 (a 3-member
ensemble on Pittsburgh: completes, scenario restored, legend and site card, legend-vs-pixels agreement).

### 3.11 Land surface: buildings as obstacles, a roughness map, storm drains

Bare earth leaves out three things a city has: buildings the water has to go round, ground of different roughness,
and storm sewers. `FloodSolver.setLandSurface({ obstacles, roughness, drainCapacity, porosity })` (`src/contracts.ts`
`LandSurface`) adds each as an optional layer built from the scene's own data (`src/app/landSurface.ts`), switched in
Advanced → *Land surface* (`SimParams.buildingObstacles` / `roughnessMap` / `drainage`, `drainageScale`). **All three
are off by default** — see *Defaults* below for why. Off, null or neutral (zero obstacles, zero drains, a uniform map
at the default n, porosity 1 with no roofs), a layer is the old solver bit for bit: the same 600-substep rough-terrain
runs (rain, inflow, stage disc, infiltration; open, walled and naive mode) hash to the same SHA-256 as `v2` before the
change, and `tests/sim/landSurface.test.ts` and `tests/sim/porosity.test.ts` check the identity within a build.

**Buildings: blocks where they fill a cell, integral porosity where they do not.** Schubert & Sanders (2012, *Adv.
Water Resour.* 41, "Building treatments for urban flood inundation models and implications for predictive skill and
modeling efficiency") compared four treatments: *building resistance* (a high Manning n inside footprints), *building
block* (footprints raised into the bed), *building hole* (footprints cut out of the mesh as walls) and *integral
porosity* (Sanders, Schubert & Gallegos 2008, *J. Hydrology* 362, sub-grid storage and conveyance porosities).
Resistance was the least accurate — water still flows through the blocks, just slowly — while block and hole were the
most accurate wherever the mesh resolves the gaps between buildings, and porosity is the efficient choice on meshes
too coarse for that. A 7.8 m grid is both: a warehouse fills dozens of cells, while many houses are 1–3 cells and the
side yards between them are narrower than one. Deluge therefore uses the block for full cells and porosity for the
rest (`src/data/porosity.ts`):

* the footprints are scan-converted on an 8 × 8 sub-grid per cell (0.98 m sub-cells on the US presets). A cell 90 % or
  more under roofs (`PHI_BLOCK`) is a **block**; every other covered cell is **porous**, with a storage porosity φ (its
  open share) and, on each face, a conveyance porosity ψ (the share of the face where the sub-cells on both sides are
  open);
* *blocks* are the old treatment: the roof height above the ground (at least 3 m), part of the state bed
  `z = ground + barrier + obstacle` and nowhere else (`bedTexture` and the CPU mirrors are unchanged; the renderer draws
  the buildings), one flat roof per group of touching blocks (`obstacleHeights`: stepped roofs were bowls that filled
  with the runoff of the taller ones, 0.86 m deep in Harvey's hour), nothing new per substep — the face depth
  `hf = max(η) − max(z)` already treats a cell 10–300 m higher as a wall — and switching them on mid-flood rebuilds the
  state bed in place (`shaders/brush.ts` kind 4) with `h` kept, so water standing in a footprint is lifted onto the
  roof and spills off;
* *porosity* (the `POROSITY` pipeline variant of the momentum, continuity and export passes; `porosityTex`
  rgba32float = φ, ψ east, ψ south, roof share). The state's `h` then holds **V, the water volume per unit cell area**,
  and the stored discharges are per unit **cell** width. Continuity, the positivity limiter and the exact Float32 ledger
  of §3.5 therefore run on volumes exactly as before, and the stats pass sums V from the state texture. The momentum
  pass reads every texel through `openState()` — depth V/φ (the depth of the water in the open part) and discharge
  q/ψ per unit open width — solves the same local-inertial equation there (surface slope, friction, smoothing,
  advection, Courant guard) and stores ψ·q. The export pass writes V/φ and the open-part velocity, so the renderer, the
  hazard maxima and the loss model all see the depth of the water in the streets. Simplified against Sanders et al.:
  the porosities do not change with depth, there is no drag term for building faces, and every face's ψ is capped at
  the smaller φ of its two cells — the single-porosity bound (Guinot & Soares-Frazão 2006, *Int. J. Numer. Meth.
  Fluids* 50) that keeps the gravity-wave speed √(g·h·ψ/φ) within the plain grid's CFL limit, and that also takes the
  edge of the mesh-dependence out of face porosities (a wall exactly on a grid line);
* never porous or blocked: cells with any initial water (a footprint mapped over a river or a dock must not dam it, and
  the initial depth is a true depth); never porous: the 3 cells along each domain edge (`POROSITY_EDGE_BAND`), which the
  open-boundary rule reads raw. A level set by a stage disc fills the open share φ of a cell;
* switched on or off mid-flood, the volume is kept and the depth becomes V/φ (or V) at once; neutral porosity (φ = ψ = 1,
  no roofs) is the plain solver bit for bit, with and without drains (`tests/sim/porosity.test.ts`).

The difference is what the old block alone could not do: in a channel past a row of 21 m houses with 2.3 m side yards,
the cell-centre block (every cell centre under a roof) dams the channel (0 of 40 m³/s past it after two hours, 2.9 m
deep upstream), the porous yards carry all of it with 0.86 m upstream. Over the shipped cities about a quarter of the
covered cells are blocks and three quarters porous (Pittsburgh 67,800 / 207,000, Houston 111,000 / 295,000; mean φ of
the porous cells 0.57–0.65). Building the layers takes 0.1–0.3 s per scene on the CPU (Houston's 49,000 footprints),
the sub-grid scan shared with the scene's status line.

**Roof rain: the downspouts.** Rain on a roof does not fall on the street beside the wall: gutters and downspouts take
it to the storm sewer or onto the ground at the foot of the building. The roof share of each cell (`roof`: 1 on a
block, 1 − φ on a porous cell) does not take its rain; instead:

* with *storm drains* on, it is piped into that cell's drain capacity first — never entering the surface water, so
  never booked — and only what the sewer cannot take spills (onto a block's roof, whose film runs off its edge as
  before, or into a porous cell's open part); the capacity left drains standing water as before;
* with *no drains*, it is discharged at the foot of the building as sheet flow: a porous cell's roof into its own open
  part, a block's into the nearest open cell (a multi-source breadth-first search outwards from the open cells round
  each building, the lowest where several touch), so a large roof sheds all round as its downspouts would. The routing
  is a per-cell factor (`spout`, the roof area in cells discharging onto it) computed once on the CPU, so the continuity
  pass gathers instead of scattering and stays exact: with no drains every drop that falls is in the domain (to 1.5·10⁻⁵),
  with drains the roof rain up to capacity never enters (`tests/sim/porosity.test.ts`).

Only rain and storm cells are split; an inflow source's discharge is not rain. Infiltration acts on the open ground
(× (1 − roof)).

**Loss with buildings resolved.** A porous cell holds the water of its open part, and the loss model reads its depth
as it reads bare earth. No water stands in a block, so for a footprint with blocked cells `src/loss` reads the cells
against its walls instead (`openCells` in `src/loss/footprints.ts`: the open cells sharing an edge with the footprint, searching up to
three cells out through touching buildings, so a terrace house reads its front and back). A wall cell lower than the
footprint's lowest ground — a gutter, a street below a building pad — counts only the water above that ground
(`sampleCells`; `HazardFields.blocked` and `.ground` carry what it needs). Read this way, the bare-earth fields give
the footprint-sampled losses back to within 6 % (Pittsburgh crest $13.1 B vs $12.7 B, Houston $2.31 B vs $2.45 B), so
the change of sampling rule does not itself move the numbers. Site check reads the same cells.

**Roughness map.** Each cell has a Manning n from land cover (`src/data/landcover.ts`): NLCD 2021 in the US, ESA
WorldCover 2021 elsewhere, values inside the ranges of the HEC-RAS 2D User's Manual table for the NLCD classes (forest
0.10–0.12, shrub 0.08, grass and crops 0.035, wetlands 0.06–0.08, barren 0.027). Developed land has two values:
with buildings unresolved it carries their resistance (0.04 / 0.08 / 0.10 / 0.13 for open space / low / medium / high
intensity, the HEC-RAS intent), with buildings as obstacles it is the open ground between them (0.035 lawns down to
0.02 for pavement with curbs and cars; Chow 1959). Open water — and every cell wet in the initial water, since NLCD's
30 m pixels class a narrow creek as the forest along it — keeps 0.035, the uniform value every preset was set up with,
so river conveyance is unchanged. The momentum pass reads the factor `r = n/0.035` of both cells of a face and uses
`n_f = manningN·(r_L + r_R)/2` (`faceN2` in `shaders/momentum.ts`), so the global slider scales the whole map and
`n² = sim.n2·r_f²` is exactly the uniform value when `r = 1`. Open-boundary normal flow keeps the global n, and a
debris rheology (§3.9) keeps its own uniform coefficients. The ensemble's Manning band (§3.10) becomes a multiplier on
the map (×0.71–1.43).

**Storm drains.** US storm sewers are designed for the 2- to 10-year storm (FHWA HEC-22 *Urban Drainage Design
Manual*, 3rd ed. 2009; ASCE/WEF MOP 77). Each developed cell removes up to `C × i₂` mm/hr of standing water: `i₂` the
2-year 60-minute rainfall intensity at the preset (NOAA Atlas 14 PFDS, fetched at bake time: Pittsburgh 30, Johnstown
31, Asheville 35, Ellicott City 36, Nashville 40, Houston 57, Boulder 20, Fort Myers 60 mm/hr), `C` the Rational-method
runoff coefficient of the class (0.2 / 0.45 / 0.65 / 0.85 for open space / low / medium / high intensity) — the inflow
the pipes under that land were sized for. The continuity pass applies it after infiltration with the same rule:
`snapInc(h, min(cap·dt, h))`, booked in the outflow slot of the ledger, so it never takes more than is there and the
mass balance stays exact (`landSurface.test.ts`: the drained volume matches capacity × time to 0.14 %, the Float32
grid of a 1 m depth; massError 7·10⁻¹⁵). `drainageScale` (0–3) scales it for clogged or oversized systems. It is a
distributed sink, not a pipe network: no inlet locations, no pipe limits downstream, and it keeps draining when a
flooded river would back the outfalls up. Non-US presets have no drains (no design data).

**Live areas.** In the lower 48 a live area fetches its NLCD 2021 subset from the MRLC GeoServer WCS, which answers
with `Access-Control-Allow-Origin: *` (`src/data/landcoverLive.ts`): one exact endpoint on the CSP and Electron
allow-lists, an uncompressed tiled GeoTIFF only (the decoder refuses compression, as the DEM decoder does — SEC-03),
size-capped at 6 MB, checked to be on the 30 m EPSG:5070 grid, codes outside the NLCD legend read as no data. It is
sampled onto a 512² raster over the area exactly as the bake samples the presets (at 256² it reproduces Pittsburgh's
baked raster cell for cell), and `i₂` comes from the Atlas 14 grid the app already serves from its own origin
(`src/data/atlas14.ts`), so a live US area gets the roughness map and drains like a preset. Best-effort, like the
imagery: a failure leaves the area without land cover. Elsewhere live areas still have none: ESA WorldCover's S3
bucket sends no CORS headers (checked 2026-10-13: no `Access-Control-Allow-Origin`, preflight 403).

**GPU.** One `rgba32float` surface texture (roughness factor, drain capacity in m/s, downspout factor) bound to the
momentum and continuity passes, one `rgba32float` porosity texture (φ, ψ east, ψ south, roof share) bound to the
momentum, continuity and export passes, and one `r32float` obstacle texture read by the brush pass (and the renderer).
Which layers run is a choice of pipeline, not a uniform: each pass is compiled per combination of the
pipeline-overridable constants `ROUGHNESS_MAP` / `STORM_DRAINS` / `POROSITY` it reads (momentum and continuity four
variants each, export two), sharing one bind group layout, and `encodeFrame` picks the variant. With a layer off, the
code that reads its texture is not compiled at all. A first version branched on a uniform flag instead and cost the
default solver 3 % (2,285–2,328 against 2,376–2,392 substeps/s at 1024²); with the variants the default path is
unchanged — 2,377–2,387 against 2,380–2,384 substeps/s, interleaved runs of `tests/sim/bench.ts 1024` against `v2` on
the GTX 1660 Ti — and bit for bit the old solver. The stats pass reads the volume from the state texture (V), every
other statistic from the export (the true depth); without porosity the two are the same value. The Sim uniform grew
144 → 160 bytes (`drainScale`, padding). Cost of a layer when on, per substep at 1024², interleaved A/B against the
plain solver (`node --import tsx tests/sim/benchLand.ts`, 15 rounds, median; the GPU was shared with other work in the
latest run, so ±5–10 %): roughness +6–7 %, drains +6–18 % (with rain on every cell, every cell reads the texture),
blocks alone 0–14 % (nothing runs per substep), blocks + porosity +47 % (the momentum pass reads the porosity of all
ten texels of its stencil), all four layers +49–60 %.

**Tests** (`tests/sim/landSurface.test.ts`, `tests/sim/porosity.test.ts`, `tests/data/porosity.test.ts`, GTX 1660 Ti /
D3D12):

| Check | Result |
| --- | --- |
| Neutral layers (uniform map at 0.035, zero obstacles and drains, nulls, every layer on then off) vs the plain solver, 400 steps | bit-identical h, q, z |
| Neutral porosity (φ = ψ = 1, no roofs), with and without drains; porosity on then off | bit-identical h, q, z and exported depth |
| An obstacle vs the same height raised into the terrain, rain and an inflow | bit-identical |
| GPU vs Float64 CPU reference (`cpuReference.ts` mirrors the map and drains), roughness 0.02–0.15, drains, obstacles, 300 free steps | max \|Δh\| 1.2·10⁻⁴ m, per step 1.1·10⁻⁶ m, volume 1.3·10⁻⁶, volumeOut 1.3·10⁻⁶ |
| GPU vs CPU reference with porosity from 70 scattered houses (blocks and porous cells), roughness, rain, infiltration, drains or downspouts, 300 steps | max \|ΔV\| 1.2–1.5·10⁻⁴ m, volume 3–5·10⁻⁶, volumeIn 4·10⁻⁵, exported depth = V/φ, massError ≤ 2.5·10⁻⁸ |
| Drains on standing water, closed basin | drained = capacity × time (0.14 %), massError 7·10⁻¹⁵; a film drains to exactly 0 |
| Downspouts, closed basin under 50 mm/hr: no drains / drains ≥ roof rain / drains 20 mm/hr | all rain in the domain, no water on a roof (1.5·10⁻⁵) / roof rain never enters / min(roof rain, capacity) piped (1.4·10⁻⁵) |
| Lake at rest, 568 blocked cells and a roughness map, 2000 steps | max \|u\| 1.2·10⁻⁴ m/s, massError 3·10⁻¹³; footprints under the lake stay open |
| Porosity switched on under standing water, flat basin | volume kept to 10⁻⁶; the open parts settle to one level (spread 0.7 mm), deeper than V |
| Obstacles switched on under 1.5 m of standing water | volume unchanged to 10⁻⁸, roofs dry after the spill, bedTexture unchanged |
| Channel, 60 m³/s past three 2×2-cell buildings with 1–2-cell streets | no water or flux into a footprint, all 60 m³/s between them, 2.3 cm afflux upstream |
| Channel, 40 m³/s past a row of 21 m houses with 2.3 m yards | porous yards carry 39.9 m³/s (0.86 m upstream); cell-centre blocks dam it (0 m³/s, 2.9 m) |
| Sub-grid coverage, blocks, faces, routing (`tests/data/porosity.test.ts`) | φ and ψ of known shapes; Σ spout = Σ roof; never porous under the initial water or in the edge band |

**What each layer does to the shipped scenarios** (`npx tsx scripts/landsurface-eval.ts`; the app's forcing, 5-s
ticks of CFL substeps, hazard maxima sampled every tick, the app's loss model; flooded = land dry at the start whose
max depth passed the threshold, *open* = the same over cells outside every footprint; a porous cell counts at the
depth of its open part):

Pittsburgh, stage ramped to the 1936 crest (46 ft) and held, 45 simulated minutes:

| Layers | Flooded ≥ 0.15 m (open ground) | ≥ 0.5 m | Roads > 0.3 m | Road depth mean / p90 | Loss | Reached / destroyed |
| --- | --- | --- | --- | --- | --- | --- |
| none (today) | 6.56 km² (4.94) | 6.27 km² | 123.1 km | 2.62 / 4.75 m | $12.66 B | 1,348 / 93 |
| buildings | 5.22 km² (4.86) | 4.99 km² | 119.0 km | 2.58 / 4.64 m | $10.53 B | 1,299 / 132 |
| roughness | 6.43 km² (4.84) | 6.14 km² | 119.3 km | 2.57 / 4.59 m | $5.82 B | 1,304 / 16 |
| buildings + roughness | 5.27 km² (4.90) | 5.04 km² | 120.9 km | 2.59 / 4.67 m | $13.77 B | 1,324 / 173 |
| drains | 6.56 km² (4.94) | 6.27 km² | 123.1 km | 2.62 / 4.75 m | $12.66 B | 1,348 / 93 |
| all three | 5.27 km² (4.90) | 5.04 km² | 120.8 km | 2.59 / 4.67 m | $13.76 B | 1,324 / 173 |

Houston, Harvey's worst hour (173 mm/hr) with Buffalo Bayou at its peak, 30 simulated minutes:

| Layers | Flooded ≥ 0.15 m (open ground) | ≥ 0.5 m | Roads > 0.3 m | Road depth mean / p90 | Loss | Reached |
| --- | --- | --- | --- | --- | --- | --- |
| none (today) | 11.85 km² (11.04) | 1.31 km² | 203.1 km | 0.30 / 0.45 m | $2.45 B | 4,162 |
| buildings | 13.23 km² (12.43) | 1.47 km² | 231.6 km | 0.31 / 0.46 m | $3.82 B | 7,181 |
| roughness | 12.16 km² (11.37) | 0.99 km² | 176.5 km | 0.28 / 0.41 m | $2.51 B | 4,249 |
| buildings + roughness | 12.90 km² (12.12) | 1.57 km² | 232.8 km | 0.32 / 0.48 m | $3.73 B | 6,917 |
| drains | 8.89 km² (8.40) | 0.94 km² | 122.3 km | 0.28 / 0.41 m | $1.94 B | 2,589 |
| all three | 9.72 km² (9.22) | 1.08 km² | 142.7 km | 0.29 / 0.42 m | $3.00 B | 4,791 |

The 2-year 1-hour design storm itself, 60 minutes of rain with the rivers as the scenario leaves them:

| | Flooded ≥ 0.15 m | Roads > 0.3 m | Reached |
| --- | --- | --- | --- |
| Houston 57 mm/hr: none / buildings / drains / all three | 7.82 / 8.57 / 1.77 / 1.97 km² | 102.5 / 113.9 / 6.9 / 7.7 km | 2,034 / 3,775 / 228 / 949 |
| Pittsburgh 30 mm/hr: none / buildings / drains / all three | 1.88 / 2.36 / 0.83 / 1.05 km² | 31.2 / 36.9 / 12.1 / 13.4 km | 893 / 4,448 / 463 / 2,616 |

Mass error stayed ≤ 1.3·10⁻⁷ in every run. Before porosity and downspouts (blocks by cell centre, roof rain shed at
the walls), the buildings rows read: Pittsburgh crest 4.88 km², $15.26 B, 1,323 / 203; Harvey's hour 12.38 km²,
214.3 km, $4.53 B, 12,516 reached; the design storm 8,282 (Houston) and 10,206 (Pittsburgh) buildings reached, and
689 / 4,793 with all three.

Reading them: at the crest, buildings take the blocked footprints out of the flooded area and leave the open-ground
flood and the street depths where they were (the stage boundary sets the level). The loss now falls 17 % instead of
rising 16 %: with the side yards open, water no longer squeezes through the few gaps a row of blocks left, so the
fast-water collapse rule fires on 132 buildings (203 with blocks alone; 93 bare). The roughness map on its own slows
the floodplain flow, collapses fall from 93 to 16 and the loss halves — the *building resistance* treatment Schubert
& Sanders found least accurate. Drains do nothing to a river crest. Under rain, drains are the largest single change
(−25 % flooded area, −40 % flooded road in Harvey's hour). The downspouts halve the buildings reached under rain
(Harvey's hour 12,516 → 7,181; the design storm 8,282 → 3,775 in Houston and 10,206 → 4,448 in Pittsburgh), and with
drains on, the roof rain they pipe away cuts Pittsburgh's design-storm count from 4,793 to 2,616. Buildings still reach
more than bare earth under rain: a porous cell's water stands in its open part, so the same volume is deeper there.

**Against the observed floods.** The same layers through the runs and scores of [docs/VALIDATION.md](docs/VALIDATION.md)
(`npx tsx scripts/validation/landsurface.ts`; a blocked cell is scored at the water surface of its wettest open
neighbour, the level a mark on its wall would record; a porous cell at the depth of its open part):

| Scene and observation | none (today) | buildings | roughness | buildings + roughness | drains | all three |
| --- | --- | --- | --- | --- | --- | --- |
| Fort Myers, Ian high-water marks: bias / RMSE | +0.07 / 0.14 m | +0.04 / 0.16 m | +0.01 / 0.17 m | +0.04 / 0.15 m | | |
| Fort Myers, FEMA 1 % zone at the 1 % stillwater: CSI | **87.9 %** | 85.8 % | 80.9 % | 85.7 % | | |
| Nashville, FEMA 1 % zone: CSI / 1 % profile bias | **82.3 %** / +0.26 m | 80.2 % / +0.27 m | 79.3 % / +0.24 m | 79.4 % / +0.27 m | | |
| Pittsburgh, FEMA 1 % zone: CSI / 1 % profile bias | **60.9 %** / −0.38 m | 60.5 % / −0.38 m | 59.1 % / −0.40 m | 60.8 % / −0.38 m | | |
| Asheville, Helene gauge peaks: French Broad / Swannanoa | −1.44 / −1.22 m | −1.44 / **−0.49 m** | −1.69 / +0.00 m | −1.41 / −0.55 m | | |
| Houston, Harvey marks (not like-for-like: 1 h of a 4-day event): bias / RMSE | −1.85 / 2.56 m | −1.01 / 2.39 m | −1.87 / 2.44 m | | −1.89 / 2.61 m | −1.07 / 2.47 m |

Mass error ≤ 6·10⁻⁸ in every run. Before porosity and downspouts the buildings column read 86.6 %, 80.2 % / +0.27 m,
60.5 % / −0.38 m, −1.45 / −1.27 m and −1.01 / 2.40 m; buildings + roughness 86.7 %, 79.6 %, 60.9 %, −1.45 / −1.02 m;
all three −1.07 / 2.48 m. Where the comparison is like-for-like — the measured stillwater or FEMA's own 1 % level
imposed, then extent and marks scored — no layer improves every score: buildings cost 0.4–2.1 CSI points (and bring
the Swannanoa gauge 0.73 m closer), the roughness map 1.8–7.0, the combination 0.1–2.9. Two causes were measured
(`--hold-scale=3` re-runs every hold three times as long, a sensitivity only):

* *the fixed hold*: FEMA's zone is where water stands with no time limit, so anything that slows the water leaves its
  fringe short when the hold ends. With 3× holds the roughness map's loss falls to 0.6 (Fort Myers), 0.8 (Nashville)
  and 1.2 points (Pittsburgh), buildings' to 0.8 (Fort Myers) and 0.3 (Pittsburgh);
* *watertight blocks*: at Nashville the buildings' loss grows with the hold (81.4 % against 77.4 %). Of the 781 zone
  cells bare earth wets and buildings do not, 651 are open ground that stays completely dry — pockets the blocks shut
  off, which a real flood reaches through doors and courtyards and FEMA maps by ground elevation.

The roughness map was checked for misapplication rather than tuned: the land-cover raster is registered (the share
of initial-water cells on NLCD's water class is highest unshifted at every US preset and drops for a 4-cell shift in
any direction; a live re-fetch at 256² reproduces Pittsburgh's baked raster cell for cell), every cell wet in the
initial water keeps 0.035 whatever its class, and the class values are inside the HEC-RAS 2D manual's ranges. The
Helene gauges move both ways under the map (Swannanoa −1.22 → 0.00 m, French Broad −1.44 → −1.69 m), which says the
error there is the burned channel and the inflow, not the floodplain n. Houston's marks record four days of Harvey; an
hour of its rain cannot be scored against them.

**Defaults.** On that evidence, all three stay off:

* *Buildings* are the right physics for flow paths, conserve mass exactly, and since the porosity and the downspouts
  no longer close side yards or shed every roof into the cell against its wall. They improve one like-for-like score
  (Helene's Swannanoa gauge) and cost 0.4–2.1 CSI points on the FEMA zones, partly from the scenes' fixed hold and
  partly from watertight blocks. Under rain they still put water against more buildings than bare earth (4,448 against
  893 in Pittsburgh's 2-year storm; 2,616 against 463 with drains), because water confined to the open part of a cell
  stands deeper. The crest loss falls 17 % through slower street flow, a change the loss model's fast-water thresholds
  (set on bare-earth speeds) were not tuned for.
* *The roughness map* makes every like-for-like score worse and moves the crest loss by −54 % (bare) or +31 % (with
  buildings) through flow speed alone. The literature values need calibrating per city before they belong in a default.
* *Drains* are the best supported physically: without them the model floods 102 km of Houston's streets more than
  30 cm deep in a 2-year storm, which the sewers are built to carry; with them, 7 km. But no observation here tests a
  storm of that size, and the shipped rain scenario is Harvey's worst hour — three times the design intensity, with the
  bayou in flood at the outfalls — when real sewers surcharge: a sink at full design capacity then under-floods
  (−25 % area, −21 % loss), the non-conservative direction for a screening tool. Recommended on for studies of
  ordinary storms.

What would change this: a city's calibrated n by land-cover class; buildings that leak; observed extents of a
design-size rain event, or a validation run that reproduces the event's duration as well as its level.

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
  terrain edit. Without walls nothing runs (one scan per terrain edit, stopping at the first wall); non-physical
  readbacks (non-finite depths, or a solver not running the robust scheme) are skipped, so the last physical answer
  stays up. A sudden collapse is confirmed by a second run
  before it is shown, and the one-time success notice waits until the river has arrived and two runs agree. Pittsburgh's scenario carries
  a demo levee (`ScenarioPreset.levee`, baked): a 2.4 km floodwall along the North Shore from bluff to bluff with its
  crest 1 m above the 1936 record. *Build a levee* resets the water if the flood is already out, raises it along its
  line in ~2 s (each ~40 m piece tall enough for the lowest ground under it), and replays the rise; at the crest it
  keeps ~0.56 km² (139 acres) and 11 km of streets dry while flooded land drops from 6.3 to 5.6 km²
  (`scripts/e2e.mjs` flow 12).

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
* **Land cover** (`landcover.u8` + the `landcover` block of `meta.json`; `scripts/bake-landcover.ts`, which
  `bake-presets.ts` runs after each bake). US presets: NLCD 2021 (USGS/MRLC, public domain, 30 m) read from the MRLC
  WCS in its native EPSG:5070 grid and reprojected here (Conus Albers, Snyder 1987) onto the preset's Web-Mercator
  grid at 256² (31 m) — 64 KB each. Elsewhere: ESA WorldCover 2021 v200 (10 m, CC BY 4.0, credited in the preset's
  attribution) read by window from the ESA bucket's COGs, at 512² (15.6 m) — 256 KB each. The solver grid upsamples it
  by nearest neighbour. Registration check (`tests/data/landcover.test.ts`): 82 % of Pittsburgh's, 80 % of Nashville's
  and 97 % of Fort Myers' burned river cells sit on NLCD open water. The bake also stores NOAA Atlas 14's 2-year
  60-minute intensity for the drains (§3.11). Live areas have none (uniform roughness, no drains).
* **Presets** (`public/presets/<id>/`: `meta.json`, `elevation.f32`, `imagery.jpg`, `roads.json`, and
  `imagery-detail.jpg` where the base photo is too coarse) are baked by `npx tsx scripts/bake-presets.ts` and work
  fully offline. Eight cities plus a procedural sandbox:

  | Preset | Domain / cell | Scenario forcing | Photo | Road edges |
  | --- | --- | --- | --- | --- |
  | `pittsburgh` | 8.0 km / 7.81 m | 1936 crest via the stage control, plus a demo levee | 1.95 + inset 0.73 | 11,053 |
  | `johnstown` | 7.0 km / 6.84 m | 1889 South Fork Dam flood as a lake-average 3,730 m³/s inflow on the Little Conemaugh | 1.71 + inset 0.61 | 4,903 |
  | `ellicott` | 5.0 km / 4.88 m | 2016 flash-flood storm over the Tiber–Hudson–New Cut watershed | 1.22 | 1,224 |
  | `asheville` | 8.0 km / 7.81 m | Helene 2024: 3,200 m³/s French Broad + 1,722 m³/s Swannanoa, sloping (no stage control) | 1.95 + inset 0.73 | 3,556 |
  | `nashville` | 6.0 km / 5.86 m | Cumberland stage control: 2010 (51.86 ft), 1937 (53.90), 1927 record (56.20) | 1.46 | 5,410 |
  | `houston` | 8.0 km / 7.81 m | Harvey 2017: 173 mm/hr over the whole domain, bayou at its 923 m³/s peak | 1.95 + inset 0.73 | 10,529 |
  | `boulder` | 5.0 km / 4.88 m | 2013 Front Range flood: 238 m³/s out of Boulder Canyon | 1.22 | 1,749 |
  | `ftmyers` | 8.0 km / 7.81 m | Hurricane Ian 2022 storm surge: a tidal stage on three sea boundaries, 4.5 → 12.9 ft | 1.95 | 3,252 |

  River centrelines for the four 2024/2025 additions are traced from USGS NHD high-resolution flowlines; peak
  discharges, stages and gauge datums come from the USGS annual peak-flow files and NWIS site file. Everything in
  `public/presets` is public-domain U.S. government data, recorded per city in `public/presets/SOURCES.txt`.

  `ftmyers` is the first COASTAL domain and the first without a river forcing it: a storm surge is a still-water rise,
  so `seaBoundaryDiscs` (`src/data/hydro.ts`) puts a stage disc on every crossing of every domain edge by the estuary
  — three of the four edges here, because the domain corner falls in the middle of the river mouth — and the slider
  raises all of them together. Its tidal datums and the 12.92 ft record are NOAA CO-OPS station 8725520; the pool
  level is MEASURED from the DEM's own flat estuary surface (-0.28 m NAVD88, essentially MLLW — the lidar was flown
  near low tide) rather than assumed.
* **Deploy budget.** `public/presets` is served from a public static host, so `tests/data/presets.test.ts` caps the
  whole directory at **125 MB** and each preset at 25 MB. It currently stands at **121.6 MB across eleven presets** —
  Asheville is the largest single city at 17.1 MB, the three Himalayan glacier presets (no photo) are 4.7–5.3 MB each,
  close-up insets account for 16.5 MB of the total and land cover for 1.3 MB (64 KB per US preset, 256 KB per
  WorldCover one).

  The two caps guard different things, which is why they moved differently. **The per-preset cap is the one a visitor
  feels**: presets load one at a time, so what anyone downloads is bounded by the largest single preset (15.9 MB), not
  by the directory. That cap stays at 25 MB. **The directory cap is a host-and-repo cost.** GitHub Pages publishes
  sites up to 1 GB and recommends the source repository stay under 1 GB, with a soft 100 GB/month of bandwidth
  ([GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), read
  2026-09-19); at 120 MB the published site is 12 % of that limit and the largest single file is a 6.2 MB JPEG. What
  keeps the cap finite at all is git history: JPEG and Float32 blobs do not delta-compress, so each preset costs about
  its own size again forever, and the repository is already 189 MB of worktree plus 132 MB of `.git`.

  Raising 90 → 120 MB buys roughly one more full preset (~10 MB) **plus** room to restore **one** of the two insets
  dropped for space — Nashville's is exported and cached in `artifacts/bake-cache` (0.611 m/texel, 2.4×, 3.80 MB), and
  Fort Myers qualifies on the texel-density rule at 1.95 m/texel. It is not room for both a second new preset and both
  insets; the bake after next needs this argument made again. If the number ever has to come down instead, the lever
  is the insets: the test's failure message names each preset's inset size and the largest one to drop.

  Raised again 120 → 125 MB for the third glacier preset (`chamoli`, 4.44 MB), which took the directory to 120.1 MB.
  A glacier preset is 4.19 MB of Float32 elevation plus ~0.25 MB of JSON — nothing left to squeeze but the grid, and
  shipping one preset at 960² instead of the 1024² every other preset runs at would have bought 0.5 MB of headroom for
  an inconsistency. 5 MB is one more glacier preset, not a US preset with a photo: the next one of those needs the
  insets argument above, or a deliberate raise of its own.
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
status, markers and rain. Bloom and ACES tonemapping follow. Hazard maps (depth, max depth, speed, arrival time,
AIDR 2017 hazard class) colour only land that was dry at reset (speed excepted); their colours are solved through the
tone mapper so the screen matches the legend. Arrival and hazard class are read from the solver's hazard accumulators
(§3.7) by the prep pass, drawn on the max-depth surface: minutes since reset (premultiplied by "the water got here",
so filtering toward land it never reached keeps the right time and fades the colour out), and H1–H6 from the maxima of
depth, speed and depth × speed, classified with WGSL generated from the legend's own threshold table. The ensemble's flood-probability view (§3.10) is a fourth field of the same prep pass: the share of members over the threshold, read from the ensemble tally, drawn on the deepest water any member reached. An
adaptive resolution controller keeps frame time on target; the app also tells it how hard the solver is pushing for GPU
time (§8), so it does not spend on pixels what the flood needs in substeps. Terrain and water are CDLOD meshes of
32×32-quad patches sized to ~4 px per quad by default: vertex work was half of the renderer's GPU time.

### 6.1 The city (`src/render/buildings.ts`)

The DEM is bare earth, so without this the flood runs *over* a photograph of a city. `TerrainData.buildings` (§5)
is meshed once at scene load into one static buffer: a quad per footprint edge for the walls, an ear-clipped cap
for the roof — Pittsburgh's 45 084 buildings are 1.17 M vertices and 610 k triangles, about half the terrain mesh.
Wall bottoms are sunk below the **lowest** ground found around the footprint's perimeter (the CDLOD surface morphs,
so planting a building exactly on the DEM shows daylight under its downhill wall), and a roof that a slope would
otherwise bury is lifted clear. Vertical exaggeration is applied to buildings exactly as to the terrain, so a
256 m tower and the 150 m hill behind it keep their real ratio.

*Lighting.* Roof heights are added to the height field the sun-shading raster is solved over (§6, `shaders/shadow.ts`),
so the city casts real shadows across the streets and the flood — and receives them — for no per-frame cost at all.
Only buildings the raster can resolve get in: below about two DEM cells (16 m here) a block of rowhouses fuses into
one slab and every facade inside it comes out in shadow, so those are carried by their own N·L instead. Roofs take
their colour from the aerial photograph at their own grid position (near-nadir imagery *is* the roof), with its
baked-in shading levelled out first, and fall back to a procedural membrane above 34 m where relief displacement
puts a tower's roof tens of metres from its footprint. Facades are a per-class, per-seed palette — Pittsburgh brick,
pale limestone, Cor-Ten bronze, dark curtain wall — with floor bands and mullions that appear up close and fade out
before they can alias.

*Water.* The waterline is read from the same per-vertex texture the water mesh is built from, so it lands exactly
where the water pass draws its surface: a dark wet band above it, moving foam at the contact line (with a
screen-space minimum width, or it vanishes at 300 m), a stain at the high-water mark, and Beer–Lambert attenuation
below it — past about two metres the wall is dropped outright and the water owns the pixel. By default buildings do
**not** take part in the physics: they are not in the solver's barrier field, and the NWS validation numbers in §9 were
measured without any such coupling. With *Buildings block flow* on (§3.11) the footprints are raised into the solver's
bed but not into `bedTexture`, so the terrain mesh is unchanged and the water stops at the walls the city already
draws. The prep pass reads the solver's `obstacleTexture` and shows no water in a blocked cell shallower than 10 cm —
the film of rain running off a roof (up to 4 cm on the largest flat roofs under Harvey's 173 mm/hr) is not a flood,
and with the buildings hidden or culled it must not paint the footprints blue — while a roof the flood has overtopped
(13 cells of low riverside buildings at Pittsburgh's crest) shows the water over it (`tests/render/prep.test.ts`).

*Cost.* Buildings are stored in Morton order, so a contiguous slice is a contiguous patch of city: chunks of 384
are frustum-culled whole, and inside a chunk they are sorted tallest-first so "only what is worth a few pixels from
here" is a prefix of its index range. The vertex shader collapses a building's roof toward its floor over the last
octave before that cut, so nothing pops — it sinks. The cut is a quality-ladder knob (`buildingMinPx`), so the
adaptive controller thins the city on the way down and the cinematic tier draws all of it.

## 7. Evacuation routing

Each road edge is sampled about once per cell. On every readback (≤ 4 Hz) an edge is dry, wet (≥ 5 cm: passable at 30 %
speed) or flooded (≥ 30 cm, roughly where cars float: impassable). Road stretches over water present at load are
bridges and stay open until the water reaches their approaches. The start and shelters are snapped to the network,
and a multi-target Dijkstra on travel time (highway 25 m/s, major 15, minor 11, local 8) finds the nearest reachable
dry shelter. The result carries the street names (`via`), metres of wet road, and a reason and advice when the route
is blocked.

### 7.1 Evacuation on foot (`src/routing/pedestrian.ts`, `pedestrianEvac.ts`)

Site check also asks how the people in a building get out on foot. The baked roads (TIGER / OSM drivable ways) carry
no footways, so people walk every road edge in both directions. A per-edge timeline is rebuilt from the run's
HazardFields as in `egress.ts`: an edge becomes unsafe for people when any of its cells (bridge spans over water at
reset, and their approaches, excepted) reaches FD2321 HR = d(v + 0.5) + DF ≥ 0.75 or AIDR H3, counted from the first
arrival of water there (early, pessimistic). A label-setting Dijkstra on arrival time uses an edge only if the walker
is across it before it closes; edges only close, so arrival is FIFO and the latest safe departure is found by
bisection. Refuges are shelters that stay safe and any network node that stays dry and stands 1 m above the highest
water within 300 m. Occupants (IBC 1004.5 design load by default) leave through the exits at the SFPE specific flow
(≈ 1.3 persons/s per metre of effective width) after a pre-movement time, in walking groups (1.22 / 0.91 / 0.6 m/s);
the result is "everyone out by T+x", "X of N reach safety" with the alert at T0, and vertical evacuation (the first
floor 1 m above the site's max depth, in a building outside the fast-water collapse band). Pittsburgh at the 1936
crest, no GPU: a 3-storey North Shore office's walk takes 63 ms (`tests/routing/pedestrianPreset.test.ts`).

### 7.2 Infrastructure dependencies (`src/data/facilities.ts`, `src/loss/infra.ts`, `infraDeps.ts`)

`scripts/bake-facilities.ts` bakes substations, power plants, hospitals, clinics, fire and police stations, water and
wastewater works, telecom exchanges, bridges on major roads and fuel stations from OpenStreetMap (Overpass) into a
`facilities.json` per preset (78 KB for all eleven). Live areas have none: Overpass is not in the CSP, and the allowed
OSM API `/map` call returns whole map tiles. Each facility's exposure (max depth within 60 m, first arrival, time
wet; a bridge at its two landings) gives operational / impaired / failed by per-type screening thresholds
(substations out at 0.45 m, hospitals at 0.6 m …, each with its basis in `FACILITY_THRESHOLDS`). A site depends on
its nearest substation (a Voronoi service area — labelled approximate), water works, exchange and wastewater plant,
and on the nearest hospital and fire station by road at the peak (the router over the arrival-ordered flood, with
the moment the last route was cut). Failed utilities add illustrative restoration days to the downtime heuristic.
The shelters evacuees are sent to are dependencies too: each is listed with its own flooding (≥ 0.3 m, from the first
arrival there) and its nearest substation, and a dry shelter whose substation fails is flagged ("no grid power
there"). A shelter that floods already drops out of the routing — the car router skips it, `egress.ts` subtracts the
drive there from its closure (§7.3), and the walk never counts a shelter that turns unsafe — so power is reported,
not routed around.

### 7.3 Leaving by road: departures and the queue (`src/routing/departure.ts`, `bottleneck.ts`, `src/loss/egressTiming.ts`)

`egress.ts` gives the moment the last road route from a site to a shelter closes. Three things stand between that and
"everyone is out", each a transparent calculation with sourced, editable defaults:

* **The latest safe departure.** Per shelter, its closure (last route cut, or the shelter itself under 0.3 m) minus
  the dry drive there; the latest over the shelters. A shelter that floods before a car leaving later could reach it
  does not stretch the window.
* **Departures after the alert.** People do not all leave at the alert. Sorensen & Mileti's (2015b, USACE)
  protective-action-initiation curves for dam and levee floods, P(t) = m·(1 − exp(−t²/(a·b²))) with t in minutes after
  the warning is received — a Rayleigh in t, capped at the share m that acts within 8 h. Coefficients as tabulated in
  Silva, Eleutério, Apel & Kreibich (2025, NHESS 25:1501, Suppl. Table S2): unprepared / threat seen as likely
  (the default: a 1.79, b 111.8 min, m 74.3 %), prepared / likely (1.37, 64.0, 88.8 %), unprepared / unlikely (1.79,
  111.8, 57.0 %), and the fastest published bound (1.00, 25.0, 100 %). p10–p90 of the default: 49 min – 3 h 47 min.
  The curve starts when the warning reaches people; the time to get the warning out is the user's alert time (which
  may be before the run starts — the river-stage presets rise ~600× faster than the real event).
* **The queue at the bottleneck.** Occupants (IBC design load by default) become cars at 2.0 per car for homes (Census
  household size over 1.23 cars per evacuating household, a KLD ETE survey) and 1.18 for workplaces (NHTS 2017). The
  route's bottleneck is the site exit (1 lane by default) or the weakest road class on the dry route (the router's
  per-class lengths), lanes × a per-lane discharge: 500 veh/h for a local street or driveway joining at a stop sign
  (HCM two-way-stop capacity of a right turn into 600 veh/h), 950 for a signalised road (HCM base saturation flow
  1,900 pc/h/ln × 0.5 green), 1,600 for a highway (peak interstate flows in the Hurricane Floyd evacuation); lanes
  2 / 2 / 1 / 1 by class (the road data has none). A point queue (Newell's cumulative curves:
  D(t) = min over s ≤ t of A(s) + c·(t − s)) gives the share of occupants through the bottleneck when the window ends
  — the rest still inside or still queued — and the clearance time (the curve's last 1 % taken at its 99th
  percentile).

Not a traffic simulation: other evacuating traffic on the route is not counted (the clearance is a lower bound), lane
counts are assumed, and buses, ambulances and people who cannot drive are outside it. On the North Shore demo parcel
A (a 6-storey apartment block, 2,494 occupants by the IBC load, 1,247 cars) at the 1936 crest the last route closes
at T+3 min; with the alert at T+0 under 1 % are out, with the alert 3 h before the run 57 % are (clearance 5 h 22 min
vs a 3 h 01 min window), and with a prepared population 89 %.

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

**Land-surface layers (§3.11).** Off — the default — they cost nothing: the passes are separate pipeline variants and
the default ones are the old shaders (2,377–2,387 against 2,380–2,384 substeps/s at 1024², GTX 1660 Ti). On, they add
to the solver's share of the frame: roughness +6 %, drains +6–9 %, buildings nothing per substep (one full-grid rebed
pass when switched), all three +16 %. The governor (§8) absorbs it as a few percent less simulated speed at the same
frame rate. Not measured on the M4.

## 9. Validation

From `npm test` (tests run on the real GPU through Dawn); the grid-convergence rows from
`npx tsx scripts/reference-run.ts` (§9.1), likewise on the real GPU:

| Check | Result | Test |
| --- | --- | --- |
| Lake at rest on rough terrain, 2000 steps | max \|u\| = 9.3·10⁻⁵ m/s | `tests/sim/wellbalanced.test.ts` |
| Dam break vs the Ritter solution at t = 20 s | profile L1 error 1.6 %, front (5 % depth) ratio 1.01 | `tests/sim/dambreak.test.ts` |
| Dam-breach peak relations vs 21 documented failures (Wahl 1998 Table A1) | central case Froehlich 1995: RMS log₁₀ error 0.15, all 21 within ×2, bias −16 %; the eight relations’ band holds 17 of 21; Teton 1976: band 22,000–107,000 m³/s vs 65,120 observed, central 43,000 | `tests/dams/breachRelations.test.ts` |
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
| Land-surface layers (§3.11): neutral layers bit-identical, GPU vs CPU with a roughness map, drains and obstacles, exact drain booking, lake at rest among buildings, a channel past buildings | bit-identical; max \|Δh\| 1.2·10⁻⁴ m free-running; drained = capacity × time (0.14 %); max \|u\| 1.2·10⁻⁴ m/s; no flux into a footprint | `tests/sim/landSurface.test.ts` |
| Land cover registered on the grid, every class in the table, credited | 80–97 % of the big rivers on the water class | `tests/data/landcover.test.ts` |

`npm run e2e` drives 13 end-to-end demo flows (load, raise to the crest, levee, rain, evacuation, presets, tools,
frame rate, idle power, cancelling a stalled `?live=` link, the one-click levee, the screen wake lock, and a GPU
device loss mid-load; `--live` adds a live-area flow) in headless Chromium on the real GPU,
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

**Against real floods.** Everything above is about solving the equations. How the scenes compare with what was
observed — USGS high-water marks and gauge peaks, FEMA's 1 % zone and profile at FEMA's own 1 % level, Copernicus EMS
damage grading, and Metro Nashville's survey of the parcels damaged in May 2010 — is measured by `scripts/validate.ts`
(same solver on Dawn, scenes set up as the app does), pinned by `tests/sim/validationRegression.test.ts`, and reported
in [docs/VALIDATION.md](docs/VALIDATION.md). A damage survey that lists only damaged parcels is made two-sided by
scoring every building footprint the scene has (`scoreDamage` in `src/validation/score.ts`: hit, miss, false alarm or
correct dry), and a crest-reach mask — ground below the gauged crest, connected to the river — separates the damage a
river-stage scene can explain from the damage it cannot. A scene may carry more than one comparison; the summary's
`more` lines are shown under the headline in the Scenario section's validation block.

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
   about whether that limit is the real 1936 flood. Reality checks are the NWS impact-stage comparison in §4 and the
   observed-flood validation in [docs/VALIDATION.md](docs/VALIDATION.md) (FEMA's 1 % zone and profile for Pittsburgh;
   surveyed marks and gauges elsewhere).
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
| `npm run test:visual` | Fourteen exactly-frozen scenes at 1470×956 @ DPR 2, compared with committed golden images in `tests/visual/baselines/` **and** checked by baseline-free detectors: blank frames, NaN magenta, water unsupported above terrain, shoreline stair-stepping, z-fighting flicker, missing imagery, UI off the canvas, legend-vs-pixel colour agreement. |
| `npm run test:security` | The penetration test's cases against the *released* bundle (no debug API): link-parameter spoofing, XSS through hostile upstream bodies, the CSP and its violations, response byte caps, `dist/` hygiene, `npm audit`. |

## 11. Future work

* A second-order Kurganov–Petrova central-upwind solver (full shallow-water equations) as a selectable mode for
  dam-break and supercritical scenarios.
* Measured channel bathymetry instead of a nominal burned depth, and culverts.
* Land surface (§3.11): validate each layer against an observed extent or high-water marks of a flood the scene
  reproduces in time as well as level (the fixed holds of docs/VALIDATION.md penalise any layer that slows the water)
  before switching it on by default; buildings that leak (doors, garages, courtyards reached through the building) —
  today a block is watertight and an enclosed pocket stays dry; depth-dependent porosity and a building drag term (the
  full Sanders et al. 2008 formulation); a pipe network with surcharge in place of the distributed drain sink; land
  cover for live areas outside the lower 48 (ESA WorldCover's bucket sends no CORS headers).
* Coverage beyond 3DEP (the Terrarium fallback works worldwide but is coarse).
* Evacuation traffic (§7.3): background traffic from the rest of the evacuating zone on the shared links, lane counts
  from OSM `lanes=` tags, and a warning-diffusion curve (Sorensen & Mileti 2015a) ahead of the departure curve.

References: Bates, Horritt & Fewtrell (2010), *J. Hydrology* 387; de Almeida, Bates, Freer & Souvignet (2012), *Water
Resources Research* 48; Ritter (1892) dam-break solution.

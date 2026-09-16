# Deluge — real-time flood simulation on real terrain (WebGPU)

**Hackathon track:** "No Wrapper — best hack without an LLM". The finished product must contain **no language
models**. What judges want: *something hard in a way we can explain* + *a working demo they can actually try*.

**Pitch:** Towns need to know where water goes in a heavy storm, but professional hydrology software is
expensive and slow. Deluge loads real USGS elevation data for any place in the US and solves the
shallow-water equations on the GPU with WebGPU compute shaders, in real time, in a browser tab. You can
draw a sandbag wall and watch the flood reroute, crank the rain, raise the river to the 1936 crest, and watch
the evacuation route re-plan as roads go underwater.

**The hard part (what we explain to judges):** solving a hyperbolic PDE system in parallel on the GPU while
keeping it numerically stable at interactive frame rates: CFL-limited adaptive timestep, semi-implicit
friction for stiff source terms, a positivity-preserving flux limiter for wetting/drying, well-balanced
treatment of steep real terrain (lake-at-rest stays at rest), and exact mass accounting shown live. We also
have a **stability demo toggle** that switches to a naive explicit scheme so judges can watch it blow up.

---

## 1. Tech stack & repo layout

* Vite 8 + TypeScript (strict), no UI framework. WebGPU only (no WebGL fallback; show a friendly message).
* Deps already installed: `geotiff` (DEM TIFF decode), `leaflet` (location picker map). Dev: `playwright`
  (headless Chromium with real Metal GPU), `webgpu` (Dawn for Node — GPU unit tests), `tsx`.
* **Do NOT run `npm install` / add dependencies** — several agents work in this tree at once. If you truly
  need a package, say so in your final report.
* All WGSL lives in TypeScript modules exporting strings (e.g. `export const fluxWGSL = /* wgsl */ \`...\``)
  so the same shaders load in Vite and in Node tests. No `?raw` imports.

```
index.html               app shell (owned by app)
src/contracts.ts         ★ shared interfaces — the integration contract (read it fully)
src/gpu.ts               createDelugeDevice(gpu) — shared device creation (browser + node)
src/app/                 main loop, wiring, debug API, store        (owner: app)
src/main.ts              entry                                       (owner: app)
src/sim/                 GPU shallow-water solver + CPU reference    (owner: sim)
src/render/              terrain/water/overlay renderer, camera, picking (owner: render)
src/data/                DEM/imagery/roads loading, presets, hydro conditioning (owner: data)
src/routing/             road graph, flood-aware shortest path       (owner: routing)
src/ui/                  panels, toolbar, HUD, tools controller, location picker (owner: ui)
public/presets/<id>/     baked offline preset data                   (owner: data)
scripts/shot.mjs         headless Chromium screenshot/console tool (shared, read-only)
scripts/bake-presets.ts  fetches + bakes preset data                 (owner: data)
tests/<module>/          node:test tests, run with `node --import tsx --test tests/<module>/*.test.ts`
dev/<module>.html        standalone dev harness pages per module (e.g. dev/render.html)
artifacts/               screenshots/logs (gitignored)
```

### Running things
* Typecheck: `npx tsc --noEmit` (errors in other agents' in-progress directories may appear during the
  parallel build — only your own files must be clean).
* Dev server: `npx vite --port <yourPort> --strictPort` — ports: app 5173, render 5181, ui 5182, data 5184,
  sim 5185, routing 5186, integration 5190+. Run it in the background and kill it when done.
* Screenshot + console: `node scripts/shot.mjs <url> artifacts/<name>.png --wait=2000 [--ready=...] [--eval=...]`
  then **look at the PNG with the Read tool**. Exit code 1 means page errors — read the log.
* GPU tests in Node: `import { create, globals } from 'webgpu'; Object.assign(globalThis, globals);
  const gpu = create([]);` then `createDelugeDevice(gpu)`. Call `process.exit()` at the end of test files
  (Dawn keeps the process alive).

---

## 2. Conventions (see top of src/contracts.ts)

Grid cells (i, j), i west→east, **j north→south**, row-major arrays, texel (i, j) = cell (i, j). Grid coords
(gx, gy) in cell units with cell centers at +0.5. World: X east, Y up, **Z south**, meters, origin at the
domain center, Y = elevation × verticalExaggeration. u is +i (east) velocity, v is +j (south) velocity.
nx, ny multiples of 16. Units: meters, seconds, m³/s, mm/hr at the UI boundary.

---

## 3. Numerical method (owner: sim)

### 3.1 Governing equations
2D shallow-water equations with bed slope and Manning friction:
```
∂h/∂t + ∂(qx)/∂x + ∂(qy)/∂y = R − I + S
∂qx/∂t + ∂(qx²/h + ½gh²)/∂x + ∂(qx qy/h)/∂y = −g h ∂z/∂x − g n² qx |q| / h^{7/3}
(similar for qy)
```
h depth, q = (qx, qy) unit discharge (m²/s), z bed (ground + barrier), R rain, I infiltration, S sources.

### 3.2 Primary scheme: local inertial (Bates et al. 2010; de Almeida et al. 2012) — "LISFLOOD-FP class"
The same approximation used by production flood-inundation models. Drops convective acceleration, keeps
local acceleration, pressure, bed slope and friction; explicit, staggered, GPU-perfect.

* **Staggered grid.** h at cell centers. qx on x-faces, qy on y-faces. Store the EAST face of cell i as
  `qx[i]` (face i+½) and the SOUTH face of cell j as `qy[j]` (face j+½). Ping-pong textures
  (rgba32float), sampled via `textureLoad` (never filtered), outputs via write-only storage textures.
* **Face flow depth (wetting/drying, well-balanced):** `hf = max(η_L, η_R) − max(z_L, z_R)` with η = z + h.
  If `hf < hMin (1e-4 m)` → q = 0.
* **Momentum update (per face), semi-implicit friction:**
  ```
  S     = (η_R − η_L) / dx
  q̃     = θ·q_c + (1−θ)/2 · (q_upstreamFace + q_downstreamFace)        θ ≈ 0.7–0.9 (de Almeida smoothing)
  |q|   = sqrt(q_c² + q_perp_avg²)   (q_perp_avg = mean of the 4 surrounding perpendicular faces)
  q_new = (q̃ − g·hf·dt·S) / (1 + g·dt·n²·|q| / hf^{7/3})
  ```
  The implicit denominator is what makes stiff friction on thin films unconditionally stable.
* **Velocity / Froude cap (robust mode):** |q| ≤ hf · min(uMax, FrMax·sqrt(g·hf)) with uMax ≈ 15 m/s, FrMax ≈ 2.
* **Positivity-preserving flux limiter:** for every cell, outgoing volume
  `O = dt/dx · (max(qx_E,0) + max(−qx_W,0) + max(qy_S,0) + max(−qy_N,0))`, factor `k = min(1, h/O)`.
  Each face flux is multiplied by k of its **donor** (upwind) cell. Guarantees h ≥ 0 exactly without
  clamping (clamping would destroy mass).
* **Continuity:** `h_new = h + dt/dx·(qx_W − qx_E + qy_N − qy_S) + dt·(R − I) + sources`.
* **Timestep:** `dt = cfl·dx / (sqrt(g·hMax) + |u|Max)`, clamp to [0.001, 5] s. hMax/|u|Max come from the
  latest async readback, inflated by a safety margin and by any known sources of sudden depth (stage levels,
  brush water) so a stale readback can't violate CFL. The limiter + friction keep it robust even if it does.
* **Substeps:** requested sim time per frame = realDt × timeScale → n = ceil(t/dt) substeps capped by
  maxSubstepsPerFrame (and adaptively by a GPU time budget so the UI stays ≥ 30 fps). All substeps of a
  frame are encoded in one command buffer.
* **Boundaries.** 'wall': edge faces q = 0. 'open': free outflow — ghost cell with the same depth and a bed
  lowered by `dx·max(localBedSlope, 0.001)`, outflow only (never inflow). Outflow volume is accounted.
* **Rain & storms:** global rate + up to 8 storm cells (uniform array) → per-cell rate. Infiltration only
  where h > 0 and never removes more than available water.
* **Inflow sources:** up to 16. Footprint weights normalized so the injected volume is exactly Q·dt.
* **Stage sources:** cells in the footprint relax toward `h = max(0, level − z)` (relaxation factor per step,
  e.g. 1 − exp(−dt/τ) with τ ≈ 30 s, or direct set). Volume change is accounted as in/out.
* **Mass accounting:** a per-cell accounting texture accumulates in/out volume contributions (open boundary,
  infiltration, stage, limiter residue); on each readback it is copied and zeroed **in the same command
  encoder** (no lost substeps), summed on the CPU in Float64. `massError` in SimStats must be real.
* **NaN safety:** naive mode can produce inf/NaN. reset() rewrites all state textures, so it always recovers.
  Robust mode must never produce NaN (tested).
* **Readback:** every ~250–500 ms: copy depth (+ speed stats) to a MAP_READ buffer; mapAsync without
  blocking; skip if a readback is still pending. Compute stats (maxDepth, maxSpeed, volume, wetArea,
  floodedArea, courant) either on GPU (reduction pass) or CPU from the readback — keep main-thread cost
  ≲ 5 ms at 1024².
* **Export state texture** for rendering: rgba32float r=h, g=u, b=v (cell-centered, from averaged face
  fluxes / h, 0 when h < 1e-3), a = max depth since reset.
* **Brush edits (GPU compute):** capsule wall raise (barrier = max(barrier, height), smooth 1-cell edge),
  erase, water add/remove (smooth falloff), ground raise/dig. Keep CPU mirrors of ground & barrier in sync
  (apply the same math on the CPU) for picking & routing. When bed rises under water, keep h (water is lifted)
  — simple and mass-conserving.

### 3.3 'naive' stability-demo mode
Explicit friction (q −= dt·g·n²·q|q|/h^{7/3}), no limiter, no velocity cap, dt from the user's cfl even > 1
(the demo sets 1.8). It must visibly go unstable within a few seconds of sim on the Pittsburgh preset, and
the solver must not crash (validation errors) while NaNs propagate.

### 3.4 Performance target
Apple M4: 1024×1024 grid, robust mode, ≥ 30 fps with ≥ 4 substeps/frame; 512×512 ≥ 60 fps with ≥ 16.
Workgroup size 16×16. Avoid per-substep `createBindGroup` — pre-create bind groups for both ping-pong
parities. Uniforms via one writeBuffer per frame (per substep only if unavoidable).

### 3.5 Stretch (after everything else is solid)
Second-order Kurganov–Petrova central-upwind full-SWE solver (Kurganov & Petrova 2007; Brodtkorb et al.
GPU implementations) as a selectable mode for dam-break / supercritical scenarios.

---

## 4. Data (owner: data)

All endpoints verified working with CORS from localhost:
* **Elevation — USGS 3DEP ImageServer** (best available: 1 m lidar where present, else 1/3″ ≈ 10 m):
  `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox={xmin},{ymin},{xmax},{ymax}&bboxSR=3857&imageSR=3857&size={nx},{ny}&format=tiff&pixelType=F32&noDataInterpretation=esriNoDataMatchAny&interpolation=RSP_BilinearInterpolation&f=image`
  → Float32 TIFF, decode with `geotiff` (`fromArrayBuffer`). Fill no-data (≤ −1000 or NaN) by nearest
  valid neighbor diffusion. Fallback: AWS Terrarium tiles `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`
  (elev = R·256 + G + B/256 − 32768), stitched + resampled.
* **Imagery — Esri World Imagery export** (single request, exact bbox):
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox={xmin},{ymin},{xmax},{ymax}&bboxSR=3857&imageSR=3857&size=2048,2048&format=jpg&f=image`
  Attribution: "Imagery © Esri, Maxar, Earthstar Geographics".
* **Roads — US Census TIGERweb** (Overpass is blocked on our network; may work for users but not required):
  `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/{layer}/query?geometry={w},{s},{e},{n}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&outFields=NAME,MTFCC&f=geojson`
  Layers: 2 Primary Roads, 6 Secondary Roads (72k), 8 Local Roads. MTFCC S1100 → highway, S1200 → major,
  S1400 → local, others → minor. Build a noded graph: split polylines where they share vertices
  (snap/quantize coordinates to ~1 m), merge degree-2 chains, convert to grid coords, compute lengths.
  Fallback: OSM API `https://api.openstreetmap.org/api/0.6/map?bbox=...` (XML, small areas only).
* **Geocoding (location picker search):** Nominatim `https://nominatim.openstreetmap.org/search?q=...&format=json&limit=5`.
* **Projection:** grid is linear in Web Mercator (EPSG:3857). For a ground size S at latitude φ, the
  mercator extent is S / cos(φ). cellSize = S / n (ground meters).

### 4.1 Hydro-conditioning (important for realism)
USGS DEMs are **hydro-flattened**: rivers are flat surfaces at the water level, with no bathymetry. If we
don't fix this, rivers start with zero depth. For presets, burn a channel: flood-fill from river seeds over
cells with elevation ≤ poolLevel + tolerance, lower those cells by a nominal depth (e.g. 6 m for big rivers,
2 m for creeks) with a smooth bank transition over 2–3 cells, then `initialFill` at poolLevel. For live areas,
auto-detect large flat connected regions at local minima (likely water bodies) and burn 3 m.

### 4.2 Presets (baked to public/presets/<id>/ by `npx tsx scripts/bake-presets.ts`)
Files: `meta.json` (name, bounds, nx, ny, cellSize, attribution, scenario), `elevation.f32` (Float32 LE,
already hydro-conditioned), `imagery.jpg`, `roads.json` (compact). 1024×1024 each. Each must look and play
great — verify in the app with screenshots. Historical facts must be accurate; if unsure, phrase generally.

1. **`pittsburgh` — Three Rivers** (default; SteelHacks is at Pitt). ~8 km box around Point State Park
   (≈ 40.4417 N, 80.0125 W) wide enough to include downtown, the North Shore stadiums, the Strip District
   and toward Oakland/Pitt if possible. Stage sources on the Allegheny, Monongahela and Ohio where they cross
   the domain edge; stage slider in feet at the Point (flood stage 25 ft; the St. Patrick's Day flood of
   March 1936 crested at 46 ft — verify both and the gauge datum). Shelters on high ground (e.g. Cathedral of
   Learning at Pitt if inside, Mount Washington).
2. **`johnstown` — Conemaugh valley.** Johnstown, PA (≈ 40.327 N, 78.922 W), famous for the 1889 flood
   (South Fork Dam failure) and 1936/1977 floods. Inflow sources on the Little Conemaugh and Stonycreek
   rivers; big discharge slider; shelters on the hillsides.
3. **`ellicott` — Ellicott City, MD** (≈ 39.268 N, 76.798 W): flash floods on Main Street in 2016 and 2018 —
   steep, rain-driven. Storm cell over the Tiber/Hudson branch watershed, Patapsco river stage sources.
4. **`sandbox` — Synthetic valley** generated in code (no network, instant): a river valley with a town grid
   of roads, a reservoir behind a dam wall, hills. Used for tests and as an offline fallback.

---

## 5. Rendering (owner: render)

WebGPU render pipeline, MSAA 4×, HDR-ish tonemapped (ACES) output, depth buffer depth32float.
* **Terrain mesh:** index buffer only; vertex shader derives (i, j) from `vertex_index` and samples
  `bedTexture` (textureLoad). Mesh stride so vertex count ≤ ~1.1M (stride 1 at 1024², 2 at 2048²).
  Normals from central differences in the fragment shader (textureLoad neighbors + manual bilinear).
  Shading: aerial imagery (sRGB) × soft hillshade + sky ambient; if no imagery, hypsometric tint + contour
  lines. Barrier cells (barrierTexture > 0.05) look like sandbag/concrete walls. Optional contour lines.
* **Water surface:** separate mesh at η = z + h (use `stateTexture`), collapse vertices with h < ~1 cm
  slightly below terrain; fragment alpha from interpolated depth so shorelines are smooth (no stair-steps).
  'realistic' mode: Beer–Lambert absorption by depth with a muddy floodwater tint, fresnel sky reflection,
  sun specular, normals from η gradient + flow-advected ripple detail (two-phase flow-map noise driven by u,v),
  foam/whitewater where speed or Froude is high and at shorelines. Hazard modes: discrete depth bands /
  max-depth / velocity colormaps (colorblind-friendly), semi-opaque. Must look impressive in screenshots.
* **Overlays:** roads as terrain-draped ribbons (width scales with class) colored by status (dry neutral,
  wet amber, flooded red); evacuation route as a glowing animated ribbon (cyan; red pulsing when blocked);
  source markers (inflow: blue beacon; stage gauge: pole with level band), storm cells (translucent rain
  column/cylinder), shelters (green pins), evac start (house pin), wall preview ghost, brush cursor ring.
* **Rain effect:** screen-space or particle streaks scaled by rainRate.
* **Sky:** gradient + sun, distance fog/haze.
* **Camera:** OrbitController — left drag orbit (when `leftDragOrbits`), right/middle drag pan, wheel zoom to
  cursor, touch pinch/drag; smooth damping; `flyTo`, `frameAll`, `topDown`. Pitch clamp, no clipping into
  terrain.
* **Picking:** CPU ray march against ground+barrier CPU mirrors (with vertical exaggeration), refine with
  bisection; depth from latest snapshot.
* **Dev harness:** `dev/render.html` + `dev/render.ts` renders a synthetic terrain with a fake animated
  water state (no solver needed) so visuals can be iterated with screenshots.

---

## 6. Routing (owner: routing)

* Graph from RoadNetwork; per-edge sample points every ≈ 1 cell along `pts`.
* `updateFlood(depth)`: per-edge max depth over samples → status: dry (< 0.05 m), wet (0.05–0.3 m, passable
  at reduced speed), flooded (≥ 0.3 m, impassable — about where cars start to float; 15 cm moving water can
  knock people over). Must handle ~50k edges at 2–4 Hz in a few ms (typed arrays, precomputed sample indices).
* `route(start, shelters)`: snap start to nearest node on a non-flooded edge (spatial hash); multi-target
  Dijkstra/A* with travel time cost (speed by class: highway 25 m/s, major 15, minor 11, local 8; ×0.3 when
  wet). Return polyline (concatenated edge pts, oriented), length, ETA, shelter, message with a street name.
  'blocked' when no shelter is reachable (message: "No safe route — shelter in place / move to higher floors").
* Tests: synthetic grids — flooding a bridge edge reroutes; isolating the start gives 'blocked'; perf test.

---

## 7. UI (owner: ui)

Dark glassmorphism over the full-screen canvas; crisp, professional, readable at a distance (demo on a
projector). Plain DOM + one CSS file (`src/ui/styles.css`, imported by `src/ui/index.ts`). Icons as inline SVG.
* **Top bar:** logo "Deluge", scenario name, sim clock (e.g. `T+02:13:40`), play/pause, speed selector
  (1×, 10×, 60×, 300×, 1200×), reset water, FPS/substeps small readout.
* **Left toolbar:** tool buttons with keyboard shortcuts (1…0) and tooltips; contextual options row for the
  active tool (wall height slider, brush radius, discharge, storm intensity).
* **Right panel (collapsible sections):** Scenario (preset list + "Pick any US location…", scenario story,
  restore scenario); Weather & rivers (rain slider in mm/hr with labeled ticks: light 2.5, heavy 10,
  extreme 50, Harvey-class 100+; river stage slider in feet with flood stage + historic crest marks);
  Evacuation (status card: route length/ETA/shelter or big red "NO SAFE ROUTE"; hint to use Evac tool);
  View (water mode segmented control + legend; vertical exaggeration; imagery/roads/contours toggles;
  frame all / top-down); Advanced (Manning n, infiltration, boundary open/wall, CFL, clear walls, reset all).
* **Stats HUD (bottom left):** flooded area (km² + acres), water volume, max depth, max speed, mass-balance
  error (e.g. `0.003 %`), dt, substeps, Courant number, sim speed achieved.
* **Probe readout** following the cursor for the probe tool (and always small in HUD).
* **"How it works" modal** — the judge explainer: equations (nicely typeset with HTML/CSS), the 4 stability
  ingredients each with a one-line why, a pipeline diagram of GPU passes per substep, data sources, and the
  "Break it" button that toggles the stability demo. Plain language first, math second.
* **Location picker modal:** Leaflet map (Esri imagery tiles + label overlay), search box (Nominatim),
  square selection preview of the chosen size (2/5/8/12 km), resolution (512/1024/2048), Load button with
  progress. US-only note (USGS 3DEP).
* **Loading overlay** with progress + messages; **error toast**; **WebGPU-unsupported** screen.
* **Help overlay** (`?`): shortcuts + 30-second "try this" guide.
* **Tool controller** (`src/ui/tools.ts`): pointer handling on the canvas per ToolId; sets
  `renderer.camera.leftDragOrbits = (tool === 'orbit')`; wall tool: drag to add points (min spacing ~1 cell),
  preview while dragging, commit capsule segments on pointerup via `solver.applyBrush`; shift-click to extend
  the last wall; brush radius in meters → cells via cellSize. Also keyboard shortcuts.
* **Dev harness:** `dev/ui.html` mounts the UI with a fake store/actions over a dummy canvas.

---

## 8. App wiring (owner: app)

`src/main.ts` → `src/app/App.ts`:
1. `createDelugeDevice(navigator.gpu)`; on failure show unsupported screen. Hook `device.onuncapturederror`
   and `device.lost` → console.error + `__deluge.errors` + error toast.
2. Create store with defaults, renderer, router, mount UI, tool controller. Load default preset
   (`?preset=` URL param override, default `pittsburgh`). Handle load failure → fall back to `sandbox`.
3. On terrain load: destroy old solver, `createSolver`, `setInitialWater(computeInitialWater(...))`, set
   sources (stage levels = base + stageOffset), storms, renderer.setScene, router.setNetwork, camera pose.
4. Frame loop (rAF): dt clamp ≤ 0.1 s; if not paused `solver.step(dt)`; poll `getSnapshot()` — when a new
   one arrives: router.updateFlood + route (≤ 4 Hz), store stats/route; build OverlayState (+ tool transient);
   renderer.render. FPS smoothing. Throttle store updates for HUD to ~5 Hz.
5. Store subscriptions push param changes into the solver (sim params, rain, sources, storms, stage offset →
   stage source levels).
6. Install `window.__deluge` (DelugeDebugAPI) for automation.
7. `index.html`: canvas + UI root, title, favicon (inline SVG data URI), meta description, fonts via system
   stack (no external fonts required).

---

## 9. Quality bar / definition of done

* `npx tsc --noEmit` clean; `npx vite build` succeeds; zero console errors / WebGPU validation errors in the
  app for all presets and all tools.
* Solver tests pass: lake-at-rest (well-balanced, |u| < 1e-3 m/s after 2000 steps on rough terrain),
  closed-domain mass conservation (rel. error < 1e-4), no negative depths, no NaN in robust mode under heavy
  rain on steep terrain, dam-break front propagates at a plausible speed vs the Ritter solution (within
  ~15%), wall blocks flow, inflow volume accurate to < 0.5%, open-boundary outflow balances rain at steady
  state (< 5%).
* Judge flows work end-to-end (verified by e2e script + screenshots): (1) open app → Pittsburgh loads with
  full rivers in < 5 s; (2) raise stage to 1936 crest → downtown floods progressively; (3) draw a levee → flow
  visibly reroutes; (4) crank rain → streets pond; (5) set evac start → route shows, reroutes / goes red as
  roads flood; (6) stability demo breaks and recovers; (7) pick a live location → loads real data.
* Visually impressive: beautiful water, readable UI, no z-fighting, no shoreline stair-steps, no flicker.
* Performance targets in §3.4.

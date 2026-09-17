# Deluge: presenter kit

This is for the people presenting Deluge to judges. Every number here comes from the code, the tests, [README.md](README.md),
[ARCHITECTURE.md](ARCHITECTURE.md), or a rehearsal on the demo laptop (MacBook Air M4, macOS 15.6, 1470×956 at 2×,
offline, real clicks) on 17 Sep 2026. The rehearsal ran in headless Chromium and in headless Brave on the laptop's own GPU.

Contents: [1 Checklist](#1-before-judging-checklist) · [2 Three-minute pitch](#2-the-three-minute-pitch) ·
[3 Sixty-second version](#3-the-sixty-second-version) · [4 The hard part](#4-the-hard-part) ·
[5 Judge Q&A](#5-judge-qa-crib-sheet) · [6 Known limitations](#6-known-limitations-say-these-first)

---

## 1. Before judging (checklist)

### While you still have internet (the day before)

- [ ] `npm ci` in the repo (the only step that needs the network).
- [ ] `npm run demo` once, then open http://localhost:4173 and click through section 2.

### At the table, 10 minutes before

**Power**

- [ ] Plug in the charger.
- [ ] **Turn Low Power Mode off:** System Settings → Battery → Low Power Mode → **Never**. On this laptop it is currently on
  for battery *and* for the power adapter (`pmset -g custom` shows `lowpowermode 1` under both), so plugging in does not
  turn it off. To check, run `pmset -g | grep lowpowermode`. It should print `0`.
  Low Power Mode and browser energy savers can cap the page at 30 fps. The app detects the cap and keeps running
  (ARCHITECTURE §8), but 60 fps and full sim speed need mains power.
- [ ] Keep the screen awake: in a Terminal tab run `caffeinate -dis` and leave it running. The display currently sleeps
  after 2 min on battery and 10 min on the adapter.
- [ ] **Keep the lid open.** Closing it puts the Mac to sleep, and waking it resets the GPU device (recovery is covered below).

**A quiet GPU**

- [ ] Quit everything else that uses the GPU: other tabs with maps, video or 3D, video calls, screen recorders, and
  IDE previews. Don't run `npm run e2e`, `npm run bench` or `npm test` during judging.
- [ ] Why it matters (measured): during one rehearsal, other GPU test runs were going on this laptop. Frames still held
  50–60 fps, but sim speed fell from 60–116× to 7–20×, and the levee beat took ~26 s instead of a few seconds.

**Server (offline)**

- [ ] In Terminal: `cd` into the repo, then `npm run demo`. It builds and serves at **http://localhost:4173**. Leave that
  terminal open. If port 4173 is busy, use `npm run demo -- --port 5000`.
- [ ] Wi-Fi can be on or off. The built-in scenarios never use the network: the rehearsal blocked every non-localhost
  request and none were attempted, and `node scripts/e2e.mjs --prod` passes offline.

**Browser: use Brave**

- [ ] Chrome is not installed on this laptop, but **Brave** is (1.94, Chromium 152). A fresh Brave profile on this laptop runs
  Deluge **with no flags**: the WebGPU adapter was `apple metal-3` (not a fallback adapter), the scene loaded and there were no errors.
- [ ] **Don't use Safari on this laptop.** It is Safari 18.6, and Deluge needs Safari 26+ (README). Safari 18 keeps WebGPU
  behind *Develop → Feature Flags*, and we haven't tested that.
- [ ] In Brave Settings, search for "energy" and turn Energy Saver off. Shields don't matter because everything comes from localhost.
- [ ] If you see "This browser can't run Deluge (yet)": turn on `brave://settings/system` → *Use graphics acceleration when
  available*, then relaunch. `brave://gpu` should list WebGPU as hardware accelerated.
- [ ] Backup browser: Playwright's Chrome for Testing also runs Deluge with no flags (tested headless only, not in a normal window):
  `open -na "$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app" --args http://localhost:4173/`

**The page**

- [ ] Open http://localhost:4173/. The address changes to `?preset=pittsburgh`. **Load it once before the first judge
  arrives.** The first load in a new browser profile took ~10 s in rehearsal. Reloads take 1.5–2.5 s.
- [ ] Full screen with Ctrl-Cmd-F, zoom at 100 % with Cmd-0. The UI was rehearsed at 1470×956 and also fits a windowed Brave (~1470×868).
- [ ] Check the start screen:
  - top right reads ≈ 60 fps
  - the LIVE SOLVER panel at bottom left shows Mass error `<0.001 %`
  - the *Try it* strip at the top shows **Raise to 1936 record · Evacuate · Build a levee · Hurricane rain · Break it**

### Reset between judges

**Press Cmd-R.** A reload is the clean reset. Measured: a running scene in 1.5–2.4 s, with the river back at 16 ft, speed at
60×, no walls, no route, the Try-it steps unchecked, and the strip back even if it was closed. `R` only resets the water:
walls stay, and a raised river rises again.

While waiting for the next judge, press **Space** to pause (a paused view goes idle, per e2e flow 10). The Air has no fan and slows down when it
gets hot (ARCHITECTURE §8.1). Press Space again as the judge walks up.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| "Lost connection to the GPU" card with a countdown | Nothing: it reloads itself (measured: running again in ~6 s). Tell the judge: "the GPU driver reset; the simulation lives on the GPU, so it restarts." |
| The same card again within a minute, no countdown, "reset again after restarting" | Quit other GPU apps and click **Reload** (measured: back in ~7 s). If it keeps happening, open a new tab at localhost:4173 (the reload guard is per tab) or relaunch Brave. |
| Brave's own crash page, or a blank page | Cmd-R. |
| "This site can't be reached" | The `npm run demo` terminal was closed. Run it again. |
| ~30 fps in the top right | Low Power Mode or Energy Saver is on (see Power). The demo still works. |
| Sim speed in single digits, HUD says "GPU-limited" | Something else is using the GPU, or the Air is hot. Keep talking: every beat still happens, just more slowly. |
| The Try-it strip is gone | Cmd-R. |
| Nothing moves | Press Space (the play/pause button is in the top bar). |

---

## 2. The three-minute pitch

Start from a freshly reloaded Pittsburgh, running (not paused), with the pointer away from the strip. The *Say* lines are
suggestions. The *If not* lines are what to do when a beat doesn't appear.

Timings were measured in the rehearsal. The GPU was sometimes shared with other test runs; that is noted where it made
things slower.

### Beat 1 · 0:00–0:20 · Hook

- **Click:** nothing. You can drag to orbit a little.
- **Say:** "This is downtown Pittsburgh built from real USGS elevation data: a million cells, 7.8 m each, 8 km across. The
  water in those rivers is being solved right now on this laptop's GPU with the shallow-water equations, in a browser
  tab, offline. There's no AI model anywhere in it."
- **Judge sees:** a 3D city with three rivers at normal pool (16 ft), ≈ 60 fps at top right, and the LIVE SOLVER HUD at bottom left.
- **If not:** black canvas or an error card → Cmd-R.

### Beat 2 · 0:20–0:50 · The 1936 flood

- **Click:** **Raise to 1936 record**.
- **Say:** "March 1936, the St. Patrick's Day flood: the Point gauge hit 46 feet. We raise the river along its whole
  length. That part is a time-lapse, minutes instead of 30 hours. From there the flood is solved at real speed." As it
  spreads: "The Point, the North Shore stadiums, the Strip District. Roads turn orange when they're wet and red when a car
  would float." Point at the HUD: "Mass error stays under a thousandth of a percent. Every cubic metre in and out is
  accounted for."
- **Judge sees:**
  - a pill reading "River rising … ft → 46.0 ft" and the stage slider moving to 46
  - measured: 46 ft and ~4 km² of flooded land 3 s after the click, ~6 km² by 10 s (sim speed 80–116×)
  - red roads, and something like "60 fps · 6.5 sub · 81×" at top right
  - [picture](docs/hero-1936-crest.jpg)
- **If not:** if nothing moves after 5 s, check the top bar isn't paused (Space). If sim speed reads single digits, the flood
  is still coming: with a shared GPU at ~10× it took ~20 s. Keep talking.

### Beat 3 · 0:50–1:10 · Evacuate

- **Click:** **Evacuate**.
- **Say:** "Now people. Deluge has the real road network from the Census Bureau. This is the fastest drive from a downtown
  street to the nearest dry shelter. It avoids any road under 30 cm of water and re-plans as the water moves."
- **Judge sees:**
  - a blue route from a yellow start marker to a green shelter pin
  - a chip at the bottom, e.g. "SAFE ROUTE TO Hill District high ground · 2.2 km · 5 min" (at the crest)
  - a notice: "Evacuation route planned"
  - if the river is still rising, the chip later reads "RE-PLANNED"
  - [picture](docs/demo-evacuate.jpg)
- **If not:** if a notice says "Click a home on the map", click a downtown street. A red "no safe route" chip is also a good
  moment: "every way out is flooded, so shelter in place."

### Beat 4 · 1:10–1:55 · Build a levee

- **Click:** **Build a levee**.
- **Say:** "The planner's question: what if the North Shore had a floodwall? This builds a 2.4-kilometre wall whose top is a
  metre above the 1936 record, resets the flood, and replays the rise with the wall in place." Once the green shows:
  "Green is land that would be under water at this level without the wall, about 140 acres and 11 km of streets. It's
  recomputed about once a second from the live water. And watch the evacuation route re-plan as the water comes back."
- **Judge sees:**
  - the camera flies to the North Shore, with the notice "Building a 2.4 km levee along the North Shore"
  - a tan wall rises over ~2 s and the river rises again
  - PNC Park and Acrisure Stadium stay dry under a green tint
  - a pill reading "Walls keep … acres dry · … km of streets" (measured: peaked at 147 acres, settled at 134–144 acres and ~11 km)
  - a notice: "The levee is holding"
  - [picture](docs/levee-north-shore.jpg)
  - measured with a shared GPU at 8–30×: wall up ~4 s after the click, green count at ~12–15 s, 46 ft at ~18–26 s. A quiet GPU should be quicker, because the rise is only 3.7 simulated minutes.
- **If not:** while the button shows a spinner, don't click again. If there's no green after ~25 s, check sim speed (Beat 2)
  and fill the time by explaining how the number is computed (Q9).

### Beat 5 · 1:55–2:30 · Break it

- **Click:** **Break it**. After ~5 s, click **Restore robust solver** in the red banner at the bottom.
- **Say:** "Why is this hard? This swaps in the textbook explicit scheme: explicit friction, no flux limiter, no smoothing,
  and a time step past its stability limit. One small splash, and within about ten steps it blows up. Depths go to
  infinity and the HUD says the numbers aren't physical." After restoring: "Switch back, and the robust solver just runs."
- **Judge sees:**
  - the HUD turns red with "Diverged" within ~1 s (measured 0.8 s)
  - spikes, then magenta speckle (infinite or NaN depths) spreading along the river from the middle of the view
  - a banner: "Stability demo — naive explicit solver at Courant 1.8"
  - [picture](docs/demo-break-it.jpg)
  - after Restore: the water resets at once (measured 0.2 s) and the river rises back to 46 ft with the levee still standing
- **If not:** if there's no magenta in view, the HUD still says Diverged. Press F to frame the whole map.

### Beat 6 · 2:30–3:00 · The hard part, and close

- **Click:** **How it works** (top right), then the *Why it's hard* chip. Press Esc to close.
- **Say:** the 30-second plain version from section 4, then: "Real terrain and real physics, checked against analytic solutions and
  National Weather Service flood reports, at 60 frames a second on a MacBook Air. That's Deluge."
- **Judge sees:** "Four ingredients that keep it stable at interactive speed", with the four formulas.
- **If not:** skip the dialog and just say it.

---

## 3. The sixty-second version

| Time | Click | Say |
| --- | --- | --- |
| 0:00–0:08 | nothing | "Real USGS terrain of Pittsburgh: a million cells, with the shallow-water equations solved live on this laptop's GPU, in a browser, offline." |
| 0:08–0:25 | **Raise to 1936 record** | "The 1936 flood, 46 feet at the Point. The rise is a time-lapse; the flood is real physics. Mass error stays under 0.001 %." |
| 0:25–0:45 | **Build a levee** | "A 2.4 km floodwall on the North Shore, then the rise again: green is the ~140 acres it keeps dry, computed from the live water." Move on as soon as the green count appears. |
| 0:45–0:57 | **Break it**, then **Restore robust solver** | "The textbook scheme blows up in seconds. Ours doesn't: an adaptive time step, friction that can only slow water, a limiter that never lets depth go negative, and still water that stays still, all in parallel on the GPU." |
| 0:57–1:00 | none | "That's Deluge." |

---

## 4. The hard part

### 30 seconds, plain language

"Simulating water on real terrain on a GPU wants to blow up. The rivers are 6 metres deep and fast, the streets carry films a
centimetre thick, walls are one cell wide, and the GPU updates a million cells at once in 32-bit numbers. Four things keep
it stable:

- the time step adapts, so no wave ever jumps more than a cell
- friction is computed so it can only slow water down
- a cell can never give away more water than it holds, so depth never goes negative and no water is created
- a still lake on a hillside stays still

On top of that, we account for every drop, and the mass error in the HUD shows it."

### 90 seconds, technical

Each point matches the code (`src/sim/Solver.ts`, `src/sim/shaders/momentum.ts`, `continuity.ts`, `common.ts`, `stats.ts`).

1. **Scheme.** A 2-D shallow-water model on a staggered grid:
   - depth `h` at cell centres; unit discharge `qx` on east faces and `qy` on south faces
   - state lives in one `rgba32float` texture `(h, qx, qy, z − z0)` that ping-pongs every substep
   - the base is the local-inertial scheme of LISFLOOD-FP-class models (Bates 2010, de Almeida 2012), **plus** first-order upwind
     convective acceleration. Without that term, a dam-break front runs at 0.48× the true speed with a 15 % profile error. With it, the
     front ratio is 1.01 and the error is 1.6 % against the Ritter solution.
2. **Explicit, CFL-limited time step.**
   - `dt = Cr·dx / (√2·max_cells(√(g·h) + |u|))`, using the two-dimensional Courant number.
   - A von Neumann analysis of this forward–backward scheme shows the grid checkerboard is the worst mode. The limit is
     `Cr ≤ 1`, or `≤ √θ ≈ 0.89` with our smoothing (θ = 0.8). We target 0.7 and cap at 0.85, and the HUD usually reads ≈ 0.55.
   - The maxima come from asynchronous GPU readbacks that are ~300 ms old. So they're inflated (×1.25 + 0.1 m/s) and combined
     with what we know is coming: stage raises, brush edits, inflows, rain runoff.
   - A per-face **local Courant guard** in the shader scales that face's momentum step by `(Cr_max/Cr_f)²` if an estimate is stale.
3. **Semi-implicit friction.**
   - `q_new = (q̃ − dt·A − g·h_f·dt·∂η/∂x) / (1 + g·dt·n²·|q| / h_f^{7/3})`.
   - Explicit Manning friction is stiff on thin films: its decay rate grows like `h^{−4/3}`, so an explicit step overshoots and
     reverses the flow. Dividing by a factor ≥ 1 can only slow water down, for any `dt`.
   - `q̃ = q + (1−θ)/2 · minmod(L, G)` damps divergent grid-scale noise, but not flow turning at stair-step banks. Before the minmod,
     diagonal channels ran 3–5× too deep.
4. **Positivity-preserving flux limiter (wetting and drying).**
   - For each cell, `O = dt/dx · Σ outgoing |q|` and `k = min(1, h/O)`. Every face flux is scaled by `k` of its *donor* cell.
   - Depth stays ≥ 0 by construction. There's no clamping that could create water: the only leftover is Float32 rounding
     (~10⁻⁹ m), which is booked. Both cells use the same limited flux, so the update is conservative.
   - Computing a neighbour's `k` needs a 13-texel stencil. Faces with `h_f < 10⁻⁴ m` carry no flux.
5. **Well-balanced face depth.**
   - `h_f = max(η_L, η_R) − max(z_L, z_R)`, with the slope written `((z_R − z_L) + (h_R − h_L))/dx` so bed differences cancel first.
   - A lake at rest on rough terrain stays at rest: max |u| = 9.3·10⁻⁵ m/s after 2000 steps.
   - Water can't leak through the top of a wall.
6. **Exact mass accounting.**
   - A per-cell storage-buffer ledger books rain, sources, stages, infiltration, boundary outflow, brush edits, and the GPU's
     own Float32 rounding.
   - The volume through a face, `dt/dx·q`, is one Float32 product that both neighbouring cells compute identically, so interior exchanges cancel exactly.
   - Increments are snapped with `round()` onto the Float32 ULP grid of the largest value in the sum, so the new depth is exact
     and the ledger books exactly what was applied. What the snap trims off the face volumes is booked as signed inflow.
     Metal's compiler folds `(h+Δ)−h` into `Δ`, so the rounding can't be measured after the fact.
   - A reduction pass sums the ledger per 16×16 block. The ledger is copied and zeroed in the same command encoder, then added
     up in Float64 on the CPU: `massError = |V − (V0 + Vin − Vout)| / max(1 m³, V0, peak V)`.
   - Tests: 7·10⁻⁹ in a closed domain; 5.9·10⁻⁷ after 3 simulated hours of river, rain and stage boundary.
7. **Parallel GPU passes.**
   - Each substep is two full-grid compute passes in 16×16 workgroups:
     - **A, momentum:** state → face fluxes
     - **B, continuity:** limiter, depth update, rain, sources, stages, boundaries, ledger
   - Each cell reads its neighbours from the previous texture and writes only itself, so there are no races.
   - All substeps of a frame go into one compute pass. The CPU only picks `dt`, writes a 112-byte uniform and submits.
   - ~1.6–2.0 ms of GPU time per substep at 1024² on the M4. A governor sets substeps per frame from frame time and GPU queue
     latency. Stats come back via `mapAsync` about every 300 ms and never block a frame.

---

## 5. Judge Q&A crib sheet

**1. Is this accurate?**
For floodplain inundation at city scale, reasonably. We checked it two ways:

- against analytic and physical benchmarks (Q2)
- against National Weather Service impact statements for the Pittsburgh Point gauge (PTTP1), holding each stage for 15 simulated minutes:
  - the water surface at the Point stays within 3 cm of the gauge reading at every stage from 28 to 46 ft
  - Point State Park floods at 31 ft (NWS: 30)
  - Federal Street at PNC Park is wet at 40 ft (NWS: 40)
  - there's 15.7 ft of water at Point State Park at 46 ft (NWS: "up to 15 ft in the Golden Triangle")
  - misses: Acrisure Stadium field and the Station Square tracks first get wet at 40 ft (NWS: 30–31), the Wood Street T station
    only at 46 ft (NWS: 28), and the Parkway "bathtub" stays dry at 46 ft (NWS: 25). Those places flood through storm drains
    and underpasses that bare-earth elevation doesn't contain.

It isn't calibrated against a measured flood hydrograph, so it's a tool for exploring and understanding, not for engineering decisions.

**2. How do you validate it?**
`npm test` runs the solver suites on the real GPU (through Dawn). We re-ran them on this laptop today:

| Check | Result |
| --- | --- |
| Lake at rest on rough terrain, 2000 steps | max \|u\| = 9.3·10⁻⁵ m/s |
| Dam break vs Ritter at t = 20 s | L1 1.6 %, front ratio 1.01, depth at the dam 0.443 (exact 0.444) |
| Mass error, closed domain | 7.0·10⁻⁹ |
| Mass error, open domain with rain, storm, inflow, stage, infiltration | 9.1·10⁻⁸ |
| Mass error, deep river with rain and a stage boundary, 3 simulated hours | 5.9·10⁻⁷ |
| Rain on a tilted plane at steady state | outflow / rain = 1.000 |
| Walled channels at 0 / 30 / 45 / 60° to the grid | depth / Manning normal depth 0.98 / 1.05 / 1.04 / 1.05 |
| GPU Float32 vs a Float64 CPU reference, 5 cases × 400 steps | max \|Δh\| ≤ 4.3·10⁻⁵ m |

On top of that, 12 end-to-end flows run in headless Chromium on the real GPU, offline, and the live HUD shows the mass error the whole time.

**3. Why not a full shallow-water Riemann solver (HLL, Roe, Kurganov–Petrova)?**
The local-inertial scheme is what production flood-inundation models such as LISFLOOD-FP use, and we add advection to it. It needs two
small-stencil passes per step, which leaves budget for a million cells at 60 fps, and it matches Ritter within 1.6 %. A
Riemann-type second-order scheme does more work per cell (reconstruction and flux evaluation, usually a two-stage time
step); we haven't benchmarked one here. Its advantage is strongly supercritical flow: hydraulic jumps and violent dam breaks.
That's exactly our stated limitation, and a Kurganov–Petrova mode is first on the future-work list (ARCHITECTURE §10).

**4. Isn't "Break it" rigged?**
It deliberately runs the textbook scheme at Courant 1.8, past its stability limit of 1, so the failure happens on screen in
seconds. It removes all four ingredients at once. It demonstrates why each one exists; it isn't a benchmark against a tuned
naive solver. The ingredients also matter at time steps a textbook would call safe. A test shows that a 1-D CFL of 0.7 (2-D
Courant 0.99, above the √θ ≈ 0.89 limit once smoothing is on) sloshes forever without the local guard. Explicit friction
overshoots on thin films at any practical `dt`.

**5. What about storm drains, buildings and bridges?**
None are modelled. The terrain is bare earth: water flows through city blocks and under viaducts. Drains and culverts are
missing, so road embankments dam small creeks under heavy rain (8.5 m of water behind I-376 in Saw Mill Run at 100 mm/hr).
Roughness is a single Manning's n = 0.035 for the whole map (adjustable under Advanced). Culverts and storm drains are on the future-work list.

**6. How big is the grid, and how fast?**

- **Grid:** the presets are 1024 × 1024 = 1,048,576 cells (Pittsburgh: 7.8 m cells over 8 km). Live areas are 1–20 km and default to
  1024²; 2048² is accepted but hasn't been benchmarked.
- **Speed on this laptop:** production build on the 1936 crest with 50 mm/hr rain gives 60 fps, a p95 frame of ≈ 19 ms, and 57–71× real time.
  In a 10-minute sustained run at 1600×1000, every minute stayed at 60 fps and 66–70×.
- **Cost per substep:** ~1.6–2.0 ms of GPU time.
- **Throughput:** at 5–6 substeps per frame that's roughly 300–400 million cell updates a second. *How it works* shows the live figure.

**7. Why WebGPU?**

- Compute shaders in a browser tab mean no install, and the same code runs on Metal, Vulkan and D3D12.
- WebGL2 has no compute shaders and no read-write storage buffers, and the mass ledger is one.
- Each cell only needs its neighbours, so the problem is embarrassingly parallel. One substep over a million cells takes
  ~2 ms of GPU time on the M4.
- A server-side GPU would need a network, and the demo has to work offline.

**8. Why does the river rise so fast?**
The rise is a time-lapse: 3 m per simulated minute, so the 1936 crest arrives in about 3.7 simulated minutes. That's
roughly 600–850× faster than the real rise, which took about 30 hours. Everything after that is solved at its real speed. While
the river rises, the side panel says "time-lapse" under the stage slider.

**9. Is the "acres kept dry" number real?**
It's an estimate from the live water, not a second simulation. About once a second, in a Web Worker, it takes the water pressing on the
wall and spreads it over the land below its level twice: once with the walls and once without. Land that would be ≥ 0.3 m deep
without the walls, isn't with them, and is dry now counts as protected. It ignores how long water leaking through a gap
would take to fill the land behind it. At the crest it settles around 139 acres and 11 km of streets, and flooded land
drops from 6.3 to 5.6 km² (e2e flow 13; rehearsal: 134–144 acres).

**10. How does evacuation routing work?**

- Road flood status is refreshed up to 4 times a second from the depth readback:
  - wet (≥ 5 cm): passable at 30 % speed
  - flooded (≥ 30 cm, roughly where cars float): closed
  - bridges stay open until their approaches flood
- A multi-target Dijkstra on travel time (highway 25 m/s, major 15, minor 11, local 8) finds the nearest reachable dry
  shelter. Roads are Census TIGER/Line.

**11. How do rivers work with elevation data that has no riverbed?**
3DEP rivers are hydro-flattened, so we burn channels in to a nominal depth (6 m in Pittsburgh), using centreline waypoints and a
pool level measured from the elevation data.

Each river gets a "stage disc" where it crosses the map edge, which sets its water level. The upstream discs sit slightly above the
gauge level and the downstream one slightly below (±0.075 m at normal pool, ±0.2 m at 46 ft), so all three rivers keep flowing downstream.

Other map edges let water leave at normal flow or at the speed it arrives, capped at critical flow. River speeds and
discharges are approximate: at the 1936 crest they're lower than the record.

**12. Where does the data come from? Licensing?**

- **Offline presets:** only public-domain U.S. government data. USGS 3DEP elevation, USDA NAIP imagery (via The National Map),
  Census TIGER/Line roads, and NWS/USGS flood stages and crests.
- **Live areas:** Esri World Imagery at runtime (Esri's terms apply). Fallbacks are Mapzen Terrarium elevation (AWS Open Data) and
  OpenStreetMap roads (ODbL). Place search uses Nominatim.
- **Code:** MIT. Full list in README → *Data and attribution*.

**13. How can the mass error be 10⁻⁷ in 32-bit floats?**
The error isn't measured after the fact. It's booked as it happens (section 4, point 6). Neighbouring cells compute each face
volume identically, so exchanges cancel bit for bit. Every increment is snapped so the new depth is exact, what the snapping
removes goes into the ledger, and the CPU sums the ledger in Float64. The first version measured `(h+Δ)−h`. Metal folded that to `Δ`, and after hours at the crest the
HUD turned yellow; snapping fixed it.

**14. Does it run on other machines?**
Any browser with WebGPU: Chrome or Edge 113+, Safari 26+, Firefox 141+ on Windows (per the unsupported-browser screen).
We've only measured performance on an Apple M4. The app adapts substeps and render resolution to measured frame time and GPU
latency. In a test that emulated a GPU ~35 % slower, frames held at 58–60 fps while sim speed fell to ~15–20× (ARCHITECTURE §8.1).

**15. Can it do my town?**
Any US location, via *Pick any US location…* or `?live=lat,lon,km`, but it **needs internet** (USGS, Esri, TIGERweb). It's built to
load a 1024² area in under ~15 s on a healthy connection. On stalled wifi it gives up in ~12–15 s and offers the offline
scenarios. If no river crosses the map edge, the first button drops a 120 mm/hr thunderstorm over the view instead. Only
try this at the venue if you've tested the network there. Offline alternatives: *Scenario → Change* → Johnstown (the 1889
flood, modelled as a 3,730 m³/s inflow down today's valley, not a dam-break simulation) or Ellicott City (the 2016 flash-flood storm).

**16. What did AI write?**
Answer honestly. We built Deluge with heavy use of AI coding assistants for writing, testing and reviewing the code and docs.
The No Wrapper track allows that. **The product itself contains no language model and no machine learning:** it makes no model or AI
API calls, its only runtime dependencies are `geotiff` and `leaflet`, and every number on screen comes from the solver.
The GPU tests against analytic solutions and a Float64 reference are how we made sure generated code is right, not just plausible.
Then say concretely what each of you decided, checked or debugged, and don't downplay the AI's share.

**17. What was the hardest bug?**
Pick one:

- The Courant number has to be two-dimensional. A 1-D formula at 0.7 sits right on the 2-D stability limit, and deep water sloshed forever.
- The Metal compiler folded away our rounding measurement (Q13).
- Rivers running diagonally across the grid came out 3–5× too deep because smoothing treated the stair-step banks as drag. The minmod limiter fixed it.
- Momentum coasted across the Ohio's stage disc and came out of its rim as an 8 m/s jet. The fix makes the disc forget its discharge.

**18. What's next?**

- A Kurganov–Petrova second-order solver mode for dam breaks and supercritical flow
- Measured channel bathymetry
- Culverts and storm drains
- Coverage beyond 3DEP
- Baking the forcing into a texture (about half of the continuity pass is ledger writes and source loops)

**19. Is the terrain exaggerated?**
In the picture, yes: 1.5× vertically by default (adjustable in the side panel's View section). It's rendering only. The solver uses true elevations.

---

## 6. Known limitations (say these first)

- **Bare earth.** There are no buildings, bridge decks, culverts or storm drains. Water flows through blocks, and embankments dam creeks under heavy rain.
- **No riverbed data.** Channels are burned in to a nominal depth (6 m in Pittsburgh), so river volumes and speeds are approximate.
- **One roughness value** (Manning's n = 0.035) for the whole map. There's no land-cover map.
- **The rise is a time-lapse**, ~600–850× faster than 1936. The flood after it runs at real speed.
- **The scheme is first order**, which is good for floodplain inundation and weaker for hydraulic jumps and violent dam breaks.
- **1936 discharges are lower than the record.** River stages are imposed at the map edges with a small head to keep the rivers moving.
- **Protected land is a still-water estimate.** It ignores how long a gap would take to fill. The number overshoots while the flood is still spreading and then settles.
- **Not calibrated** against a measured flood hydrograph. The NWS comparison is by stage, and some impacts miss (Q1).
- **Performance has been measured only on an Apple M4.** A hot, fanless Air loses sim speed before it loses frame rate.
- **Live areas need internet** and get full quality only in the US (USGS 3DEP). Elsewhere a coarse fallback is used.

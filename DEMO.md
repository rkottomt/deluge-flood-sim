# Deluge: presenter kit

For the people presenting Deluge to judges. Every number below comes from the code, the tests,
[README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), or a rehearsal on the demo laptop itself (MacBook Air M4,
macOS 15.6): production build, headless Chromium on the laptop's own GPU, 1470×956 at 2×, offline, real clicks,
17 Sep 2026. Where a rehearsal ran on battery or while other GPU jobs were running, the numbers say so.

[1 Checklist](#1-before-judging) · [2 Three-minute pitch](#2-the-three-minute-pitch) ·
[3 Sixty-second version](#3-the-sixty-second-version) · [4 The hard part](#4-the-hard-part) ·
[5 Judge Q&A](#5-judge-qa-crib-sheet) · [6 Known limitations](#6-known-limitations-say-these-first)

---

## 1. Before judging

### The day before, with internet

- [ ] `npm ci` in the repo. This is the only step that needs the network.
- [ ] `npm run demo`, open http://localhost:4173 in Brave, and click through section 2 once.

### At the table, 10 minutes before

**Power.** Low Power Mode and heat cost sim speed long before they cost frame rate.

- [ ] Plug in the charger.
- [ ] **Turn Low Power Mode off.** System Settings → Battery → Low Power Mode → **Never**. On this laptop it is set on
  for battery *and* for the adapter, so plugging in does not turn it off. Check in Terminal:
  `pmset -g | grep lowpowermode` must print `0`.
- [ ] Keep the screen awake: run `caffeinate -dis` in a Terminal tab and leave it running. The display otherwise sleeps
  after 2 min on battery and 10 min on the adapter.
- [ ] **Keep the lid open.** Closing it sleeps the Mac, and waking it can reset the GPU (see *If something goes wrong*).

**A quiet GPU.**

- [ ] Quit everything else that draws on the GPU: other browser tabs with maps, video or 3D, video calls, screen
  recorders, IDE previews.
- [ ] Don't run `npm test`, `npm run e2e` or `npm run bench` during judging.
- [ ] Why, measured on this laptop: with the GPU to itself the flood ran at 80–116× and a reload took 1.5 s. With other
  headless browser tests sharing the GPU (and on battery), frames mostly still held 50–60 fps, but sim speed fell to
  7–33×, a reload took up to 12 s, and the river took 16 s instead of 3 s to reach the 1936 crest.

**Server.**

- [ ] Terminal: `cd` into the repo, `npm run demo`. It builds, then serves **http://localhost:4173**. Leave it open.
  If 4173 is busy: `npm run demo -- --port 5000`.
- [ ] Wi-Fi on or off doesn't matter. The rehearsal blocked every non-localhost request and the built-in scenarios made
  none; `node scripts/e2e.mjs --prod` passes offline.

**Browser: Brave, no flags.**

- [ ] Use **Brave** (installed: 1.94 on Chromium 152). Chrome is not installed. On this laptop Brave with no flags gets a
  real WebGPU adapter (`apple metal-3`, not a fallback), loads the scene with no errors, and passes 11 of the 12
  offline e2e flows headless (the miss is flow 12, cancelling a `?live=` download, which the pitch doesn't use).
- [ ] **Not Safari.** It is Safari 18.6; Deluge supports Safari 26+ (README). Safari 18 keeps WebGPU behind
  *Develop → Feature Flags* and that path is untested.
- [ ] Brave Settings → search "energy" → turn **Energy Saver** off (it caps pages at 30 fps). Shields don't matter:
  everything is served from localhost.
- [ ] If Brave shows "This browser can't run Deluge (yet)": `brave://settings/system` → *Use graphics acceleration when
  available* on, relaunch, and check `brave://gpu` lists WebGPU as hardware accelerated.
- [ ] Backup browser: Playwright's Chrome for Testing (also no flags, also `apple metal-3`; tested headless only):
  `open -na "$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app" --args http://localhost:4173/`

**The page.**

- [ ] Open http://localhost:4173/ (the address becomes `?preset=pittsburgh`) **before the first judge arrives**, and watch it
  run for a minute.
- [ ] Full screen (Ctrl-Cmd-F) at 100 % zoom (Cmd-0). The rehearsal viewport was 1470×956, which is full screen on this Air.
- [ ] The start screen should show:
  - top right: ≈ 60 fps
  - bottom left, LIVE SOLVER: Mass error `<0.001 %`, Sim speed `60×`
  - top centre, *Try it*: **Raise to 1936 record · Evacuate · Build a levee · Hurricane rain · Break it**
  - right panel: River stage **16.0 ft**

### Reset between judges

**Press Cmd-R.** A reload is the clean reset: river back at 16 ft, speed 60×, no walls, no route, the Try-it steps
unchecked (checked after a full pitch in rehearsal), and the strip comes back even if it was closed. Running again in
1.5–1.7 s on a quiet GPU. Don't use `R` for this:
it resets only the water, so walls stay and a raised river rises again.

While you wait for the next judge, press **Space** to pause: a paused view drops to ~4 renders a second (e2e flow 10),
which keeps a fanless Air cool. Press Space again as the judge walks up.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| "Lost connection to the GPU" with "Reloading in 3 s…" | Nothing. It reloads by itself into the same scene (rehearsal: running again 11 s after the loss, on a busy GPU). Say: "the GPU driver reset; the whole simulation lives on the GPU, so it restarts." |
| The same card with no countdown, "reset again after restarting", a **Reload** button | A second loss within 10 minutes of an automatic reload in this tab waits for you. Quit other GPU apps, click **Reload** (rehearsal: running 9 s later). If it keeps happening, open a new tab at localhost:4173 (the limit is per tab) or relaunch Brave. |
| Brave's own crash page, or a blank page | Cmd-R. |
| "This site can't be reached" | The `npm run demo` terminal was closed. Run it again. |
| ≈ 30 fps top right | Low Power Mode or Energy Saver is on. The demo still works; fix it between judges. |
| Sim speed in single digits, the HUD says "GPU-limited" | Something else is using the GPU, or the Air is hot. Keep talking: every beat still happens, just more slowly. |
| The Try-it strip is gone | Cmd-R. |
| Nothing moves | Press Space (the play/pause button is top centre). |

---

## 2. The three-minute pitch

Start from a freshly reloaded Pittsburgh, running, with the pointer off the strip. *Say* lines are suggestions; *If not*
is the fallback. Timings are from the rehearsal (conditions noted).

### Beat 1 · 0:00–0:20 · Hook

- **Click:** nothing. Drag a little to orbit if you like.
- **Say:** "This is downtown Pittsburgh from real USGS elevation data: a million cells, 7.8 metres each, 8 km across.
  The water in those rivers is being solved right now on this laptop's GPU, the shallow-water equations, in a browser
  tab, offline. There's no AI model anywhere in it."
- **Judge sees:** the city and three rivers at normal pool (16 ft), ≈ 60 fps top right, the LIVE SOLVER panel bottom left.
- **If not:** black canvas or an error card → Cmd-R.

### Beat 2 · 0:20–0:50 · The 1936 flood

- **Click:** **Raise to 1936 record**.
- **Say:** "March 1936, the St. Patrick's Day flood: 46 feet at the Point. We raise the river along its whole length.
  The rise is a time-lapse, minutes instead of 30 hours; the flood after it is solved at real speed." As it spreads:
  "The Point, the North Shore stadiums, the Strip District. Roads go orange when wet and red when a car would float."
  Point at the HUD: "Mass error stays under a thousandth of a percent: every cubic metre in and out is booked."
- **Judge sees:** a pill "River rising 16.0 ft → 46.0 ft" under the strip; the slider in the side panel moves to 46;
  downtown and the North Shore go under; red roads.
  [Picture](docs/hero-1936-crest.jpg).
  Rehearsal: with the GPU to itself, 46 ft and ~4 km² flooded 3 s after the click, ~6 km² by 10 s, the top right
  reading e.g. "60 fps · 6.5 sub · 88×". With a shared GPU (13–33×): 46 ft after 8–16 s.
- **If not:** nothing moving after 5 s → check it isn't paused (Space). Sim speed in single digits → the flood is
  still coming, just slower; keep talking.

### Beat 3 · 0:50–1:10 · Evacuate

- **Click:** **Evacuate**.
- **Say:** "Now people. This is the Census Bureau's real road network. Deluge plans the fastest drive from a downtown
  street to the nearest dry shelter, avoiding any road under 30 cm of water, and re-plans as the water moves."
- **Judge sees:** a blue route from a start marker to a shelter pin; a chip at the bottom, "Safe route to Hill District
  high ground · 2.2 km · 5 min" at the crest (same in two rehearsals); a notice "Evacuation route planned".
  [Picture](docs/demo-evacuate.jpg).
- **If not:** a notice "Click a home on the map" → click a downtown street. A red "No safe route" chip is a good moment
  too: "every way out is flooded, so shelter in place."

### Beat 4 · 1:10–1:55 · Build a levee

- **Click:** **Build a levee**. Don't click again while it shows a spinner.
- **Say:** "The planner's question: what if the North Shore had a floodwall? This builds a 2.4-kilometre wall with its
  top a metre above the 1936 record, resets the flood, and replays the rise with the wall in place." When green shows:
  "Green is land that would be under water at this level without the wall, about 140 acres and 11 km of streets,
  recomputed every second from the live water. And watch the evacuation route re-plan as the water comes back."
- **Judge sees:** the camera flies to the North Shore; notice "Building a 2.4 km levee along the North Shore"; a tan
  wall rises; the river rises again; PNC Park and Acrisure Stadium stay dry under a green tint; the pill "Walls keep …
  acres dry · … km of streets"; notice "The levee is holding"; the route chip flips to Mount Washington while the land
  is dry, then back to "Re-planned — safe route to Hill District high ground".
  [Picture](docs/levee-north-shore.jpg).
  Rehearsal with a shared GPU (10–25×): wall up 4–5 s after the click, first green at 10–11 s, 46 ft and "The levee is
  holding" at 19–20 s, then the count peaks (143–152 acres) and settles at 134–139 acres and 11 km. A quiet GPU should
  be quicker (the replayed rise is 3.7 simulated minutes), but plan for 20 s.
- **If not:** no green after ~25 s → check sim speed (see Beat 2) and fill with how the number is computed (Q9).

### Beat 5 · 1:55–2:30 · Break it

- **Click:** **Break it**. About 5 s later, **Restore robust solver** in the red banner at the bottom.
- **Say:** "Why is this hard? This swaps in the textbook explicit scheme: explicit friction, no flux limiter, no
  smoothing, a time step past its stability limit. One small splash, and it blows up: depths go to infinity and the HUD
  says the numbers aren't physical." After Restore: "Switch back, and the robust solver just runs."
- **Judge sees:** the banner "Stability demo — naive explicit solver at Courant 1.8"; the HUD turns red, "Diverged"
  and "∞"; magenta speckle (infinite or NaN depth) spreading along the river from mid-view.
  [Picture](docs/demo-break-it.jpg).
  After Restore: the water resets at once and the river rises back to 46 ft with the levee still standing.
  Rehearsal: banner within 0.6 s of the click, "Diverged" within 2 s; after Restore the water reset within 0.3 s.
- **If not:** no magenta in view → press F to frame the whole map; the HUD says Diverged either way.

### Beat 6 · 2:30–3:00 · The hard part, and close

- **Click:** **How it works** (top right) → the *Why it's hard* chip. Esc closes it.
- **Say:** the 30-second version from section 4, then: "Real terrain, real physics, checked against analytic solutions
  and National Weather Service flood reports, at 60 frames a second on a MacBook Air. That's Deluge."
- **Judge sees:** "Four ingredients that keep it stable at interactive speed", with the four formulas.
- **If not:** skip the dialog and just say it. Then offer the mouse: drag to orbit, press 2 and drag to draw a wall.

---

## 3. The sixty-second version

Same start. Skip Evacuate; don't wait for a beat to finish before talking.

| Time | Click | Say |
| --- | --- | --- |
| 0:00–0:08 | nothing | "Real USGS terrain of Pittsburgh, a million cells, with the shallow-water equations solved live on this laptop's GPU, in a browser, offline." |
| 0:08–0:22 | **Raise to 1936 record** | "The 1936 flood, 46 feet at the Point. The rise is a time-lapse; the flood is real physics. Mass error stays under 0.001 %." |
| 0:22–0:45 | **Build a levee** | "A 2.4 km floodwall on the North Shore, then the rise again. Green is the ~140 acres it keeps dry, computed from the live water." Move on as soon as the green count shows. |
| 0:45–0:57 | **Break it**, then **Restore robust solver** | "The textbook scheme blows up in seconds. Ours doesn't: an adaptive time step, friction that can only slow water, a limiter that never lets depth go negative, and still water that stays still, all in parallel on the GPU." |
| 0:57–1:00 | nothing | "That's Deluge." |

Rehearsal with a shared GPU: the whole sequence took 45 s of clicking (crest 16 s after Raise, green 10 s after Build a
levee, Diverged 1 s after Break it). The crest comes ~3 s after Raise on a quiet GPU, so the timings above have slack.

---

## 4. The hard part

### 30 seconds, plain language

"Water simulations on real terrain want to blow up. The rivers here are six metres deep and fast, streets carry films
a centimetre thick, walls are one cell wide, and the GPU updates a million cells at once. Four rules keep it stable:
the time step shrinks so no wave skips a cell; friction can only slow water down, never reverse it; a cell can never
give away more water than it holds; and a still lake stays still. And we count every drop: that's the mass error in
the corner."

### 90 seconds, technical (say this)

"It's the 2-D shallow-water equations on a staggered grid: depth at cell centres, discharge on cell faces. The base is
the local-inertial scheme from flood models like LISFLOOD-FP, plus upwind advection, which is what makes a dam-break
front move at the right speed.

It's explicit, so, one: the time step is CFL-limited with the two-dimensional Courant number, dt = Cr·dx over √2 times
the fastest √(gh) + |u|. The worst mode is the grid checkerboard, so we aim for 0.7 and never exceed 0.85. The maximum
comes back from the GPU a few hundred milliseconds late, so we pad it, and a per-face guard in the shader catches
anything it misses.

Two: friction is semi-implicit. We divide by one plus g·dt·n²·|q| over h to the seven-thirds instead of subtracting, so
on thin films it can only slow water down, for any time step.

Three: wetting and drying use a positivity-preserving flux limiter. Each cell scales its outgoing fluxes so it can't
export more than it holds, so depth never goes negative and we never clamp, which would create water.

Four: face depth is well-balanced, max of the surfaces minus max of the beds, so a lake on rough terrain stays at rest.

Mass is booked exactly: a per-cell ledger records every source and sink, even the GPU's own Float32 rounding, and the
CPU sums it in Float64. And every substep is two full-grid compute passes where each cell reads its neighbours and
writes only itself, about 2 milliseconds for a million cells on this laptop."

### Backup detail, if they dig

All of this is in `src/sim/Solver.ts`, `src/sim/shaders/{momentum,continuity,common,stats}.ts` and ARCHITECTURE §3.

1. **Scheme.** State is one `rgba32float` texture `(h, qx, qy, z − z0)` ping-ponged every substep; `qx` lives on the
   east face, `qy` on the south face. Upwind advection is what fixes the dam break: without it the front runs at 0.48×
   the Ritter speed with a 15 % profile error; with it the front ratio is 1.01 and the error 1.6 %.
2. **Time step.** `dt = Cr·dx / (√2·max_cells(√(g·h) + |u|))`. Von Neumann analysis of the forward–backward update:
   the checkerboard needs `Cr ≤ 1`, or `≤ √θ ≈ 0.89` with θ = 0.8 smoothing. Target 0.7, cap 0.85; the HUD usually reads
   ≈ 0.55. The readback maxima are ~300 ms old, so they are inflated (×1.25 + 0.1 m/s) and combined with what is known to
   be coming (stage raises, brush edits, inflows, rain runoff). The per-face guard: if a face's own Courant number
   `Cr_f` exceeds the limit, that face's momentum step uses `dt·(Cr_max/Cr_f)²`, which puts it exactly back at the limit.
3. **Friction.** `q_new = (q̃ − dt·A − g·h_f·dt·∂η/∂x) / (1 + g·dt·n²·|q| / h_f^{7/3})`. Explicit Manning friction on a
   thin film has a decay rate growing like `h^{−4/3}`, so it overshoots and reverses the flow. `q̃ = q + (1−θ)/2 ·
   minmod(L, G)` damps grid-scale noise but not flow turning at stair-step banks (before the minmod, diagonal channels ran
   3–5× too deep). Velocity is capped at `min(15 m/s, Froude 8)`.
4. **Limiter.** Per cell, `O = dt/dx · Σ outgoing |q|`, `k = min(1, h/O)`; every face flux is scaled by `k` of its donor
   cell. Both cells of a face use the same limited flux, so the update stays conservative. A neighbour's `k` needs a
   13-texel stencil. Faces with `h_f < 10⁻⁴ m` carry no flux.
5. **Well-balanced.** `h_f = max(η_L, η_R) − max(z_L, z_R)`, slope written `((z_R − z_L) + (h_R − h_L))/dx` so bed
   differences cancel first. Lake at rest on rough terrain: max |u| = 9.3·10⁻⁵ m/s after 2000 steps. Water can't leak
   through the top of a wall.
6. **Mass accounting.** A per-cell ledger books rain, sources, stages, infiltration, boundary outflow, brush edits and
   rounding. A face volume `dt/dx·q` is one Float32 product both neighbours compute identically, so interior exchanges
   cancel bit for bit. Each increment is snapped onto the Float32 grid of the larger of the depth and the increment, so
   the new depth is exact and what the snap trims is booked. (Measuring `(h+Δ)−h` instead fails: Metal's compiler folds
   it to `Δ`.) A reduction pass sums the ledger per 16×16 block; the ledger is copied and zeroed in the same command
   encoder and summed in Float64: `massError = |V − (V0 + Vin − Vout)| / max(1 m³, V0, peak V)`.
7. **GPU passes.** Pass A (momentum): state → face fluxes. Pass B (continuity): limiter, depth update, rain, sources,
   stages, boundaries, ledger. 16×16 workgroups; every substep of a frame goes into one compute pass; the CPU only
   picks `dt`, writes a 112-byte uniform and submits. 1.6–2.0 ms of GPU time per substep at 1024² on the M4. A governor
   sets substeps per frame from frame time and GPU queue latency; stats come back through `mapAsync` about every 300 ms
   and never block a frame.

---

## 5. Judge Q&A crib sheet

**1. Is this accurate?**
For city-scale floodplain inundation, reasonably, and we checked it two ways. Against analytic and physical benchmarks
(Q2). And against National Weather Service impact statements for the Point gauge (PTTP1), holding each stage for 15
simulated minutes: the water surface at the Point stays within 3 cm of the gauge reading from 28 to 46 ft; Point State
Park floods at 31 ft (NWS: 30); Federal Street at PNC Park is wet at 40 ft (NWS: 40); 15.7 ft of water at Point State
Park at 46 ft (NWS: "up to 15 ft in the Golden Triangle"). The misses: Acrisure Stadium's field and the Station Square
tracks first get wet at 40 ft (NWS: 30–31), the Wood Street T station only at 46 ft (NWS: 28), and the Parkway
"bathtub" stays dry at 46 ft (NWS: 25). Those flood through storm drains, underpasses and underground stations that
bare-earth elevation doesn't contain. It isn't calibrated against a measured flood, so it's for exploring and
explaining, not for engineering decisions.

**2. How do you validate it?**
`npm test` runs the solver suites on the real GPU through Dawn. Re-run on this laptop today:

| Check | Result |
| --- | --- |
| Lake at rest on rough terrain, 2000 steps | max \|u\| = 9.3·10⁻⁵ m/s |
| Dam break vs the Ritter solution, t = 20 s | L1 error 1.6 %, front ratio 1.01, depth at the dam 0.443 m (exact 0.444) |
| Mass error, closed domain | 7.0·10⁻⁹ |
| Mass error, open domain with rain, storm, inflow, stage, infiltration | 9.1·10⁻⁸ |
| Mass error, deep river with rain and a stage boundary, 3 simulated hours | 5.9·10⁻⁷ |
| Rain on a tilted plane at steady state | outflow / rain = 1.000 |
| Walled channels at 0 / 30 / 45 / 60° to the grid | depth / Manning normal depth 0.98 / 1.05 / 1.04 / 1.05 |
| GPU Float32 vs a Float64 CPU reference, 5 cases × 400 steps | max \|Δh\| ≤ 4.3·10⁻⁵ m |

Plus 12 end-to-end flows in headless Chromium on the real GPU, offline, and the mass error on screen the whole time.

**3. Why not a full shallow-water Riemann solver (HLL, Roe, Kurganov–Petrova)?**
The local-inertial scheme is what production inundation models such as LISFLOOD-FP use, and we added advection to it.
It needs two small-stencil passes per substep, which leaves budget for a million cells at 60 fps, and it matches Ritter
within 1.6 %. A second-order Riemann-type scheme does more work per cell (reconstruction, flux evaluation, usually two
stages per step); we haven't benchmarked one here. Where it wins is strongly supercritical flow, hydraulic jumps and
violent dam breaks, which is exactly our stated limitation. A Kurganov–Petrova mode is first on the future-work list.

**4. Isn't "Break it" rigged?**
It deliberately runs the textbook scheme at Courant 1.8, past its limit of 1, so the failure shows up in seconds, and it
removes all the ingredients at once. It shows why they exist; it isn't a benchmark against a tuned naive solver. They
also matter at time steps a textbook calls safe: a test shows the 1-D formula at CFL 0.7 (2-D Courant 0.99, above the
√θ ≈ 0.89 limit with smoothing) sloshes forever without the per-face guard, and explicit friction overshoots on thin
films at any practical time step.

**5. What about storm drains, buildings and bridges?**
Not modelled. The terrain is bare earth: water flows through city blocks and under viaducts, and with no drains or
culverts, road embankments dam small creeks under heavy rain (8.5 m of water behind I-376 in Saw Mill Run at
100 mm/hr). Roughness is one Manning's n = 0.035 for the whole map (adjustable under Advanced). Culverts and drains are
on the future-work list.

**6. How big is the grid, and how fast?**
Presets are 1024 × 1024 = 1,048,576 cells (Pittsburgh: 7.8 m cells, 8 km across). Live areas are 1–20 km at 512², 1024²
or 2048² (2048² isn't benchmarked). Benchmark on an M4 (ARCHITECTURE §8.1: production build, 1936 crest plus 50 mm/hr
rain): 60 fps, p95 frame ≈ 19 ms, 57–64× real time at this Air's 1470×956 @ 2×, 68–73× at 1600×1000, and 66–70× every
minute of a 10-minute run. A substep costs 1.6–2.0 ms of GPU time, so at 5–6 substeps a frame that's roughly 300–400
million cell updates a second (How it works shows the live figure).

**7. Why WebGPU?**
Compute shaders in a browser tab: no install, and the same code runs on Metal, Vulkan and D3D12. WebGL2 has no compute
shaders and no read-write storage buffers, and the mass ledger is one. Each cell only needs its neighbours, so the
problem is embarrassingly parallel. A server GPU would need the network, and this demo runs offline.

**8. Why does the river rise so fast?**
The rise is a time-lapse: 3 m (about 10 ft) per simulated minute, so the 1936 crest arrives in ~3.7 simulated minutes,
roughly 600–850× faster than the real ~30-hour rise. Everything after that runs at its real speed. The side panel says
"time-lapse" while it rises. Raising it all at once would be a dam break along every bank.

**9. Is the "acres kept dry" number real?**
It's an estimate from the live water, not a second simulation. About once a second, in a Web Worker, it takes the level
of the water pressing on the wall and spreads it over the land below that level twice, with and without the walls.
Land that would stand ≥ 0.3 m deep without the walls, isn't with them, and is dry now counts as protected. It ignores
how long water leaking through a gap would take to fill the land behind. At the crest it settles around 139 acres and
11 km of streets, and flooded land drops from 6.3 to 5.6 km² (e2e flow 13; rehearsal: 134–139 acres, 11 km). While the
flood is still spreading it can overshoot (a peak of 152 in rehearsal) before it settles.

**10. How does the evacuation routing work?**
Road flood status comes from the depth readback, up to 4 times a second: wet (≥ 5 cm) is passable at 30 % speed;
flooded (≥ 30 cm, roughly where cars float) is closed; bridges stay open until their approaches flood. A multi-target
Dijkstra on travel time (highway 25 m/s, major 15, minor 11, local 8) finds the nearest reachable dry shelter.
Roads are Census TIGER/Line; Pittsburgh's five shelters are named high ground, snapped to road nodes above the highest stage.

**11. The elevation data has no riverbed. How do the rivers work?**
3DEP rivers are hydro-flattened, so channels are burned in to a nominal depth (6 m in Pittsburgh) along centreline
waypoints. Each river gets a stage disc where it crosses the map edge that holds its water level; the upstream discs
sit slightly above the gauge level and the downstream one slightly below (±0.075 m at normal pool, ±0.2 m at 46 ft), so
all three keep flowing downstream. Other edges let water leave at normal flow or at the speed it arrives, capped at
critical flow. River speeds and discharges are approximate; at the 1936 crest they're lower than the record.

**12. Where does the data come from? Licensing?**
Offline presets use only public-domain U.S. government data: USGS 3DEP elevation, USDA NAIP imagery via The National
Map, Census TIGER/Line roads, NWS and USGS flood stages. Live areas fetch Esri World Imagery at runtime (Esri's terms);
fallbacks are Mapzen Terrarium elevation (AWS Open Data) and OpenStreetMap roads (ODbL); place search is Nominatim.
Code is MIT. Full list: README → *Data and attribution*.

**13. How can the mass error be 10⁻⁷ in 32-bit floats?**
It isn't measured after the fact; it's booked as it happens (section 4, backup point 6). Neighbouring cells compute each
face volume identically, so exchanges cancel bit for bit; every increment is snapped so the new depth is exact and what
the snap removes goes in the ledger; the CPU sums the ledger in Float64. The first version measured `(h+Δ)−h` on the
GPU. Metal folded that into `Δ`, and after hours at the crest the HUD turned yellow. Snapping fixed it.

**14. Does it run on other machines?**
Any browser with WebGPU: Chrome or Edge 113+, Safari 26+, Firefox 141+ on Windows (the list on the unsupported-browser
screen). Performance has only been measured on an Apple M4. The app adapts substeps and render resolution to measured
frame time and GPU latency; with the GPU emulated ~35 % slower, frames held 58–60 fps and sim speed fell to ~15–20×.

**15. Can it do my town?**
Any US location, through *Pick any US location…* or `?live=lat,lon,km`, but it **needs internet** (USGS, Esri,
TIGERweb). A healthy 1024² area loads in well under 15 s; on dead wifi it gives up after ~12–15 s and offers the
offline scenarios. With no river crossing the map edge, the first button drops a 120 mm/hr thunderstorm over the view.
Only try it at the venue if you've tested the network there. Offline alternatives under *Scenario → Change*: Johnstown
(the 1889 flood as a 3,730 m³/s inflow down today's valley, not a dam-break simulation) and Ellicott City (the 2016
flash-flood storm).

**16. What did AI write?**
Answer honestly. We used AI coding assistants heavily to write, test and review the code and the docs; the No Wrapper
track allows that. **The product itself contains no language model and no machine learning:** no model or AI API calls,
its only runtime dependencies are `geotiff` and `leaflet`, and every number on screen comes from the solver. The GPU
tests against analytic solutions and a Float64 reference are how we checked that generated code is right and not just
plausible. Then say concretely what each of you decided, checked or debugged, and don't downplay the AI's share.

**17. What was the hardest bug?**
Pick one you can tell well:
- The Courant number has to be two-dimensional: a 1-D formula at 0.7 sits right on the 2-D stability limit, and deep
  water sloshed forever.
- Metal's compiler folded away the rounding measurement (Q13).
- Rivers running diagonally across the grid came out 3–5× too deep because smoothing treated stair-step banks as drag.
  The minmod limiter fixed it.
- At the 1936 crest, momentum coasted across the Ohio's stage disc and came out of its rim as an 8 m/s jet. Faces inside
  a disc now forget their discharge.

**18. What's next?**
A Kurganov–Petrova second-order mode for dam breaks and supercritical flow; measured channel bathymetry; culverts and
storm drains; coverage beyond 3DEP; baking the forcing into a texture (about half the continuity pass is ledger writes
and source loops).

**19. Is the terrain exaggerated?**
On screen, yes: 1.5× vertically by default (View section of the side panel). Rendering only; the solver uses true
elevations.

---

## 6. Known limitations (say these first)

- **Bare earth.** No buildings, bridge decks, culverts or storm drains. Water flows through blocks, and embankments dam
  creeks under heavy rain.
- **No riverbed data.** Channels are burned in to a nominal depth (6 m in Pittsburgh), so river volumes and speeds are
  approximate, and 1936 discharges come out lower than the record.
- **One roughness** (Manning's n = 0.035) for the whole map; no land-cover map.
- **The rise is a time-lapse**, ~600–850× faster than 1936. The flood after it runs at real speed.
- **First-order scheme:** good for floodplain inundation, weaker for hydraulic jumps and violent dam breaks.
- **Protected land is a still-water estimate.** It ignores how long a gap takes to fill, and overshoots while the flood
  is still spreading.
- **Not calibrated** against a measured flood. The NWS comparison is by stage, and some impacts miss (Q1).
- **Performance is measured only on Apple M4.** A hot fanless Air, Low Power Mode or a shared GPU cut sim speed before
  frame rate.
- **Live areas need internet** and are full quality only in the US (USGS 3DEP); elsewhere a coarse fallback is used.

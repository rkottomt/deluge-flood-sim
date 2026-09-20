# Devpost submission — Deluge

Paste-ready. Everything below is checked against `README.md`, `ARCHITECTURE.md` and `DEMO.md` in this repo.

---

## Built with

25 tags, the Devpost maximum. Lowercase, one per box.

```
webgpu
wgsl
compute-shaders
typescript
vite
node.js
electron
playwright
geotiff
leaflet
shallow-water-equations
computational-fluid-dynamics
gpu-computing
numerical-analysis
dijkstra
geospatial
usgs-3dep
lidar
naip
esri
tiger-line
openstreetmap
nominatim
noaa
copernicus-dem
```

Why each one is defensible, if a judge asks:

| Tag group | What it actually is in the repo |
| --- | --- |
| `webgpu` `wgsl` `compute-shaders` | The solver is WGSL compute shaders — momentum and continuity passes in `src/sim/shaders/`. No WebGL fallback, no CPU solver in the product. |
| `typescript` `vite` `node.js` | The whole app is TypeScript on Vite; Node 20.19+/22.12+ to build. Zero runtime frameworks. |
| `electron` | `electron/` wraps the same static build as `Deluge.app` — privileged `app://deluge/` origin, no preload, no IPC, no listening port. |
| `playwright` | Drives the end-to-end, performance, visual-regression and security suites on a real GPU through headless Chromium. |
| `geotiff` `leaflet` | The only two runtime dependencies: GeoTIFF parses USGS elevation rasters, Leaflet is the "pick any US location" map. |
| `shallow-water-equations` `computational-fluid-dynamics` `numerical-analysis` `gpu-computing` | Local-inertial 2-D shallow water, CFL-adaptive timestep, semi-implicit friction, positivity-preserving flux limiter, well-balanced face depths. |
| `dijkstra` | `src/routing/` — travel-time Dijkstra over the road graph, re-planned as edges flood. |
| `usgs-3dep` `lidar` `naip` `esri` `tiger-line` `openstreetmap` `nominatim` `noaa` `copernicus-dem` `geospatial` | Every data source the app names in its own *How it works → Data* panel. |

---

## Try it out

**Link 1 — the code**
`https://github.com/rkottomt/deluge-flood-sim`
The full repo: solver, shaders, data pipeline, tests, desktop wrapper, and `ARCHITECTURE.md`.

**Link 2 — run it**
`https://rkottomt.github.io/deluge-flood-sim/`
`npm run build` emits a static site with relative URLs, and `.github/workflows/pages.yml` publishes it to GitHub
Pages as soon as the repo is public and Pages is set to "GitHub Actions". **Publish it before you paste this link,
then open it once in Chrome to confirm.** A hosted copy needs a WebGPU browser (Chrome/Edge/Brave 113+, Safari 26+,
Firefox 141+ on Windows or 147+ on Apple-silicon). If Pages isn't up in time, drop this link rather than ship a 404.

**Link 3 — the presenter guide**
`https://github.com/rkottomt/deluge-flood-sim/blob/main/DEMO.md`
The 3-minute pitch, the 60-second version, the judge Q&A crib sheet, and a "known limitations, say these first"
section. Worth linking precisely because it lists what Deluge gets wrong.

*Optional fourth:* `https://github.com/rkottomt/deluge-flood-sim/blob/main/ARCHITECTURE.md` — the numerical method
in full, including the validation table.

---

## Elevator paragraph

> Deluge loads real USGS elevation for a place in the United States and solves the 2-D shallow-water equations on your
> GPU with WebGPU compute shaders, live in a browser tab. Raise the Allegheny and the Monongahela to the 1936 crest and
> watch the Golden Triangle go under; draw a levee and see the land it keeps dry counted in acres; crank the rain to
> Harvey levels; drop a pin and watch the evacuation route re-plan as roads flood. A million cells of momentum and
> continuity run every frame at 60 fps and roughly 70× real time on an Apple M4, with the mass-balance error staying
> under 0.001 % at the crest. Nothing here is a wrapper: no language models, no hosted simulation service, no baked
> animation. The method is checked against the Ritter dam-break solution, a Float64 CPU reference and the National
> Weather Service's own impact statements for the Pittsburgh Point gauge, and every cubic metre is booked in a ledger
> you can watch in the corner of the screen.

Short version, if the field is tight:

> Real-time flood simulation on real terrain: the 2-D shallow-water equations solved on the GPU in WGSL compute
> shaders, over USGS lidar elevation, with levees you can draw and evacuation routes that re-plan as roads go under.
> 60 fps and ~70× real time on an M4, mass conserved to under 0.001 %.

---

## Numbers you can quote safely

All measured, all in the repo.

| Claim | Source |
| --- | --- |
| 60 fps, p95 frame 18.7 ms, 68–73× real time at 1600×1000, Apple M4, crest + 50 mm/hr rain | `ARCHITECTURE.md §8.1` |
| HUD mass-balance error < 0.001 % at the 1936 crest, with or without hurricane rain | `README.md` |
| Solver mass error 7·10⁻⁹ closed / ≤ 9.1·10⁻⁸ open, in tests | `tests/sim/conservation.test.ts` |
| Dam break vs the Ritter analytic solution: 1.6 % L1 profile error | `tests/sim/dambreak.test.ts` |
| GPU Float32 vs Float64 CPU reference: max \|Δh\| ≤ 4.3·10⁻⁵ m over 5 cases × 400 steps | `tests/sim/reference.test.ts` |
| Lake at rest on rough terrain, 2000 steps: max \|u\| = 9.3·10⁻⁵ m/s | `tests/sim/wellbalanced.test.ts` |
| Water surface at the Point within 3 cm of the NWS gauge reading at every stage | `ARCHITECTURE.md §4` |
| 326 unit tests, 13 end-to-end flows, plus perf / visual / security / desktop suites | `README.md` |
| 1024 × 1024 cells, 7.8 m per cell, 8 km square (Pittsburgh) | in-app scenario panel |

**Say these limitations out loud** (they're in `DEMO.md §6`, and saying them first is what makes the rest credible):
bare-earth terrain, so water flows through buildings and under bridges; no riverbed survey, so channels are burned to
a nominal depth; one Manning's n for the whole map; the river *rise* is a time-lapse; first-order scheme; not
calibrated against a measured flood; performance measured only on Apple M4.

---

## Before you paste this

1. **Branches.** The gallery images come from `graphics` (3D buildings, images 1–6) and `global-presets` (Asheville,
   Nashville, Houston, Boulder, Fort Myers — images 7–14). `main` alone ships Pittsburgh, Johnstown, Ellicott and the
   sandbox. Merge what you intend to show, or the screenshots won't match the link.
2. **`copernicus-dem`** is honest only if `global-presets` ships — the global DEM fallback lives in
   `src/data/demGlobal.ts` on that branch. Drop the tag if you submit `main`.
3. **GitHub Pages** has to be switched on and the workflow run before Link 2 exists.
4. The desktop path (`npm run app:build` → `release/Deluge.app`, ad-hoc signed, ~330 MB) is worth a sentence in the
   long description: it's the offline, no-terminal, no-browser way to present, and it's the same static build.

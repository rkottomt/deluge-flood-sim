# Deluge — real-time flood simulation on real terrain

A browser app that loads real USGS 3DEP elevation data for any area in the US and solves the 2D shallow-water
equations on the GPU with WebGPU compute shaders. Draw a sandbag wall, crank the rain, or raise the river to a
historic crest, and watch the flood reroute live while evacuation routes re-plan as roads go underwater.

Built for SteelHacks — *No Wrapper* track (no language models in the product). Architecture and numerical method:
[DESIGN.md](DESIGN.md). Module contracts: [src/contracts.ts](src/contracts.ts).

## Run it

Requires a WebGPU browser (Chrome / Edge 113+, Safari 26+). No network is needed for the built-in presets.

```bash
npm install
npm run demo       # production build served at http://localhost:4173 — use this for the live demo
npm run dev        # Vite dev server
```

URL options: `?preset=pittsburgh|johnstown|ellicott|sandbox`, or a live area
`?live=<lat>,<lon>,<km>` (e.g. `?live=29.95,-90.07,6` for New Orleans — needs internet: USGS, Esri, Census TIGERweb).

## Try this (30 seconds)

1. Pittsburgh loads with full rivers. Click **Raise the river to 1936 record** (or the *1936 record* chip under
   *Weather & rivers*) and watch the Point, the North Shore and the Strip District go under.
2. Press **2** and drag across a street to build a levee; switch the view to **Max depth** to compare.
3. Press **8** and click a street to set an evacuation start — the route re-plans or turns red as roads flood.
4. **How it works → Break it** swaps in a naive explicit solver: the rivers blow up into glowing garbage within
   seconds. *Restore robust solver* recovers exactly.

Keys: `1`–`0` tools, `Space` pause, `?` help. The HUD's mass-balance error shows no water is created or lost.

## Tests

```bash
npx tsc --noEmit
node --import tsx --test tests/sim/*.test.ts       # GPU solver (Dawn): well-balanced, conservation, dam break…
node --import tsx --test tests/data/*.test.ts      # DEM decode, hydro-conditioning, presets
node --import tsx --test tests/routing/*.test.ts   # flood-aware routing, perf
node --import tsx --test tests/render/*.test.ts    # shader validation, prep pass, picking, LOD
node --import tsx --test tests/ui/*.test.ts
node --import tsx --test tests/app/*.test.ts
npm run e2e                                        # 10 judge flows in headless Chromium on the real GPU (offline)
node scripts/e2e.mjs --prod                        # same against the production build
```

Presets are baked with `npx tsx scripts/bake-presets.ts` (raw downloads are cached in `artifacts/bake-cache`).

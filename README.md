# Deluge — real-time flood simulation on real terrain

A browser app that loads real USGS 3DEP elevation data for any area in the US and solves the 2D shallow-water
equations on the GPU with WebGPU compute shaders. Draw a sandbag wall, crank the rain, or raise the river to a
historic crest, and watch the flood reroute live while evacuation routes re-plan as roads go underwater.

Built for SteelHacks — *No Wrapper* track (no language models in the product).

> Work in progress. See [DESIGN.md](DESIGN.md) for the architecture and numerical method.

```bash
npm install
npm run dev        # http://localhost:5173 (Chrome/Edge 113+ or another WebGPU browser)
```

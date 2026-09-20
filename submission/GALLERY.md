# Devpost image gallery — Deluge

14 images, `submission/gallery/`, all 2400 × 1600 JPEG (3:2), largest 1.3 MB.
Upload in this order; Devpost uses the first image as the project's cover.

The order is a story: **hook → what it does → why you should believe it → how far it goes.**

---

## 1 · `01-pittsburgh-1936-crest.jpg` — COVER

> **Pittsburgh at the 1936 St Patrick's Day crest.** The Point gauge is pushed to 46 ft and the depth view colours
> every cell by how deep the water is: 6.27 km² flooded, 83.6 million m³, mass-balance error under 0.001 %.

*Proves:* the whole product in one frame — real geography, a real historic crest, a hazard map that reads in human
terms ("cars float", "second storey"), and a conservation number sitting next to it.

## 2 · `02-levee-holds-north-shore.jpg`

> **One click builds a floodwall along the North Shore and replays the 1936 rise against it.** The land the wall keeps
> dry glows green, and the strip counts it: 139 acres and 11 km of streets.

*Proves:* you can change the world and the solver answers — this is a what-if tool, not a replay.

## 3 · `03-evacuation-replans.jpg`

> **Drop an evacuation start and Deluge drives the Census road graph to the nearest shelter that is still dry,**
> re-planning as streets go under. Here: 2.6 km, 5 minutes, out to Hill District high ground — with the river still
> rising from 40 ft to 46 ft.

*Proves:* the simulation feeds a decision, not just a picture. Travel-time Dijkstra over live per-road flood status.

## 4 · `04-no-safe-route.jpg`

> **When the start point itself is under 2 m of water, Deluge refuses to draw a route:** "don't drive into floodwater —
> shelter in place on higher floors."

*Proves:* it says no. An honest failure state instead of a confident wrong answer.

## 5 · `05-shallow-water-equations.jpg`

> **How it works, inside the app:** the 2-D shallow-water equations Deluge actually solves, term by term, down to the
> semi-implicit flux update. Local-inertial scheme after Bates et al. (2010) and de Almeida et al. (2012), keeping the
> convective acceleration term the pure local-inertial model drops.

*Proves:* a numerical method with a citation trail, explained in the product rather than the README.

## 6 · `06-checked-against-nws.jpg`

> **Every data layer named, and the flood checked against the National Weather Service's own impact statements** for
> the Pittsburgh Point gauge. The water surface at the Point stays within 3 cm of the gauge at every stage — and the
> misses are listed too: storm drains, underpasses and depressed roadways that bare-earth elevation doesn't contain.

*Proves:* provenance, validation and stated failure modes on one screen.

## 7 · `07-johnstown-conemaugh-valley.jpg`

> **Johnstown, with the 1889 dam-break discharge coming down the Little Conemaugh.** Flat downtown fills wall to wall
> between dry hills, and peak flow reaches 8.77 m/s — 19.6 mph.

*Proves:* the colour scale the rest of the gallery uses, on terrain where the valley shape does the work.

## 8 · `08-asheville-helene.jpg`

> **Hurricane Helene, September 2024.** The French Broad at 3,200 m³/s (113,000 cu ft/s) meets the Swannanoa at
> 1,722 m³/s, and the confluence drowns Asheville's river flats — with a hard wet/dry edge against the Blue Ridge.

*Proves:* real gauged discharges in, geographically correct inundation out.

## 9 · `09-houston-harvey-rainfall.jpg`

> **Harvey-class rain — 173 mm/hr, 6.8 in/hr — on Houston's dead-flat coastal plain.** Buffalo Bayou fills first and
> runs deep blue; then the whole street grid ponds. 7.57 km² wet after 128 mm of rain.

*Proves:* a second failure mode — rainfall-driven ponding with nowhere to drain, not a river overtopping.

## 10 · `10-nashville-2010-crest.jpg`

> **The Cumberland raised to 51.9 ft, the May 2010 crest,** with the 1937 and 1927 marks on the slider. The east bank
> and the stadium go under; downtown's bluff on the west stays dry.

*Proves:* stage-driven flooding respects topography — one bank floods, the other doesn't.

## 11 · `11-fort-myers-ian-surge.jpg`

> **Hurricane Ian's record 12.9 ft surge pushed up the Caloosahatchee estuary,** against the NOAA 8725520 datum:
> 146 million m³ of Gulf water over the Fort Myers waterfront.

*Proves:* coastal storm surge through a tidal water-level boundary, not only river flooding.

## 12 · `12-boulder-canyon-flash-flood.jpg`

> **The 2013 Front Range flood out of Boulder Canyon:** 238 m³/s (8,400 cu ft/s) of creek leaving the Rockies and
> crossing the city at up to 12.6 m/s — 28 mph.

*Proves:* the solver is doing momentum, not filling a bathtub. 28 mph down a creek only a few cells wide.

## 13 · `13-ellicott-city-flash-flood.jpg`

> **Ellicott City's 2016 flash flood.** A 110 mm/hr storm fills the Hudson, Tiber and New Cut branches; they converge
> on Main Street and discharge into the Patapsco, resolved at 4.9 m per cell.

*Proves:* sub-catchment routing at small scale — three separate branches light up and meet where they really do.

## 14 · `14-live-new-orleans.jpg`

> **Not a preset.** New Orleans pulled live from USGS 3DEP elevation, aerial imagery and Census road data through
> *Pick any US location*, then flooded with Harvey-class rain: 6 km × 6 km at 5.9 m per cell, 1 water surface detected
> and pre-filled.

*Proves:* the "any US location" claim — the whole data pipeline runs on demand, not off baked fixtures.

---

## Notes on the set (for you, not for Devpost)

**Which build each shot came from.** Images 1–6 are the `graphics` branch (3D buildings, new sky, presentation mode).
Images 7–14 are `global-presets` (which is where Asheville, Nashville, Houston, Boulder and Fort Myers actually live —
`main` ships only Pittsburgh, Johnstown, Ellicott and the sandbox). No image in this gallery is from `main` alone.
**Before you submit, make sure the build you link is a build these screenshots are honest about.**

**Buildings are rendered, not solid.** On the `graphics` branch the 3D blocks are a rendering layer
(`ARCHITECTURE.md §6.1`: "Buildings do not" enter the solver). Water flows through them, exactly as the bare-earth
limitation in `DEMO.md §6` says. Don't let a caption imply the flood is routed around buildings.

**Why most city shots are the Depth view, not the photoreal one.** At these depths over aerial imagery the realistic
water renders as a flat tan-grey film that a viewer cannot distinguish from a sandbar. The Depth hazard view is what
makes the flood unambiguous; images 2, 3 and 4 show the realistic view so the gallery doesn't imply the renderer only
does false colour.

**Every frame is paused** (`PAUSED` in the transport bar) with the live HUD visible, so the flooded-area, volume,
max-depth and mass-error numbers in each caption are readable in the image itself.

**The fps reading differs between frames, and one is low.** The measured claim — 60 fps, p95 18.7 ms, 68-73x real
time (`ARCHITECTURE.md` 8.1) — is at 1600x1000. These stills are captured at 2400x1600, 2.4x the pixels, on a GPU
shared with other work at the time, so the corner reads 41-60 fps on most frames and **18 fps on image 4**, which is
the closest, heaviest 3D camera in the set. If a judge asks, that is the answer: a bigger viewport, not a different
solver. If you would rather the question never came up, drop image 4 and submit 13 — see the note below.

**Not included, deliberately:** no desktop/`Deluge.app` screenshot. An Electron window shows the identical UI, so it
would have been the weakest image in the set; the offline/desktop story is carried in `SUBMISSION.md` text instead.

**Rejects** stay in `submission/raw-moments/` and `submission/raw-cities/`. The two that were cut from the shortlist:
a second Ellicott City frame (superseded by image 13, which has far more water in it) and the Pittsburgh photoreal
wide shot (the flood over downtown reads as wet tarmac rather than water).

/// <reference types="node" />
/**
 * Bake real-world presets into public/presets/<id>/{meta.json, elevation.f32, imagery.jpg, imagery-detail.jpg,
 * roads.json, landcover.u8}.
 *
 *   npx tsx scripts/bake-presets.ts            # all presets
 *   npx tsx scripts/bake-presets.ts johnstown  # one preset
 *   options: --refresh (refetch cached downloads), --imagery=naip|esri (default naip), --out=<dir> (default
 *   public/presets). Baked imagery is committed and served offline, so it comes from USDA NAIP (public domain, via The
 *   National Map): Esri's World Imagery item says the layer is not intended for exporting imagery for offline use
 *   outside ArcGIS apps. NAIP is also orthorectified, so buildings and TIGER roads line up (see src/data/imagery.ts).
 *
 * NON-US ("global") PRESETS take the same steps with different sources (PresetDef.global): Copernicus DEM GLO-30 read
 * straight from the COGs and put through the DSM → bare-earth filter (src/data/demGlobal.ts), roads from OSM API XML
 * downloaded ahead of time (artifacts/nepal-build/fetch-osm.mjs), and no baked photo — Sentinel-2 L2A is open and
 * could be redistributed with credit, but composing a usable cloud-free mosaic is its own job and the ready-made
 * cloud-free mosaics (EOX s2cloudless 2018+) are CC BY-NC-SA, so the renderer's hypsometric tint is the ground
 * texture. The scenario text says which of those it is; see public/presets/SOURCES.txt.
 *
 * Steps per preset: USGS 3DEP DEM (1024²) → no-data/seam repair → river centerlines from waypoints →
 * pool level measured from the DEM → channel burn with smooth banks → sources placed on the channel spine at
 * the domain edges → initial fill seeds along the centerlines (verified: no water outside the channel) →
 * shelters snapped to high road nodes (verified above the maximum stage) → aerial imagery 4096² JPEG →
 * close-up imagery inset for the middle of the domain (PresetDef.detail, another 4096² JPEG) →
 * TIGERweb roads → compact roads.json → land cover (NLCD 2021 / ESA WorldCover 2021, landcover.u8;
 * scripts/bake-landcover.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CameraPose, GridRect, HydrographPoint, ScenarioPreset, Shelter, StageControl, StormCell, WaterSource, WaterViewMode } from '../src/contracts';
import { applyChainResult } from './bake-chain-result';
import { hazardChainFor } from './chain-defs';
import { tileBoundsOf } from './osm-fetch';
import { hydrographVolume } from '../src/sim/forcing';
import { type DEMSource, demAttribution, fetchDEM } from '../src/data/dem';
import { bareEarthFromSurface, BARE_EARTH_ALGO_VERSION, BARE_EARTH_DEFAULTS, type BareEarthOptions, fetchCopernicusDEM } from '../src/data/demGlobal';
import { geoToGrid, squareDomain } from '../src/data/geo';
import { burnRivers, edgeRuns, edgeStageDiscAvoiding, findRiverEnds, growEdgeRun, flatThreshold, localRelief, seaBoundaryDiscs, type BurnResult, type RiverSpec } from '../src/data/hydro';
import {
  detailMercatorBBox,
  detailMetersPerTexel,
  detailRect,
  DETAIL_SIZE,
  DETAIL_TARGET_MPT,
  fetchImageryBytes,
  IMAGERY_ATTRIBUTION,
  type ImagerySource,
  NAIP_ATTRIBUTION,
  NAIP_MAX_EXPORT,
} from '../src/data/imagery';
import { computeInitialWater } from '../src/data/initialWater';
import { type PresetMeta, PRESETS, validatePresetMeta } from '../src/data/presets';
import {
  buildRoadNetwork,
  encodeRoads,
  fetchTigerRoads,
  parseOSMXml,
  type RawRoad,
  ROADS_ATTRIBUTION_OSM,
  ROADS_ATTRIBUTION_TIGER,
  roadStats,
} from '../src/data/roads';
import { makeGeoToGrid } from '../src/data/geo';
import { bakeLandCover } from './bake-landcover';

const FT = 0.3048;
/** Baked imagery edge length, pixels. */
const IMAGERY_SIZE = 4096;
const CFS = 0.0283168; // m³/s per ft³/s
/** ft³/s for a discharge in m³/s, rounded to the nearest thousand, e.g. "132,000". */
const cfsLabel = (m3s: number) => (Math.round(m3s / CFS / 1000) * 1000).toLocaleString('en-US');
/**
 * Johnstown's 1889 flood. Lake Conemaugh held 1.455 × 10⁷ m³ when the South Fork Dam failed, and more than 65 minutes
 * were needed to drain most of it; the breach peaked at 7,200–8,970 m³/s (Coleman, Kaktins & Wojno, 2016,
 * "Dam-Breach hydrology of the Johnstown flood of 1889", Heliyon 2(6) e00120, doi:10.1016/j.heliyon.2016.e00120).
 * A preset inflow is constant, so the Little Conemaugh carries the lake's AVERAGE outflow over those 65 minutes
 * (≈ 3,730 m³/s): the model delivers the whole lake in about an hour, rather than the breach peak for as long as the
 * scene runs. Measured on the M4 (runFor, sim time): 0.56 km² of land flooded at T+10 min, 1.9 km² at T+30 min, max
 * speed 9–14 m/s; the 1936 peaks (1,671 + 816 m³/s) stay in the channels (0.25 km²).
 */
const LAKE_CONEMAUGH_M3 = 1.455e7;
const LAKE_CONEMAUGH_DRAIN_S = 65 * 60;
const JOHNSTOWN_1889_INFLOW = Math.round(LAKE_CONEMAUGH_M3 / LAKE_CONEMAUGH_DRAIN_S / 10) * 10;
/**
 * Stonycreek River at Ferndale (USGS 03040000): median annual peak 10,600 ft³/s over 110 years of record (1936 record
 * 59,000). On May 31, 1889 the rivers were already running high after a night of heavy rain.
 */
const STONYCREEK_TYPICAL_PEAK_CFS = 10600;
/**
 * Hurricane Helene, September 27, 2024 — USGS annual peak-flow records. Both gauges beat the 1916 flood that had
 * stood for a century: French Broad River at Asheville (03451500) 113,000 ft³/s at 24.82 ft (1916: 110,000 at
 * 23.10 ft); Swannanoa River at Biltmore (03451000) 60,800 ft³/s at 27.33 ft (1916: 23,000).
 */
const HELENE_FRENCH_BROAD_CFS = 113_000;
const HELENE_SWANNANOA_CFS = 60_800;
/**
 * Hurricane Harvey — USGS 08074000 Buffalo Bayou at Houston (Shepherd Drive) annual peak: 32,600 ft³/s at 41.90 ft on
 * August 28, 2017, the biggest since 40,000 ft³/s at 49.00 ft in December 1935, before the Addicks and Barker dams.
 */
const HARVEY_BUFFALO_BAYOU_CFS = 32_600;
/**
 * Harvey's documented peak hourly rainfall: 6.8 inches in one hour over southeastern Houston, from rain bands training
 * over the same ground (NHC Tropical Cyclone Report AL092017) = 173 mm/hr. Houston rains at that rate rather than at
 * Harvey's four-day average (~10 mm/hr) because the storm's worst hour is what a 30-minute scene can show — and
 * because Buffalo Bayou here runs in a trench 12–14 m below the streets (measured:
 * artifacts/more-cities/probe-transect.ts), so the bayou's own record flood fills that trench but never climbs into
 * the city. In Harvey, Houston flooded from above.
 */
const HARVEY_PEAK_RAIN_MM_HR = 173;
/**
 * 2013 Front Range flood — USGS 06730200 Boulder Creek at North 75th St near Boulder annual peak: 8,400 ft³/s at
 * 10.60 ft on September 13, 2013, four times the previous record of 2,050 ft³/s (2003). That gauge sits ~7 km east of
 * the city, so this is the flood that had already crossed Boulder; the preset delivers it at the canyon mouth, where
 * it came in.
 */
const BOULDER_2013_CFS = 8400;
/** Boulder's record calendar day, 9.08 in on September 12, 2013 (NWS Boulder), as a mean rate: 230.6 mm / 24 h. */
const BOULDER_2013_RAIN_MM_HR = 9.6;

/*
 * Fort Myers, FL — Hurricane Ian's storm surge, 28 September 2022.
 *
 * NOAA tide station 8725520 (Fort Myers, Caloosahatchee River) datums, 1983-2001 epoch, in feet ABOVE STATION DATUM
 * (api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/8725520/datums.json): MHHW 5.68, MSL 4.99, MLLW 4.36,
 * NAVD88 5.40. The station datum therefore sits 5.40 ft = 1.646 m BELOW NAVD88, so this gauge's feet convert
 * straight to NAVD88 and the app's stage readout is the real gauge reading.
 *
 * The station's record water level is 12.923 ft = 2.293 m NAVD88, set by Ian at 22:18 GMT on 2022-09-28 (verified
 * against the 6-minute water_level series for 2022-09-28/29 on the NAVD datum).
 */
const FTMYERS_GAUGE_DATUM = -5.4 * FT; // m NAVD88
const FTMYERS_MHHW_FT = 5.68;
const FTMYERS_MHHW_NAVD88 = (FTMYERS_MHHW_FT - 5.4) * FT; // +0.085 m
const IAN_PEAK_FT = 12.92; // 2.293 m NAVD88 — the station record
/**
 * Betrawati, Nepal — the Bhote Koshi / Trishuli debris flood of 26 August 2026.
 *
 * Shortly after 08:37 NPT rock and glacier ice broke from the north face of Langtang Lirung and fell about 1,200 m into
 * the Lhende Khola; the flood ran down the Bhote Koshi into the Trishuli, reached Betrawati about 09:20 — roughly four
 * minutes after the first SMS alerts went out — and destroyed the bridge over the Phalakhu Khola that carried the only
 * road into Rasuwa district. ICIMOD's analysis is a rock-and-ice SLOPE FAILURE, not a glacial lake outburst, and it
 * happened on the Nepali side; neither claim may be softened into the other.
 *
 * WHAT IS MEASURED AND WHAT IS NOT. Nepal's DHM Flood Forecasting Division reported about 20 million m³ of excess water
 * down the Bhote Koshi–Trishuli–Narayani system (technical report, 27 August 2026), and a peak of 5,850 m³/s at Devghat
 * 168 km downstream — the only published peak discharge anywhere on the river. Nothing was measured at Betrawati: the
 * gauge there (DHM station 447, warning level 4.1 m, danger level 5.0 m) last read 3.55 m at 09:20 and was then swept
 * away, as were the three other automatic stations in the corridor. So the inflow below is the reported VOLUME divided
 * by the 30 minutes this scenario releases it over — the same construction as Johnstown's lake, and it must carry the
 * same label: an average, not a peak. The alternative arithmetic is in public/presets/SOURCES.txt (20 Mm³ over an hour
 * is 5,600 m³/s, close to the measured Devghat peak); 30 minutes is the aggressive end and is chosen because at
 * Betrawati the surge had travelled only 56 km and ICIMOD timed it still moving at ~20 m/s.
 *
 * WHAT THE SIMULATION CANNOT DO. The channel falls 163 m in the 6.5 km of this domain (2.5 %), where the flow is
 * supercritical and the local-inertial scheme is outside the regime it was validated in — and the real event was a
 * sediment-laden debris flood that ran hundreds of metres up the valley walls. The solver's flood speeds capped at 15 m/s
 * against the ~20 m/s ICIMOD measured between Rasuwagadhi and Betrawati (the app now runs this preset with its hazard
 * chain's debris friction and a 25 m/s cap, ARCHITECTURE.md §3.9). This is a clear-water flood of comparable
 * volume on the real terrain: which ground goes under, in what order, and what that does to the roads.
 */
const BHOTE_KOSHI_EXCESS_M3 = 2.0e7;
const BHOTE_KOSHI_RELEASE_S = 30 * 60;
const TRISHULI_SURGE_INFLOW = Math.round(BHOTE_KOSHI_EXCESS_M3 / BHOTE_KOSHI_RELEASE_S / 100) * 100;
/** DHM station 447 (Trishuli at Betrawati) thresholds and its last reading, m on the gauge. Read from DHM's own page. */
const BETRAWATI_WARNING_M = 4.1;
const BETRAWATI_DANGER_M = 5.0;
const BETRAWATI_LAST_READING_M = 3.55;
/**
 * Chungthang, North Sikkim — the South Lhonak GLOF of 3–4 October 2023.
 *
 * At 22:13:20 IST on 3 October about 14.7 million m³ of frozen lateral moraine collapsed into South Lhonak Lake
 * (~5,200 m), raised a ~20 m wave that breached the moraine dam, and ~50 million m³ — about half the lake — drained
 * into the Goma Chu / Lhonak Chu / Lachen Chu. The flood reached Chungthang and the 60 m dam of the 1,200 MW Teesta-III
 * project about 00:30 on 4 October and destroyed the dam (Sattar et al. 2025, Science, doi:10.1126/science.ads2659,
 * via Eos / The Landslide Blog and Newcastle University).
 *
 * NO GAUGE SURVIVED AT CHUNGTHANG, and the published peaks there are MODEL OUTPUT that disagree by a factor of two:
 * 7,355 m³/s (HEC-HMS/HEC-RAS reconstruction, Natural Hazards 121 (2025), doi:10.1007/s11069-025-07350-9, which
 * reproduces the GAUGED ~8,252 m³/s at Gazoldoba downstream with its own 8,282) against 10,282–14,673 m³/s in other
 * studies (research spec §G.3). The calibrated one is used. Its time series is not published in anything this bake
 * read, so the placeholder inflow is a PARAMETRIC hydrograph — the spec's §B.4 gamma shape (a = 3) with that peak and
 * the ~50 million m³ released at the lake — and is labelled as such. It is a stand-in for the routed hydrograph the
 * hazard-chain engine will put at this edge (public/presets/chungthang/chain.json), not a reconstruction.
 */
const SOUTH_LHONAK_RELEASE_M3 = 50e6;
const CHUNGTHANG_PEAK_M3S = 7355;
/**
 * Gamma-shaped hydrograph Q(t) = Qp·(t/tp)^a·e^(a(1 − t/tp)), whose volume is Qp·tp·e^a·Γ(a+1)/a^(a+1)
 * (research spec §B.4; a = 3 ⇒ V = 1.488·Qp·tp). Sampled at `points` times over [0, span·tp] (99.8 % of the volume
 * for a = 3, span = 4) and closed with a zero, so the piecewise-linear table delivers the volume to within a
 * fraction of a percent; the bake logs the exact figure.
 */
function gammaHydrograph(qPeak: number, volume: number, a = 3, points = 41, span = 4): HydrographPoint[] {
  let fact = 1;
  for (let k = 2; k <= a; k++) fact *= k;
  const tp = volume / (qPeak * (Math.exp(a) * fact) / a ** (a + 1));
  const out: HydrographPoint[] = [];
  for (let k = 0; k < points; k++) {
    const t = (span * tp * k) / (points - 1);
    out.push({ t: Math.round(t), q: Math.round(qPeak * (t / tp) ** a * Math.exp(a * (1 - t / tp))) });
  }
  out.push({ t: out[out.length - 1].t + 60, q: 0 });
  return out;
}
const CHUNGTHANG_HYDROGRAPH = gammaHydrograph(CHUNGTHANG_PEAK_M3S, SOUTH_LHONAK_RELEASE_M3);
/** Share of the Chungthang domain steeper than the bare-earth filter's 20° gate, measured on the shipped DEM. */
const CHUNGTHANG_STEEP_PCT = 94;
const CHUNGTHANG_DESCRIPTION =
  'Chungthang stands where the Lachen Chu and the Lachung Chu meet to form the Teesta, and the 60 m dam of the ' +
  '1,200 MW Teesta-III hydropower project stood just below it. Late on 3 October 2023 about 14.7 million m³ of frozen ' +
  'moraine collapsed into South Lhonak Lake, 5,200 m up and some 68 km upstream; the wave it raised, about 20 m high, ' +
  'breached the moraine dam, and about 50 million m³ of water — half the lake — came down the valley. It reached ' +
  'Chungthang around 00:30, about two and a quarter hours later, and destroyed the dam (Sattar et al., Science, 2025). ' +
  'No gauge survived here, and the published peaks at Chungthang are reconstructions that disagree by a factor of ' +
  `two (${CHUNGTHANG_PEAK_M3S.toLocaleString('en-US')} to 14,673 m³/s). This run uses the one calibrated against the ` +
  `gauged peak downstream, ${CHUNGTHANG_PEAK_M3S.toLocaleString('en-US')} m³/s, on a smooth rise and fall that carries ` +
  `the ${(SOUTH_LHONAK_RELEASE_M3 / 1e6).toFixed(0)} million m³ released at the lake — a parametric placeholder, not a ` +
  'measured hydrograph — and the clock starts as the front reaches the north edge of the map, not at the collapse. ' +
  'The real flood was a debris flood that moved hundreds of millions of cubic metres of sediment; this run carries no ' +
  'sediment — it moves the water under one uniform debris-flood friction law with a 25 m/s speed cap — so the ' +
  'arrival times here are the model’s, not the flood’s. The terrain ' +
  'is Copernicus 30 m radar data, a surface model with canopy and buildings in it, acquired in 2011–2015 while the ' +
  'dam was being built, so neither the dam nor its reservoir is in it. The bare-earth filter only runs on ground ' +
  `flatter than 20°, and ${CHUNGTHANG_STEEP_PCT} % of this domain is steeper: the valley floor is filtered and still a ` +
  'metre or two high, the walls above it are the raw surface model. No photograph is baked in — open satellite ' +
  'imagery of this valley could be redistributed, but composing a cloud-free mosaic of it was beyond this bake — so ' +
  'the ground is shaded by height instead. OpenStreetMap maps only the highway and a few lanes here, and one named ' +
  'place on the road network stands clear of the river. The rivers start dry, so every drop you see is the modelled ' +
  'flood. Watch which ground goes under and in what order, and do not read street-level depths.';

/**
 * Raini–Tapovan, Chamoli district, Uttarakhand — the rock-ice avalanche and debris flow of 7 February 2021.
 *
 * At 04:51 UTC (10:21 IST) ~26.9 million m³ of rock and glacier ice (~80/20 %) fell from the north face of Ronti Peak
 * at ~5,500 m. The ice melted almost entirely on the way (frictional heating) and the mass became a debris flow down
 * the Ronti Gad, the Rishiganga and the Dhauliganga; it destroyed the 13.2 MW Rishiganga plant at Raini and the
 * barrage of the 520 MW Tapovan-Vishnugad project, under construction (Shugar et al. 2021, Science 373:300–306,
 * doi:10.1126/science.abh4455; research spec §G.4).
 *
 * WHAT IS RECONSTRUCTED: Shugar et al. give a MEAN discharge of 8,200–14,200 m³/s at the Rishiganga plant over a
 * passage of 10–20 minutes — a band, not a gauged hydrograph (no gauge on either river survived). The standalone
 * inflow is therefore the spec's §B.4 gamma SHAPE (a = 3) with the band's top as its peak and the volume the chain's
 * direct-flow source produces from the published numbers (src/hazard/mass.ts directFlow): 26.9 Mm³ × 20 % ice × 0.917
 * (ice → water) = 4.93 Mm³ of melt water, carried at Cv 0.4 (DIRECT_FLOW_CV) = 8.2 Mm³ of mixture. That puts the
 * curve's mean over its central 10–20 minutes inside the published band. It is a placeholder for the routed
 * hydrograph the hazard chain puts at this edge, labelled as such, and it only ships on a first bake: once chain.json
 * exists, applyChainResult (scripts/bake-chain-result.ts) replaces it — and this description — with the chain's median
 * member, as for the other glacier presets.
 */
const CHAMOLI_PEAK_M3S = 14200;
const CHAMOLI_MIXTURE_M3 = Math.round((26.9e6 * 0.2 * 0.917) / (1 - 0.4) / 1e5) * 1e5;
const CHAMOLI_HYDROGRAPH = gammaHydrograph(CHAMOLI_PEAK_M3S, CHAMOLI_MIXTURE_M3);
/** Share of the Raini–Tapovan domain steeper than the bare-earth filter's 20° gate, measured on the shipped DEM. */
const CHAMOLI_STEEP_PCT = 90;
const CHAMOLI_DESCRIPTION =
  'Raini stands where the Rishiganga meets the Dhauliganga, and the 13.2 MW Rishiganga hydropower plant stood beside ' +
  'it; 6 km downstream, at Tapovan, the barrage of the 520 MW Tapovan-Vishnugad project was being built. At 10:21 on ' +
  'the morning of 7 February 2021 about 27 million m³ of rock and glacier ice broke from the north face of Ronti Peak, ' +
  '5,500 m up and some 15 km away. Its ice melted on the way down, and the avalanche became a debris flow that ran ' +
  'down the Ronti Gad and the Rishiganga at about 25 m/s, destroyed the Rishiganga plant, reached the Tapovan barrage ' +
  'about a quarter of an hour after the collapse and destroyed it too. Most of the people it took were workers at ' +
  'the two projects (Shugar et al., Science, 2021). Nothing gauged the flow; the published reconstruction gives a mean ' +
  'discharge of 8,200 to 14,200 m³/s at the Rishiganga plant over 10–20 minutes. This run brings ' +
  `${CHAMOLI_PEAK_M3S.toLocaleString('en-US')} m³/s at its peak and ${(CHAMOLI_MIXTURE_M3 / 1e6).toFixed(1)} million m³ in all ` +
  '(the melted ice and the rock it carried) in through the east edge on a smooth rise and fall — a parametric ' +
  'placeholder, not a measured hydrograph — and the clock starts as the front reaches the east edge of the map, not at ' +
  'the collapse. The flow moves as one fluid under a uniform debris-flow friction law (O’Brien–Julien, 45 % solids by ' +
  'volume) with a 25 m/s speed cap; it neither picks up nor drops sediment, so the 8 million m³ the real flow left ' +
  'near the Ronti Gad and the mud it laid down at Tapovan are not here, and the arrival times are the model’s, not ' +
  'the flood’s. The terrain is Copernicus 30 m radar data, a surface model with canopy and buildings in it, acquired ' +
  'in 2011–2015, before the Tapovan barrage was finished. The bare-earth filter only runs on ground flatter than 20°, ' +
  `and ${CHAMOLI_STEEP_PCT} % of this domain is steeper: the valley floor is filtered and still a metre or two high, ` +
  'the walls above it are the raw surface model. No photograph is baked in, so the ground is shaded by height ' +
  'instead. OpenStreetMap maps the Joshimath–Malari road and a few village lanes here. The rivers start dry, so every ' +
  'drop you see is the modelled flow. Watch where it goes and in what order, and do not read street-level depths.';

type LonLat = [number, number];

interface RiverDef {
  name: string;
  /** Waypoints upstream → downstream, [lon, lat]. */
  path: LonLat[];
  depth: number;
  bankCells?: number;
  snapRadius?: number;
  maxHalfWidth?: number;
  /**
   * Slide the upstream inflow ACROSS the channel onto its lowest cell (within half the footprint radius). The edge
   * placement picks the channel's widest cell, which on a narrow, steep gorge (Chungthang's Lachen Chu, ~5 %) can sit
   * a metre or more up the side of the thalweg; on the gentler Trishuli it does not matter and is left alone.
   */
  inflowOnThalweg?: boolean;
  /**
   * GORGE FLOOR: after the burn, set a floor (2·halfWidth + 1) cells wide along the river's traced centreline to its
   * fitted water level minus `depth` — the burn's own monotone level profile, so the floor never rises downstream.
   * Within that strip it both CUTS the false sills and FILLS the false pits between them (a pit in a DSM gorge is the
   * same radar artefact as a sill, and a 15 m pit is a pond the flood has to fill before it moves on); outside the
   * strip nothing changes. The bake logs how many cells it cut and filled, and the deepest of each.
   *
   * Why: a radar DSM cannot see the floor of a slot gorge. In the Rishiganga gorge (Chamoli) Copernicus puts false
   * sills 10–40 m high across the channel (layover off the walls; bake-chain.ts logs them on the same river: +41 m at
   * 13.8 km) and narrows the floor to one or two cells, where the burn's smooth-bank ramp then burns almost nothing.
   * Measured on the GPU (artifacts/chamoli-build/tools/physics.mjs): without the floor even CLEAR WATER ponds 48 m deep
   * behind those sills and creeps down the Rishiganga at 5–8 m/s, where the real debris flow ran ~25 m/s. A burn that
   * is not monotone is the bug; the floor is the spec's "minimum gorge floor width" applied to the 2-D grid.
   */
  carve?: { halfWidth: number };
  /**
   * Source created where the UPSTREAM end meets the domain edge. An inflow may carry `stopAfter` (simulated
   * seconds): a scenario forced by a published VOLUME rather than by a gauge record has to stop, or the run keeps
   * delivering the peak for ever and the total on screen leaves the total that was reported behind.
   */
  upstream?:
    | {
        type: 'inflow';
        discharge: number;
        stopAfter?: number;
        /** A published or parametric hydrograph Q(t) (WaterSource.hydrograph); `discharge` is then its peak. */
        hydrograph?: HydrographPoint[];
        label: string;
      }
    | { type: 'stage'; label: string };
  /** Source created where the DOWNSTREAM end meets the domain edge. */
  downstream?: { type: 'stage'; label: string };
}

interface PresetDef {
  id: string;
  center: { lat: number; lon: number };
  sizeMeters: number;
  n: number;
  rivers: RiverDef[];
  /** Flat navigation pool: measured from the DEM near this initial guess (m). */
  pool?: { guess: number };
  stage?: Omit<StageControl, 'normalLevel'> & { normalLevel?: number };
  /**
   * COASTAL domains: hold every edge crossing of the open water at the stage level, instead of the two discs a
   * river's `upstream`/`downstream` ends give. A tidal estuary is cut by more than two edges (Fort Myers: north,
   * west and south at once) and every uncovered boundary cell drains it — see seaBoundaryDiscs. The slider then
   * raises the whole sea surface together, which is what a storm surge is: a still-water rise, not a discharge, so
   * a `sea` preset takes no `confluenceHead`.
   */
  sea?: {
    /** Label for the boundary sources, e.g. the tide gauge and the event. */
    label: string;
    /**
     * Elevation (m, DEM datum) up to which a crossing may grow beyond the at-rest waterline: the cross-section wet
     * at MEAN HIGHER HIGH WATER, not at the top of the surge slider. See seaBoundaryDiscs for why the surge ceiling
     * cannot be used on flat coastal ground.
     */
    growCeiling: number;
  };
  /**
   * Water-surface drop (m) from the upstream stage boundaries to the downstream one, at normal pool and at a named
   * crest. Half of it is added above the gauge level at upstream boundaries and half taken off at the downstream
   * one, so the gauge (at the confluence) still reads the slider's stage; in between it grows linearly with the
   * slider offset (WaterSource.offsetScale). With every boundary at one level nothing drives the rivers: at the
   * 1936 crest floodplain drainage pulled all three rivers backwards (the Ohio ran INTO downtown at ~2,500 m³/s).
   */
  confluenceHead?: { normal: number; crestFt: number; crest: number };
  shelters: Array<{ name: string; at: LonLat; /** search radius for a high road node, m */ search?: number }>;
  /**
   * Where the scenario's evacuation story starts: the home the "Evacuate" demo step puts the pin on, chosen on
   * evidence — a start whose route to a shelter re-plans as the flood rises, and that still has a way out at the
   * crest where the scenario has one to give, rather than one that merely works or merely fails (artifacts/evac-story
   * ranks every street in the domain; artifacts/demo-beats checks the finalists on the GPU). Snapped to the nearest
   * ordinary street node, never a highway ramp or a bridge deck.
   */
  evacStart?: { at: LonLat; label: string };
  /**
   * The second evacuation beat: a home that stays dry and still loses every road out at the scenario's crest, one
   * click from the first in the Try-it strip. Only where such a start was measured — on a flat coast every start
   * that loses its roads is under water itself, and there is no dry one to show.
   */
  evacCutOff?: { at: LonLat; label: string };
  /** Water view the scenario opens in (ScenarioPreset.defaultView); the photoreal view when omitted. */
  view?: WaterViewMode;
  /**
   * `none` ships NO initial water: the channels start dry and every drop the scene shows comes from its sources.
   *
   * The default flat-level pre-fill cannot represent this domain. `initialFill` semantics are "every cell 4-connected
   * to a seed through ground below the seed's level", and the Betrawati reach falls 167 m across 8 km: a front carrying
   * an upstream level marches down the channel (everything downstream is below it) and then spills sideways onto
   * ground the local level would never have wetted. Measured on the Betrawati bake: 44,261 cells outside the channel
   * mask, ponded up to 85 m deep, with seeds on the centreline as the US presets place them; 6,653 cells and 55 m with
   * a seed on every channel cell; sealing the shoreline (152 cells, ≤ 1.82 m) removed every escape point and changed
   * nothing, because the leak is not an escape through a rim but the fill's own flat-level semantics
   * (artifacts/nepal-build/probe-fill.ts). No measured baseflow for the Trishuli at Betrawati survives either — the
   * gauge was destroyed — so inventing one to fill the channel would be worse than starting dry and saying so.
   */
  prefill?: 'none';
  /**
   * Clearance (m) a shelter needs above the nearest channel's water surface where the preset has no stage slider.
   * The default 20 m is generous mountain-valley headroom. Houston's whole domain lies within 20 m of Buffalo Bayou,
   * so the default leaves no ground to stand on there; see that preset's note for the value it uses and why.
   */
  shelterMargin?: number;
  storms: Array<{ id: string; at: LonLat; radiusMeters: number; intensity: number }>;
  rainRate: number;
  camera: { at: LonLat; distance: number; yaw: number; pitch: number };
  /**
   * Close-up imagery inset: a second DETAIL_SIZE² NAIP export over a square of `sizeMeters` centred on `at` (the
   * scenario camera target by default) — downtown, where judges zoom in. Leave it out where the base photo is
   * already close to NAIP's own resolution (ellicott: 5 km over 4096² = 1.22 m/texel, see the note on the imagery
   * section below); an inset there would add megabytes and no detail.
   */
  detail?: { at?: LonLat; sizeMeters: number };
  /**
   * One-click demo levee ("Build a levee"): a wall from high ground to high ground whose crest clears the scenario's
   * highest crest. The bake checks that both ends stand on ground at least `crest` high and that no segment needs a
   * wall taller than the wall tool builds (10 m).
   */
  levee?: { name: string; crest: number; path: LonLat[]; camera: { at: LonLat; distance: number; yaw: number; pitch: number } };
  /**
   * OUTSIDE THE US: elevation from Copernicus GLO-30 + the bare-earth filter, roads from cached OSM XML, no baked
   * photo. 3DEP, NAIP and TIGERweb all stop at the border, and the elevation model stops being bare earth — which is
   * why this carries its own provenance rather than reusing the US strings.
   */
  global?: {
    /**
     * OSM XML extracts covering the domain, repo-relative: files (API 0.6 `map` quadrants, see
     * artifacts/nepal-build/fetch-osm.mjs) or directories, every *.xml in which is read (scripts/osm-fetch.ts tiles).
     */
    osmXml: string[];
    /** Overrides for the bare-earth filter; anything omitted uses the validated defaults in src/data/demGlobal.ts. */
    bareEarth?: Partial<Omit<BareEarthOptions, 'cellSize'>>;
    /**
     * `none` ships no imagery.jpg: Sentinel-2 L2A is the only globally open source (10 m, and composing it is a
     * separate job), EOX s2cloudless 2018+ is CC BY-NC-SA and may not be redistributed, and Esri World Imagery is
     * live-only by its own terms. The renderer already falls back to a hypsometric tint with slope shading.
     */
    imagery: 'none';
  };
  description: (ctx: { normalLevel: number | null; gaugeDatum: number | null }) => string;
}

const PRESET_DEFS: PresetDef[] = [
  {
    id: 'pittsburgh',
    center: { lat: 40.444, lon: -79.99 },
    sizeMeters: 8000,
    n: 1024,
    pool: { guess: 216.4 },
    rivers: [
      {
        name: 'Allegheny River',
        path: [[-79.96386, 40.47954], [-79.97815, 40.45954], [-79.99567, 40.44902], [-80.0095, 40.4434]],
        depth: 6,
        bankCells: 3,
        maxHalfWidth: 400,
        upstream: { type: 'stage', label: 'Allegheny River' },
      },
      {
        name: 'Monongahela River',
        path: [[-79.95279, 40.4083], [-79.95602, 40.42515], [-79.97262, 40.43358], [-79.99567, 40.43498], [-80.01043, 40.43989]],
        depth: 6,
        bankCells: 3,
        maxHalfWidth: 400,
        upstream: { type: 'stage', label: 'Monongahela River' },
      },
      {
        name: 'Ohio River',
        path: [[-80.01411, 40.44235], [-80.0261, 40.44621], [-80.03671, 40.45674]],
        depth: 6,
        bankCells: 3,
        maxHalfWidth: 400,
        downstream: { type: 'stage', label: 'Ohio River' },
      },
    ],
    stage: {
      label: 'Ohio River at Pittsburgh (Point gauge, USGS 03085152)',
      // NWS PTTP1 flood categories (api.water.noaa.gov/nwps/v1/gauges/PTTP1): action 18 ft, minor (flood stage) 22 ft,
      // moderate 25 ft ("The Parkway Central (also known as the bathtub) is closed by flooding"), major 28 ft.
      // USGS 03085152 gage datum: 693.6 ft above NAVD88 (GNSS survey). NOAA VERTCON 3.0 at the Point gives
      // NAVD88 = NGVD29 − 0.161 m (−0.53 ft), so the Emsworth pool's 710.0 ft NGVD29 is 216.25 m NAVD88 — the
      // bake measures the flat pool surface in the DEM (≈ 216.3 m) and it reads ≈ 16 ft on this gauge.
      gaugeDatum: 693.6 * FT,
      floodStageFt: 22,
      marks: [
        { label: '2004 Ivan', ft: 31.0 },
        { label: '1972 Agnes', ft: 35.8 },
        { label: '1936 record', ft: 46.0 },
      ],
      maxOffset: 12,
    },
    // Measured on the GPU solver after 1–2 h at each stage (all three rivers flow downstream; the Point stays within
    // ±4 cm of the gauge reading): ±0.075 m at normal pool gives ~300–650 m³/s at 0.25 m/s, close to the rivers'
    // mean flows; ±0.2 m at 46 ft gives Allegheny 3,560, Monongahela 2,950 and Ohio 3,070 m³/s with no fast jets.
    confluenceHead: { normal: 0.15, crestFt: 46, crest: 0.4 },
    /*
     * The two evacuation beats, both measured on the GPU at the 1936 crest and not on the bathtub stand-in
     * (artifacts/demo-beats/pgh-endpoints.json, pgh-timeline.json, pgh-cutoff.json).
     *
     * OPENING PIN — Smithfield St at Oliver Ave, 226.5 m, a metre above the 46 ft crest. The demo clicks "Evacuate"
     * AFTER the river is up, so the pin has to still have a route then: this one keeps its way out and re-plans
     * twice on the way — Mount Washington over the Smithfield St bridge (2.4 km), then the same shelter by the
     * Parkway as the bridge approaches go (2.2 km), then the Hill District once the Parkway floods
     * (2.2 km, 5 min at the crest, unchanged from +900 s to +1330 s of simulated time).
     *
     * The start this replaced (Market Square, below) is cut off at the crest: at the moment the judge sees it, the
     * only thing on screen was a red card, and the re-planning it does on the way up had already happened.
     */
    evacStart: { at: [-79.99816, 40.4408], label: 'Smithfield St at Oliver Ave, downtown Pittsburgh' },
    /*
     * SECOND BEAT — Market Square, 226.2 m, also above the crest and dry in the simulation (0.00 m at every sample
     * from +919 s to +1329 s), and still cut off: 830 m of the 1.9 km drive to Mount Washington is under water.
     * The Golden Triangle's tip is the only pocket in this domain where that happens — of 4,467 street nodes, 6
     * stay dry and lose every road out, and all six are these blocks (artifacts/demo-beats/sweep-cutoff.ts).
     */
    evacCutOff: { at: [-80.00294, 40.43999], label: 'Market Square, downtown Pittsburgh' },
    shelters: [
      { name: 'Cathedral of Learning (Pitt, Oakland)', at: [-79.95319, 40.4443], search: 250 },
      { name: 'Mount Washington — Grandview Ave', at: [-80.0105, 40.4362], search: 350 },
      { name: 'Hill District high ground', at: [-79.975, 40.4455], search: 400 },
      { name: 'Fineview hilltop (North Side)', at: [-80.00394, 40.46451], search: 350 },
      { name: 'South Side Slopes', at: [-79.978, 40.423], search: 400 },
    ],
    storms: [],
    rainRate: 0,
    camera: { at: [-80.0005, 40.4418], distance: 4300, yaw: 0.62, pitch: 0.52 },
    // 3 km over the Point: the Golden Triangle, both North Shore stadiums, the Strip's west end and the whole demo
    // levee, i.e. everywhere the scripted cameras go. 0.73 m/texel, 2.7x the base photo.
    detail: { at: [-80.005, 40.442], sizeMeters: 3000 },
    // The North Shore (both stadiums) behind a riverside floodwall from the bluff below Manchester to the bluff at the
    // 16th Street Bridge, ~50 m back from the channel. Crest 226.5 m = 1 m above the 46 ft record at the Point (the
    // Allegheny side stands ~0.3 m higher). Measured on the M4 (runFor, 25 sim-min at 46 ft): 0 wet cells behind it,
    // 0.57 km² and 11 km of streets kept dry, flooded land 6.30 → 5.62 km².
    levee: {
      name: 'the North Shore',
      crest: 226.5,
      path: [
        [-80.02015, 40.44905], [-80.02015, 40.44604], [-80.01831, 40.44556], [-80.01647, 40.44518], [-80.01462, 40.44504],
        [-80.01278, 40.4452], [-80.01093, 40.44537], [-80.00909, 40.4457], [-80.00724, 40.44594], [-80.0054, 40.44631],
        [-80.00356, 40.44698], [-80.00171, 40.44759], [-79.99987, 40.44817], [-79.99895, 40.45067],
      ],
      camera: { at: [-80.00955, 40.44695], distance: 2600, yaw: 0.1, pitch: 0.68 },
    },
    description: ({ normalLevel, gaugeDatum }) =>
      "Downtown Pittsburgh sits on the Point, where the Allegheny and Monongahela rivers meet to form the Ohio. " +
      `Normal pool here is about ${(((normalLevel ?? 0) - (gaugeDatum ?? 0)) / FT).toFixed(1)} ft on the Point gauge; ` +
      'flood stage is 22 ft, and by 25 ft the Parkway "bathtub" through downtown is closed by flooding. On March 18, 1936 — the St. ' +
      'Patrick\'s Day flood — snowmelt and heavy rain drove the river to a record 46 ft and flooded most of the ' +
      'Golden Triangle. The remnants of Agnes crested at 35.8 ft in June 1972 and Hurricane Ivan at 31 ft in ' +
      'September 2004. ' +
      'Raise the river stage to replay those crests and watch the Strip District, the North Shore stadiums and ' +
      'downtown go under — then try a levee.',
  },
  {
    id: 'johnstown',
    center: { lat: 40.33, lon: -78.915 },
    sizeMeters: 7000,
    n: 1024,
    rivers: [
      {
        name: 'Conemaugh River',
        path: [[-78.92495, 40.32905], [-78.92479, 40.33378], [-78.92479, 40.34022], [-78.93204, 40.3436], [-78.93768, 40.34606], [-78.93888, 40.3522], [-78.93888, 40.36128]],
        depth: 2.5,
        bankCells: 2,
        snapRadius: 8,
      },
      {
        name: 'Stonycreek River',
        path: [[-78.91754, 40.29864], [-78.91633, 40.30122], [-78.9115, 40.30196], [-78.90723, 40.30337], [-78.90988, 40.30583], [-78.91472, 40.30675], [-78.91593, 40.30921], [-78.91593, 40.31382], [-78.91415, 40.31689], [-78.91472, 40.32088], [-78.91633, 40.32223], [-78.91955, 40.32334], [-78.92318, 40.32285], [-78.92455, 40.32518], [-78.92495, 40.32886]],
        depth: 2.5,
        bankCells: 2,
        snapRadius: 8,
        upstream: { type: 'inflow', discharge: Math.round(STONYCREEK_TYPICAL_PEAK_CFS * CFS), label: 'Stonycreek River — a typical yearly flood peak (10,600 ft³/s)' },
      },
      {
        name: 'Little Conemaugh River',
        path: [[-78.87396, 40.35281], [-78.87726, 40.35361], [-78.88048, 40.35158], [-78.88113, 40.34974], [-78.88435, 40.34483], [-78.89176, 40.34188], [-78.89982, 40.33378], [-78.90787, 40.3304], [-78.91593, 40.32886], [-78.92237, 40.32886], [-78.92479, 40.32905]],
        depth: 2,
        bankCells: 2,
        snapRadius: 8,
        upstream: { type: 'inflow', discharge: JOHNSTOWN_1889_INFLOW, label: `Little Conemaugh River — the 1889 dam-break flood (${cfsLabel(JOHNSTOWN_1889_INFLOW)} ft³/s)` },
      },
    ],
    shelters: [
      { name: 'Inclined Plane upper station (Westmont)', at: [-78.92729, 40.32573], search: 250 },
      { name: 'Westmont hilltop', at: [-78.95169, 40.31563], search: 300 },
      { name: 'Southmont hilltop', at: [-78.93864, 40.31063], search: 300 },
      { name: 'Prospect hilltop', at: [-78.91212, 40.3345], search: 350 },
    ],
    storms: [],
    rainRate: 0,
    // Looking north-east over downtown with the Little Conemaugh valley running up to the top right: the flood enters
    // there at T+5–10 min, fills the valley through Woodvale by T+20 and covers downtown by T+30 (the flood needs
    // ~15 min to travel the 4.5 km of valley in the domain). At the ~45–50× the M4 reaches with "Play the flood" that is
    // 10–35 s of real time, all inside the frame and clear of the HUD and the side panel at 1470×956. (The old view, 3.4
    // km from a target 1.3 km further south-west, left the valley — where the flood shows first — off the top edge.)
    camera: { at: [-78.91033, 40.33043], distance: 4000, yaw: 0.62, pitch: 0.6 },
    // 2.5 km over downtown Johnstown and the Stonycreek / Little Conemaugh confluence: 0.61 m/texel, 2.8x the base.
    detail: { at: [-78.91033, 40.33043], sizeMeters: 2500 },
    // Sources: Coleman et al. (2016) and USGS peak-flow records (see the constants above); 1889 timeline and toll from
    // the National Park Service (Johnstown Flood National Memorial); 1977 from USGS Open-File Report 78-963.
    description: () =>
      'Johnstown fills a narrow valley where the Little Conemaugh and Stonycreek rivers join to form the ' +
      'Conemaugh. On May 31, 1889, after a night of heavy rain, the South Fork Dam on a branch of the Little ' +
      'Conemaugh 14 miles upstream gave way, and 57 minutes later its lake struck the city as a wall of water and ' +
      'debris that killed ' +
      `2,209 people. Here that flood comes down the valley into today's city: about ${JOHNSTOWN_1889_INFLOW.toLocaleString('en-US')} m³/s ` +
      `(${cfsLabel(JOHNSTOWN_1889_INFLOW)} ft³/s), Lake Conemaugh's 14.5 million m³ spread over the roughly 65 minutes it took ` +
      'to drain (the breach itself peaked at 7,200–9,000 m³/s), while the Stonycreek runs at a typical yearly ' +
      'flood peak. The inflow never stops: remove it after an hour of simulated time to let the valley drain. ' +
      'After the 1936 flood (25 deaths) the Army Corps of Engineers built the concrete channels you see here to ' +
      'carry that flood; in July 1977 up to 12 inches of rain in eight hours and seven failed dams still killed at ' +
      'least 78 people.',
  },
  {
    id: 'ellicott',
    center: { lat: 39.27, lon: -76.805 },
    sizeMeters: 5000,
    n: 1024,
    rivers: [
      {
        name: 'Patapsco River',
        path: [[-76.78525, 39.29234], [-76.79432, 39.26787], [-76.77608, 39.25691]],
        depth: 2,
        bankCells: 2,
        snapRadius: 12,
        upstream: { type: 'inflow', discharge: Math.round(22800 * CFS), label: 'Patapsco River — July 30, 2016 peak (22,800 ft³/s at Hollofield)' },
      },
    ],
    shelters: [
      { name: 'Patapsco Female Institute (Church Rd)', at: [-76.79709, 39.27085], search: 200 },
      { name: 'Howard County Courthouse (Court Ave)', at: [-76.7984, 39.26848], search: 200 },
      { name: 'Fire Station 2 (Montgomery Rd)', at: [-76.82045, 39.25557], search: 250 },
      { name: 'Oella (east bank ridge)', at: [-76.78667, 39.27413], search: 350 },
    ],
    // The storm sits on the centroid of the Tiber Branch watershed at its Patapsco confluence (Hudson, Tiber and New Cut
    // branches; USGS FS 2021–3025: 3.68 mi²). Delineated on this DEM (priority-flood fill + D8): 8.83 km² draining to
    // the Patapsco at grid (653, 576), centroid (403, 617). A storm cell rains at full intensity inside 0.3·R and fades
    // to zero at R (src/sim/forcing.ts stormWeight), so over that watershed a 2,440 m cell averages 0.70 of its peak:
    // 110 mm/hr peak ≈ 77 mm/hr (3.0 in/hr) on the watershed ≈ the 2016 storm's two peak hours (5.96 in between 6:50
    // and 8:50 p.m. at gauge ELYM2). The old 1,900 m, 75 mm/hr cell gave the watershed only ~39 mm/hr. Equilibrium
    // runoff ≈ 77 mm/hr × 8.83 km² ≈ 190 m³/s, below the USGS indirect peaks of 2016 (Hudson 2,750 + Tiber 2,100 +
    // New Cut 3,320 ft³/s ≈ 231 m³/s). Measured (runFor, sim time): 0.12 km² of land flooded at T+10 min, 0.33 at
    // T+20 min (was 0.075 / 0.20).
    storms: [{ id: 'tiber-hudson', at: [-76.81118, 39.26539], radiusMeters: 2440, intensity: 110 }],
    rainRate: 0,
    // Low over the Patapsco looking west up lower Main Street and the branches' confluence, ~1.1 km away: the town's
    // flood channels are ~20–40 px wide at 1470×956 (at the old 1,900 m they were thin threads). Pitch 0.8 keeps the eye
    // above the storm's cloud deck (452 m × exaggeration 1.5 + margin), where the renderer does not grey the sky.
    camera: { at: [-76.79775, 39.26781], distance: 1100, yaw: -Math.PI / 2, pitch: 0.8 },
    description: () =>
      'Historic Ellicott City sits at the bottom of a hill where the Hudson, Tiber and New Cut branches converge ' +
      'and empty into the Patapsco River — and Main Street is the overflow channel when they flash. On July 30, ' +
      '2016, 6.6 inches of rain fell in three hours (nearly 6 in two); the branches tore down Main Street, the ' +
      'Patapsco rose over the lower town, and two people died. On May 27, 2018 almost the same rain fell again ' +
      '(6.56 inches in three hours at the gauge, heavier just to the south) and one man died — two roughly ' +
      '1-in-1,000-year storms in 22 months. Here a storm cell peaking at 110 mm/hr parks over the 3.7 mi² ' +
      'watershed of the three branches and soaks it at about 3 inches an hour, the 2016 storm\'s rate over its two ' +
      'worst hours, while the Patapsco runs at its 2016 peak of 22,800 ft³/s. Try walls or a detention pond upstream.',
  },
  {
    /*
     * Asheville, NC — Hurricane Helene (September 27, 2024). Chosen for MECHANISM (an extreme tropical-remnant river
     * flood in a steep valley, unlike Pittsburgh's slow navigation-pool rise) and for recognition: it is the most
     * recent major US flood disaster. 8 km over the French Broad / Swannanoa confluence covers the River Arts
     * District, Biltmore Village and downtown; measured relief 347 m, so there is real high ground for shelters.
     * River centerlines traced from USGS NHD high-resolution flowlines (artifacts/more-cities/nhd_path.py) and
     * clipped to the domain: the French Broad crosses it south → north, the Swannanoa comes in from the east and
     * joins at cell (584, 714). DEM water surfaces sampled along those traces (probe-river.ts): French Broad
     * 602.2 → 593.6 m, Swannanoa 606.1 → 599.4 m — both sloping, so no flat pool and no stage slider. At the gauge
     * (35.60889, -82.57806) the DEM surface is ~594.9 m, which reads 2.0 ft on its 1,949.93 ft NAVD88 datum: exactly
     * the French Broad's normal stage at Asheville, confirming the datum. Helene's 24.82 ft put the surface 7 m higher.
     */
    id: 'asheville',
    center: { lat: 35.583, lon: -82.57 },
    sizeMeters: 8000,
    n: 1024,
    rivers: [
      {
        name: 'French Broad River',
        path: [
          [-82.57979, 35.54717], [-82.58354, 35.55063], [-82.58815, 35.55316], [-82.59178, 35.55661], [-82.59291, 35.56106],
          [-82.58977, 35.56454], [-82.58436, 35.56564], [-82.57914, 35.56468], [-82.5736, 35.56527], [-82.56833, 35.56713],
          [-82.56374, 35.56901], [-82.56542, 35.57312], [-82.56866, 35.57674], [-82.56778, 35.58149], [-82.56866, 35.58595],
          [-82.57194, 35.58968], [-82.57314, 35.59403], [-82.576, 35.59787], [-82.57739, 35.60203], [-82.58014, 35.60589],
          [-82.57806, 35.60978], [-82.57693, 35.61417], [-82.57802, 35.61852], [-82.57818, 35.61882],
        ],
        depth: 3,
        bankCells: 3,
        snapRadius: 10,
        maxHalfWidth: 200,
        upstream: {
          type: 'inflow',
          discharge: Math.round(HELENE_FRENCH_BROAD_CFS * CFS),
          label: `French Broad River — Helene's record crest (${HELENE_FRENCH_BROAD_CFS.toLocaleString('en-US')} ft³/s)`,
        },
      },
      {
        name: 'Swannanoa River',
        path: [
          [-82.52595, 35.57525], [-82.52898, 35.5727], [-82.53311, 35.57191], [-82.53726, 35.57093], [-82.54126, 35.56952],
          [-82.54537, 35.56835], [-82.54836, 35.5658], [-82.55168, 35.56362], [-82.55602, 35.56413], [-82.56024, 35.56337],
          [-82.56443, 35.56414], [-82.56334, 35.5672], [-82.56391, 35.56858],
        ],
        depth: 2.5,
        bankCells: 2,
        snapRadius: 8,
        upstream: {
          type: 'inflow',
          discharge: Math.round(HELENE_SWANNANOA_CFS * CFS),
          label: `Swannanoa River — Helene's record crest (${HELENE_SWANNANOA_CFS.toLocaleString('en-US')} ft³/s)`,
        },
      },
    ],
    shelters: [
      { name: 'Pack Square (downtown Asheville)', at: [-82.5515, 35.5951], search: 300 },
      { name: 'Beaucatcher Mountain', at: [-82.5385, 35.5905], search: 400 },
      { name: 'Mission Hospital (Biltmore Ave)', at: [-82.5478, 35.5807], search: 300 },
      { name: 'Montford ridge', at: [-82.5635, 35.599], search: 350 },
      { name: 'Kenilworth', at: [-82.542, 35.578], search: 350 },
    ],
    storms: [],
    rainRate: 0,
    // Low over the French Broad just below the Swannanoa confluence, looking north-north-east up the valley: the
    // confluence and Biltmore Village are in the foreground, the River Arts District mid-frame and downtown
    // Asheville on the hill beyond — the three places Helene destroyed, in one frame.
    camera: { at: [-82.566, 35.574], distance: 3200, yaw: 0.4, pitch: 0.5 },
    // 8 km domain = 1.95 m/texel in the base photo, the same mush as Pittsburgh: inset the confluence, the River
    // Arts District and Biltmore Village — everything the scenario camera frames.
    detail: { sizeMeters: 3000 },
    description: () =>
      'Asheville sits in a Blue Ridge valley where the Swannanoa River joins the French Broad. On September 27, ' +
      "2024 Hurricane Helene's rain fell on ground already soaked by a storm two days before, and both rivers broke " +
      'records that had stood since 1916: the French Broad crested at 24.82 ft at the Asheville gauge carrying ' +
      '113,000 ft³/s, the Swannanoa at 27.33 ft and 60,800 ft³/s at Biltmore. The River Arts District was largely ' +
      'destroyed, Biltmore Village went under, dozens of people died in Buncombe County, and washed-out mains left ' +
      'the city without drinking water until November. Here both rivers run at those peaks — the French Broad from ' +
      'the south, the Swannanoa from the east. The inflows never stop: remove them after an hour of simulated time ' +
      'to let the valley drain.',
  },
  {
    /*
     * Nashville, TN — the May 2010 flood. Chosen for a mechanism the other presets cannot show: a single large river
     * held as a navigation pool, rising 30 ft into a downtown, with a real gauge datum and three historic crests on
     * the slider. Measured relief 111 m, so shelters sit on genuine hills. Centerline from USGS NHD flowlines: the
     * river enters at the east edge, bends past downtown and leaves at the north edge.
     *
     * The domain — 6 km at (36.158273, -86.7830) — is the product of two measured constraints, neither obvious.
     *
     * The EAST edge: the Cheatham pool is only truly flat below the city. Sampled along the centerline
     * (probe-river.ts), the DEM surface holds 119.48 m NAVD88 through downtown and then climbs to 120.2 m in the
     * 2 km above it — a real backwater slope. An 8 km domain put that reach at the upstream edge, where the burn's
     * 0.3 m flat tolerance excluded it, so the channel mask never reached the edge and the river had no upstream
     * boundary at all. This east edge sits inside the flat reach.
     *
     * The NORTH edge: the Cumberland's big bend crosses the north side of a wider domain TWICE, and the second
     * crossing is a separate arm that no traced centerline reaches — so it is not in the channel mask and gets no
     * stage boundary, leaving an open edge at pool level that drains the raised river. Bed profiles along candidate
     * north rows (probe-row.ts) show the low ground below the stage ceiling breaking into six runs at one latitude
     * and a single river-only run at this one. Here the edge crosses the river once, so one disc covers it.
     */
    id: 'nashville',
    center: { lat: 36.158273, lon: -86.783 },
    sizeMeters: 6000,
    n: 1024,
    pool: { guess: 119.5 },
    rivers: [
      {
        name: 'Cumberland River',
        path: [
          [-86.74976, 36.16056], [-86.75474, 36.15986], [-86.75952, 36.15926], [-86.76444, 36.15888], [-86.76901, 36.16033],
          [-86.77294, 36.16273], [-86.77522, 36.16601], [-86.77839, 36.17182], [-86.78035, 36.17522], [-86.78163, 36.17962],
          [-86.78224, 36.18511],
        ],
        depth: 6,
        bankCells: 3,
        maxHalfWidth: 400,
        upstream: { type: 'stage', label: 'Cumberland River — upstream of downtown' },
        downstream: { type: 'stage', label: 'Cumberland River — downstream toward Cheatham Lake' },
      },
    ],
    stage: {
      label: 'Cumberland River at Nashville (USGS 03431500)',
      // USGS 03431500 gage datum: 367.45 ft above NAVD88 (NWIS expanded site file). NWS flood stage 40 ft. The
      // May 3, 2010 crest of 51.86 ft is the highest since the Corps' dams were built; USGS measured that peak at
      // 52.55 ft and 188,000 ft³/s. The 1937 (53.90 ft) and 1927 (56.20 ft, 203,000 ft³/s) crests predate the dams.
      gaugeDatum: 367.45 * FT,
      floodStageFt: 40,
      marks: [
        { label: '2010 flood', ft: 51.86 },
        { label: '1937 flood', ft: 53.9 },
        { label: '1927 record', ft: 56.2 },
      ],
      maxOffset: 11,
    },
    // One river, so the "confluence" head is simply the reach's water-surface drop: without it both boundaries sit
    // at one level and nothing drives the pool. 0.15 m over the 4.9 km reach at pool, 0.5 m at the 2010 crest.
    confluenceHead: { normal: 0.15, crestFt: 51.86, crest: 0.5 },
    // Davidson St in East Nashville, across the river from downtown: Rolling Mill Hill → Lockeland Springs as the
    // Cumberland rises, then cut off at 51.5 ft — before the 1927 record the slider reaches.
    evacStart: { at: [-86.75846, 36.161], label: 'Davidson St, East Nashville' },
    shelters: [
      { name: 'Tennessee State Capitol', at: [-86.7844, 36.1659], search: 300 },
      { name: 'Vanderbilt / Midtown', at: [-86.7996, 36.1477], search: 350 },
      { name: 'Fisk University', at: [-86.8075, 36.168], search: 300 },
      { name: 'Lockeland Springs (East Nashville)', at: [-86.753, 36.176], search: 350 },
      { name: 'Rolling Mill Hill', at: [-86.772, 36.154], search: 300 },
    ],
    storms: [],
    rainRate: 0,
    // From East Nashville looking west across the Cumberland at the downtown skyline — the view every photograph of
    // the 2010 flood was taken from. The stadium is on the near bank, Second Avenue and the riverfront on the far one.
    camera: { at: [-86.7735, 36.1635], distance: 2100, yaw: -Math.PI / 2, pitch: 0.45 },
    /*
     * No inset here, though at 1.46 m/texel the base photo is coarser than NAIP resolves and one was baked and
     * measured (2.4x, 3.8 MB): the bytes went to the four domains with the worst blur (1.71-1.95 m/texel) and
     * Nashville, the mildest of the five, keeps its base photo. The directory budget has since moved to 120 MB
     * (tests/data/presets.test.ts explains why), which leaves room for ONE of this inset and Fort Myers'; the
     * export is cached in artifacts/bake-cache, so re-adding it costs one bake.
     */
    description: ({ normalLevel, gaugeDatum }) =>
      'Downtown Nashville stands on the west bank of the Cumberland River, which crosses the city as a navigation ' +
      'pool between Old Hickory Dam upstream and Cheatham Dam downstream. ' +
      `The pool in this elevation model reads about ${(((normalLevel ?? 0) - (gaugeDatum ?? 0)) / FT).toFixed(1)} ft on the Nashville gauge; ` +
      'flood stage is 40 ft. On May 1–2, 2010 a stalled front dropped 13.57 inches of rain on Nashville — double the ' +
      'previous two-day record of 6.68 inches — and on May 3 the river crested at 51.86 ft, the highest since the ' +
      'dams were built (USGS measured the peak at 52.55 ft and 188,000 ft³/s). Second Avenue, the Country Music ' +
      'Hall of Fame, the Schermerhorn Symphony Center and the stadium all took water; 18 people died in Middle ' +
      'Tennessee and damage passed $2 billion. Before the dams the river reached 53.90 ft in 1937 and a record ' +
      '56.20 ft in 1927. Raise the river stage to replay those crests and watch the riverfront go under — then try ' +
      'a wall along First Avenue.',
  },
  {
    /*
     * Houston, TX — Hurricane Harvey (August 2017). Chosen for RAINFALL RUNOFF on a dead-flat coastal city, the one
     * mechanism the other presets do not have, and because Harvey is the flood most judges will name first. The
     * honest physics here are unusual and worth stating: Buffalo Bayou through downtown is a trench 12–14 m below
     * street level (transects at cells (584,515), (707,498), (311,522)), so even its record 32,600 ft³/s cannot
     * climb out. Houston floods from above instead, so the forcing is rain at Harvey's documented peak hourly rate
     * with the bayou already running full, which is what actually happened. Relief 29.5 m — the flattest domain in
     * the set, and the reason it needs `shelterMargin`.
     */
    id: 'houston',
    center: { lat: 29.7625, lon: -95.3855 },
    sizeMeters: 8000,
    n: 1024,
    rivers: [
      {
        name: 'Buffalo Bayou',
        path: [
          [-95.42677, 29.75835], [-95.42451, 29.75732], [-95.42232, 29.75735], [-95.41971, 29.75911], [-95.41731, 29.75839],
          [-95.41462, 29.75991], [-95.4132, 29.76222], [-95.40929, 29.76082], [-95.4054, 29.76091], [-95.40175, 29.76183],
          [-95.39722, 29.76225], [-95.39265, 29.7625], [-95.38839, 29.76175], [-95.38472, 29.76178], [-95.38228, 29.76361],
          [-95.37969, 29.76226], [-95.37628, 29.76102], [-95.37252, 29.76135], [-95.36973, 29.7635], [-95.36627, 29.76398],
          [-95.36253, 29.7646], [-95.35861, 29.76484], [-95.35458, 29.7622], [-95.35387, 29.7647], [-95.35063, 29.76516],
          [-95.34739, 29.76648], [-95.34661, 29.76263], [-95.34423, 29.7621],
        ],
        depth: 4,
        bankCells: 2,
        snapRadius: 12,
        upstream: {
          type: 'inflow',
          discharge: Math.round(HARVEY_BUFFALO_BAYOU_CFS * CFS),
          label: `Buffalo Bayou — Harvey's peak (${HARVEY_BUFFALO_BAYOU_CFS.toLocaleString('en-US')} ft³/s at Shepherd Dr)`,
        },
      },
    ],
    // Every point in this domain is within 20 m of the bayou's surface, so the default clearance leaves nowhere to
    // stand. 6 m is above the sheet flood the scene produces on the streets (the bayou's own flood stays in its
    // trench) and it picks out the only real high ground: the Heights, Memorial Park and the Midtown rise.
    shelterMargin: 6,
    shelters: [
      { name: 'George R. Brown Convention Center', at: [-95.3565, 29.7525], search: 300 },
      { name: 'Houston Heights', at: [-95.3985, 29.7905], search: 300 },
      { name: 'Memorial Park (east)', at: [-95.4225, 29.7655], search: 350 },
      { name: 'Rice Military', at: [-95.4045, 29.7655], search: 300 },
      { name: 'Midtown / Fourth Ward', at: [-95.383, 29.7495], search: 300 },
    ],
    storms: [],
    rainRate: HARVEY_PEAK_RAIN_MM_HR,
    // Over Buffalo Bayou Park looking east-south-east down the bayou at the downtown skyline: the park trench fills
    // in the foreground (the Harvey photograph everyone saw) with the towers behind it.
    camera: { at: [-95.385, 29.762], distance: 2200, yaw: 1.45, pitch: 0.42 },
    // 8 km domain = 1.95 m/texel in the base photo: inset Buffalo Bayou Park and the downtown towers behind it,
    // the frame this scenario opens on.
    detail: { sizeMeters: 3000 },
    description: () =>
      'Houston is built on a dead-flat coastal plain drained by slow bayous, and Buffalo Bayou runs in a deep trench ' +
      'past downtown. Hurricane Harvey stalled over the city in August 2017 and dropped more than 40 inches of rain ' +
      'in four days over much of Harris County — 60.58 inches at Nederland, a US tropical-cyclone record — with ' +
      'bands that trained over the same ground long enough to put 6.8 inches on southeast Houston in a single hour. ' +
      'Buffalo Bayou crested at 41.90 ft at the Shepherd Drive gauge on August 28 carrying 32,600 ft³/s, its biggest ' +
      'flood since 1935, swollen by emergency releases from the Addicks and Barker reservoirs upstream. Here the ' +
      "bayou runs at that peak while the city takes Harvey's worst hour of rain, 6.8 inches an hour: the bayou's own " +
      'flood stays in its trench, 12 m below the streets, so with nowhere for the rain to drain the water rises in ' +
      'the streets instead — which is how Houston actually flooded.',
  },
  {
    /*
     * Boulder, CO — the September 2013 Front Range flood. Chosen for the FLASH-FLOOD mechanism in steep terrain: a
     * creek leaving a canyon onto the city, different again from Ellicott City's urban storm drain and from
     * Johnstown's dam break. Boulder Creek is banked only ~1.5–3 m deep through town (transects: probe-transect.ts),
     * so the record inflow leaves the channel within minutes. Centerline from USGS NHD flowlines: the creek enters
     * inside Boulder Canyon at the west edge and leaves at the east edge.
     *
     * 5 km and maxHalfWidth 8, both measured (artifacts/more-cities/sweep-boulder.ts). Boulder Creek is at grade with
     * its floodplain — unlike Johnstown's concrete channels or Ellicott's incised Patapsco — so filling it to the
     * DEM's own water surface is delicate: an upstream seed's level sits above ground far downstream, and if the
     * channel mask touches the low corridor toward Boulder Reservoir the initial fill escapes and drowns the domain.
     * The sweep is sharply bimodal: 5 km with a mask capped at 8 cells (39 m) leaves 7 cells of water outside the
     * channel out of 3,763; the 8 km domain, and the same domain with a 14-cell cap, leak 98 % of their wet cells.
     * The tighter domain also frames the story better — canyon mouth, downtown and the CU campus at 4.88 m cells.
     */
    id: 'boulder',
    center: { lat: 40.014, lon: -105.283 },
    sizeMeters: 5000,
    n: 1024,
    rivers: [
      {
        name: 'Boulder Creek',
        path: [
          [-105.31218, 40.01529], [-105.31069, 40.01401], [-105.30886, 40.01274], [-105.30714, 40.01197], [-105.30413, 40.01218],
          [-105.30114, 40.01232], [-105.3004, 40.01394], [-105.29768, 40.01309], [-105.29462, 40.01353], [-105.2915, 40.01377],
          [-105.28831, 40.01361], [-105.28541, 40.01432], [-105.28241, 40.01433], [-105.27922, 40.01485], [-105.27626, 40.01371],
          [-105.27359, 40.01241], [-105.27089, 40.01164], [-105.268, 40.01176], [-105.26524, 40.01095], [-105.26242, 40.01134],
          [-105.25951, 40.01157], [-105.2567, 40.01092], [-105.25383, 40.01113],
        ],
        depth: 2,
        bankCells: 2,
        snapRadius: 8,
        maxHalfWidth: 8,
        upstream: {
          type: 'inflow',
          discharge: Math.round(BOULDER_2013_CFS * CFS),
          label: `Boulder Creek — the 2013 flood out of Boulder Canyon (${BOULDER_2013_CFS.toLocaleString('en-US')} ft³/s)`,
        },
      },
    ],
    shelters: [
      { name: 'Chautauqua Park', at: [-105.281, 40.0], search: 350 },
      { name: 'Mount Sanitas trailhead', at: [-105.2955, 40.0215], search: 350 },
      { name: 'University Hill', at: [-105.277, 40.006], search: 300 },
      { name: 'Flagstaff Mountain (Flagstaff Rd)', at: [-105.296, 40.004], search: 500 },
    ],
    storms: [],
    // The 2013 storm was extraordinary for duration, not intensity: Boulder's record calendar day, 9.08 in, averages
    // 9.6 mm/hr. So the whole domain rains at that rate (it wets the foothills and adds runoff) while the creek
    // carries the flood — rather than a high-intensity cell, which this event never had.
    rainRate: BOULDER_2013_RAIN_MM_HR,
    // Over Boulder Creek between the canyon mouth and downtown, looking west-north-west back up the creek: the flood
    // comes out of the canyon toward the camera with the foothills behind it and downtown Boulder off to the right.
    camera: { at: [-105.29, 40.0136], distance: 1800, yaw: -1.35, pitch: 0.45 },
    description: () =>
      'Boulder is built at the mouth of Boulder Canyon, where the creek leaves the Rockies and crosses the city past ' +
      'downtown and the university. Between September 9 and 16, 2013 a stalled monsoon plume dropped 17.15 inches of ' +
      "rain on Boulder County — 9.08 inches on September 12 alone, the wettest calendar day in the city's record — " +
      'and the canyons flashed. Boulder Creek left town at 8,400 ft³/s at the 75th Street gauge, four times its ' +
      'previous record of 2,050 ft³/s, and the flood closed every canyon road out of the city. Here that flood comes ' +
      "out of the canyon at the west edge while the record day's rain falls on the foothills. Boulder Creek is banked " +
      'only about 3 m deep through town, so it leaves its channel within minutes and runs down the streets beside it.',
  },
  {
    /*
     * Fort Myers, FL — Hurricane Ian, 28 September 2022. Chosen for COASTAL STORM SURGE, the one mechanism none of
     * the other presets has: the forcing is not a discharge but the sea itself standing higher, pushed up a tidal
     * estuary. It is also the Florida flood judges name first, and it is the best-instrumented one — NOAA 8725520 is
     * inside this frame (26.6478, -81.8714), and its record is Ian's.
     *
     * The domain (8 km, 7.81 m cells) is framed on the probe in artifacts/florida-build/probe-layout.ts: the
     * Caloosahatchee runs diagonally from the north edge (cells 496..928) down to the west edge (486..1023) and the
     * south edge (0..217) — it leaves through THREE edges, because the domain corner falls in the middle of the
     * river mouth. That is why this preset uses `sea` rather than a river's upstream/downstream pair: two discs
     * cannot cover three crossings, and an uncovered crossing drains the estuary off the edge at rest.
     *
     * Fort Myers is on the SOUTH bank (ground 4-5 m NAVD88, rising to 13 m); Cape Coral is the low 1-3 m ground to
     * the north-west. 35 % of the domain is below MHHW. The DEM's own flat river surface measures about -0.28 m
     * NAVD88, essentially MLLW (-0.317 m) — the lidar was flown near low tide — and the bake measures it rather
     * than assuming it.
     *
     * There is NO confluenceHead: a surge is a still-water rise, so every boundary sits at one level and nothing
     * drives the estuary at rest, which is correct for a tidal river. The slider raises all three boundaries
     * together and the water advances inland from the shoreline as a front.
     */
    id: 'ftmyers',
    center: { lat: 26.632, lon: -81.872 },
    sizeMeters: 8000,
    n: 1024,
    pool: { guess: -0.28 },
    rivers: [
      {
        name: 'Caloosahatchee River',
        // Centerline down the middle of the estuary, north edge -> south-west, read off the layout probe. No
        // upstream/downstream source: `sea` places the boundary discs on every crossing instead.
        path: [
          [-81.8576, 26.6675], [-81.8657, 26.6608], [-81.8751, 26.6548], [-81.8852, 26.6474], [-81.8934, 26.6400],
          [-81.8984, 26.6341], [-81.9009, 26.6237], [-81.9028, 26.6103], [-81.9040, 26.5969],
        ],
        depth: 4,
        bankCells: 3,
        maxHalfWidth: 260,
        snapRadius: 8,
      },
    ],
    stage: {
      label: 'Caloosahatchee River at Fort Myers (NOAA 8725520)',
      gaugeDatum: FTMYERS_GAUGE_DATUM,
      marks: [
        { label: 'Mean higher high water', ft: FTMYERS_MHHW_FT },
        { label: 'Hurricane Ian (record)', ft: IAN_PEAK_FT },
      ],
      // Ian's 12.92 ft is 2.57 m above the measured low-tide pool; 2.8 m of slider clears it with headroom.
      maxOffset: 2.8,
    },
    sea: {
      label: 'Gulf tide at Fort Myers — storm surge (NOAA 8725520)',
      // Crossings grow only over ground below MEAN HIGHER HIGH WATER (+0.085 m NAVD88): the tidal flat that is wet
      // anyway at the top of the tide. Growing to the surge ceiling would run away across this flat domain.
      growCeiling: FTMYERS_MHHW_NAVD88,
    },
    /*
     * High ground, from the layout probe, with each point's street confirmed by OSM reverse geocoding. Downtown Fort
     * Myers itself is only ~3 m NAVD88 and sits BELOW the top of this slider, so it is not a shelter — which is the
     * honest answer for a riverfront that flooded.
     */
    /*
     * McGregor Blvd on the riverfront, 1.6 m NAVD88: the route out starts along the river, is pushed inland onto
     * Linhart Ave and Hanson St as the surge takes McGregor, and loses its last street before the gauge reaches
     * Ian's 12.92 ft. Of 1,473 streets in this domain only 14 both re-plan and then close within 1.3 km of the
     * scenario's framing; this is the one with the largest re-plan (6.0 km → 4.2 km).
     *
     * THERE IS NO SECOND BEAT HERE, and that is the finding rather than a gap. Sampling every ordinary street node
     * at 60 m spacing gives 1,684 starts; raised to Ian's crest, 1,208 never change their drive at all (their ground
     * is above the surge), 442 lose their last route, and only 16 in the whole domain re-plan onto a way out that
     * survives — 1 %, against 17 % on Pittsburgh's hills (artifacts/demo-beats/ftm-distribution.ts). A flat coast
     * has no high ground to detour onto, so no home here stays dry and merely cut off the way Market Square does:
     * `evacCutOff` is deliberately absent, and what this preset measures instead is warning time. Live on the GPU
     * from this pin (artifacts/demo-beats/ftm-timeline.json): 6.0 km along McGregor at the tide, 4.2 km inland as
     * the surge takes it, 4.5 km with water on the road at T+3:01, and at T+3:19 the last route closes — 3 min 19 s
     * of warning, which the route card states with the clock reading from the top bar.
     */
    evacStart: { at: [-81.8829, 26.6298], label: 'McGregor Blvd, Fort Myers riverfront' },
    shelters: [
      { name: 'Canal Street — east Fort Myers', at: [-81.85194, 26.62558], search: 800 },
      { name: 'Veronica S. Shoemaker Boulevard', at: [-81.83938, 26.62747], search: 350 },
      { name: 'Aldermans Walk', at: [-81.8338, 26.6107], search: 400 },
      { name: 'Ironbridge Boulevard', at: [-81.84103, 26.61561], search: 600 },
    ],
    storms: [],
    rainRate: 0,
    // Over the middle of the estuary looking south-east at the downtown Fort Myers riverfront: the surge comes up
    // the river from the right of frame and climbs the near bank.
    camera: { at: [-81.879, 26.642], distance: 2400, yaw: 1.45, pitch: 0.42 },
    /*
     * No close-up inset, though at 1.95 m/texel this domain has the same blur Houston's inset was baked for: this
     * eighth preset ships base imagery only. The directory budget has since been settled at 120 MB
     * (tests/data/presets.test.ts carries the argument), which leaves ~13 MB over the current 97.2 MB — enough for
     * ONE more preset OR one of the two deferred insets (this one and Nashville's), not both.
     */
    description: ({ normalLevel, gaugeDatum }) =>
      'Fort Myers stands on the south bank of the Caloosahatchee, a tidal estuary two kilometres wide that opens ' +
      'into San Carlos Bay and the Gulf of Mexico. A third of this domain lies below mean higher high water, so the ' +
      'flood here does not come down the river — it comes in from the sea. ' +
      `The estuary in this elevation model reads about ${(((normalLevel ?? 0) - (gaugeDatum ?? 0)) / FT).toFixed(1)} ft ` +
      `on the Fort Myers gauge (NOAA 8725520), close to low tide; mean higher high water is ${FTMYERS_MHHW_FT} ft. ` +
      'Hurricane Ian came ashore on Sanibel and Cayo Costa on September 28, 2022 as a category 4 hurricane and drove ' +
      `the Gulf up the Caloosahatchee: at 22:18 GMT the gauge read ${IAN_PEAK_FT} ft — 2.29 m above NAVD88 — the ` +
      'highest water level in its record. Downtown Fort Myers, three metres above the datum, went under, and boats ' +
      'were left in the streets of the River District. ' +
      'Raise the surge and watch the water come in from the river mouth rather than fall from the sky: the ' +
      'elevation model is USGS 3DEP lidar at 7.8 m cells, so the streets are resolved but individual buildings ' +
      'and seawalls are not. ' +
      'Evacuation here is about warning time, not detours, and that is a measurement rather than a mood: sampling ' +
      'the street network at 60 m spacing gives 1,684 starts, and as the surge rises to Ian\u2019s crest 442 of them ' +
      'lose their last route to a shelter while only 16 find another way out that survives it — flat ground has no ' +
      'high ground to re-plan onto. Put the evacuation pin down BEFORE you raise the surge: the card then names the ' +
      'moment the last road out closed and how long there had been one.',
  },
  {
    /*
     * Betrawati — 8 km square centred 27.9900 N, 85.1860 E, 7.81 m cells, the same grid as Pittsburgh and Asheville.
     * Chosen because the evacuation story is geometric here: the Pasang Lhamu Highway runs along the valley floor at
     * 605–625 m, metres above a channel at 601 m, and the only way out of the water is UP — the Trishuli, the Salankhu
     * Khola and the Phalakhu Khola all meet inside the box, with 1,900 m of relief around them (measured on this DEM:
     * 560 → 2,494 m; the research brief's 1,144 m figure was low, see artifacts/nepal-build/out-layout-8000.txt).
     *
     * The box crosses 28.0 N, so the elevation is a two-tile Copernicus mosaic — which is the point: any non-US domain
     * can straddle a tile line, and the seam here is measurably invisible (artifacts/nepal-build, `validate-global.ts
     * seam`: the row holding 28.0 N differs from its neighbour by 2.39 m of mean |Δz| against a domain median of
     * 2.77 m, i.e. less than the terrain's own roughness).
     *
     * NO STAGE CONTROL and no pool. What defines this event is a wave arriving from upstream while the reach below is
     * still normal; a stage slider raises the whole channel at once, which would tell the opposite story. Forced by one
     * inflow at the north edge, as Johnstown is.
     */
    id: 'nepal',
    center: { lat: 27.99, lon: 85.186 },
    sizeMeters: 8000,
    n: 1024,
    global: {
      osmXml: [
        'artifacts/nepal-build/osm-betrawati-q0.xml',
        'artifacts/nepal-build/osm-betrawati-q1.xml',
        'artifacts/nepal-build/osm-betrawati-q2.xml',
        'artifacts/nepal-build/osm-betrawati-q3.xml',
      ],
      imagery: 'none',
    },
    rivers: [
      {
        /*
         * Traced from OSM ways 343007937 + 343007938 + 27033466 ("Trishuli Ganga River"), simplified to 25 m and
         * extended to the channel the DEM shows on the north edge — OSM's mapping stops 70 m short of it, and an
         * inflow has to sit on a river that crosses the boundary (artifacts/nepal-build/extract-rivers.ts). Surface
         * heights along the trace, from the DSM over water: 726 → 691 → 661 → 630 → 615 → 600 → 563 m.
         */
        name: 'Trishuli',
        path: [
          [85.1889, 28.02596], [85.18787, 28.02529], [85.18668, 28.0242], [85.18604, 28.02236], [85.18619, 28.02075],
          [85.18748, 28.01932], [85.18729, 28.01625], [85.18563, 28.01517], [85.18423, 28.01286], [85.18369, 28.01109],
          [85.18362, 28.00704], [85.18427, 28.00476], [85.18378, 28.0018], [85.18617, 27.99683], [85.18228, 27.99324],
          [85.18286, 27.99001], [85.18247, 27.98949], [85.18047, 27.9886], [85.1801, 27.98772], [85.18054, 27.9844],
          [85.18038, 27.98116], [85.18153, 27.97869], [85.18246, 27.97497], [85.18442, 27.97211], [85.18434, 27.97138],
          [85.1838, 27.97065], [85.1829, 27.97025], [85.17911, 27.96928], [85.17821, 27.96852], [85.17626, 27.96494],
          [85.16976, 27.96263], [85.16709, 27.95703], [85.16194, 27.95484], [85.16255, 27.95317], [85.1626, 27.94903],
        ],
        depth: 4,
        bankCells: 3,
        snapRadius: 10,
        maxHalfWidth: 40,
        upstream: {
          type: 'inflow',
          discharge: TRISHULI_SURGE_INFLOW,
          /*
           * AND IT STOPS. The forcing here is a reported VOLUME divided by a release time, so the release time is
           * part of the number: without it the same 11,100 m³/s kept arriving and the run had delivered 2.07e7 m³ by
           * 31 simulated minutes and 5.15e7 m³ by 78 — two and a half times the 20 million m³ DHM reported, while
           * the label on screen still said 20. 11,100 × 1,800 s = 19.98 million m³, the reported total to within the
           * rounding of the discharge to a hundred m³/s (tests/data/presets.test.ts asserts the product).
           */
          stopAfter: BHOTE_KOSHI_RELEASE_S,
          label: `Trishuli — scenario surge: ${(BHOTE_KOSHI_EXCESS_M3 / 1e6).toFixed(0)} million m³ over 30 minutes (DHM reported volume, not a measured peak)`,
        },
      },
      {
        /*
         * OSM way 298744777. The two tributaries deliberately START INSIDE the domain rather than at its edge: no
         * monsoon discharge for either is published that I could tie to a gauge, and a wet channel touching an open
         * boundary with no inflow simply drains out of it. Inventing a baseflow number would be worse than a channel
         * that begins 300 m in.
         */
        name: 'Salankhu Khola',
        path: [
          [85.14812, 27.98943], [85.14889, 27.98864], [85.15075, 27.98905], [85.15374, 27.98728], [85.15741, 27.98833],
          [85.15856, 27.98799], [85.15936, 27.98659], [85.16032, 27.98563], [85.16157, 27.98612], [85.16205, 27.98591],
          [85.16224, 27.98479], [85.16277, 27.98426], [85.16661, 27.98273], [85.16777, 27.98282], [85.16932, 27.98194],
          [85.17342, 27.98218], [85.17663, 27.98304], [85.17929, 27.98228], [85.18027, 27.98166],
        ],
        depth: 1.5,
        bankCells: 2,
        snapRadius: 8,
        maxHalfWidth: 15,
      },
      {
        /*
         * OSM way 300686595, tagged "Falaakhu River" — the Phalakhu Khola, the channel the destroyed Betrawati bridge
         * spanned, and where India's 70 m Bailey bridge is being installed. Its confluence with the Trishuli at
         * 27.9728 N is the district line and the scenario's camera target.
         */
        name: 'Phalakhu Khola',
        path: [
          [85.22226, 27.97406], [85.22134, 27.97555], [85.21914, 27.97582], [85.21674, 27.97507], [85.21559, 27.97361],
          [85.21305, 27.97245], [85.2109, 27.97312], [85.20816, 27.97494], [85.20718, 27.97478], [85.20587, 27.97529],
          [85.20383, 27.975], [85.2021, 27.9757], [85.20109, 27.97514], [85.19991, 27.97494], [85.19461, 27.97602],
          [85.19144, 27.97549], [85.18912, 27.97664], [85.1881, 27.97646], [85.187, 27.97565], [85.18588, 27.9743],
          [85.18463, 27.97389], [85.18404, 27.97281],
        ],
        depth: 1.5,
        bankCells: 2,
        snapRadius: 8,
        maxHalfWidth: 15,
      },
    ],
    /*
     * TWO SHELTERS, and each is a node in the OSM extracts this preset ships with — name, spelling and position all
     * read out of the XML (artifacts/nepal-build/osm-betrawati-q*.xml), not out of the research brief and not out of
     * anyone's memory. tests/data/presets.test.ts pins both to their node id and coordinates.
     *
     *   Shree Sundaradevi Pra Vi   node 5063441826   27.9762731 N, 85.1769728 E   774 m on this DEM
     *   Shree Sivalaya Ni Ma.V     node 4969611375   27.9835489 N, 85.1913123 E   917 m on this DEM
     *
     * The bake then snaps each to a high road node within `search` — a refuge nothing drives to is no refuge — which
     * puts them at 715 m and 929 m, 80 m and 276 m above the channel surface the burn measured beside each of them
     * (605 m and 623 m). The second one's spelling really is "Ni Ma.V" in OSM; it shipped as "Ni Ma Vi" until the
     * audit, and a name that is not the name is a small lie that goes out on the on-screen route text.
     *
     * NOT "Kalika Community Hospital", which was the third entry and was wrong twice over:
     *   • its coordinates, [85.18091, 28.02053], are an untagged vertex of OSM way 443766738 — a stream — 3.5 km
     *     north of the hospital and 753 m below it. The name was on screen, in the routing text, over a stream bank.
     *   • the hospital's real node (4407834159, 27.9938874 N, 85.2034632 E, addr:city Kalikasthan) stands at 1,520 m
     *     on this DEM, 919 m above the valley floor and up on the Kalikasthan ridge. The research brief calls that
     *     "on the ridge — a long climb, not a walk" and warns that a UI implying the ridge tops are minutes away is
     *     lying. Moving the pin to the true node would have fixed the name and told a worse lie: the router would
     *     have offered a 900 m climb as an evacuation destination with a travel time beside it.
     * So the honest set here is two, both on the 700–930 m band the brief recommends, and the domain keeps a real
     * hospital it does not pretend is reachable.
     *
     * ALSO NOT Shree Neelkanta Higher Sec School (node 4706138525, 27.9785677 N, 85.1840744 E) — the school nearest
     * the Betrawati bazaar, and the one the research brief wanted. NOT because it is too low: on this DEM it stands
     * 706.4 m, 69 m clear of the channel beside it, well over the 33 m this preset demands (`shelterMargin` + the
     * bake's own 3 m buffer). It is out because this bake's road graph has NO node within its 200 m search radius —
     * the nearest three are 260 m away, at 706–709 m — so the shelter would fall back to the landmark point itself,
     * off the road network, where the router cannot reach it and tests/data/presets.test.ts (40 m of a road node)
     * refuses it. Widening one shelter's search radius until the answer came out right is the edit not to make.
     *   (The number this comment used to carry — "the highest road node within 200 m stands 656.1 m, 31.3 m above the
     *   Salankhu channel" — described a road node at 27.98371 N, 85.17876 E, 775 m from the school and beside the
     *   Trishuli, not the Salankhu. It was the same class of error as the Kalika pin: a measurement of somewhere else.)
     * Shree Ramchandra Ni Ma Vi, 15 m above the channel, was never a candidate.
     */
    shelters: [
      { name: 'Shree Sundaradevi Pra Vi', at: [85.1769728, 27.9762731], search: 200 },
      { name: 'Shree Sivalaya Ni Ma.V', at: [85.1913123, 27.9835489], search: 200 },
    ],
    /*
     * The surge is on the scale of the valley, not of a floodplain: 30 m of clearance above the nearest channel
     * surface, rather than the default 20, before a point counts as high ground.
     */
    shelterMargin: 30,
    /*
     * Dry channels at t = 0 — see PresetDef.prefill for the measurements behind that. The scenario text says so, and
     * the surge is on screen quickly: 354,000 m³ in the domain by 30 simulated seconds, the front in frame by about
     * 8 simulated minutes and through the Betrawati crossing by 23 (measured, artifacts/nepal-build/shots).
     */
    prefill: 'none',
    storms: [],
    rainRate: 0,
    /*
     * Looking north up the Trishuli, with the Betrawati bridge crossing — the Phalakhu junction — in the lower third
     * of the frame and the reach the surge comes down filling the rest.
     *
     * NONE OF THESE THREE NUMBERS IS TASTE; each one was measured against a screenshot, and the first framing this
     * preset shipped with (the crossing itself at 2.6 km and pitch 0.52) failed on both counts:
     *   • PITCH. The crossing sits at 600 m with 900 m ridges a kilometre away on both sides, so a shallow pitch puts
     *     the camera BEHIND the south ridge and every shot is a green hillside with no river in it
     *     (artifacts/nepal-build/shots/probe-A.png, probe2-I.png). Looking into a Himalayan valley means looking DOWN
     *     into it: 0.72 rad clears the wall.
     *   • WHERE THE WATER IS, AND WHEN. The surge enters 5.9 km upstream of the crossing and the solver caps at
     *     15 m/s, so nothing reaches the crossing for about 20 simulated minutes — 30 s of real time at the app's 60x
     *     default. Framed tight on the crossing, the opening half-minute of the demo is an empty valley (nepal-15s.png
     *     has 4.4 million m³ of water in the domain and not one pixel of it on screen). Pulling back to 5 km and
     *     putting the target 760 m NORTH of the crossing brings the front into the top of frame at about 8 simulated
     *     minutes while the crossing, both shelters and the highway along the floor all stay in shot.
     * The target is 27.97961 N, 85.18544 E — the Trishuli reach above Betrawati, not the confluence itself.
     */
    camera: { at: [85.18544, 27.97961], distance: 5000, yaw: 0.12, pitch: 0.72 },
    /*
     * OPENS IN THE DEPTH VIEW, and that is a truthfulness decision rather than a styling one. The photoreal water
     * shader was built for a river that is already there: absorption and a sky reflection over a wet bed, with foam
     * where the flow is fast. Here the channels start DRY (`prefill: 'none'`) and the surge arrives over bare rock at
     * the solver's 15 m/s speed cap — every cell it covers is whitewater-fast — so the shading it produces is a pale
     * grey-tan streak down the valley that reads as the gravel riverbed it is flowing over, not as water. There is no
     * aerial photo under it to say otherwise either (`imagery: 'none'`). Compared side by side at the same instant of
     * the same run (artifacts/demo-beats/shots/nepal-t400-realistic.png vs nepal-t400-depth.png, 0.79 km² wet,
     * 21.4 m deepest): the depth view puts a blue ribbon down the gorge with the deepest water dark in the middle
     * of it, and a judge reads it as a flood without being told. The realistic view stays one press of V away.
     */
    view: 'depth',
    description: () =>
      'Betrawati stands where the Phalakhu Khola meets the Trishuli on the Nuwakot–Rasuwa district line, and its ' +
      'bridge carried the Pasang Lhamu Highway — the only road into Rasuwa district. On the morning of 26 August ' +
      '2026 rock and glacier ice broke from the north face of Langtang Lirung and fell about 1,200 m into the Lhende ' +
      'Khola, sending a debris flood down the Bhote Koshi and the Trishuli; it reached Betrawati around 9:20 am, ' +
      'minutes after the first SMS alerts went out, and took the bridge with it. Nepal\u2019s Flood Forecasting ' +
      `Division reported about ${(BHOTE_KOSHI_EXCESS_M3 / 1e6).toFixed(0)} million m³ of excess water down the river ` +
      `system, and this run releases that volume over 30 minutes — about ${TRISHULI_SURGE_INFLOW.toLocaleString('en-US')} m³/s, ` +
      'an average rather than a measured peak, because the gauge here ' +
      `(warning level ${BETRAWATI_WARNING_M} m, danger level ${BETRAWATI_DANGER_M} m) last read ` +
      `${BETRAWATI_LAST_READING_M} m and was swept away before the crest arrived; the inflow then stops, so the run ` +
      'delivers that volume and no more. The terrain is Copernicus 30 m radar data, a surface model with canopy and ' +
      'buildings in it. The bare-earth filter only runs on ground flatter than 20°, and 77 % of this domain is ' +
      'steeper: the valley floor is filtered and still a metre or two high, the walls above it are the raw surface ' +
      'model. No photograph is baked in — open satellite imagery of this valley could be redistributed, but ' +
      'composing a cloud-free monsoon mosaic of it was beyond this bake and the ready-made cloud-free mosaics are ' +
      'licensed against redistribution — so the ground is shaded by height instead. ' +
      'The rivers start dry, because no surviving gauge gives their flow that morning and this model cannot hold a ' +
      'river that falls 167 m across the domain at a level — so every drop you see is the modelled surge. The clock ' +
      'is the model’s, not the flood’s: the surge starts from rest at the edge of the map and moves under one ' +
      'uniform debris-flood friction law with a 25 m/s speed cap (measured debris-flood fronts ran 20–25 m/s), so ' +
      'these are not the real arrival times. Watch which roads go under and in what order, and where the ' +
      'routes turn uphill, and do not read street-level depths.',
  },
  {
    /*
     * Chungthang — 8 km square centred 27.6033 N, 88.6380 E (7.81 m cells, the Betrawati grid), built exactly as
     * `nepal` is: Copernicus GLO-30 through the bare-earth filter, OSM roads, no photo, dry channels, one inflow.
     * The centre is ~850 m west of Chungthang village (OSM node 13148720740, 27.60424 N, 88.64652 E), and the north
     * edge (27.6392 N) is placed where the Lachen Chu — the river the flood came down — crosses it on a reach the raw
     * DEM shows falling steadily. Two earlier centres put the edge on DSM noise instead (measured along the routed
     * river, artifacts/chungthang-build): at 27.648 N and 27.656 N the radar surface over the channel RISES 4–10 m
     * downstream for a few hundred metres, which left the inflow on a false low with the bed climbing away from it.
     * The Lachen–Lachung confluence, the village, the Teesta-III dam site (OSM way 733894880) and the Teesta's exit
     * through the south edge are all inside.
     */
    id: 'chungthang',
    center: { lat: 27.6033, lon: 88.638 },
    sizeMeters: 8000,
    n: 1024,
    global: {
      // Aligned 0.03° OSM API tiles shared with the chain bake (scripts/osm-fetch.ts `tiles`, scripts/bake-chain.ts).
      osmXml: ['artifacts/chungthang-build/chain-osm'],
      imagery: 'none',
    },
    rivers: [
      {
        /*
         * OSM ways 126757767 + 126757760 ("Lachen Chu") + 1214968882 + 1214968883 + 126757765 ("Teesta"), clipped to
         * the domain and simplified to 25 m (the same extraction as the Betrawati rivers). The Lachen Chu meets the
         * Lachung Chu at 27.6011 N, 88.6489 E and is called the Teesta below it.
         */
        name: 'Lachen Chu',
        path: [
          [88.61007, 27.64199], [88.61103, 27.64071], [88.61144, 27.6403],
          [88.61256, 27.63966], [88.61293, 27.63902], [88.61302, 27.63816], [88.61369, 27.63703], [88.61438, 27.63657],
          [88.61544, 27.63651], [88.61612, 27.63544], [88.61674, 27.63436], [88.61713, 27.63273], [88.61816, 27.63072],
          [88.61875, 27.63009], [88.61912, 27.62901], [88.61885, 27.62794], [88.61938, 27.62654], [88.61933, 27.62598],
          [88.61925, 27.62528], [88.61911, 27.62407], [88.61937, 27.62294], [88.61903, 27.62176], [88.61934, 27.62062],
          [88.61979, 27.61963], [88.62025, 27.61948], [88.62156, 27.61965], [88.62245, 27.61924], [88.62273, 27.61869],
          [88.62307, 27.61843], [88.62417, 27.6179], [88.62506, 27.61758], [88.62519, 27.61715], [88.62546, 27.61693],
          [88.62565, 27.61658], [88.62643, 27.61624], [88.62652, 27.61595], [88.62655, 27.61564], [88.62711, 27.61487],
          [88.62813, 27.61431], [88.62871, 27.614], [88.62879, 27.61376], [88.62855, 27.61323], [88.62859, 27.61262],
          [88.62907, 27.61184], [88.62925, 27.61128], [88.6297, 27.61085], [88.63173, 27.61053], [88.63262, 27.61067],
          [88.63316, 27.61075], [88.63439, 27.61078], [88.6361, 27.61043], [88.63714, 27.60998], [88.63834, 27.60959],
          [88.6391, 27.60885], [88.64, 27.60846], [88.64084, 27.60752], [88.64163, 27.60626], [88.64174, 27.60535],
          [88.6421, 27.6043], [88.64273, 27.60364], [88.64343, 27.60322], [88.64422, 27.60301], [88.64511, 27.60284],
          [88.64652, 27.60158], [88.64736, 27.60128], [88.64841, 27.60114], [88.64893, 27.6011], [88.64966, 27.60012],
          [88.64957, 27.59937], [88.6495, 27.59862], [88.64982, 27.59794], [88.65025, 27.59771], [88.65197, 27.59601],
          [88.65257, 27.59567], [88.65333, 27.59525], [88.65368, 27.59472], [88.65451, 27.59414], [88.65509, 27.59387],
          [88.65575, 27.59344], [88.65617, 27.59313], [88.65642, 27.59272], [88.65679, 27.59208], [88.65687, 27.5916],
          [88.65659, 27.59086], [88.65594, 27.58968], [88.65611, 27.58881], [88.65584, 27.58814], [88.6551, 27.58794],
          [88.65485, 27.58722], [88.65481, 27.58675], [88.65474, 27.58592], [88.65507, 27.58533], [88.65545, 27.58494],
          [88.65556, 27.5841], [88.65601, 27.58346], [88.65636, 27.58286], [88.65684, 27.58207], [88.65684, 27.58147],
          [88.65575, 27.57986], [88.6556, 27.57911], [88.65553, 27.57866], [88.65442, 27.57723], [88.65343, 27.57583],
          [88.65289, 27.575], [88.65289, 27.57409], [88.65294, 27.57364], [88.65321, 27.57339], [88.65337, 27.57212],
          [88.65352, 27.57168], [88.65424, 27.57097], [88.65464, 27.57027], [88.65496, 27.56918], [88.6545, 27.56794],
          [88.65381, 27.56555],
        ],
        depth: 4,
        bankCells: 3,
        snapRadius: 10,
        maxHalfWidth: 10,
        inflowOnThalweg: true,
        upstream: {
          type: 'inflow',
          discharge: CHUNGTHANG_PEAK_M3S,
          hydrograph: CHUNGTHANG_HYDROGRAPH,
          stopAfter: CHUNGTHANG_HYDROGRAPH[CHUNGTHANG_HYDROGRAPH.length - 1].t,
          label:
            `Lachen Chu — placeholder hydrograph: published modelled peak ${CHUNGTHANG_PEAK_M3S.toLocaleString('en-US')} m³/s, ` +
            `${(SOUTH_LHONAK_RELEASE_M3 / 1e6).toFixed(0)} million m³ on a parametric rise-and-fall (not a measured hydrograph)`,
        },
      },
      {
        /*
         * OSM way 170015107 ("Lachung Chu"). It STARTS INSIDE the domain, ~200 m in from the east edge, for the same
         * reason as the Betrawati tributaries: no discharge for it that night is published, and a wet channel touching
         * an open boundary without an inflow just drains out of it.
         */
        name: 'Lachung Chu',
        path: [
          [88.67649, 27.6245], [88.67461, 27.62357], [88.67223, 27.62364], [88.67044, 27.62335], [88.66957, 27.62291],
          [88.66825, 27.62226], [88.66699, 27.62162], [88.66503, 27.61983], [88.66344, 27.6178], [88.66334, 27.6172],
          [88.6632, 27.61646], [88.66308, 27.61599], [88.66253, 27.61564], [88.66219, 27.615], [88.66188, 27.61477],
          [88.6614, 27.61454], [88.66089, 27.61418], [88.6607, 27.61364], [88.66026, 27.61337], [88.65973, 27.6132],
          [88.65908, 27.61267], [88.65841, 27.61191], [88.65791, 27.61155], [88.65741, 27.6111], [88.6568, 27.61077],
          [88.6562, 27.61044], [88.6557, 27.61005], [88.65498, 27.60983], [88.65411, 27.60961], [88.65317, 27.60904],
          [88.65255, 27.6084], [88.65197, 27.60745], [88.65164, 27.60691], [88.65118, 27.60664], [88.65045, 27.6056],
          [88.6499, 27.60521], [88.64855, 27.60383], [88.64848, 27.60332], [88.64859, 27.60306], [88.64846, 27.60231],
          [88.64851, 27.60171], [88.64893, 27.6011],
        ],
        depth: 2,
        bankCells: 2,
        snapRadius: 8,
        maxHalfWidth: 20,
      },
    ],
    /*
     * ONE SHELTER, because OpenStreetMap here has one candidate that is both a named place and on the road network:
     * the nine OSM tiles covering the domain hold ~1,170 buildings (all unnamed), 4 places of worship, 2 toilets, a
     * viewpoint and a waterfall — no school, clinic or office — and 73 drivable ways, 35 km of road inside it.
     *   • Gurudwara (node 10852707609, 27.603885 N, 88.646096 E), snapped by the bake to the highest-scoring road node
     *     within 200 m: 107 m away, at 1,614 m on this DEM — 45 m above the channel surface beside it (the bake's
     *     30 m margin + 15 m). That is a margin, not a guarantee: the 2021 pre-event study cited in
     *     public/presets/SOURCES.txt modelled 25–30 m flow depths at Chungthang for a large outburst.
     * NOT shipped, with the reason measured rather than assumed:
     *   • Rinchen gompa (node 10852708207, 1,673 m) and the Tibetan monastery at Pegong (node 10852710206, 1,726 m)
     *     stand well clear of the river, but neither has a drivable road node within 200 m that is itself high ground
     *     (the nearest are 159 m and 387 m away at 1,602 m and 1,518 m) — their access is by footpath, which this
     *     road graph does not carry — so the router could not reach them (tests require a shelter within 40 m of a
     *     road node). Widening the search until they pass is the edit not to make (see the Betrawati note).
     */
    shelters: [{ name: 'Gurudwara, Chungthang', at: [88.646096, 27.603885], search: 200 }],
    shelterMargin: 30,
    prefill: 'none',
    storms: [],
    rainRate: 0,
    /*
     * Looking north up the Lachen Chu from above the village: the reach the flood comes down fills the frame, the
     * confluence and the dam site sit in the lower third. Same pitch reasoning as Betrawati (look DOWN into the gorge).
     */
    camera: { at: [88.632, 27.618], distance: 5500, yaw: 0.12, pitch: 0.72 },
    view: 'depth',
    description: () => CHUNGTHANG_DESCRIPTION,
  },
  {
    /*
     * Raini–Tapovan — 12 km square centred 30.4900 N, 79.6600 E, 1024² cells of 11.72 m (NOT the 8 km / 7.81 m grid of
     * the other presets). The two plants are what the event is about and they are 6.1 km apart in a straight line
     * (Raini 79.691 E, Tapovan barrage 79.630 E); the Rishiganga has to enter the map ABOVE the first and the
     * Dhauliganga leave it well BELOW the second for Shugar et al.'s "below Tapovan" discharge to be inside it. That
     * is 79.597–79.723 E: 9.6 km is the minimum, and 8 km would put the inflow on top of the Rishiganga plant. 12 km
     * buys 3.0 km of Rishiganga above Raini (the inflow enters 1 km below the Ronti Gad confluence, which sits 1 km
     * outside the east edge) and 5.5 km of Dhauliganga below the barrage, out through the north-west corner. The cost
     * is the cell: 11.7 m instead of 7.8 m — still 2.6 cells per 30 m Copernicus posting, so the terrain loses nothing
     * it had, while the gorge is resolved by fewer cells (the Rishiganga floor is 30–60 m wide: 3–5 cells). The bonus
     * is the time step: CFL scales with the cell, so a 12 km domain runs a simulated minute in about the same wall
     * time as the 8 km grid with half the cell count wet. 16 km (15.6 m cells) would add Joshimath, which stands on the
     * slope ~500 m above the river and is not what the flood touched, at 2 cells across the Rishiganga gorge.
     * Measured on the probe DEM (artifacts/chamoli-build/tools/probe-dem.ts): the Rishiganga falls 2,224 → 1,931 m over
     * its 4 km inside (7 %), the Dhauliganga 1,931 → 1,790 m from Raini to Tapovan (2.3 %) and → 1,626 m at the exit.
     */
    id: 'chamoli',
    center: { lat: 30.49, lon: 79.66 },
    sizeMeters: 12000,
    n: 1024,
    global: {
      // Aligned 0.03° OSM API tiles shared with the chain bake (scripts/osm-fetch.ts `tiles`, scripts/bake-chain.ts).
      osmXml: ['artifacts/chamoli-build/chain-osm'],
      imagery: 'none',
    },
    rivers: [
      {
        /*
         * OSM ways 1074462194 ("Rishi Ganga") + 297368686 ("Dhauli Ganga"), clipped to the domain with one vertex
         * outside each end and simplified to 25 m (artifacts/chamoli-build/tools/extract-rivers.ts). The Rishiganga
         * meets the Dhauliganga at Raini (30.4877 N, 79.6902 E) and is called the Dhauliganga below it.
         */
        name: 'Rishiganga',
        path: [
          [79.72257, 30.46961], [79.72114, 30.46963], [79.71974, 30.46883], [79.71719, 30.46874], [79.71539, 30.46779],
          [79.71409, 30.46797], [79.71308, 30.46896], [79.70827, 30.47028], [79.7045, 30.47362], [79.70349, 30.4741],
          [79.69868, 30.47893], [79.69761, 30.47951], [79.69705, 30.4801], [79.69649, 30.4823], [79.69574, 30.4832],
          [79.69449, 30.48402], [79.69379, 30.48536], [79.69024, 30.48774], [79.6894, 30.48748], [79.6876, 30.48815],
          [79.68594, 30.48797], [79.68432, 30.48832], [79.68264, 30.48781], [79.68069, 30.48784], [79.67818, 30.48906],
          [79.67181, 30.48871], [79.66711, 30.48993], [79.66535, 30.48985], [79.66375, 30.48911], [79.66144, 30.48988],
          [79.65967, 30.4896], [79.65831, 30.49], [79.65577, 30.48976], [79.653, 30.49019], [79.65154, 30.49128],
          [79.6481, 30.49213], [79.64161, 30.49285], [79.6397, 30.49393], [79.63668, 30.49333], [79.63499, 30.49244],
          [79.63282, 30.49239], [79.63116, 30.49275], [79.62999, 30.49347], [79.6281, 30.49326], [79.62394, 30.49519],
          [79.62256, 30.49654], [79.62367, 30.49946], [79.62325, 30.5002], [79.62096, 30.50264], [79.61951, 30.50518],
          [79.6183, 30.506], [79.61766, 30.50754], [79.61644, 30.50847], [79.6159, 30.50977], [79.61512, 30.51046],
          [79.61466, 30.51297], [79.61363, 30.51375], [79.61228, 30.5166], [79.60963, 30.52016], [79.60918, 30.52225],
          [79.60925, 30.52535], [79.60604, 30.52877], [79.60433, 30.53158], [79.60365, 30.53193], [79.60309, 30.53425],
          [79.60153, 30.53662], [79.59839, 30.53828], [79.59726, 30.53955],
        ],
        depth: 4,
        bankCells: 3,
        snapRadius: 8,
        maxHalfWidth: 8,
        inflowOnThalweg: true,
        // ~59 m: the floor the flow had (see RiverDef.carve for the GPU measurement that made this necessary).
        carve: { halfWidth: 2 },
        upstream: {
          type: 'inflow',
          discharge: CHAMOLI_PEAK_M3S,
          hydrograph: CHAMOLI_HYDROGRAPH,
          stopAfter: CHAMOLI_HYDROGRAPH[CHAMOLI_HYDROGRAPH.length - 1].t,
          label:
            `Rishiganga — placeholder hydrograph: peak ${CHAMOLI_PEAK_M3S.toLocaleString('en-US')} m³/s (top of the published ` +
            `8,200–14,200 m³/s band), ${(CHAMOLI_MIXTURE_M3 / 1e6).toFixed(1)} million m³ on a parametric rise-and-fall (not a measured hydrograph)`,
        },
      },
      {
        /*
         * OSM way 297279727 ("Dhauli Ganga") above Raini, from Lata. It STARTS INSIDE the domain, ~230 m in from the
         * east edge, for the same reason as the Betrawati and Chungthang tributaries: no discharge for it that morning
         * is published, and a wet channel touching an open boundary without an inflow just drains out of it. The real
         * flow ran some way UP this valley from the confluence before turning downstream; here it can too.
         */
        name: 'Dhauliganga above Raini',
        path: [
          [79.72011, 30.5021], [79.71793, 30.50127], [79.7154, 30.4994], [79.71083, 30.49936], [79.70967, 30.4983],
          [79.7062, 30.49674], [79.70489, 30.497], [79.70292, 30.49574], [79.70107, 30.49581], [79.69927, 30.49441],
          [79.69504, 30.49257], [79.6947, 30.49105], [79.6919, 30.48861], [79.69057, 30.48797],
        ],
        depth: 2,
        bankCells: 2,
        snapRadius: 8,
        maxHalfWidth: 8,
      },
    ],
    /*
     * TWO SHELTERS, each a node in the OSM tiles this preset ships with (artifacts/chamoli-build/chain-osm), with name,
     * spelling and position read out of the XML, snapped by the bake to a high node of the road GRAPH (which keeps
     * only junctions and way ends — OSM maps 33 drivable ways here, 30 km of road and 22 graph nodes in 144 km²):
     *   Dhak                 node 5519535106 (place=village)      30.498861 N, 79.611343 E → the Joshimath–Malari road
     *                        junction 46 m away, 2,068 m on the shipped DEM, ~270 m above the Dhauliganga below it.
     *   SubCentre, Topoban   node 8229553590 (healthcare=centre)  30.490821 N, 79.626933 E → the Joshimath–Malari road
     *                        junction 202 m away (30.49073 N, 79.62903 E), 1,903 m, ~110 m above the barrage site.
     *                        Its search is 250 m, not 200, and that is the one widening this preset makes: the junction
     *                        is where the lane up to the sub-centre leaves the main road; the next graph node out is
     *                        410 m off. The spelling "Topoban" is OSM's (the village node beside it is "Tapoban").
     * NOT shipped, with the measured reason:
     *   • SubCentre, Lata (node 8230258764, 2,142 m) — no road graph node within 900 m; the main road runs past it
     *     as one unbroken way from the Reni bridge to the east edge.
     *   • Reni/Raini village (node 7833070518) — the only road node near it is the west end of the destroyed Reni
     *     bridge, 260 m off and 45 m above the river, which is what the flood took.
     *   • Tapoban village (node 7833070513) and the Bhavishya Badri temple — footpaths only, which this graph does not
     *     carry.
     * So the map gives no refuge on the Raini side, and that is true to the road network: the way west from Raini was
     * the bridge.
     */
    shelters: [
      { name: 'Dhak', at: [79.611343, 30.498861], search: 200 },
      { name: 'SubCentre, Topoban', at: [79.626933, 30.490821], search: 250 },
    ],
    /*
     * The barrage site itself: the end of the unnamed access road at the river below Tapovan (road graph node at
     * 30.49339 N, 79.62892 E, 1,785 m on this DEM — at river level, 90 m from the barrage outline, OSM way 683265980).
     * This is the warning-time story, not a re-planning one: the route uphill to the sub-centre exists from the moment
     * the pin goes down and closes when the front arrives, and the route card names how long there had been one.
     */
    evacStart: { at: [79.62892, 30.49339], label: 'Tapovan barrage site (access road)' },
    shelterMargin: 30,
    prefill: 'none',
    storms: [],
    rainRate: 0,
    /*
     * Looking WEST, down the valley, from above Raini: the Rishiganga comes in at the bottom right, the Dhauliganga runs
     * up the frame to the Tapovan barrage. Measured against screenshots (artifacts/chamoli-build/physics): the first
     * framing, looking north across the valley at pitch 0.75, put the 3,000 m south wall between the camera and the
     * river — a green hillside with no water in it. The gorge is 2–5 cells wide, so the camera has to look down into
     * it (pitch 1.0) and along it, not across it. And close: from 7 km out the 5-cell channel's water no longer
     * draws (the flow was there by the probe, not on screen); 5.5 km shows it from Raini down towards Tapovan.
     */
    camera: { at: [79.672, 30.488], distance: 5500, yaw: -1.5, pitch: 1.0 },
    view: 'depth',
    description: () => CHAMOLI_DESCRIPTION,
  },
];

// ────────────────────────────────────────────────────────────────────────────────────────────────

const HERE = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const argValue = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = path.resolve(argValue('out') ?? path.resolve(HERE, '../public/presets'));
const IMAGERY_SOURCE: ImagerySource = argValue('imagery') === 'esri' ? 'esri' : 'naip';
/** Raw downloads are cached here (gitignored) so re-bakes are fast and reproducible; pass --refresh to refetch. */
const CACHE = path.resolve(HERE, '../artifacts/bake-cache');
const REFRESH = process.argv.includes('--refresh');

/** Return cached bytes for `name` under a preset + request key, or fetch and store them. */
async function cachedBytes(id: string, key: string, name: string, fetcher: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const dir = path.join(CACHE, id);
  const file = path.join(dir, name);
  const keyFile = `${file}.key`;
  if (!REFRESH && fs.existsSync(file) && fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key) {
    log(id, `  (cached ${name})`);
    return new Uint8Array(fs.readFileSync(file));
  }
  const bytes = await fetcher();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(keyFile, key);
  return bytes;
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Level above the gauge level (m) and slider offsetScale of a stage source at a river's upstream or downstream end
 * (see PresetDef.confluenceHead): upstream +head/2, downstream −head/2, head growing linearly from `normal` at
 * offset 0 to `crest` at the crest's offset.
 */
function stageHead(def: PresetDef, which: 'upstream' | 'downstream', normalLevel: number | null): { level: number; offsetScale: number } {
  const ch = def.confluenceHead;
  if (!ch || !def.stage || normalLevel === null) return { level: 0, offsetScale: 1 };
  const crestOffset = ch.crestFt * FT + def.stage.gaugeDatum - normalLevel;
  if (!(crestOffset > 0)) throw new Error(`${def.id}: confluenceHead crest ${ch.crestFt} ft is not above normal pool`);
  const sign = which === 'upstream' ? 1 : -1;
  return {
    level: r3((sign * ch.normal) / 2),
    offsetScale: Math.round((1 + (sign * (ch.crest - ch.normal)) / 2 / crestOffset) * 1e5) / 1e5,
  };
}

function log(id: string, ...args: unknown[]) {
  console.log(`[${id}]`, ...args);
}

function medianOf(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

async function bake(def: PresetDef) {
  const t0 = performance.now();
  const info = PRESETS.find((p) => p.id === def.id)!;
  const { bounds, merc } = squareDomain(def.center, def.sizeMeters);
  const N = def.n;
  const cellSize = def.sizeMeters / N;
  const grid = { nx: N, ny: N, bounds };
  const toGrid = (ll: LonLat) => geoToGrid(grid, ll[0], ll[1]);

  // ── DEM
  // The key carries the RESOLVED filter parameters, not just the overrides: retuning the defaults must invalidate a
  // cached global DEM, or a re-bake would quietly ship the terrain the old filter produced.
  const requestKey = JSON.stringify({
    center: def.center,
    sizeMeters: def.sizeMeters,
    n: N,
    ...(def.global ? { bareEarth: { ...BARE_EARTH_DEFAULTS, ...def.global.bareEarth }, bareEarthAlgo: BARE_EARTH_ALGO_VERSION } : {}),
  });
  type DemInfo = { source: DEMSource; filled: number; tiles?: string[]; bareEarth?: Record<string, number> };
  let demInfo: DemInfo = { source: 'usgs3dep', filled: 0 };
  const demBytes = await cachedBytes(def.id, requestKey, 'dem.f32', async () => {
    let elevation: Float32Array;
    if (def.global) {
      /*
       * Copernicus GLO-30 is a SURFACE model: canopy and buildings are part of the terrain, and a flood run on it
       * runs over tree tops. bareEarthFromSurface is a progressive morphological filter validated against 3DEP
       * lidar over four US domains (artifacts/nepal-build/out-bareearth.txt); what it cannot remove — a metre or so
       * of bias under continuous canopy — is stated in the scenario text and in public/presets/SOURCES.txt rather
       * than hidden.
       */
      const g = await fetchCopernicusDEM(merc, N, N, (msg) => log(def.id, ` ${msg}`));
      const bare = bareEarthFromSurface(g.elevation, N, N, { cellSize, ...def.global.bareEarth });
      log(
        def.id,
        `bare-earth filter: ${(bare.removedFraction * 100).toFixed(1)} % of cells flagged as surface features, ` +
          `mean drop ${bare.meanRemoved.toFixed(1)} m, max ${bare.maxRemoved.toFixed(1)} m, windows ${bare.windows.join('/')} m`,
      );
      demInfo = {
        source: 'copernicus',
        filled: g.filled,
        tiles: g.tiles,
        bareEarth: {
          flaggedPercent: r2(bare.removedFraction * 100),
          meanDropM: r2(bare.meanRemoved),
          maxDropM: r2(bare.maxRemoved),
        },
      };
      elevation = bare.ground;
    } else {
      const d = await fetchDEM(merc, N, N, cellSize);
      demInfo = { source: d.source, filled: d.filled };
      elevation = d.elevation;
    }
    fs.mkdirSync(path.join(CACHE, def.id), { recursive: true });
    fs.writeFileSync(path.join(CACHE, def.id, 'dem.json'), JSON.stringify(demInfo));
    return new Uint8Array(elevation.buffer, elevation.byteOffset, elevation.byteLength);
  });
  const demInfoFile = path.join(CACHE, def.id, 'dem.json');
  if (fs.existsSync(demInfoFile)) demInfo = JSON.parse(fs.readFileSync(demInfoFile, 'utf8')) as DemInfo;
  const dem = { elevation: new Float32Array(demBytes.slice().buffer), ...demInfo };
  log(def.id, `DEM ${dem.source}, repaired ${dem.filled} cells${dem.tiles ? ` (tiles ${dem.tiles.join(', ')})` : ''}`);
  const raw = dem.elevation;

  // ── Hydro-conditioning
  const specsFor = (poolLevel?: number): RiverSpec[] =>
    def.rivers.map((r) => ({
      name: r.name,
      path: r.path.map(toGrid),
      depth: r.depth,
      bankCells: r.bankCells,
      snapRadius: r.snapRadius,
      maxHalfWidth: r.maxHalfWidth,
      flatLevel: poolLevel,
    }));
  let normalLevel: number | null = null;
  let burn: BurnResult;
  if (def.pool) {
    // Pass 1 with the guess, then measure the actual hydro-flattened surface (median of flat channel cells).
    const first = burnRivers(raw, N, N, cellSize, specsFor(def.pool.guess));
    const relief = localRelief(raw, N, N);
    const ft = flatThreshold(cellSize);
    const zs: number[] = [];
    for (let k = 0; k < raw.length; k += 3) if (first.owner[k] && relief[k] <= 0.01) zs.push(raw[k]);
    normalLevel = r2(medianOf(zs));
    log(def.id, `pool surface measured in DEM: ${normalLevel} m NAVD88 (${zs.length} samples, flat tol ${ft.toFixed(3)})`);
    burn = burnRivers(raw, N, N, cellSize, specsFor(normalLevel));
  } else {
    burn = burnRivers(raw, N, N, cellSize, specsFor());
  }
  const elevation = burn.elevation;
  // Gorge floor (RiverDef.carve): a monotone floor of minimum width along the centreline (sills cut, pits filled).
  def.rivers.forEach((r, ri) => {
    if (!r.carve) return;
    const { centerline: cl, levels } = burn.rivers[ri];
    const R = r.carve.halfWidth;
    let floor = Infinity;
    const floorAt = new Map<number, number>();
    for (let q = 0; q < levels.length; q++) {
      floor = Math.min(floor, levels[q] - r.depth);
      const ci = Math.floor(cl[2 * q]);
      const cj = Math.floor(cl[2 * q + 1]);
      for (let dj = -R; dj <= R; dj++) {
        for (let di = -R; di <= R; di++) {
          if (di * di + dj * dj > R * R + R) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const k = j * N + i;
          // A cell under two stretches of the centreline takes the lower floor.
          floorAt.set(k, Math.min(floorAt.get(k) ?? Infinity, floor));
        }
      }
    }
    let cut = 0;
    let filled = 0;
    let deepest = 0;
    let highest = 0;
    for (const [k, f] of floorAt) {
      if (elevation[k] > f) {
        cut++;
        deepest = Math.max(deepest, elevation[k] - f);
      } else if (elevation[k] < f) {
        filled++;
        highest = Math.max(highest, f - elevation[k]);
      }
      elevation[k] = f;
    }
    log(
      def.id,
      `  ${r.name}: gorge floor ${2 * R + 1} cells wide (${r1((2 * R + 1) * cellSize)} m): cut ${cut} cells (deepest ${deepest.toFixed(1)} m), ` +
        `filled ${filled} (highest ${highest.toFixed(1)} m)`,
    );
  });
  for (const r of burn.rivers) {
    log(def.id, `  ${r.name}: ${r.cells} channel cells, surface ${r.maxLevel.toFixed(2)} → ${r.minLevel.toFixed(2)} m, burn ${r.depth} m`);
  }
  log(def.id, `burned cells: ${burn.burnedCells} (${((100 * burn.burnedCells) / (N * N)).toFixed(2)} % of domain)`);

  // ── Initial fill
  // Seeds sit on the channel SPINE (the cell of the same river farthest from the shore within a few cells of the
  // traced centerline) and take that cell's own water level. Where a trace hugs a bank, a seed on the bank would
  // otherwise carry the bank's (higher) capped level into the channel and start an over-deep pool.
  const spineCell = (gx: number, gy: number, river: number, reach = 6): number => {
    const ci = Math.floor(gx);
    const cj = Math.floor(gy);
    let best = -1;
    let bestScore = -Infinity;
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const k = j * N + i;
        if (burn.owner[k] !== river + 1) continue;
        const score = burn.dist[k] - 0.05 * Math.hypot(di, dj);
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
    }
    return best;
  };
  const initialFill: ScenarioPreset['initialFill'] = [];
  if (def.prefill === 'none') {
    log(def.id, 'initial fill: none (see PresetDef.prefill) — the channels start dry and the sources bring the water');
  } else if (normalLevel !== null) {
    const seeds: Array<{ gx: number; gy: number }> = [];
    burn.rivers.forEach((r, ri) => {
      const npts = r.centerline.length / 2;
      for (let q = 0; q < npts; q += 80) {
        const k = spineCell(r.centerline[q * 2], r.centerline[q * 2 + 1], ri);
        if (k >= 0) seeds.push({ gx: (k % N) + 0.5, gy: ((k / N) | 0) + 0.5 });
      }
    });
    initialFill.push({ seeds, level: normalLevel });
  } else {
    // Sloping rivers: ONE fill for the whole connected system, seeds along each centerline with their own
    // level — every 10 path cells, and more densely where the surface drops quickly (> 0.2 m between seeds).
    const seeds: Array<{ gx: number; gy: number; level: number }> = [];
    burn.rivers.forEach((r, ri) => {
      const npts = r.centerline.length / 2;
      let lastQ = -Infinity;
      let lastLevel = Infinity;
      let lastK = -1;
      for (let q = 0; q < npts; q++) {
        const k = spineCell(r.centerline[q * 2], r.centerline[q * 2 + 1], ri);
        if (k < 0 || k === lastK) continue;
        const lvl = burn.waterLevel[k];
        if (q - lastQ >= 10 || Math.abs(lvl - lastLevel) > 0.2 || q === npts - 1) {
          seeds.push({ gx: (k % N) + 0.5, gy: ((k / N) | 0) + 0.5, level: r2(lvl) });
          lastQ = q;
          lastLevel = lvl;
          lastK = k;
        }
      }
    });
    initialFill.push({ seeds, level: Math.min(...seeds.map((s) => s.level)) });
  }
  const h0 = computeInitialWater({ nx: N, ny: N, elevation }, { initialFill });
  let wet = 0;
  let leak = 0;
  let maxDepth = 0;
  for (let k = 0; k < h0.length; k++) {
    if (h0[k] > 0.01) {
      wet++;
      if (!burn.owner[k]) leak++;
      maxDepth = Math.max(maxDepth, h0[k]);
    }
  }
  log(def.id, `initial fill: ${wet} wet cells, ${leak} outside the channel mask, max depth ${maxDepth.toFixed(2)} m`);
  if (leak > wet * 0.01) throw new Error(`${def.id}: initial fill leaks outside the channel (${leak} cells)`);

  // ── Sources at the domain edges
  // Inflows sit on the channel spine just inside the edge. Stage sources are boundary conditions: their disc covers
  // the river's whole wet crossing of the edge (see edgeStageDisc), so the open boundary cannot drain the part of
  // the crossing a small disc would miss.
  const ends = findRiverEnds(burn, N, N, 12);
  const sources: WaterSource[] = [];
  def.rivers.forEach((r, ri) => {
    for (const which of ['upstream', 'downstream'] as const) {
      const cfg = r[which];
      if (!cfg) continue;
      const end = ends.find((e) => e.river === ri && e.end === which);
      if (!end) throw new Error(`${def.id}: ${r.name} ${which} end does not reach the domain edge`);
      const base = r.name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-river$/, '');
      // A river with a boundary at BOTH ends needs two distinct ids (the app keys stage state by source id).
      const id = `${base}-${r.upstream && r.downstream ? `${which}-` : ''}${cfg.type}`;
      if (cfg.type === 'inflow') {
        const p = inflowPlacement(burn, ri, which, end, N);
        if (r.inflowOnThalweg) {
          const along = end.edge === 'north' || end.edge === 'south' ? [1, 0] : [0, 1];
          const reach = Math.ceil(p.radius / 2);
          let best = { gx: p.gx, gy: p.gy, z: elevation[Math.floor(p.gy) * N + Math.floor(p.gx)] };
          for (let c = -reach; c <= reach; c++) {
            const gx = p.gx + along[0] * c;
            const gy = p.gy + along[1] * c;
            if (Math.min(gx, gy, N - gx, N - gy) < p.radius + 1) continue;
            const z = elevation[Math.floor(gy) * N + Math.floor(gx)];
            if (z < best.z) best = { gx, gy, z };
          }
          if (best.gx !== p.gx || best.gy !== p.gy) log(def.id, `  inflow moved across the channel from (${p.gx}, ${p.gy}) to the thalweg (${best.gx}, ${best.gy})`);
          p.gx = best.gx;
          p.gy = best.gy;
        }
        sources.push({
          id,
          type: 'inflow',
          gx: r2(p.gx),
          gy: r2(p.gy),
          radius: r1(p.radius),
          discharge: cfg.discharge,
          ...(cfg.stopAfter !== undefined ? { stopAfter: cfg.stopAfter } : {}),
          ...(cfg.hydrograph ? { hydrograph: cfg.hydrograph } : {}),
          label: cfg.label,
        });
        log(
          def.id,
          `  source ${id} at (${p.gx.toFixed(1)}, ${p.gy.toFixed(1)}) r=${p.radius} edge=${end.edge}` +
            (cfg.hydrograph
              ? `, hydrograph peak ${Math.max(...cfg.hydrograph.map((p) => p.q))} m³/s, ` +
                `${(hydrographVolume(cfg.hydrograph, 0, cfg.stopAfter ?? cfg.hydrograph[cfg.hydrograph.length - 1].t) / 1e6).toFixed(3)} million m³ delivered`
              : cfg.stopAfter !== undefined
                ? `, stops after ${cfg.stopAfter} s = ${((cfg.discharge * cfg.stopAfter) / 1e6).toFixed(2)} million m³ delivered`
                : ''),
        );
      } else {
        const along = end.edge === 'north' || end.edge === 'south' ? end.gx : end.gy;
        const runs = edgeRuns(end.edge, N, N, (k) => h0[k] > 0.01);
        const run = runs.sort((a, b) => distToRun(a, along) - distToRun(b, along))[0];
        if (!run || distToRun(run, along) > 24) throw new Error(`${def.id}: ${r.name} has no wet crossing of the ${end.edge} edge`);
        // Cover the crossing as wide as it gets at the top of the stage slider (see growEdgeRun).
        const level = normalLevel ?? r2(end.level);
        const ceiling = level + (def.stage?.maxOffset ?? 0);
        const head = stageHead(def, which, normalLevel);
        const grown = growEdgeRun(end.edge, run[0], run[1], N, N, (k) => h0[k] > 0.01 || (elevation[k] < ceiling && elevation[k] >= level));
        const { run: [t0, t1], ...disc } = edgeStageDiscAvoiding(end.edge, [run[0], run[1]], grown, N, N, (k) => h0[k] <= 0.01 && elevation[k] < level + Math.max(0, head.level));
        sources.push({ id, type: 'stage', ...disc, level: r3(level + head.level), ...(head.offsetScale !== 1 ? { offsetScale: head.offsetScale } : {}), label: cfg.label });
        log(def.id, `  source ${id} covers ${end.edge} edge cells ${t0}..${t1} (wet ${run[0]}..${run[1]}): disc (${disc.gx}, ${disc.gy}) r=${disc.radius}, head ${head.level >= 0 ? '+' : ''}${head.level} m, offsetScale ${head.offsetScale}`);
      }
    }
  });

  // ── Sea boundary (coastal domains)
  if (def.sea) {
    if (def.confluenceHead) throw new Error(`${def.id}: a sea boundary is a still-water rise; confluenceHead makes no sense with it`);
    if (normalLevel === null) throw new Error(`${def.id}: a sea boundary needs a measured pool level (set def.pool)`);
    const discs = seaBoundaryDiscs({
      nx: N,
      ny: N,
      wet: (k) => h0[k] > 0.01,
      bed: (k) => elevation[k],
      growCeiling: def.sea.growCeiling,
    });
    if (!discs.length) throw new Error(`${def.id}: sea boundary found no wet edge crossing`);
    discs.forEach((d, i) => {
      sources.push({
        id: `sea-${d.edge}-${i}`,
        type: 'stage',
        gx: r2(d.gx),
        gy: r2(d.gy),
        radius: r2(d.radius),
        level: r3(normalLevel),
        label: def.sea!.label,
      });
      log(
        def.id,
        `  sea boundary ${d.edge} cells ${d.run[0]}..${d.run[1]} (wet ${d.wetRun[0]}..${d.wetRun[1]}): disc (${d.gx}, ${d.gy}) r=${d.radius}`,
      );
    });
    log(def.id, `sea boundary: ${discs.length} discs at ${normalLevel} m, grow ceiling ${def.sea.growCeiling} m`);
  }
  if (sources.length > 16) throw new Error(`${def.id}: ${sources.length} sources exceeds the solver's MAX_SOURCES (16)`);

  // ── Roads
  /*
   * TIGER/Line inside the US; OSM everywhere else. The OSM API refuses a box this size (50,000 nodes), so the
   * quadrants are downloaded ahead of the bake by artifacts/nepal-build/fetch-osm.mjs and parsed here. Quadrants
   * overlap in the ways that cross their edges — the API returns each such way in full — and buildRoadNetwork
   * deduplicates identical edges, so concatenating them is correct.
   */
  const rawRoads = def.global
    ? def.global.osmXml.flatMap((rel) => {
        const at = path.resolve(HERE, '..', rel);
        // A directory is a tile cache (scripts/osm-fetch.ts): read the tiles whose bbox touches the domain.
        const touches = (f: string) => {
          const tb = tileBoundsOf(f);
          return !tb || (tb.west < bounds.east && tb.east > bounds.west && tb.south < bounds.north && tb.north > bounds.south);
        };
        const files = fs.statSync(at).isDirectory()
          ? fs.readdirSync(at).filter((f) => f.endsWith('.xml') && touches(f)).sort().map((f) => path.join(at, f))
          : [at];
        const parsed = files.flatMap((file) => parseOSMXml(fs.readFileSync(file, 'utf8')));
        log(def.id, `  OSM ${rel}: ${parsed.length} drivable ways from ${files.length} file(s)`);
        return parsed;
      })
    : (JSON.parse(
        new TextDecoder().decode(
          await cachedBytes(def.id, requestKey, 'roads-raw.json', async () => new TextEncoder().encode(JSON.stringify(await fetchTigerRoads(bounds)))),
        ),
      ) as RawRoad[]);
  const roads = buildRoadNetwork(rawRoads, { nx: N, ny: N, cellSize, toGrid: makeGeoToGrid(grid) });
  log(def.id, 'roads', roadStats(roads));

  // ── Shelters on high road nodes
  const stageCeiling = normalLevel !== null && def.stage ? normalLevel + def.stage.maxOffset : null;
  const elevAt = (gx: number, gy: number) => elevation[Math.min(N - 1, Math.floor(gy)) * N + Math.min(N - 1, Math.floor(gx))];
  const nearestWaterLevel = (gx: number, gy: number) => {
    let best = Infinity;
    let lvl = NaN;
    for (let k = 0; k < N * N; k += 7) {
      if (!burn.owner[k]) continue;
      const d = Math.hypot((k % N) + 0.5 - gx, ((k / N) | 0) + 0.5 - gy);
      if (d < best) {
        best = d;
        lvl = burn.waterLevel[k];
      }
    }
    return lvl;
  };
  const shelters: Shelter[] = def.shelters.map((s) => {
    const p = toGrid(s.at);
    const ceiling = stageCeiling ?? nearestWaterLevel(p.gx, p.gy) + (def.shelterMargin ?? 20);
    const searchCells = (s.search ?? 250) / cellSize;
    let best: { gx: number; gy: number; score: number } | null = null;
    for (let k = 0; k < roads.nodes.length / 2; k++) {
      const gx = roads.nodes[k * 2];
      const gy = roads.nodes[k * 2 + 1];
      const d = Math.hypot(gx - p.gx, gy - p.gy);
      if (d > searchCells) continue;
      const z = elevAt(gx, gy);
      if (z < ceiling + 3) continue;
      // Prefer close to the landmark, then higher.
      const score = -d * cellSize + 0.5 * (z - ceiling);
      if (!best || score > best.score) best = { gx, gy, score };
    }
    const at = best ?? { gx: p.gx, gy: p.gy };
    const z = elevAt(at.gx, at.gy);
    const moved = Math.hypot(at.gx - p.gx, at.gy - p.gy) * cellSize;
    log(
      def.id,
      `  shelter "${s.name}": ${z.toFixed(1)} m (${(z - ceiling).toFixed(1)} m above ceiling ${ceiling.toFixed(1)}), ` +
        `${moved.toFixed(0)} m from the named point${best ? '' : ' [no road node — landmark point]'}`,
    );
    if (z < ceiling + 3) throw new Error(`${def.id}: shelter "${s.name}" is not on high enough ground`);
    return { name: s.name, gx: r2(at.gx), gy: r2(at.gy) };
  });

  // ── Storms, camera, stage
  const storms: StormCell[] = def.storms.map((s) => {
    const p = toGrid(s.at);
    return { id: s.id, gx: r1(p.gx), gy: r1(p.gy), radius: r1(s.radiusMeters / cellSize), intensity: s.intensity };
  });
  const cp = toGrid(def.camera.at);
  const zs: number[] = [];
  for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) zs.push(elevAt(cp.gx + di, cp.gy + dj));
  const camera: CameraPose = {
    target: { gx: r1(cp.gx), gy: r1(cp.gy), elevation: r1(medianOf(zs)) },
    distance: def.camera.distance,
    yaw: Math.round(def.camera.yaw * 1000) / 1000,
    pitch: def.camera.pitch,
  };
  let levee: ScenarioPreset['levee'];
  if (def.levee) {
    const L = def.levee;
    const points = L.path.map((ll) => {
      const p = toGrid(ll);
      return { gx: r1(p.gx), gy: r1(p.gy) };
    });
    for (const end of [points[0], points[points.length - 1]]) {
      const z = elevAt(end.gx, end.gy);
      if (z < L.crest) throw new Error(`${def.id}: levee end (${end.gx}, ${end.gy}) at ${z.toFixed(2)} m is below its crest ${L.crest} m`);
    }
    for (let k = 0; k + 1 < points.length; k++) {
      const a = points[k];
      const b = points[k + 1];
      const steps = Math.ceil(Math.hypot(b.gx - a.gx, b.gy - a.gy) * 2);
      let low = Infinity;
      for (let t = 0; t <= steps; t++) low = Math.min(low, elevAt(a.gx + ((b.gx - a.gx) * t) / steps, a.gy + ((b.gy - a.gy) * t) / steps));
      if (L.crest - low > 10) throw new Error(`${def.id}: levee segment ${k} needs a ${(L.crest - low).toFixed(1)} m wall (max 10 m)`);
    }
    const lc = toGrid(L.camera.at);
    levee = {
      name: L.name,
      crest: L.crest,
      points,
      camera: { target: { gx: r1(lc.gx), gy: r1(lc.gy), elevation: r1(elevAt(lc.gx, lc.gy)) }, distance: L.camera.distance, yaw: L.camera.yaw, pitch: L.camera.pitch },
    };
    log(def.id, `levee: ${points.length} points, crest ${L.crest} m`);
  }
  const stage: StageControl | null =
    def.stage && normalLevel !== null
      ? {
          label: def.stage.label,
          gaugeDatum: Math.round(def.stage.gaugeDatum * 1000) / 1000,
          normalLevel,
          floodStageFt: def.stage.floodStageFt,
          marks: def.stage.marks,
          maxOffset: def.stage.maxOffset,
        }
      : null;
  if (stage) {
    log(def.id, `stage: normal ${((stage.normalLevel - stage.gaugeDatum) / FT).toFixed(1)} ft, max ${((stage.normalLevel + stage.maxOffset - stage.gaugeDatum) / FT).toFixed(1)} ft`);
  }

  // ── Evacuation starts (the demo's opening pin and its cut-off second beat), snapped to ordinary street nodes.
  // A home is on an ordinary street: the node has to carry a local or minor road, and must not also touch an
  // interstate ramp or a bridge deck (the route would snap onto one of those instead of the street).
  const snapEvac = (spot: { at: LonLat; label: string } | undefined, what: string) => {
    if (!spot) return null;
    const p = toGrid(spot.at);
    const streetNode = new Uint8Array(roads.nodes.length / 2);
    const blocked = new Uint8Array(roads.nodes.length / 2);
    for (const e of roads.edges) {
      const bridge = /\bBrg\b|Bridge/.test(e.name ?? '');
      if (e.cls === 'highway' || bridge) blocked[e.a] = blocked[e.b] = 1;
      if ((e.cls === 'local' || e.cls === 'minor') && !bridge) streetNode[e.a] = streetNode[e.b] = 1;
    }
    const searchCells = 150 / cellSize;
    let best: { gx: number; gy: number; d: number } | null = null;
    for (let k = 0; k < roads.nodes.length / 2; k++) {
      if (!streetNode[k] || blocked[k]) continue;
      const gx = roads.nodes[k * 2];
      const gy = roads.nodes[k * 2 + 1];
      const d = Math.hypot(gx - p.gx, gy - p.gy);
      if (d > searchCells) continue;
      if (!best || d < best.d) best = { gx, gy, d };
    }
    const at = best ?? { gx: p.gx, gy: p.gy };
    log(
      def.id,
      `${what} "${spot.label}": gx ${at.gx.toFixed(1)} gy ${at.gy.toFixed(1)}, ground ${elevAt(at.gx, at.gy).toFixed(2)} m` +
        (best ? ` (street node ${(best.d * cellSize).toFixed(0)} m from the point)` : ' [no street node within 150 m — using the point itself]'),
    );
    return { gx: r2(at.gx), gy: r2(at.gy), label: spot.label };
  };
  const evacStart = snapEvac(def.evacStart, 'evac start');
  const evacCutOff = snapEvac(def.evacCutOff, 'evac cut-off start');

  const scenario: ScenarioPreset = {
    description: def.description({ normalLevel, gaugeDatum: stage?.gaugeDatum ?? null }),
    sources,
    storms,
    shelters,
    rainRate: def.rainRate,
    stage,
    initialFill,
    camera,
    ...(levee ? { levee } : {}),
    ...(evacStart ? { evacStart } : {}),
    ...(evacCutOff ? { evacCutOff } : {}),
    ...(def.view ? { defaultView: def.view } : {}),
    // The glacier hazard chain upstream of the domain (scripts/chain-defs.ts; chain.json is baked by bake-chain.ts).
    ...(hazardChainFor(def.id) ? { hazardChain: hazardChainFor(def.id) } : {}),
  };
  /*
   * A preset with a baked valley profile floods from its hazard chain: the inflow above (and the description) are the
   * pre-chain placeholders, replaced here by the chain's routed hydrograph — the ensemble's median member — with its
   * chain-result.json written beside it (scripts/bake-chain-result.ts). Without chain.json (a first bake, before
   * scripts/bake-chain.ts has run) the placeholder stays.
   */
  if (scenario.hazardChain && fs.existsSync(path.join(OUT, def.id, scenario.hazardChain.profile))) {
    applyChainResult(def.id, scenario, (m) => log(def.id, m), OUT);
  }

  // ── Imagery
  // 4096²: ≈ 2 m per texel over Pittsburgh's 8 km, sharp at the 0.5–2 km camera distances where walls get drawn and
  // streets inspected. (8192² would cost ~360 MB of GPU memory with mips — too much next to the solver on a fanless
  // laptop.) NAIP exports are limited to 4000 px, so NAIP always comes as four stitched 2048² quadrants.
  const imageryKey = JSON.stringify({ ...JSON.parse(requestKey), imagery: IMAGERY_SIZE, ...(IMAGERY_SOURCE === 'esri' ? {} : { source: IMAGERY_SOURCE }) });
  const imageryFile = `imagery-${IMAGERY_SOURCE === 'esri' ? '' : `${IMAGERY_SOURCE}-`}${IMAGERY_SIZE}.jpg`;
  const jpg = def.global ? null : await cachedBytes(def.id, imageryKey, imageryFile, async () => {
    if (IMAGERY_SOURCE === 'naip' && IMAGERY_SIZE > NAIP_MAX_EXPORT) return fetchImageryStitched(merc, IMAGERY_SIZE, IMAGERY_SOURCE);
    try {
      return await fetchImageryBytes(merc, IMAGERY_SIZE, undefined, undefined, IMAGERY_SOURCE);
    } catch (e) {
      // The server renders a whole export before answering and its gateway gives up after ~90 s (HTTP 504), which a
      // 4096² export of a rural area can exceed. Fetch the four quadrants instead and stitch them.
      log(def.id, `  single ${IMAGERY_SIZE}² imagery export failed (${(e as Error).message}); fetching 2×2 quadrants`);
      return fetchImageryStitched(merc, IMAGERY_SIZE, IMAGERY_SOURCE);
    }
  });

  /*
   * The close-up inset (src/data/imagery.ts): a second DETAIL_SIZE² export over part of the domain, blended over
   * the base photo by the terrain shader. Measured over downtown Pittsburgh (artifacts/detail-imagery): NAIP stops
   * adding detail just under 1 m per texel, so an inset is only worth its bytes where the base photo is coarser
   * than that, and never needs to be finer than DETAIL_TARGET_MPT.
   */
  let detailBytes: Uint8Array | null = null;
  let detailGrid: GridRect | null = null;
  if (def.detail && !def.global) {
    const baseMpt = def.sizeMeters / IMAGERY_SIZE;
    const at = def.detail.at ?? def.camera.at;
    const c = geoToGrid({ nx: N, ny: N, bounds }, at[0], at[1]);
    const rect = detailRect(N, N, cellSize, { gx: c.gx, gy: c.gy }, def.detail.sizeMeters);
    if (!rect) {
      log(def.id, `  detail inset skipped: ${def.detail.sizeMeters} m does not fit inside the ${def.sizeMeters} m domain`);
    } else {
      const mpt = detailMetersPerTexel(rect, cellSize, DETAIL_SIZE);
      log(def.id, `imagery detail: ${DETAIL_SIZE}² over ${r1((rect.x1 - rect.x0) * cellSize)} m at cells [${rect.x0},${rect.y0}]-[${rect.x1},${rect.y1}]`);
      log(def.id, `  ${r3(mpt)} m/texel vs ${r3(baseMpt)} base (${r2(baseMpt / mpt)}x)${mpt < DETAIL_TARGET_MPT * 0.8 ? ' — finer than NAIP resolves, consider a larger square' : ''}`);
      const detailKey = JSON.stringify({ ...JSON.parse(requestKey), detail: { rect, size: DETAIL_SIZE }, source: IMAGERY_SOURCE });
      detailBytes = await cachedBytes(def.id, detailKey, `imagery-detail-${IMAGERY_SOURCE}-${DETAIL_SIZE}.jpg`, () =>
        fetchImageryStitched(detailMercatorBBox(merc, N, N, rect), DETAIL_SIZE, IMAGERY_SOURCE),
      );
      detailGrid = rect;
    }
  }

  // ── Write
  const dir = path.join(OUT, def.id);
  fs.mkdirSync(dir, { recursive: true });
  const meta: PresetMeta = {
    version: 1,
    id: def.id,
    name: info.name,
    subtitle: info.subtitle,
    nx: N,
    ny: N,
    cellSize,
    bounds,
    attribution: def.global
      ? `${demAttribution('copernicus')} · Terrain shading: no aerial imagery (hypsometric tint) · ${ROADS_ATTRIBUTION_OSM} (ODbL)`
      : `Elevation: USGS 3DEP · ${IMAGERY_SOURCE === 'naip' ? NAIP_ATTRIBUTION : IMAGERY_ATTRIBUTION} · ${ROADS_ATTRIBUTION_TIGER}`,
    scenario,
    files: {
      elevation: 'elevation.f32',
      imagery: jpg ? 'imagery.jpg' : null,
      roads: 'roads.json',
      ...(detailGrid ? { imageryDetail: 'imagery-detail.jpg' } : {}),
    },
    ...(detailGrid ? { imageryDetail: detailGrid } : {}),
    bake: {
      bakedAt: new Date().toISOString(),
      demSource: dem.source,
      demRepairedCells: dem.filled,
      ...(dem.tiles ? { demTiles: dem.tiles } : {}),
      ...(dem.bareEarth ? { bareEarth: dem.bareEarth } : {}),
      center: def.center,
      sizeMeters: def.sizeMeters,
      burnedCells: burn.burnedCells,
      rivers: burn.rivers.map((r) => ({ name: r.name, cells: r.cells, depth: r.depth, surfaceMax: r2(r.maxLevel), surfaceMin: r2(r.minLevel) })),
      initialWetCells: wet,
      ...(def.prefill ? { prefill: def.prefill } : {}),
      roads: roadStats(roads),
    },
  };
  const problems = validatePresetMeta(meta);
  if (problems.length) throw new Error(`${def.id}: invalid meta: ${problems.join('; ')}`);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(dir, 'elevation.f32'), Buffer.from(elevation.buffer, elevation.byteOffset, elevation.byteLength));
  if (jpg) fs.writeFileSync(path.join(dir, 'imagery.jpg'), jpg);
  else fs.rmSync(path.join(dir, 'imagery.jpg'), { force: true });
  if (detailBytes) fs.writeFileSync(path.join(dir, 'imagery-detail.jpg'), detailBytes);
  else fs.rmSync(path.join(dir, 'imagery-detail.jpg'), { force: true });
  fs.writeFileSync(path.join(dir, 'roads.json'), JSON.stringify(encodeRoads(roads)));
  const sizes = ['meta.json', 'elevation.f32', ...(jpg ? ['imagery.jpg'] : []), ...(detailBytes ? ['imagery-detail.jpg'] : []), 'roads.json'].map(
    (f) => `${f} ${(fs.statSync(path.join(dir, f)).size / 1e6).toFixed(2)} MB`,
  );
  log(def.id, `wrote ${sizes.join(', ')} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

/**
 * `size`² imagery for `merc` from four (size/2)² exports of its exact quadrants — the same pixel grid as one export —
 * stitched and re-encoded (JPEG, quality 0.92) in headless Chromium, the one image codec among the dev dependencies.
 */
async function fetchImageryStitched(merc: { xmin: number; ymin: number; xmax: number; ymax: number }, size: number, source: ImagerySource): Promise<Uint8Array> {
  const half = size / 2;
  const xm = (merc.xmin + merc.xmax) / 2;
  const ym = (merc.ymin + merc.ymax) / 2;
  const quads = [
    { xmin: merc.xmin, xmax: xm, ymin: ym, ymax: merc.ymax },
    { xmin: xm, xmax: merc.xmax, ymin: ym, ymax: merc.ymax },
    { xmin: merc.xmin, xmax: xm, ymin: merc.ymin, ymax: ym },
    { xmin: xm, xmax: merc.xmax, ymin: merc.ymin, ymax: ym },
  ];
  const parts: Uint8Array[] = [];
  for (const q of quads) parts.push(await fetchImageryBytes(q, half, undefined, undefined, source));
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const b64 = await page.evaluate(
      async ({ parts, half }) => {
        const canvas = new OffscreenCanvas(half * 2, half * 2);
        const ctx = canvas.getContext('2d')!;
        for (let q = 0; q < 4; q++) {
          const bytes = Uint8Array.from(atob(parts[q]), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
          if (bmp.width !== half || bmp.height !== half) throw new Error(`quadrant ${q} is ${bmp.width}×${bmp.height}`);
          ctx.drawImage(bmp, (q % 2) * half, (q >> 1) * half);
        }
        const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer());
        let bin = '';
        for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
        return btoa(bin);
      },
      { parts: parts.map((p) => Buffer.from(p).toString('base64')), half },
    );
    return new Uint8Array(Buffer.from(b64, 'base64'));
  } finally {
    await browser.close();
  }
}

/** Cells between a position along an edge and a run [t0, t1] of edge cells (0 inside the run). */
function distToRun(run: [number, number], t: number): number {
  return t < run[0] ? run[0] - t : t > run[1] + 1 ? t - run[1] - 1 : 0;
}

/**
 * Inflow footprints need room: at least 4 cells of radius, fully inside the domain. Walk inward along the
 * centerline from the edge end until the footprint fits.
 */
function inflowPlacement(burn: BurnResult, river: number, which: 'upstream' | 'downstream', end: { gx: number; gy: number; radius: number }, N: number) {
  const radius = Math.max(4, end.radius);
  const cl = burn.rivers[river].centerline;
  const npts = cl.length / 2;
  const fits = (gx: number, gy: number) => Math.min(gx, gy, N - gx, N - gy) >= radius + 1;
  if (fits(end.gx, end.gy)) return { gx: end.gx, gy: end.gy, radius };
  for (let s = 0; s < npts; s++) {
    const q = which === 'upstream' ? s : npts - 1 - s;
    const gx = cl[q * 2];
    const gy = cl[q * 2 + 1];
    if (fits(gx, gy)) return { gx, gy, radius };
  }
  return { gx: end.gx, gy: end.gy, radius: end.radius };
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const defs = only.length ? PRESET_DEFS.filter((d) => only.includes(d.id)) : PRESET_DEFS;
  if (!defs.length) throw new Error(`unknown preset(s): ${only.join(', ')}; known: ${PRESET_DEFS.map((d) => d.id).join(', ')}`);
  for (const d of defs) {
    await bake(d);
    // Land cover (scripts/bake-landcover.ts) registers itself in the meta.json bake() just wrote.
    await bakeLandCover(d.id, OUT, REFRESH);
  }
  let total = 0;
  for (const id of fs.readdirSync(OUT)) {
    const dir = path.join(OUT, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size;
  }
  console.log(`public/presets total: ${(total / 1e6).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

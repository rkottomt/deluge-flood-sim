/**
 * Glacier-hazard chain definitions: what scripts/bake-chain.ts routes and where its stations are, and the
 * HazardChainSpec each preset's meta.json carries (scripts/bake-presets.ts writes it into the scenario, and
 * scripts/bake-chain.ts writes it into an already-baked meta.json, so a re-bake of either keeps it).
 *
 * Every coordinate below is either an OpenStreetMap element (named by id; © OpenStreetMap contributors, ODbL) or a
 * published number (cited). Numbers that are this bake's ASSUMPTIONS rather than anyone's measurement say so, here
 * and in public/presets/SOURCES.txt.
 */
import { MATERIAL_GLENWOOD_1, VPE_D84_HIMALAYA } from '../src/hazard/defaults';
import type { HazardChainSpec } from '../src/hazard/types';

export type LonLat = [number, number];

export interface ChainStationDef {
  name: string;
  kind: 'source' | 'lake' | 'gauge' | 'town' | 'hydro' | 'bridge';
  at: LonLat;
  /** Use the profile's first node instead of `at` (the source is where the profile starts). */
  atSource?: boolean;
  capacityMW?: number;
  /** Largest allowed distance from the routed river, m (default 600): a town's place node sits beside the river. */
  maxOffset?: number;
}

export interface ChainStructureDef {
  name: string;
  kind: 'weir' | 'dam';
  at: LonLat;
  /** Published structural height, m: crest = profile bed at the structure + height. */
  height: number;
  /** Integrate a stage–storage curve from the upstream sections. */
  storage?: boolean;
}

export interface ChainDef {
  /** Preset id (public/presets/<id>/). */
  id: string;
  name: string;
  clockZero?: string;
  /** Coarse corridor upstream → downstream; only chooses which OSM tiles are downloaded. */
  route: LonLat[];
  /** Corridor half-width, degrees. */
  corridorDeg: number;
  /** Where the profile starts: the waterway node nearest `at` (on a way whose name matches `wayName`, if given). */
  source: { at: LonLat; wayName?: RegExp; bedBelow?: number };
  /** Where the profile ends (inside or past the 2-D domain). */
  end: LonLat;
  waterways?: string[];
  stations: ChainStationDef[];
  structures: ChainStructureDef[];
  /** The preset's inflow source the routed hydrograph will replace, and the name of the domainEdge station. */
  domainEntry: { sourceId: string; name: string };
  /** Leading sentence(s) of ChainFile.attribution: the sources of the stations, structures and numbers. */
  attribution: string;
  hazardChain: HazardChainSpec;
}

export const CHAIN_DEFS: ChainDef[] = [
  {
    id: 'nepal',
    name: 'Lhende Khola → Bhote Koshi → Trishuli',
    clockZero: '2026-08-26T08:37:00+05:45',
    route: [
      [85.455, 28.5], [85.43, 28.4], [85.385, 28.29], [85.38, 28.27], [85.343, 28.159], [85.3, 28.1], [85.25, 28.06],
      [85.189, 28.026], [85.1626, 27.952],
    ],
    corridorDeg: 0.04,
    /*
     * s = 0 is where the Lhende Khola's bed on this DEM first falls below 2,900 m — the elevation at which YAE/KU's
     * rapid report has the avalanche reaching the river (Chand, Kayastha et al., 31 Aug 2026). The impact point itself
     * was never located in anything this bake read, so the source is defined by that one published number. It lands
     * 15.5 km of river above the Rasuwagadhi headworks; NDRRMA puts the source "~20 km upstream". The routed river
     * is OSM's: Donglin Zangbo / Lende Khola (relation 21285794) → Bhote Koshi → Trishuli (relation 4839538).
     */
    source: { at: [85.455, 28.5], wayName: /Lhende|Lende|东林/, bedBelow: 2900 },
    // The Trishuli's exit through the south edge of the Betrawati domain (the end of bake-presets.ts' traced path).
    end: [85.1626, 27.952],
    stations: [
      { name: 'Lhende Khola at 2,900 m (avalanche runout)', kind: 'source', at: [0, 0], atSource: true },
      // OSM way 1552793903 "Rasuwagadhi Hydropower Dam" — the headworks, ~400 m below the Kerung–Lende confluence
      // (rghpcl.com.np). 111 MW: IPPAN via Spotlight Nepal (26 Aug / 1 Sep 2026), Ekantipur 26 Aug 2026.
      { name: 'Rasuwagadhi HEP headworks', kind: 'hydro', at: [85.3771, 28.27377], capacityMW: 111 },
      // OSM node 992955542 (place=hamlet "रसुवागढी"), the border post the reports time the flood at.
      { name: 'Rasuwagadhi', kind: 'town', at: [85.37778, 28.27777] },
      // OSM node 2553894641 (place=suburb "Timure").
      { name: 'Timure', kind: 'town', at: [85.36667, 28.25285] },
      // OSM node 267564991 ("Syafrubesi"/"Shyaphru").
      { name: 'Syafrubesi', kind: 'town', at: [85.33725, 28.16367] },
      /*
       * The Bhote Koshi hydrometric station at Syafrubesi (DHM). Its exact site is not in OSM or in any report this
       * bake read, so it is placed at the Syafrubesi place node — a station position good to a few hundred metres,
       * which is what the chain needs for an arrival time, and no better.
       */
      { name: 'Syafrubesi gauge (DHM, position approximate)', kind: 'gauge', at: [85.33725, 28.16367] },
      // OSM node 982602383 "Chilime Hydropower Powerhouse", generator:output:electricity=22.1 MW (Spotlight Nepal: 22 MW).
      { name: 'Chilime HEP powerhouse', kind: 'hydro', at: [85.33192, 28.15735], capacityMW: 22.1 },
      // OSM way 1552864314 "Upper Trishuli-1 Hydroelectric Project" (which component is not tagged). 216 MW, under
      // construction: IPPAN via Spotlight Nepal.
      { name: 'Upper Trishuli-1 HEP (under construction)', kind: 'hydro', at: [85.20952, 28.07287], capacityMW: 216 },
      // OSM way 1554017038 "Upper Trishuli 3A" (power=plant). 60 MW: Ekantipur 26 Aug 2026 (three headworks washed away).
      { name: 'Upper Trishuli-3A HEP powerhouse', kind: 'hydro', at: [85.18635, 28.02532], capacityMW: 60, maxOffset: 300 },
      // OSM way 1553105361 "Upper Trishuli-3B Powerhouse" (power=plant), inside the 2-D domain. 37 MW: ShareSansar
      // 1 Sep 2026 ("structures completely destroyed").
      { name: 'Upper Trishuli-3B HEP powerhouse', kind: 'hydro', at: [85.18306, 27.9949], capacityMW: 37 },
      /*
       * Betrawati: OSM way 341461646, the Falaakhu River Bridge at the Phalakhu–Trishuli confluence — the crossing
       * the scenario is about and where the reports time the flood (~09:20). DHM station 447 (Trishuli at Betrawati)
       * is here too; its exact site is not published, so no separate gauge station is invented for it.
       */
      { name: 'Betrawati', kind: 'town', at: [85.18577, 27.97419] },
    ],
    /*
     * NO STRUCTURES. Every plant on this reach is run-of-river behind a low diversion weir, and no weir height for any of
     * them was found (Rasuwagadhi's own site gives "overflow diversion weir", gross head 167.9 m, design flow 80 m³/s,
     * but not the weir's height). A crest invented to the nearest metre would be read as a number someone measured.
     */
    structures: [],
    domainEntry: { sourceId: 'trishuli-inflow', name: 'Betrawati 2-D domain (north edge)' },
    attribution:
      'Event times: NDRRMA Rasuwa Flood Situation Report #01 (1 Sep 2026), DHM Flood Forecasting Division technical report (27 Aug 2026, via Kathmandu Post and Onlinekhabar), Chand, Kayastha et al., YAE/HiCCDRC/KU rapid situation report (31 Aug 2026). ' +
      'Secondary timeline: S. Rauniyar, "The Langtang Collapse", SPF Ocean Policy Research Institute (3 Sep 2026). ' +
      'River flow: mean August discharge of the Trishuli from DHM station 447 (1967–2010), ESSA Technologies (2014), Environmental Flows Assessment, Supplemental ESIA Upper Trishuli-1 HEP, Appendix E. ' +
      'Hydropower capacities: IPPAN via Spotlight Nepal (26 Aug and 1 Sep 2026), Ekantipur (26 Aug 2026), ShareSansar (1 Sep 2026), OSM node 982602383. ' +
      'Station positions: OpenStreetMap elements listed in scripts/chain-defs.ts.',
    hazardChain: {
      /*
       * THE 2026 MECHANISM, per research spec §C.3 / §G.1: an ice-rock avalanche into the Lhende that turned into a
       * debris flood, after blocking the river for "a few minutes" at most (YAE/KU; an 18–19 h impoundment hypothesis
       * exists and is not the default).
       *   mode        DIRECT FLOW (spec §C.3 branch 2), not a transient dam. Calibration, Oct 2026: s = 0 is where the
       *               avalanche met the river, and the DEM profile has no valley above it to pond, so a transient dam
       *               there "fills" for 10.5 h at baseflow and lets out 3.8 Mm³ at ~500 m³/s — the front reached
       *               Betrawati after ~15 h against the reported 43 min. Moving s = 0 upstream would invent a lake no
       *               report describes. Every timing source says the flood followed the collapse within minutes:
       *               Rasuwagadhi ~3 min (NDRRMA) or ~7 min (CCTV at Gyirong Port, via OPRI), the Syafrubesi gauge dead
       *               by 08:50. So the avalanche itself becomes the flood: its melted ice (20.7 Mm³ — DHM measured
       *               19.96 Mm³ of excess water at Devghat) at the default source Cv.
       *   volume      113 Mm³ — YAE/KU's rough collapse estimate (assumed depths, "field verification required"; they
       *               add 29.4 Mm³ eroded for > 142 Mm³). NDRRMA describes "~1 km² of rock-glacier material".
       *   fallHeight  2,300 m — failure zone ~5,200 m (YAE/KU) down to the river at 2,900 m (profile s = 0).
       *   pathLength  13,000 m — ASSUMPTION: map distance from Langtang Lirung's north face to the profile's start.
       *               H/L ≈ 0.18, in the range of ice-rich rock avalanches (Chamoli 2021: 0.16, Shugar et al. 2021).
       *   travelSpeed 50 m/s — the OPRI reconstruction ("The Langtang Collapse", Sep 2026) has the debris moving at
       *               "roughly fifty metres a second"; the chain's clock (08:37) is the collapse's seismic signal, so the
       *               water leaves s = 0 only 13 km / 50 m/s = 4.3 min later. The observed times include this travel;
       *               the routing is not tuned to absorb it.
       *   iceFraction 0.2 — ASSUMPTION (the Chamoli rock:ice split, 80:20); no published split for this event.
       *   damLength   1,500 m — spec default (1–2 km), used only if the mode is switched back to transientDam.
       *   baseflow    100 m³/s — ASSUMPTION, the low end of the spec's monsoon 100–300 m³/s for the Lhende.
       */
      /*
       *   shape       'surge' (third pass, research spec §G.9): the debris flow leaves the impact with its peak at the
       *               front (src/hazard/mass.ts surgeHydrograph) instead of the breach-like gamma rise that put the peak
       *               11 min after the mass reached the river. Same peak (43,000 m³/s, Jitousono) and volume.
       *   slide       NOT set: a Voellmy–Salm runout (src/hazard/runout.ts) needs a back-analysed friction pair, and none
       *               exists for this event. With Chamoli's (μ 0.12, ξ 2,500 m/s²) the block reaches the river at a mean
       *               40 m/s — slower than OPRI's ~50 m/s — and stops within 1.5 km, as the reports' brief blockage of
       *               the Lhende suggests; it moves Rasuwagadhi 1 min LATER and Betrawati 0.5 min earlier, so it is not
       *               adopted (sensitivity in §G.9).
       */
      trigger: {
        kind: 'massIntoRiver',
        mass: { volume: 113e6, iceFraction: 0.2, fallHeight: 2300, pathLength: 13000, travelSpeed: 50 },
        mode: 'directFlow',
        damLength: 1500,
        baseflow: 100,
        shape: 'surge',
      },
      profile: 'chain.json',
      result: 'chain-result.json',
      /*
       * 2-D rheology: O'Brien–Julien quadratic, "mud flood" Cv 0.3 with the Glenwood 1 material (spec §D.1; FLO-2D
       * default K). Not the Voellmy μ 0.05 / ξ 500 of the first version: its Coulomb term stops flow wherever the surface
       * slope is under μ·cosθ ≈ 2.9°, and the Trishuli floor in this domain falls ~2 %, so the 2-D surge stalled ~2 km
       * into the map (solver engineer's headless runs, Oct 2026: front row at 450 s — water 456, Voellmy 401,
       * quadratic Cv 0.3 436, Cv 0.45 336) [C]. The spec notes the yield/Coulomb terms matter little for debris floods
       * at Cv 0.1–0.35. uMax 25 m/s — ICIMOD timed ~20 m/s Rasuwagadhi → Betrawati. (The 1-D routing does not read
       * this: it carries its own Cv and Manning × n_td(Cv).)
       */
      rheology: { kind: 'quadratic', cv: 0.3, material: { ...MATERIAL_GLENWOOD_1 } },
      solver: { uMax: 25 },
      /*
       * 1-D bed resistance: Ferguson's (2007) variable-power equation on D84 = 0.5 m (src/hazard/defaults.ts
       * VPE_D84_HIMALAYA — a literature-range assumption, not fitted to the arrival times), instead of a constant
       * n = 0.05. At this flood's depths it is equivalent to n ≈ 0.044–0.047 (Manning–Strickler over a boulder bed), so
       * it speeds the front only modestly: the median member's Betrawati front 75 → 70 min against 43 min reported (second pass).
       * Adopted because it moves every Nepal station toward its observation (research spec §G.9).
       */
      /*
       * Tributaries (third pass): the Lhende's assumed 100 m³/s was the whole river all the way to Betrawati, i.e. the
       * flood ran down a nearly empty Trishuli in late August. The mean August flow of the Trishuli is 557.8 m³/s at the
       * Upper Trishuli-1 intake and 557.8 / 0.8971 = 621.8 m³/s at Betrawati — 44 years (1967–2010) of DHM station 447
       * at Betrawati, scaled by catchment area to the intake (ESSA Technologies 2014, Environmental Flows Assessment,
       * Supplemental ESIA Upper Trishuli-1 HEP, Appendix E, Table 5-2 and §2) [V]. The Betrawati gauge read 3.55 m
       * against its 4.1 m warning level before it was lost: a high monsoon river that morning, not a low one. HOW the
       * flow joins is this bake's ASSUMPTION [H]: everything above the intake that is not the Lhende's 100 m³/s
       * (458 m³/s) enters with the Kerung (Gyirong Zangbo) at the Rasuwagadhi confluence, ~400 m above the HEP
       * headworks; the 64 m³/s between the intake and Betrawati enters at the Upper Trishuli-1 site. Putting the 458 at
       * Syafrubesi instead (the Langtang Khola's confluence) moves Betrawati by +0.8 min (§G.9).
       */
      routing: {
        resistance: { law: 'ferguson2007', d84: VPE_D84_HIMALAYA },
        tributaries: [
          { s: 15100, q: 458, name: 'Kerung / Gyirong Zangbo and the rest of the Bhote Koshi above the Upper Trishuli-1 intake (mean August flow, DHM 447 via ESSA 2014)' },
          { s: 47233, q: 64, name: 'Trishuli between the Upper Trishuli-1 intake and Betrawati (mean August flow, DHM 447 via ESSA 2014)' },
        ],
      },
      // The first DHM SMS alerts went out at about 09:15 NPT (DHM issued warnings 09:00–09:16; 632,295–679,295 SMS).
      alertTime: 38 * 60,
      observations: [
        {
          station: 'Rasuwagadhi',
          tFront: 3 * 60,
          note: 'Flood at Rasuwagadhi ~08:40, about three minutes after the 08:37 seismic signal. 08:40 is also the time of the last NORMAL reading of the Bhote Koshi gauge (1.62 m against a 6 m warning level; DHM technical report) — 28 km of path and river in 3 min would be ~150 m/s, so this time is probably that gauge timestamp, not the flood.',
          source: 'NDRRMA Situation Report #01 (1 Sep 2026); YAE/KU rapid report (31 Aug 2026); DHM FFD technical report via Onlinekhabar (27 Aug 2026)',
        },
        {
          station: 'Syafrubesi gauge (DHM, position approximate)',
          tFront: 13 * 60,
          note: 'The Bhotekoshi–Syafrubesi gauge read 1.62 m (normal; warning level 6 m) at 08:40 and its data stopped at 08:50. If the flood destroyed it, the front arrived between 08:40 and 08:50 and 08:50 is an upper bound; if its telemetry failed first (a link through the flooded valley above), 08:50 bounds nothing. Shown as 08:50.',
          source: 'DHM Flood Forecasting Division technical report (27 Aug 2026), via Onlinekhabar; NDRRMA SitRep #01',
        },
        {
          station: 'Betrawati',
          tFront: 43 * 60,
          note: 'Flood at Betrawati ~09:20 — the time DHM station 447 (warning 4.1 m, danger 5.0 m) stopped transmitting; its last reading was 3.55 m, below warning. So 09:20 is when the gauge was lost, an upper bound on the front if the flood destroyed it.',
          source: 'NDRRMA SitRep #01 (1 Sep 2026); DHM FFD technical report via Onlinekhabar (27 Aug 2026); DHM station 447 page (dhm.gov.np/hydrology/hms-Single/52)',
        },
        /*
         * A second, secondary reconstruction (think-tank synthesis of seismic, CCTV and official sources) puts both
         * crossings at different times. Kept beside the official series so the spread of the observations is on
         * screen too: Betrawati at 23 or 43 minutes is itself a ±30 % uncertainty.
         */
        {
          station: 'Rasuwagadhi',
          tFront: 7 * 60,
          note: 'CCTV recorded floodwaters destroying the Gyirong Port complex at the Rasuwagadhi crossing ~08:44, seven minutes after the seismic signal (secondary source).',
          source: 'OPRI, "The Langtang Collapse" (Sep 2026), citing Xinhua/CCTV',
        },
        {
          station: 'Betrawati',
          tFront: 23 * 60,
          note: 'The surge reaches Betrawati ~09:00 in this reconstruction, against ~09:20 in NDRRMA SitRep #01 (secondary source).',
          source: 'OPRI, "The Langtang Collapse" (Sep 2026), citing ICIMOD/DHM',
        },
        {
          station: 'Timure',
          tFront: 13 * 60,
          note: 'The same reconstruction: "~08:50, surge crosses at Rasuwagadhi-Timure and reaches Syabrubesi … in roughly ten minutes" (secondary source).',
          source: 'S. Rauniyar, OPRI, "The Langtang Collapse" (3 Sep 2026)',
        },
        {
          station: 'Syafrubesi',
          tFront: 23 * 60,
          note: 'Syafrubesi ~09:00 in the same reconstruction (~10 min after Rasuwagadhi–Timure); secondary source.',
          source: 'S. Rauniyar, OPRI, "The Langtang Collapse" (3 Sep 2026)',
        },
        {
          station: 'Galchhi',
          tFront: (10 * 60 + 28 - 517) * 60,
          note: 'Arrival 10:28, stage +9 m in ~30 min — beyond the profile (validation if it is extended downstream).',
          source: 'NDRRMA SitRep #01; YAE/KU rapid report',
        },
        {
          station: 'Malekhu',
          tFront: (11 * 60 + 50 - 517) * 60,
          note: 'Arrival 11:50, stage +7 m — beyond the profile.',
          source: 'NDRRMA SitRep #01; YAE/KU rapid report',
        },
        { station: 'Mugling', tFront: (13 * 60 - 517) * 60, note: 'Arrival 13:00 — beyond the profile.', source: 'NDRRMA SitRep #01' },
        {
          station: 'Devghat',
          tFront: (15 * 60 + 20 - 517) * 60,
          qPeak: 5850,
          tPeak: (16 * 60 - 517) * 60,
          note: 'Arrival 15:20, peak 5,850 m³/s at 16:00 (stage 6.57 m); 57.40 Mm³ passed, 19.96 Mm³ of it excess — the only measured discharge, 168 km below Betrawati and beyond the profile.',
          source: 'NDRRMA SitRep #01 (DHM figures)',
        },
      ],
    },
  },
  {
    id: 'chungthang',
    name: 'South Lhonak → Lhonak Chu → Lachen Chu → Teesta',
    clockZero: '2023-10-03T22:13:20+05:30',
    // The rivers as OSM draws them (ways 134410502/293178138/193281483 Goma Chu → 193282162/193282428 Lhonak Chu →
    // 134410518/481835020 Zemu Chu → 293185705/126757767/126757760 Lachen Chu → 1214968882/… Teesta).
    route: [
      [88.1964, 27.9125], [88.2092, 27.9162], [88.3046, 27.878], [88.4162, 27.8709], [88.4508, 27.8535], [88.493, 27.7799],
      [88.544, 27.7543], [88.6086, 27.6426], [88.6489, 27.6011], [88.6547, 27.5524],
    ],
    corridorDeg: 0.05,
    /*
     * s = 0 is the head of OSM's Goma Chu (way 134410502, node 4709038501, 27.9162 N, 88.2092 E): the lake's outlet,
     * 1.4 km east of the lake centroid Eos gives (27.9125 N, 88.1964 E) for a lake ~2.9 km long before the flood
     * (EGU24-18788).
     */
    source: { at: [88.2092, 27.9162], wayName: /Goma/ },
    // Just inside the south edge of the Chungthang domain, on the Teesta (OSM way 126757765).
    end: [88.65442, 27.57723],
    stations: [
      // The lake: s = 0 (its outlet), position the published centroid (Sattar et al. 2025 via Eos).
      { name: 'South Lhonak Lake', kind: 'lake', at: [88.1964, 27.9125], atSource: true },
      // OSM node 342098800 (place=town "Lachen"). The town stands on the valley side above the Lachen Chu.
      { name: 'Lachen', kind: 'town', at: [88.5495, 27.73061], maxOffset: 1200 },
      // OSM way 117990901, North Sikkim Highway bridge (NH310A) over the Lachen Chu just above the confluence.
      { name: 'Chungthang bridge (North Sikkim Highway)', kind: 'bridge', at: [88.646454, 27.601762] },
      // OSM node 13148720740 (place=village "Chungthang").
      { name: 'Chungthang', kind: 'town', at: [88.64652, 27.60424] },
      // OSM way 733894880 "Teesta Stage III Dam" (power=plant, waterway=dam), centroid. 1,200 MW: research spec §G.3
      // and Sattar et al. 2025 via Eos.
      { name: 'Teesta-III dam', kind: 'hydro', at: [88.65018, 27.597332], capacityMW: 1200 },
    ],
    structures: [
      /*
       * Teesta-III: "the 60 m high dam was destroyed" (Sattar et al. 2025 via Eos). Crest = the profile bed at the dam
       * + 60 m. The bed is the 2011–2015 radar surface, i.e. the river while the dam was under construction, which is
       * the valley the reservoir would fill; the storage curve is integrated from those sections, so it is the DEM's
       * valley volume below the crest, not the project's design figure.
       */
      { name: 'Teesta-III dam', kind: 'dam', at: [88.65018, 27.597332], height: 60, storage: true },
    ],
    domainEntry: { sourceId: 'lachen-chu-inflow', name: 'Chungthang 2-D domain (north edge)' },
    attribution:
      'Event: Sattar et al. 2025, Science, doi:10.1126/science.ads2659 (accepted manuscript, eprints.whiterose.ac.uk/224098; also via Eos / The Landslide Blog and Newcastle University). ' +
      'Lake area: NRSC/ISRO pre/post-outburst map (167.4 ha on 28 Sep 2023); lake volume: EGU24-18788 (102.4 Mm³, 2015–2023 mean). ' +
      'Peak reconstruction: Natural Hazards 121 (2025), doi:10.1007/s11069-025-07350-9. ' +
      'Station positions: OpenStreetMap elements listed in scripts/chain-defs.ts.',
    hazardChain: {
      /*
       * Research spec §C.2 / §G.3: a mass movement into the lake → displacement wave → overtopping → breach.
       *   lake        27.9125 N, 88.1964 E (Eos); ~5,200 m (EGU24-18788); 1.674 km² (NRSC, 28 Sep 2023, 167.4 ha);
       *               volume 102.4 Mm³ (EGU24-18788, 2015–2023 mean; consistent with "~50 Mm³ ≈ half the lake").
       *               The ±25 % band (77–128 Mm³) is this bake's ASSUMPTION, not a published interval.
       *   mass        14.7 Mm³ of frozen lateral moraine (Sattar et al. 2025). A later study puts the debris input at
       *               ~38 Mm³ (Mohanty et al. 2026, Science Advances) — the published disagreement is real.
       *               iceFraction 0.2, fallHeight 150 m, pathLength 500 m are ASSUMPTIONS (order of magnitude for a
       *               lateral-moraine slope into the lake); none was published in the sources read.
       *   breach      weir + linear erosion (§B.3) with the spec's trigger-driven k = 100 m/h; finalDepth 28 m, the
       *               lake-level drop Sattar et al. 2025 measured (it was the spec's ASSUMED 40 m until Oct 2026's
       *               third pass), with r = 2, side slope 1, p = 1.5 defaults.
       *   wave        where the outlet lies relative to the slide, for the impulse wave's spreading (mass.ts
       *               impulseWave; Evers et al. 2019 manual §4.2.1). A LATERAL moraine runs along the lake's side, so
       *               the slide enters across the lake and the outlet, at the lake's end, is off to its side. From the
       *               published numbers: the outlet (OSM Goma Chu head) is 1.3 km from the lake centroid (Eos), and
       *               the lake is ~2.9 km long (EGU24-18788) so ~0.58 km wide (1.674 km² / 2.9 km). Impact taken at
       *               the centroid, half a width from the shore: distance √(1300² + 290²) ≈ 1,330 m, angle
       *               atan(1300 / 290) ≈ 77° — ASSUMPTIONS built from those numbers; the failure's exact place on
       *               the shore was not in the sources read. Result (Oct 2026): wave height 15 m at the outlet
       *               (≈ 20 m observed) where the flume equations gave 46 m.
       */
      trigger: {
        kind: 'massIntoLake',
        lake: {
          id: 'south-lhonak',
          name: 'South Lhonak Lake',
          lat: 27.9125,
          lon: 88.1964,
          elevation: 5200,
          area: 1.674e6,
          volume: { median: 102.4e6, lo: 76.8e6, hi: 128e6, method: 'empirical' },
          damType: 'moraine',
        },
        mass: { volume: 14.7e6, iceFraction: 0.2, fallHeight: 150, pathLength: 500 },
        /*
         * finalDepth 28 m (third pass, Oct 2026): the lake LEVEL fell 28 m — Sattar et al. 2025 (accepted manuscript,
         * eprints.whiterose.ac.uk/224098) [V]; the breach itself was cut 55 m into the moraine crest, which stood above
         * the lake. The 40 m before was the spec's assumption. With the default hypsometry it drains 43 Mm³ (Sattar:
         * 50 ± 1.8 Mm³, which includes water displaced by the 14.7 Mm³ slide — not modelled). k = 100 m/h agrees with
         * their timeline: the full breach depth was reached at ~22:24, ~11 min after the collapse, and the outflow was
         * steady after ~18 min.
         */
        breach: { model: 'weirErosion', erosionRate: 100, finalDepth: 28, widthRatio: 2, sideSlope: 1, hypsometry: 1.5 },
        wave: { distance: 1330, angleDeg: 77 },
      },
      profile: 'chain.json',
      result: 'chain-result.json',
      /*
       * ~270 Mm³ of sediment was mobilised (Sattar et al. 2025): a debris flood. 2-D rheology O'Brien–Julien quadratic,
       * "mud flood" Cv 0.3, Glenwood 1 (spec §D.1), not Voellmy μ 0.05 — whose Coulomb term stalls flow on surface
       * slopes under ~2.9°, which lagged the 2-D front here as on the Trishuli (solver engineer's runs, Oct 2026) [C].
       */
      rheology: { kind: 'quadratic', cv: 0.3, material: { ...MATERIAL_GLENWOOD_1 } },
      solver: { uMax: 25 },
      /*
       * 1-D bed resistance stays Manning n = 0.05 here (no `routing`), deliberately. Ferguson's VPE on the same
       * D84 = 0.5 m as Nepal and Chamoli moved the median member's Chungthang front (second pass) 109 → 103 min, further EARLY of the
       * ~137 min observed (−24 % against −21 %); D84 = 1 m would give 120 min, but picking the bed size that fits the
       * clock is the tuning this calibration refuses. The early bias here has other suspects (the breach hydrograph,
       * the 30 m DEM's sections, how much of the ~270 Mm³ of mobilised sediment loaded the front) — research spec §G.9.
       */
      observations: [
        {
          station: 'South Lhonak Lake',
          tFront: 0,
          note: '14.7 Mm³ of frozen moraine failed into the lake at 22:13:20 IST; displacement wave ~20 m; ~50 Mm³ (about half the lake) released; peak flow height ~11 m about 1 km downstream.',
          source: 'Sattar et al. 2025, Science, doi:10.1126/science.ads2659 (via Eos / The Landslide Blog)',
        },
        {
          station: 'Chungthang',
          tFront: 8500,
          note: 'The flood reached Chungthang about 00:35 on 4 Oct (≈ 2 h 22 min after the failure) — the "reported arrival time" Sattar et al. compare their model with; how it was recorded is not stated. The often-quoted 00:30 is THEIR HEC-RAS result (water only, n = 0.05), not an observation. The 60 m Teesta-III dam was destroyed.',
          source: 'Sattar et al. 2025, Science, doi:10.1126/science.ads2659 (accepted manuscript, eprints.whiterose.ac.uk/224098)',
        },
        {
          station: 'Chungthang',
          qPeak: 5340,
          note: 'MODELLED peak in Sattar et al. 2025 (HEC-RAS, water phase): 5,340 m³/s within ~6 min of the first arrival, 9 m deep, 9 m/s — a fourth reconstruction beside 7,355 and 10,282–14,673.',
          source: 'Sattar et al. 2025, Science (accepted manuscript)',
        },
        {
          station: 'Chungthang',
          qPeak: 7355,
          note: 'MODELLED peak (HEC-HMS/HEC-RAS reconstruction calibrated to the gauged peak at Gazoldoba); other studies give 10,282–14,673 m³/s here. No gauge measured it.',
          source: 'Natural Hazards 121 (2025), doi:10.1007/s11069-025-07350-9; research spec §G.3',
        },
        {
          station: 'Gazoldoba',
          qPeak: 8252,
          note: 'Gauged peak at the Gazoldoba barrage on the Teesta in West Bengal — far beyond the profile; the reconstruction above reproduces it with 8,282 m³/s.',
          source: 'Natural Hazards 121 (2025), doi:10.1007/s11069-025-07350-9',
        },
      ],
    },
  },
  {
    id: 'chamoli',
    name: 'Ronti Gad → Rishiganga → Dhauliganga',
    // Shugar et al. 2021: the failure at 04:51 UTC = 10:21 IST on 7 February 2021.
    clockZero: '2021-02-07T10:21:00+05:30',
    // OSM ways 682961414 ("Raunthi Gadhera" = Ronti Gad) → 1074462194 ("Rishi Ganga") → 297368686 ("Dhauli Ganga"),
    // down to the Dhauliganga–Alaknanda confluence at Vishnuprayag below Joshimath.
    route: [
      [79.7503, 30.3894], [79.7322, 30.4665], [79.7114, 30.4697], [79.6902, 30.4877], [79.6304, 30.4929], [79.6226, 30.4965],
      [79.6092, 30.5222], [79.5984, 30.5383], [79.5756, 30.5625],
    ],
    corridorDeg: 0.03,
    /*
     * s = 0 is the head of OSM's Raunthi Gadhera (way 682961414, 30.3894 N, 79.7503 E): the Ronti Gad below the Ronti
     * glacier, which the avalanche from Ronti Peak's north face ran down. Where exactly the rock-ice mass "became" a
     * debris flow is not a point anyone measured; the head of the mapped stream is this bake's choice of where the
     * 1-D model takes it over, and the trigger below says so.
     */
    source: { at: [79.7503, 30.3894], wayName: /Raunthi|Ronti/ },
    // The Dhauliganga's last OSM node at its confluence with the Alaknanda (Vishnuprayag), 16 km below Raini.
    end: [79.5756, 30.5625],
    stations: [
      { name: 'Ronti Gad (avalanche runout, head of the mapped stream)', kind: 'source', at: [0, 0], atSource: true },
      /*
       * The Rishiganga plant (13.2 MW; research spec §G.4, Shugar et al. 2021) stood on the Rishiganga at Raini, just
       * above its confluence with the Dhauliganga. Its site is not mapped in OSM, so the station is placed at OSM node
       * 7833070518 (place=village "Reni", alt_name "Raini") — a position good to a few hundred metres, as the chain
       * needs for an arrival time, and no better.
       */
      { name: 'Rishiganga HEP, Raini (position approximate)', kind: 'hydro', at: [79.691091, 30.485222], capacityMW: 13.2 },
      // OSM way 905613418 "Reni Bridge (Destroyed)", NH107B, "Washed away in floods on February 8" (sic, OSM).
      { name: 'Reni bridge (NH107B)', kind: 'bridge', at: [79.69423, 30.48549] },
      /*
       * OSM way 683265980 "Tapovan Vishnugad Hydropower Plant (Destroyed)" (landuse=construction), centroid — the
       * barrage site. 520 MW, under construction in 2021 (research spec §G.4). No barrage height was found in anything
       * this bake read, so the barrage is a STATION, not a ChainStructure (an invented crest would read as measured).
       */
      { name: 'Tapovan-Vishnugad HEP barrage (under construction)', kind: 'hydro', at: [79.63042, 30.4929], capacityMW: 520 },
      // OSM node 7833070513 (place=village "Tapoban"), on the slope just below the barrage.
      { name: 'Tapovan', kind: 'town', at: [79.625267, 30.488531], maxOffset: 800 },
      /*
       * OSM node 2376466294 (place=hamlet "Vishnuprayāg", tagged "Location approximate") at the Dhauliganga–Alaknanda
       * confluence below Joshimath — the downstream end of Shugar et al.'s "Raini → Joshimath, 16 km". Joshimath town
       * (OSM node 342105699) stands on the slope ~1.6 km west of the river and ~500 m above it.
       */
      { name: 'Joshimath (Vishnuprayag confluence)', kind: 'town', at: [79.57915, 30.56264] },
    ],
    structures: [],
    domainEntry: { sourceId: 'rishiganga-inflow', name: 'Raini–Tapovan 2-D domain (east edge)' },
    attribution:
      'Event: Shugar et al. 2021, Science 373:300–306, doi:10.1126/science.abh4455 (volumes, ice fraction, front speeds, discharges, losses). ' +
      'Tapovan arrival: Cook et al. 2021, Science 374:87–92, doi:10.1126/science.abj1227 (seismic), via The Landslide Blog; Joshimath arrival: the same, via the GFZ press release. ' +
      'Seismic timeline (confluence, Rishiganga HEP, Tapovan): Tiwari et al. 2022, Sci. Rep. 12:3733, doi:10.1038/s41598-022-07491-y. ' +
      'Avalanche friction (Voellmy μ 0.12, ξ 2,500 m/s²): Zhang, Yin, Li et al. 2022, J. Rock Mech. Geotech. Eng. 15:296–308, doi:10.1016/j.jrmge.2022.04.003. ' +
      'Station positions: OpenStreetMap elements listed in scripts/chain-defs.ts.',
    hazardChain: {
      /*
       * Research spec §C.3 branch 2 / §G.4 — DIRECT TRANSFORMATION: the avalanche itself became the debris flow; no dam.
       *   volume      26.9 Mm³ detached (95 % CI 26.5–27.3; Shugar et al. 2021).
       *   iceFraction 0.2 — Shugar's ~80 % rock / 20 % ice; the 5–6 Mm³ of ice melted almost entirely (frictional heat),
       *               which is the melt directFlow() turns into water (src/hazard/mass.ts).
       *   fallHeight  1,400 m — from the ~5,500 m failure zone (Shugar) to the bed at s = 0 on this DEM (4,094 m raw,
       *               chain.json zBed[0]; the bake prints it). pathLength 3,700 m is an ASSUMPTION: the map distance
       *               from Raunthi Peak (OSM node 6764534673, 6,063 m) to s = 0. H/L 0.38 — the mass is far steeper than
       *               it needs to be to reach the stream (Shugar: H/L 0.16 all the way to Tapovan). travelSpeed is
       *               left at the chain's default 50 m/s (74 s over the 3.7 km): no speed for the avalanche itself was
       *               in the sources read.
       *   baseflow    20 m³/s — ASSUMPTION: a winter low flow (February) of the right order for the Rishiganga; no
       *               gauge record for that morning was read.
       */
      /*
       *   shape       'surge': the debris flow leaves the impact with its peak at its front (src/hazard/mass.ts
       *               surgeHydrograph; rise ≈ 12 s = the ~600 m slab length over 50 m/s, then a linear fall over ~15
       *               min — Shugar's "10–20 min" at Raini), not the gamma curve's 6.6 min rise (§G.9 third pass).
       *   slide       a Voellmy–Salm sliding block from the detachment (src/hazard/runout.ts) with μ 0.12, ξ 2,500 m/s²,
       *               the RAMMS back-analysis of THIS avalanche by Zhang, Yin, Li et al. 2022 (J. Rock Mech. Geotech.
       *               Eng. 15:296–308, doi:10.1016/j.jrmge.2022.04.003) [S — read through a secondary source; the
       *               primary text was not retrievable], inside Allen et al. 2009's compilation of rock–ice avalanche
       *               back-analyses (μ 0.05–0.2, ξ 1,500–4,500; NHESS 9:481) [V]. Checks that are NOT the arrival times
       *               it is judged on: on the avalanche path it averages 52 m/s (the chain's default 50 m/s; seismic
       *               analyses give ~55 m/s source → confluence, Tiwari et al. 2022), and run on to rest it stops at
       *               ~8.8 km on the 6 % stretch 1.6 km above the Ronti Gad–Rishiganga confluence (≈ 10.4 km, where the
       *               profile turns west), near which Shugar et al. mapped the ~8 Mm³ deposit. It hands over to the routed
       *               flood at 3.4 km, where the flood is the faster.
       */
      trigger: {
        kind: 'massIntoRiver',
        mass: { volume: 26.9e6, iceFraction: 0.2, fallHeight: 1400, pathLength: 3700 },
        mode: 'directFlow',
        baseflow: 20,
        shape: 'surge',
        slide: { mu: 0.12, xi: 2500, source: 'Zhang et al. 2022, RAMMS back-analysis of this event' },
      },
      profile: 'chain.json',
      result: 'chain-result.json',
      /*
       * Research spec §I.6 #3: a DEBRIS FLOW, O'Brien–Julien quadratic at Cv 0.45 (top of the FLO-2D mud-flood band,
       * bottom of mudflow). Material: Glenwood 1, the FLUID end of O'Brien & Julien's 1988 table (src/hazard/defaults.ts
       * MATERIAL_GLENWOOD_1) — τ_y ≈ 29 Pa, η ≈ 8.9 Pa·s at Cv 0.45. The stiff end (Aspen Pit 1: τ_y ≈ 1.9 kPa,
       * η ≈ 75 Pa·s) gives a viscous friction slope of 0.2–0.5 at 5–10 m depth, ten times the Dhauliganga's 2.3 %
       * bed slope — it would stop the flow below Raini, which is not what happened. K = 2,285 (FLO-2D default).
       * MEASURED on the GPU with this preset's terrain and the routed inflow (artifacts/chamoli-build/tools/physics.mjs,
       * ARCHITECTURE.md §3 caveat): Glenwood 1 at Cv 0.45 reaches the Tapovan barrage 1,080 s after the solver starts
       * (water 900 s, Glenwood 1 at Cv 0.3 960 s) and runs on out of the map; Aspen Pit 1 never reaches the barrage
       * (2.6 m/s at most after 25 min, 600 m short); Voellmy μ 0.05 stops ~1.3 km below Raini. So Cv stays at the
       * spec's 0.45 — it did not need lowering.
       */
      rheology: { kind: 'quadratic', cv: 0.45, material: { ...MATERIAL_GLENWOOD_1 } },
      // Shugar et al.: the front ran ~25 m/s near the Rishiganga plant.
      solver: { uMax: 25 },
      /*
       * 1-D bed resistance: Ferguson's (2007) VPE on D84 = 0.5 m, as for Nepal (research spec §G.9). Median member:
       * (second pass) Tapovan barrage front 22.3 → 20.9 min against ~15 min (seismic), Raini peak 10,435 → 10,882 m³/s (inside the
       * reconstructed 8,200–14,200) — but the peak below Tapovan rises 5,365 → 5,917 m³/s, further above the
       * reconstructed 2,900–4,900. Adopted on the timing (the one timed observation) with that cost stated: the
       * attenuation miss below Tapovan is the barrage and the debris the real flow dropped there, neither of which the
       * profile carries (structures: []), not the bed law.
       */
      routing: { resistance: { law: 'ferguson2007', d84: VPE_D84_HIMALAYA } },
      observations: [
        {
          station: 'Ronti Gad (avalanche runout, head of the mapped stream)',
          tFront: 0,
          note: '04:51 UTC (10:21 IST): ~26.9 Mm³ of rock and ice (~80/20 %) detached from the north face of Ronti Peak at ~5,500 m — a slab up to ~550 m wide and ~80 m thick; ~8 Mm³ was deposited near the Ronti Gad–Rishiganga confluence.',
          source: 'Shugar et al. 2021, Science 373:300–306, doi:10.1126/science.abh4455',
        },
        {
          station: 'Rishiganga HEP, Raini (position approximate)',
          qPeak: 11200,
          note: 'RECONSTRUCTED mean discharge 8,200–14,200 m³/s at the Rishiganga plant (centre of the band shown), passing in 10–20 min; front ~25 m/s here, ~15 km from the source. The 13.2 MW plant was destroyed.',
          source: 'Shugar et al. 2021, Science (research spec §G.4)',
        },
        {
          station: 'Rishiganga HEP, Raini (position approximate)',
          tFront: 6 * 60,
          note: 'Seismic timeline: release 04:51:10 UTC, debris at the Ronti Gad–Rishiganga confluence 04:54 ("~55 m/s from the source"), Rishiganga HEP damaged 04:57 (~27 m/s, "verified with available videos").',
          source: 'Tiwari et al. 2022, Sci. Rep. 12:3733, doi:10.1038/s41598-022-07491-y',
        },
        {
          station: 'Tapovan-Vishnugad HEP barrage (under construction)',
          tFront: 16 * 60,
          note: 'Seismic timeline: first wave at the Tapovan HEP 05:07 UTC (~13 m/s from Raini), a second, damaging wave at 05:12 (21 min).',
          source: 'Tiwari et al. 2022, Sci. Rep. 12:3733',
        },
        {
          station: 'Tapovan-Vishnugad HEP barrage (under construction)',
          tFront: 15 * 60,
          note: 'Seismic records put the debris flow at the Tapovan project ~15 min after the failure (Shugar et al.: ~16 m/s just upstream of Tapovan). Most of those lost that morning were workers at the two hydropower projects, many of them in the Tapovan tunnels (casualty figures are kept off screen, as in every preset).',
          source: 'Cook et al. 2021, Science 374:87–92 (via The Landslide Blog); Shugar et al. 2021',
        },
        {
          station: 'Tapovan',
          qPeak: 3900,
          note: 'RECONSTRUCTED mean discharge 2,900–4,900 m³/s below Tapovan (centre of the band shown); front ~12 m/s.',
          source: 'Shugar et al. 2021, Science (research spec §G.4)',
        },
        {
          station: 'Joshimath (Vishnuprayag confluence)',
          tFront: 37.5 * 60,
          note: 'Seismic detection of the flood at the road bridge near Joshimath at 10:58:33 IST, 34.6 km downstream, where the water rose 16 m (the earlier "~27 min from 10 m/s" was a derived figure, not a timed arrival).',
          source: 'Cook et al. 2021, Science 374:87–92, doi:10.1126/science.abj1227, via the GFZ press release (secondary source)',
        },
      ],
    },
  },
];

/** HazardChainSpec for a preset id, for scripts/bake-presets.ts. */
export function hazardChainFor(id: string): HazardChainSpec | undefined {
  return CHAIN_DEFS.find((d) => d.id === id)?.hazardChain;
}

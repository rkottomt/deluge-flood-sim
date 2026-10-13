/**
 * Sikkim, 3–4 October 2023: South Lhonak Lake bursts and the flood destroys the Teesta-III dam at Chungthang. Facts:
 * public/presets/chungthang/meta.json (description and observations, citing Sattar et al. 2025, Science, and Natural
 * Hazards 121, 2025) and docs/research/glacier-hazard-chain.md §G.3 (the pre-event modelling).
 */
import type { Story } from '../types';

const DAM = 'Teesta-III dam';

export const CHUNGTHANG_STORY: Story = {
  id: 'sikkim-2023',
  preset: 'chungthang',
  title: 'The lake that took a dam',
  subtitle: 'South Lhonak outburst · Chungthang, Sikkim · 3–4 October 2023',
  summary: 'A moraine collapses into a glacial lake 68 km upstream; two and a quarter hours later the flood destroys the 1,200 MW Teesta-III dam.',
  beats: [
    {
      id: 'teesta',
      kicker: 'Chungthang, Sikkim · 3 Oct 2023',
      caption:
        'Chungthang stands where the Lachen Chu and the Lachung Chu meet to form the Teesta. Just below it stood the 60 m dam of the 1,200 MW Teesta-III hydropower project.',
      source: 'Sattar et al. 2025, Science; presets/chungthang/meta.json',
      durationMs: 8000,
      camera: { kind: 'scenario', seconds: 2, orbitDeg: 6 },
      actions: [{ kind: 'reset' }, { kind: 'waterView', mode: 'default' }],
    },
    {
      id: 'lake',
      kicker: '22:13 IST',
      caption:
        'About 14.7 million m³ of frozen moraine collapsed into South Lhonak Lake, 5,200 m up and some 68 km upstream. Its wave, about 20 m high, breached the moraine dam: about 50 million m³ of water — half the lake — came down the valley.',
      source: 'Sattar et al. 2025, Science, doi:10.1126/science.ads2659',
      durationMs: 11000,
      actions: [{ kind: 'replayUpstream' }],
      highlight: [{ kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'warned',
      kicker: 'The warning existed',
      caption:
        'Pre-event modelling had predicted 25–30 m of water and 6–9 m/s at Chungthang for a large outburst of this lake.',
      source: 'Sattar et al. 2021, Geomorphology, via glacier-hazard-chain.md §G.3',
      durationMs: 8000,
      highlight: [{ kind: 'station', station: 'Chungthang' }, { kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'front',
      kicker: 'The flood on the map',
      caption: 'The modelled front enters the top of the map at {front:Chungthang 2-D domain (north edge)}. Clock on the map: {now}.',
      source: 'Hazard-chain model, median of 27 runs (meta.json)',
      durationMs: 8000,
      camera: { kind: 'scenario', zoom: 0.75, seconds: 2.5 },
      actions: [{ kind: 'release', speed: 300 }],
      until: { kind: 'station', station: DAM },
      maxWaitMs: 120_000,
      highlight: [{ kind: 'stationPin', station: 'Chungthang' }],
    },
    {
      id: 'dam',
      kicker: '≈ 00:30 IST, 4 Oct',
      caption:
        'The flood reached Chungthang around 00:30, about two and a quarter hours after the collapse, and destroyed the dam. The terrain predates it: neither the dam nor its reservoir is in the elevation model.',
      source: 'Sattar et al. 2025, Science; meta.json',
      durationMs: 10000,
      camera: { kind: 'station', station: DAM, distance: 2200, pitch: 0.7, seconds: 2.5, orbitDeg: 10 },
      actions: [{ kind: 'play' }],
      highlight: [{ kind: 'stationPin', station: DAM, label: 'Teesta-III dam' }, { kind: 'station', station: DAM }],
    },
    {
      id: 'honest',
      kicker: 'What the model gets wrong',
      caption:
        'The model is early: its front reaches Chungthang at {front:Chungthang}, against about 00:30 observed. No gauge survived, and the published peak reconstructions here disagree by a factor of two — 7,355 to 14,673 m³/s.',
      source: 'meta.json; Natural Hazards 121 (2025)',
      durationMs: 11000,
      camera: { kind: 'scenario', seconds: 2.5 },
      actions: [{ kind: 'waterView', mode: 'arrival' }],
      highlight: [{ kind: 'station', station: 'Chungthang' }, { kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'end',
      kicker: 'Deluge',
      caption:
        'The outburst, the valley routing and the 2-D flood all ran in this browser tab, offline. Try a sensor upstream under Hazard chain → Early warning.',
      source: 'README.md',
      durationMs: 7000,
      actions: [{ kind: 'panel', section: 'chain' }],
    },
  ],
};

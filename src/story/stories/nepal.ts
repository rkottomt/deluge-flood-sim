/**
 * Nepal, 26 August 2026: the Langtang Lirung avalanche, the 09:15 SMS, the front down the valley timeline, and the
 * Betrawati bridge. Facts: public/presets/nepal/meta.json (description and hazardChain.observations, which cite
 * NDRRMA Situation Report #01, DHM and the YAE/KU rapid report) and BUSINESS.md §4.3 (the Early warning designer's
 * lead times). Modelled front times are read live ({front:…}), never typed in.
 */
import type { Story } from '../types';

const BETRAWATI = 'Betrawati';

export const NEPAL_STORY: Story = {
  id: 'nepal-2026',
  preset: 'nepal',
  title: 'Forty-three minutes to Betrawati',
  subtitle: 'Langtang Lirung avalanche · Trishuli valley, Nepal · 26 August 2026',
  summary: 'An avalanche at 08:37, the first SMS at 09:15, and the bridge that was Rasuwa’s only road: what warning the valley had, and what a sensor would buy.',
  beats: [
    {
      id: 'betrawati',
      kicker: 'Betrawati, Nepal · 26 Aug 2026',
      caption:
        'Betrawati stands where the Phalakhu Khola meets the Trishuli. Its bridge carried the Pasang Lhamu Highway — the only road into Rasuwa district.',
      source: 'Scenario description, presets/nepal/meta.json',
      durationMs: 7000,
      camera: { kind: 'scenario', seconds: 2, orbitDeg: 6 },
      actions: [{ kind: 'reset' }, { kind: 'waterView', mode: 'default' }],
    },
    {
      id: 'avalanche',
      kicker: '08:37 NPT',
      caption:
        'At 8:37 am rock and glacier ice broke from the north face of Langtang Lirung and fell about 1,200 m into the Lhende Khola. A debris flood started down the Bhote Koshi toward the Trishuli.',
      source: 'NDRRMA Situation Report #01 (1 Sep 2026), via meta.json',
      durationMs: 9000,
      actions: [{ kind: 'replayUpstream' }],
      highlight: [{ kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'border',
      kicker: '≈ 08:40 NPT',
      caption:
        'About three minutes after the seismic signal the flood was at Rasuwagadhi, on the border. Downstream, the DHM gauge at Syafrubesi stopped transmitting at 08:50 and was washed away.',
      source: 'NDRRMA SitRep #01; YAE/KU rapid report; DHM FFD technical report (27 Aug 2026)',
      durationMs: 8000,
      highlight: [{ kind: 'station', station: 'Rasuwagadhi' }, { kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'sms',
      kicker: '09:15 NPT',
      caption:
        'The first SMS alerts went out at 09:15, 38 minutes after the avalanche. On the model’s own times the water had already passed every place from Rasuwagadhi down to the Chilime powerhouse.',
      source: 'BUSINESS.md §4.3; glacier-hazard-chain.md §E',
      durationMs: 9000,
      highlight: [{ kind: 'station', station: 'Chilime HEP powerhouse' }, { kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'front',
      kicker: 'The flood on the map',
      caption:
        'The modelled front enters the top of the map at {front:Betrawati 2-D domain (north edge)} and runs down the Trishuli to Betrawati. Clock on the map: {now}.',
      source: 'Hazard-chain model, median of 9 runs (meta.json)',
      durationMs: 8000,
      camera: { kind: 'scenario', zoom: 0.75, seconds: 2.5 },
      actions: [{ kind: 'release', speed: 300 }],
      until: { kind: 'station', station: BETRAWATI },
      maxWaitMs: 120_000,
      highlight: [{ kind: 'stationPin', station: BETRAWATI }],
    },
    {
      id: 'bridge',
      kicker: 'Betrawati',
      caption:
        'By the official account the flood reached Betrawati around 9:20 am, minutes after the first SMS, and took the bridge with it. The gauge here (danger level 5 m) last read 3.55 m before it was swept away.',
      source: 'NDRRMA SitRep #01; DHM station 447',
      durationMs: 10000,
      camera: { kind: 'station', station: BETRAWATI, distance: 1900, pitch: 0.72, seconds: 2.5, orbitDeg: 10 },
      actions: [{ kind: 'play' }],
      highlight: [{ kind: 'stationPin', station: BETRAWATI, label: 'Betrawati bridge' }, { kind: 'station', station: BETRAWATI }],
    },
    {
      id: 'lead',
      kicker: 'The lead-time lesson',
      caption:
        'Minutes decide it. On the model’s clock, one automated gauge with SMS at Rasuwagadhi would have warned Betrawati about 19 minutes earlier than the 09:15 alert; the best single sensor site, about 30 minutes earlier.',
      source: 'Early warning designer, BUSINESS.md §4.3',
      durationMs: 11000,
      camera: { kind: 'scenario', seconds: 2.5 },
      actions: [{ kind: 'waterView', mode: 'arrival' }],
      highlight: [{ kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'honest',
      kicker: 'What the model gets wrong',
      caption:
        'The model is late: its front reaches Betrawati at {front:Betrawati}, against about 09:20 reported (09:00 in another reconstruction). That gap is the model’s error — a 30 m elevation model, an assumed boulder size — so read lead times as differences, not absolute minutes.',
      source: 'meta.json description; README, Glacier hazards',
      durationMs: 12000,
      highlight: [{ kind: 'station', station: BETRAWATI }, { kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'end',
      kicker: 'Deluge',
      caption:
        'The valley routing and the 2-D flood both ran in this browser tab, offline, with no AI model in it. Place your own sensor under Hazard chain → Early warning.',
      source: 'README.md',
      durationMs: 7000,
      actions: [{ kind: 'panel', section: 'chain' }],
    },
  ],
};

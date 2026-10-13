/**
 * Uttarakhand, 7 February 2021: the Ronti Peak collapse becomes a debris flow through two hydropower projects. Facts:
 * public/presets/chamoli/meta.json (description and observations, citing Shugar et al. 2021 and Cook et al. 2021) and
 * docs/research/glacier-hazard-chain.md §E and §G.4 (the warning-time estimate). As in the preset itself, casualty
 * figures are kept off screen.
 */
import type { Story } from '../types';

const BARRAGE = 'Tapovan-Vishnugad HEP barrage (under construction)';

export const CHAMOLI_STORY: Story = {
  id: 'chamoli-2021',
  preset: 'chamoli',
  title: 'A quarter of an hour',
  subtitle: 'Ronti Peak debris flow · Raini–Tapovan, Uttarakhand · 7 February 2021',
  summary: 'Rock and ice from Ronti Peak become a debris flow that reaches two hydropower projects within minutes: how much warning the workers could have had.',
  beats: [
    {
      id: 'raini',
      kicker: 'Uttarakhand · 7 Feb 2021',
      caption:
        'Raini stands where the Rishiganga meets the Dhauliganga, and the 13.2 MW Rishiganga plant stood beside it. Six kilometres downstream, at Tapovan, the barrage of the 520 MW Tapovan-Vishnugad project was being built.',
      source: 'Shugar et al. 2021, Science; presets/chamoli/meta.json',
      durationMs: 9000,
      camera: { kind: 'scenario', seconds: 2, orbitDeg: 6 },
      actions: [{ kind: 'reset' }, { kind: 'waterView', mode: 'default' }],
    },
    {
      id: 'collapse',
      kicker: '10:21 IST',
      caption:
        'About 27 million m³ of rock and glacier ice broke from the north face of Ronti Peak, 5,500 m up. Its ice melted on the way down, and the avalanche became a debris flow running down the Ronti Gad and the Rishiganga at about 25 m/s.',
      source: 'Shugar et al. 2021, Science 373:300–306',
      durationMs: 10000,
      actions: [{ kind: 'replayUpstream' }],
      highlight: [{ kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'front',
      kicker: 'The flow on the map',
      caption: 'The modelled flow enters the east edge of the map at {front:Raini–Tapovan 2-D domain (east edge)}, past the Rishiganga plant. Clock on the map: {now}.',
      source: 'Hazard-chain model, median of 9 runs (meta.json)',
      durationMs: 8000,
      camera: { kind: 'scenario', zoom: 0.75, seconds: 2.5 },
      actions: [{ kind: 'release', speed: 300 }],
      until: { kind: 'station', station: BARRAGE },
      maxWaitMs: 120_000,
      highlight: [{ kind: 'stationPin', station: 'Rishiganga HEP, Raini (position approximate)', label: 'Rishiganga plant' }],
    },
    {
      id: 'tapovan',
      kicker: '≈ 10:36 IST',
      caption:
        'Seismic records put the flow at the Tapovan barrage about a quarter of an hour after the collapse. Most of the people it took that morning were workers at the two hydropower projects, many of them in the Tapovan tunnels.',
      source: 'Cook et al. 2021, Science 374:87–92; Shugar et al. 2021',
      durationMs: 11000,
      camera: { kind: 'station', station: BARRAGE, distance: 2400, pitch: 0.72, seconds: 2.5, orbitDeg: 10 },
      actions: [{ kind: 'play' }],
      highlight: [{ kind: 'stationPin', station: BARRAGE, label: 'Tapovan barrage' }, { kind: 'station', station: BARRAGE }],
    },
    {
      id: 'warning',
      kicker: 'Warning time',
      caption:
        'Shugar et al. estimated 6–10 minutes of possible warning at Tapovan — up to 20 minutes with a sensor near the source. For every plant below a glacier the question is the same: how many minutes, and who receives them.',
      source: 'Shugar et al. 2021, via glacier-hazard-chain.md §E, §G.4',
      durationMs: 11000,
      camera: { kind: 'scenario', seconds: 2.5 },
      actions: [{ kind: 'waterView', mode: 'arrival' }],
      highlight: [{ kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'honest',
      kicker: 'What the model gets wrong',
      caption:
        'The model is late: its front reaches the barrage at {front:Tapovan-Vishnugad HEP barrage (under construction)}, against about 10:36 observed. Inside the map the flow carries no sediment, so the mud it laid down at Tapovan is not here.',
      source: 'meta.json description',
      durationMs: 11000,
      highlight: [{ kind: 'station', station: BARRAGE }, { kind: 'ui', target: 'timeline' }],
    },
    {
      id: 'end',
      kicker: 'Deluge',
      caption:
        'The debris flow’s routing and the 2-D flood ran in this browser tab, offline. Place a sensor near the source under Hazard chain → Early warning and read the minutes it buys.',
      source: 'README.md',
      durationMs: 7000,
      actions: [{ kind: 'panel', section: 'chain' }],
    },
  ],
};

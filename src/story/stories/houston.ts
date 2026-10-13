/**
 * Houston, Hurricane Harvey, August 2017: the rain falls on a flat city, and a portfolio counts its loss. Facts:
 * public/presets/houston/meta.json (rain, the Buffalo Bayou crest) and BUSINESS.md §4.2 (the fictional demo
 * portfolio and its reference run, stated as such).
 */
import type { Story } from '../types';

export const HOUSTON_STORY: Story = {
  id: 'houston-harvey',
  preset: 'houston',
  title: 'The city floods from above',
  subtitle: 'Hurricane Harvey · Houston · August 2017',
  summary: 'Harvey’s worst hour of rain on a dead-flat city, Buffalo Bayou at its crest, and a 19-asset portfolio counting its loss as the water rises.',
  beats: [
    {
      id: 'plain',
      kicker: 'Houston · August 2017',
      caption:
        'Houston is built on a dead-flat coastal plain drained by slow bayous. Hurricane Harvey stalled over the city and dropped more than 40 inches of rain in four days over much of Harris County.',
      source: 'Scenario description, presets/houston/meta.json',
      durationMs: 8000,
      camera: { kind: 'scenario', seconds: 2, orbitDeg: 8 },
      actions: [{ kind: 'reset' }, { kind: 'rain', mmPerHour: 0 }, { kind: 'waterView', mode: 'realistic' }],
    },
    {
      id: 'rain',
      kicker: 'Harvey’s worst hour',
      caption:
        'Rain bands trained over the same ground long enough to put 6.8 inches on southeast Houston in a single hour. That is what falls here now — 173 mm an hour over the whole map. Simulated so far: {simtime}.',
      source: 'meta.json',
      durationMs: 10000,
      actions: [{ kind: 'rain', mmPerHour: 173 }, { kind: 'waterView', mode: 'depth' }, { kind: 'play', speed: 300 }],
    },
    {
      id: 'bayou',
      kicker: 'Buffalo Bayou',
      caption:
        'Buffalo Bayou crested at 41.90 ft at Shepherd Drive on 28 August, carrying 32,600 ft³/s. Its flood stays in its trench, 12 m below the streets — so the rain, with nowhere to drain, rises in the streets instead.',
      source: 'USGS Shepherd Dr gauge, via meta.json',
      durationMs: 11000,
      camera: { kind: 'scenario', zoom: 0.6, seconds: 2.5, orbitDeg: 10 },
    },
    {
      id: 'portfolio',
      kicker: 'A portfolio under the rain',
      caption:
        'A fictional 19-asset portfolio — warehouses, a data centre, stores, apartments, a clinic, offices — each pinned to a real footprint. Impact & loss reads depth, loss and downtime per asset as the rain falls.',
      source: 'public/demo/houston-portfolio.csv (fictional); BUSINESS.md §4.2',
      durationMs: 11000,
      camera: { kind: 'scenario', seconds: 2.5 },
      actions: [{ kind: 'useCase', id: 'portfolio' }],
      highlight: [{ kind: 'ui', target: 'impact' }],
    },
    {
      id: 'loss',
      kicker: 'After one simulated hour',
      caption:
        'In the reference run, after one simulated hour: 15 of 19 assets reached, $17.3 M of physical loss (damage-curve range $8.9–26.0 M) and $7.9 M of business interruption. Dry is not open: the data centre stays dry, but its access road is cut.',
      source: 'BUSINESS.md §4.2, reference run',
      durationMs: 13000,
      highlight: [{ kind: 'ui', target: 'impact' }],
    },
    {
      id: 'limits',
      kicker: 'Read it honestly',
      caption:
        'Damage uses the JRC global depth–damage curves, and the range shown is only their spread. Screening, not a catastrophe model — and nothing you load leaves this browser tab.',
      source: 'Use cases brief, limits; BUSINESS.md',
      durationMs: 9000,
    },
  ],
};

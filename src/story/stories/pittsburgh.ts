/**
 * Pittsburgh, 18 March 1936: the St. Patrick's Day crest, an evacuation, and the North Shore levee — what a wall
 * would have saved. Facts: public/presets/pittsburgh/meta.json (gauge, crests, the demo levee) and DEMO.md (the NWS
 * impact statements in Q1, the routing rule in Q10, the protected-land estimate in Q9, the limits in §6). The land the
 * wall keeps dry is read live ({kept}); the solver's own depths are not typed into captions.
 */
import type { Story } from '../types';

export const PITTSBURGH_STORY: Story = {
  id: 'pittsburgh-1936',
  preset: 'pittsburgh',
  title: 'What a wall would have saved',
  subtitle: 'St. Patrick’s Day flood · Pittsburgh · 18 March 1936',
  summary: 'The river to its 1936 record of 46 ft, a route out of downtown, then a 2.4 km floodwall on the North Shore and the land it keeps dry.',
  beats: [
    {
      id: 'point',
      kicker: 'Pittsburgh · the Point',
      caption:
        'Downtown Pittsburgh sits on the Point, where the Allegheny and the Monongahela meet to form the Ohio. Normal pool is about 16 ft on the Point gauge; flood stage is 22 ft.',
      source: 'NWS / USGS gauge 03085152, via presets/pittsburgh/meta.json',
      durationMs: 8000,
      camera: { kind: 'scenario', seconds: 2, orbitDeg: 8 },
      actions: [{ kind: 'reset' }, { kind: 'waterView', mode: 'realistic' }, { kind: 'play', speed: 60 }],
    },
    {
      id: 'record',
      kicker: '18 March 1936',
      caption:
        'The St. Patrick’s Day flood: snowmelt and heavy rain drove the river to a record 46 ft. On the gauge now: {stage}. The rise is a time-lapse; the flood after it is solved at real speed.',
      source: 'meta.json; DEMO.md Q8',
      durationMs: 9000,
      actions: [{ kind: 'raiseStage', feet: 46 }, { kind: 'play', speed: 300 }],
      until: { kind: 'stageArrived' },
      maxWaitMs: 90_000,
    },
    {
      id: 'under',
      kicker: '46 ft at the Point',
      caption:
        'The Point, the North Shore stadiums and the Strip District go under. The National Weather Service’s impact statement for this crest: up to 15 ft of water in the Golden Triangle.',
      source: 'NWS impact statements, Point gauge (PTTP1); DEMO.md Q1',
      durationMs: 10000,
      camera: { kind: 'scenario', zoom: 0.7, yawOffset: -0.25, seconds: 2.5, orbitDeg: 8 },
      actions: [{ kind: 'waterView', mode: 'depth' }],
    },
    {
      id: 'evacuate',
      kicker: 'Getting out',
      caption:
        'Census roads: the fastest drive from downtown to the nearest dry shelter, avoiding any road under more than 30 cm of water — roughly where cars float — and re-planning as the water moves.',
      source: 'DEMO.md Q10; Census TIGER/Line roads',
      durationMs: 9000,
      actions: [{ kind: 'evacuate' }],
      until: { kind: 'route' },
      maxWaitMs: 15_000,
      highlight: [{ kind: 'ui', target: 'route' }],
    },
    {
      id: 'levee',
      kicker: 'What a wall would have saved',
      caption:
        'The planner’s question: a 2.4 km floodwall along the North Shore, its top about a metre above the 1936 record. The flood is reset and the river rises again with the wall in place.',
      source: 'Scenario demo levee, meta.json; DEMO.md beat 4',
      durationMs: 9000,
      camera: { kind: 'levee', seconds: 2 },
      actions: [{ kind: 'waterView', mode: 'realistic' }, { kind: 'levee' }],
      until: { kind: 'protection' },
      maxWaitMs: 90_000,
    },
    {
      id: 'kept',
      kicker: 'Kept dry',
      caption:
        'Green is land that would be under water at this level without the wall: {kept}, recomputed from the live water about once a second. Gauge: {stage}.',
      source: 'Protected-land estimate, DEMO.md Q9',
      durationMs: 12000,
      until: { kind: 'stageArrived' },
      maxWaitMs: 90_000,
    },
    {
      id: 'limits',
      kicker: 'Read it honestly',
      caption:
        'Bare-earth terrain: no storm drains, underpasses or buildings in the elevation model, and no calibration against a measured flood. For exploring and explaining — not for engineering decisions.',
      source: 'DEMO.md §6, Known limitations',
      durationMs: 9000,
      camera: { kind: 'scenario', seconds: 2.5 },
    },
  ],
};

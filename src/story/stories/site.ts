/**
 * "Should we build here?" — a developer's site due diligence on Pittsburgh's two demo parcels (the site use case,
 * src/ui/useCaseDefs.ts DEMO_SITES_PARAM): the Site check sweep, the verdict, the way out, an indicative floor level,
 * and the pick. Facts: the parcels and the building from useCaseDefs.ts and BUSINESS.md §4.1; the ladder's sources
 * from src/loss/ladders.ts; the limits from DEMO.md §6 and the Use cases brief.
 *
 * Every number the sweep produces — depths, the egress times, the EAL, the floor levels, the loss — is read live from
 * Site check through the {site:…} tokens: the verdict on screen is the one this run computed, in the panel's own words.
 */
import type { Story } from '../types';

/** Where the demo parcels are (DEMO_SITES_PARAM: A's pin, B's pin); Site check's own overlay marks and names them. */
const A = { lat: 40.446, lon: -80.0124 };
const B = { lat: 40.4525, lon: -80.0045 };

export const SITE_STORY: Story = {
  id: 'site-decision',
  preset: 'pittsburgh',
  group: 'business',
  title: 'Should we build here?',
  subtitle: 'Site due diligence · Pittsburgh · two candidate parcels',
  summary: 'Two candidate parcels for one apartment building: a sweep through the river’s flood levels, the verdict, the way out, an indicative floor level — and which parcel to buy.',
  beats: [
    {
      id: 'brief',
      kicker: 'Two candidate parcels · Pittsburgh',
      caption:
        'A developer plans a 6-storey apartment building, $45 M to replace, and has two candidate parcels: A, a surface lot on the North Shore between the stadiums, and B, the same building on the higher ground of Allegheny Center, 700 m inland. Fictional parcels on real terrain.',
      source: 'Use cases → Check a site before you build; BUSINESS.md §4.1',
      durationMs: 10000,
      camera: { kind: 'at', lat: 40.4492, lon: -80.0085, distance: 2600, pitch: 0.8, seconds: 2.5, orbitDeg: 6 },
      actions: [{ kind: 'reset' }, { kind: 'waterView', mode: 'realistic' }, { kind: 'demoSites' }],
    },
    {
      id: 'sweep',
      kicker: 'Site check · Run sweep',
      caption:
        'Site check runs both parcels through the Ohio River’s levels at the Point: the NWS flood categories, the 2004 and 1972 crests, FEMA’s 1 % level and the 1936 record. Each level is a full 2-D flood, 30 simulated minutes, run headless at full speed.',
      source: 'Site check sweep; levels from NWS (PTTP1) and FEMA NFHL, src/loss/ladders.ts',
      durationMs: 10000,
      actions: [{ kind: 'panel', section: 'site' }, { kind: 'siteSweep' }],
      highlight: [{ kind: 'ui', target: 'site' }],
    },
    {
      id: 'a-verdict',
      kicker: 'Parcel A · the verdict',
      caption: 'Parcel A, in the panel’s own words: {site:a.reach} {site:a.floor}',
      source: 'Site check verdict, computed on this run',
      durationMs: 11000,
      camera: { kind: 'at', lat: A.lat, lon: A.lon, distance: 1100, pitch: 0.85, seconds: 2.5, orbitDeg: 8 },
      actions: [{ kind: 'panel', section: null }],
    },
    {
      id: 'a-egress',
      kicker: 'Parcel A · getting out',
      caption: '{site:a.egress} A road counts as cut at 0.3 m of water, where cars stop; the route is to the nearest dry shelter on Census roads.',
      source: 'Site check egress; DEMO.md Q10',
      durationMs: 10000,
    },
    {
      id: 'a-eal',
      kicker: 'Parcel A · expected annual loss',
      caption: '{site:a.eal} A return period counts only where a published source gives one; the app does not invent it.',
      source: 'Site check EAL; the Use cases brief',
      durationMs: 10000,
    },
    {
      id: 'a-floor',
      kicker: 'Parcel A · floor level',
      caption:
        'Designed to the FEMA 1 % level, the floor is {site:a.ffe100}. Designed for the worst level that reaches it, the floor is {site:a.ffe}. Indicative, from the model’s water and ASCE 24-14 freeboard.',
      source: 'Site check recommendations (ASCE 24-14 Table 2-1)',
      durationMs: 12000,
      camera: { kind: 'at', lat: A.lat, lon: A.lon, distance: 700, pitch: 0.6, seconds: 2, orbitDeg: 6 },
    },
    {
      id: 'b-verdict',
      kicker: 'Parcel B · Allegheny Center',
      caption: 'Parcel B: {site:b.reach} {site:b.egress}',
      source: 'Site check verdict, computed on this run',
      durationMs: 10000,
      camera: { kind: 'at', lat: B.lat, lon: B.lon, distance: 1100, pitch: 0.85, seconds: 2.5, orbitDeg: 8 },
    },
    {
      id: 'pick',
      kicker: 'The pick',
      caption:
        'Same building, 700 m apart. In the worst level run, B is {site:b.worst}; A takes {site:a.worst}. Parcel B is the safer pick: it needs no higher floor and keeps its way out.',
      source: 'Site check, both parcels, this run; BUSINESS.md §4.1',
      durationMs: 11000,
      camera: { kind: 'at', lat: 40.4492, lon: -80.0085, distance: 2400, pitch: 0.75, seconds: 2.5 },
    },
    {
      id: 'limits',
      kicker: 'Read it honestly',
      caption:
        'Bare-earth terrain, one 2-D run per level, return periods only where a source publishes them. Due-diligence screening: the questions to take to a surveyor and an engineer, not their answers.',
      source: 'DEMO.md §6; Use cases brief, limits',
      durationMs: 8000,
      actions: [{ kind: 'panel', section: 'site' }],
      highlight: [{ kind: 'ui', target: 'site' }],
    },
  ],
};

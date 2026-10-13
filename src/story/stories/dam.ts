/**
 * "A dam upstream" — a dam owner's screen for the county below: Edenville Dam, Michigan (NID MI00549, which failed on
 * 19 May 2020), breached flood-induced on the valley below it as the dam-breach use case does (src/ui/damView.ts):
 * the band of eight published breach relations, the wave on the real valley, arrival times along the flow path with
 * their spread, and what to tell the county. Facts: BUSINESS.md §4.5 and README.md (Dam breaches); the relations and
 * their score from src/dams/breachRelations.ts.
 *
 * The scene is a live area (USGS 3DEP elevation over the internet, like the use case); the dam index ships with the
 * app. Every number — the NID's, the band, the hydrograph, the arrivals — is read live through {dam:…} and {arrival:…}.
 */
import type { Story } from '../types';

/** The NID point of Edenville Dam (public/dams/nid-index.bin). */
const DAM = { lat: 43.81667, lon: -84.38833 };

export const DAM_STORY: Story = {
  id: 'dam-upstream',
  dam: { nid: 'MI00549', breach: 'flood' },
  group: 'business',
  title: 'A dam upstream',
  subtitle: 'Dam-breach screening · Edenville Dam, Michigan',
  summary: 'An NID dam breached on the real valley below it: the band of eight published breach relations, the wave, arrival times downstream with their spread — and what to tell the county. Needs the internet for the terrain.',
  beats: [
    {
      id: 'dam',
      kicker: 'Edenville Dam · Michigan',
      caption:
        '{dam:name} (NID {dam:nid}) held {dam:storage} behind {dam:height} of dam; the National Inventory of Dams rates its hazard {dam:hazard}. It failed on 19 May 2020. The question for any such dam’s owner, and the county below: if it failed, when would the water arrive?',
      source: 'USACE National Inventory of Dams (baked index); BUSINESS.md §4.5',
      durationMs: 13000,
      actions: [{ kind: 'reset' }, { kind: 'waterView', mode: 'arrival' }],
      highlight: [{ kind: 'pin', lat: DAM.lat, lon: DAM.lon, label: 'Edenville Dam' }],
    },
    {
      id: 'band',
      kicker: 'Eight relations, one band',
      caption:
        'A {dam:mode}. Eight published breach relations put the peak outflow at {dam:band} for this dam. The map runs the central case, {dam:central}: of the eight, the one that best reproduced 21 documented failures.',
      source: 'Breach relations scored on Wahl 1998 (USBR), src/dams/breachRelations.ts; README.md',
      durationMs: 14000,
      highlight: [{ kind: 'pin', lat: DAM.lat, lon: DAM.lon, label: 'Edenville Dam' }],
    },
    {
      id: 'wave',
      kicker: 'The wave down the valley',
      caption:
        'The breach hydrograph, {dam:volume} in all, enters at the toe of the dam and runs down the real valley. The colour is when the water came. Simulated since the breach began: {simtime}.',
      source: 'Dam-breach use case: inflow at the toe, 2-D flood on USGS 3DEP',
      durationMs: 12000,
      camera: { kind: 'frame', seconds: 2 },
      actions: [{ kind: 'play', speed: 300 }],
      until: { kind: 'simTime', t: 5400 },
      maxWaitMs: 120_000,
    },
    {
      id: 'arrivals',
      kicker: 'Read arrivals',
      caption:
        'Along the flow path below the dam, the wave arrives at 1 km in {arrival:1}, at 3 km in {arrival:3}, at 5 km in {arrival:5}. Each spread is this run rescaled to the band’s high and low peaks — not simulated.',
      source: 'Dam view → Read arrivals (kinematic-wave rescaling, travel time ∝ peak^−0.4)',
      durationMs: 14000,
      actions: [{ kind: 'readArrivals' }],
    },
    {
      id: 'county',
      kicker: 'What to tell the county',
      caption:
        'For the county: water at 2 km in {arrival:2}, at 8 km in {arrival:8}. Plan on the early end of each range — the high case belongs in any plan. A first arrival-time table for a tabletop exercise, in a minute.',
      source: 'BUSINESS.md §4.5',
      durationMs: 14000,
      camera: { kind: 'frame', seconds: 2 },
    },
    {
      id: 'limits',
      kicker: 'What this is not',
      caption:
        'Not an Emergency Action Plan inundation map: the reservoir is two NID numbers, not a survey; spillways, gates and downstream dams are not modelled. It is the screen that says which dams need the full study first.',
      source: 'Dam-breach caveats in the panel; BUSINESS.md §4.5',
      durationMs: 11000,
    },
  ],
};

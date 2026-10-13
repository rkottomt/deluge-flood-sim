/**
 * "Is the levee worth it?" — the North Shore demo levee as an investment: Compare designs runs the baseline and the
 * wall through FEMA's 1 % level and the 1936 record (500-year: the user's assumption, labelled as such, as in BUSINESS.md
 * §4.1), then the benefit–cost view gives the avoided EAL, the BCR with its range and the break-even cost. Facts: the
 * levee from public/presets/pittsburgh/meta.json (as in the Pittsburgh story), the discount-rate and useful-life
 * defaults from README.md (Benefit–cost) and src/loss/bca.ts.
 *
 * Every money figure and ratio is read live from the comparison through the {bca:…} tokens; the story types none.
 */
import type { Story } from '../types';

export const LEVEE_STORY: Story = {
  id: 'levee-bca',
  preset: 'pittsburgh',
  group: 'business',
  title: 'Is the levee worth it?',
  subtitle: 'Benefit–cost · Pittsburgh · the North Shore floodwall',
  summary: 'A 2.4 km floodwall on Pittsburgh’s North Shore as an investment: what it saves a year, what it costs, its benefit–cost ratio with the range around it, and the most it can cost to pay.',
  beats: [
    {
      id: 'question',
      kicker: 'North Shore · Pittsburgh',
      caption:
        'A floodwall keeps water out; the question for whoever pays is whether it pays back. The design: the scenario’s demo levee, 2.4 km along the North Shore, its top about a metre above the 1936 record.',
      source: 'Scenario demo levee, presets/pittsburgh/meta.json',
      durationMs: 10000,
      camera: { kind: 'levee', seconds: 2.5, orbitDeg: 8 },
      actions: [{ kind: 'reset' }, { kind: 'waterView', mode: 'realistic' }],
    },
    {
      id: 'build',
      kicker: 'The design on the map',
      caption: 'The wall goes up and the river rises to the 1936 record behind it. Green is land it keeps dry: {kept}. Gauge: {stage}.',
      source: 'Try it → Build a levee; protected-land estimate, DEMO.md Q9',
      durationMs: 11000,
      actions: [{ kind: 'levee' }],
      until: { kind: 'stageArrived' },
      maxWaitMs: 90_000,
    },
    {
      id: 'compare',
      kicker: 'Compare designs',
      caption:
        'Compare designs runs the river without the wall and with it, headless, through two levels: FEMA’s 1 % level (100-year, published) and the 1936 record, which has no published return period — we type 500 years, an assumption the app labels as ours.',
      source: 'Compare designs; BUSINESS.md §4.1',
      durationMs: 13000,
      actions: [
        { kind: 'panel', section: 'designs' },
        { kind: 'compare', levels: ['rp100', 'record1936'], userRp: [{ level: 'record1936', years: 500 }] },
      ],
      highlight: [{ kind: 'ui', target: 'designs' }],
    },
    {
      id: 'benefit',
      kicker: 'What it saves, what it costs',
      caption:
        'Against the river without it, the wall avoids {bca:deltaeal} in expected annual loss — the range from the damage curves and the tail beyond the rarest level. Its cost at planning unit rates: {bca:cost}.',
      source: 'Compare designs → Benefit–cost, this run',
      durationMs: 13000,
      highlight: [{ kind: 'ui', target: 'designs' }],
    },
    {
      id: 'bcr',
      kicker: 'Benefit–cost ratio',
      caption: 'At {bca:rate} over {bca:life}, the BCR is {bca:bcr}, with a range of {bca:range}. The panel’s verdict: {bca:verdict}. A BCR is never shown without its range.',
      source: 'Compare designs → Benefit–cost; 7 %: OMB Circular A-94, the FEMA BCA Toolkit default',
      durationMs: 13000,
      highlight: [{ kind: 'ui', target: 'designs' }],
    },
    {
      id: 'breakeven',
      kicker: 'Break-even',
      caption:
        'The most it can cost and still pay at the central estimate: {bca:breakeven}, against an estimate of {bca:cost}. That is the number to take to the engineers pricing it.',
      source: 'Compare designs → Break-even construction cost (BCR = 1)',
      durationMs: 12000,
      camera: { kind: 'levee', seconds: 2.5, orbitDeg: 8 },
      highlight: [{ kind: 'ui', target: 'designs' }],
    },
    {
      id: 'limits',
      kicker: 'Read it honestly',
      caption:
        'Two levels, one return period assumed; bare-earth terrain; planning unit costs, not quotes. An Uncertainty ensemble widens the range further. Not a FEMA-accepted BCA: the report’s appendix lists the Toolkit inputs for an engineer to check.',
      source: 'README.md, Benefit–cost; BUSINESS.md §8',
      durationMs: 11000,
      camera: { kind: 'scenario', seconds: 2.5 },
    },
  ],
};

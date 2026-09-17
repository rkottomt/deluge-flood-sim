/**
 * "How it works" — the explainer for visitors. Plain language first, then the shallow-water equations typeset
 * in HTML/CSS, the four stability ingredients, the per-substep GPU pipeline diagram (two compute passes, as
 * dispatched by src/sim/Solver.ts), data sources, and the "Break it" stability-demo toggle.
 *
 * Keep the text in sync with src/sim: the scheme (shaders/momentum.ts — local inertial + upwind advection,
 * θ-smoothing, semi-implicit friction), the Courant limit (constants.ts robustCflMax, √θ) and the passes.
 */
import { h, fragment, setText, toggleClass, type UIContext } from './dom';
import { icon, iconMarkup } from './icons';
import { createModal, type Modal } from './modal';
import { fmtNum, siParts } from './format';
import { BREAK_TIME_SCALE, startBreakDemo, stopBreakDemo } from './stabilityDemo';

// ─── Tiny math typesetting helpers (static, trusted markup) ─────────────────────────────────────
const v = (s: string) => `<i class="m-v">${s}</i>`;
const sub = (base: string, s: string) => `${base}<sub class="m-sub">${s}</sub>`;
const sup = (base: string, s: string) => `${base}<sup class="m-sup">${s}</sup>`;
const supsub = (base: string, up: string, down: string) =>
  `${base}<span class="m-supsub"><sup class="m-sup">${up}</sup><sub class="m-sub">${down}</sub></span>`;
const frac = (num: string, den: string, cls = '') => `<span class="m-frac ${cls}"><span class="m-num">${num}</span><span class="m-den">${den}</span></span>`;
const pd = (num: string, den: string) => frac(`∂${num}`, `∂${den}`);
const op = (s: string) => `<span class="m-op">${s}</span>`;
const paren = (inner: string, big = true) =>
  `<span class="m-paren${big ? ' m-big' : ''}">(</span>${inner}<span class="m-paren${big ? ' m-big' : ''}">)</span>`;
const sqrt = (inner: string) => `<span class="m-sqrt"><span class="m-radic">√</span><span class="m-radicand">${inner}</span></span>`;
// The inner span keeps an inline formatting context so <sub>/<sup> vertical-align still applies.
const term = (inner: string, note: string, tone = '') =>
  `<span class="m-term ${tone}"><span class="m-term-body"><span>${inner}</span></span><span class="m-note">${note}</span></span>`;
const abs = (inner: string) => `<span class="m-abs">|</span>${inner}<span class="m-abs">|</span>`;
const rm = (s: string) => `<span class="m-rm">${s}</span>`;
const eq = (markup: string, cls = '') => fragment<HTMLElement>(`<div class="m-eq ${cls}"><span class="m-row">${markup}</span></div>`);

/** SVG subscript: base + lowered, smaller tspan (Unicode subscript letters are missing from most fonts). */
const svgSub = (base: string, s: string) => `${base}<tspan baseline-shift="sub" font-size="8.5">${s}</tspan>`;
/** Numbered circular badge for a pipeline box, centered at (cx, cy). */
const svgBadge = (cx: number, cy: number, n: number) =>
  `<g class="dl-pipe-badge"><circle cx="${cx}" cy="${cy}" r="8.5"/><text x="${cx}" y="${cy + 3.6}" text-anchor="middle">${n}</text></g>`;

const h_ = v('h');
const g = v('g');
const n = v('n');
const qx = sub(v('q'), v('x'));
const qy = sub(v('q'), v('y'));
const hf = sub(v('h'), v('f'));
const dt = `${rm('Δ')}${v('t')}`;
const dx = `${rm('Δ')}${v('x')}`;
const eta = v('η');
/** Time level of the new flux (not n: that is Manning's roughness). */
const qNew = sup(v('q'), rm('new'));

export function createHowItWorks(ctx: UIContext): Modal {
  const { store, bind } = ctx;

  // ── Section nav ──
  const sections: Array<[string, string]> = [
    ['plain', 'In plain language'],
    ['equations', 'The equations'],
    ['stability', 'Why it’s hard'],
    ['pipeline', 'GPU pipeline'],
    ['data', 'Data'],
    ['break', 'Break it'],
  ];
  let modal: Modal;
  const chips = new Map<string, HTMLButtonElement>();
  const nav = h(
    'nav',
    { class: 'dl-how-nav', 'aria-label': 'Sections' },
    ...sections.map(([id, text]) => {
      const chip = h(
        'button',
        {
          type: 'button',
          class: `dl-how-chip${id === 'break' ? ' dl-how-chip-danger' : ''}`,
          onclick: () => {
            // scroll-margin-top on the sections keeps titles clear of this sticky nav.
            modal.body.querySelector<HTMLElement>(`[data-how="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        },
        text,
      );
      chips.set(id, chip);
      return chip;
    }),
  );

  const sec = (id: string, kicker: string, title: string, ...body: Array<HTMLElement | string | null>) =>
    h('section', { class: 'dl-how-sec', 'data-how': id }, h('div', { class: 'dl-how-kicker' }, kicker), h('h3', { class: 'dl-how-title' }, title), ...body);

  // ── 1. Plain language ──
  const liveCells = h('b');
  const liveUpdates = h('b');
  const plain = sec(
    'plain',
    '01 · The idea',
    'A million tiny buckets of water, updated all at once',
    h(
      'p',
      { class: 'dl-lead' },
      'Deluge turns real USGS elevation data into a grid of about a million square cells, each a few meters across. Every cell stores how deep its water is; every edge between two cells stores how much water is flowing across it.',
    ),
    h(
      'div',
      { class: 'dl-how-cards' },
      h('div', { class: 'dl-how-card' }, h('span', { class: 'dl-how-card-icon' }, icon('water', 20)), h('b', null, 'Water flows downhill'), h('p', null, 'Flow across each edge speeds up toward the lower water surface — the height of the water, not just the ground.')),
      h('div', { class: 'dl-how-card' }, h('span', { class: 'dl-how-card-icon' }, icon('layers', 20)), h('b', null, 'Friction slows it'), h('p', null, 'One roughness value for the whole map (Manning’s n = 0.035, adjustable under Advanced) drags on the flow; thin sheets of water feel it most.')),
      h('div', { class: 'dl-how-card' }, h('span', { class: 'dl-how-card-icon' }, icon('check', 20)), h('b', null, 'Every drop is counted'), h('p', null, 'A cell’s depth changes by exactly what flows in minus what flows out, plus rain and rivers. Nothing is created or lost.')),
    ),
    h(
      'p',
      null,
      'Each cell only needs its four neighbors, so the whole grid can be updated in parallel by thousands of GPU cores — many times per rendered frame. Right now that is ',
      liveCells,
      ' cells, about ',
      liveUpdates,
      ' cell updates every second, in a browser tab.',
    ),
    h(
      'p',
      null,
      'Raising the river is a time-lapse: in 1936 the Point rose about 21 ft over some 30 hours; Deluge raises it at about 10 ft per simulated minute so you can watch the whole crest in seconds. The flood that follows is solved at its real speed.',
    ),
  );
  bind(
    (s) => {
      const g2 = s.grid;
      if (!g2) return '—|—';
      const cells = g2.nx * g2.ny;
      const perSec = cells * (s.stepInfo?.substeps ?? 0) * (s.paused ? 0 : s.fps);
      const p = siParts(perSec);
      const readable = p.suffix === 'G' ? `${p.num} billion` : p.suffix === 'M' ? `${p.num} million` : p.suffix === 'k' ? `${p.num} thousand` : p.num;
      return `${fmtNum(cells, 0)}|${s.paused || perSec === 0 ? 'many millions of (paused right now)' : readable}`;
    },
    (key) => {
      const [c, u] = key.split('|');
      setText(liveCells, c);
      setText(liveUpdates, u);
    },
  );

  // ── 2. Equations ──
  const massEq = eq(
    `${term(pd(h_, v('t')), 'depth changes…')}${op('+')}${term(`${pd(qx, v('x'))}${op('+')}${pd(qy, v('y'))}`, '…by net outflow…')}${op('=')}${term(`${v('R')}${op('−')}${v('I')}${op('+')}${v('S')}`, '…plus rain − infiltration<br>+ river sources')}`,
    'm-annotated',
  );
  const momEq = eq(
    `${term(pd(qx, v('t')), 'acceleration')}${op('+')}${term(
      `${frac('∂', `∂${v('x')}`)}${paren(`${frac(sup(qx, '2'), h_)}${op('+')}${frac('1', '2')}${g}${sup(h_, '2')}`)}${op('+')}${frac('∂', `∂${v('y')}`)}${paren(frac(`${qx}${qy}`, h_))}`,
      'momentum flux + pressure',
    )}${op('=')}${term(`${op('−')}${g}${h_}${pd(v('z'), v('x'))}`, 'bed slope', 'm-tone-a')}${op('−')}${term(frac(`${g}${sup(n, '2')}${qx}${abs(v('q'))}`, sup(h_, '7/3')), 'Manning friction', 'm-tone-b')}`,
    'm-annotated',
  );
  const schemeEq = eq(
    `${qNew}${op('=')}${frac(
      `${v('q̃')}${op('−')}${dt}${v('A')}${op('−')}${g}${hf}${dt}${frac(`${sub(eta, 'R')}${op('−')}${sub(eta, 'L')}`, dx, 'm-small')}`,
      `1${op('+')}${frac(`${g}${dt}${sup(n, '2')}${abs(v('q'))}`, supsub(v('h'), '7/3', v('f')), 'm-small')}`,
      'm-big-frac',
    )}`,
    'm-display',
  );
  const glossary = h(
    'dl',
    { class: 'dl-glossary' },
    ...(
      [
        [h_, 'water depth (m)'],
        [`${v('q')} = ${v('h')}${v('u')}`, 'flow per meter of width (m²/s)'],
        [v('z'), 'ground + walls elevation (m)'],
        [`${eta} = ${v('z')} + ${v('h')}`, 'water surface elevation'],
        [g, 'gravity, 9.81 m/s²'],
        [n, 'Manning roughness'],
        [`${v('R')}, ${v('I')}, ${v('S')}`, 'rain, infiltration, sources'],
        [v('q̃'), 'lightly smoothed previous flux (θ-weighting, θ = 0.8)'],
        [v('A'), 'convective acceleration ∂(qu)/∂x + ∂(qv)/∂y, first-order upwind'],
        [`${hf}`, 'flow depth at the cell face'],
      ] as Array<[string, string]>
    ).flatMap(([sym, text]) => [fragment(`<dt>${sym}</dt>`), h('dd', null, text)]),
  );
  const equations = sec(
    'equations',
    '02 · The physics',
    'The 2-D shallow-water equations',
    h('p', null, 'When water is much wider than it is deep — rivers, streets, floodplains — its motion is governed by conservation of mass and momentum, averaged over depth:'),
    h('div', { class: 'dl-eq-block' }, h('div', { class: 'dl-eq-tag' }, 'Mass'), massEq),
    h('div', { class: 'dl-eq-block' }, h('div', { class: 'dl-eq-tag' }, 'Momentum (x; y is symmetric)'), momEq),
    h(
      'p',
      null,
      'Deluge starts from the ',
      h('b', null, 'local-inertial'),
      ' scheme behind production flood-inundation models (LISFLOOD-FP class; Bates et al. 2010, de Almeida et al. 2012) and keeps the ',
      h('b', null, 'convective acceleration'),
      ' term A that the pure local-inertial model drops — without it a dam-break front advances at only about half its true speed. On a staggered grid, the flux across each cell face is updated as:',
    ),
    h('div', { class: 'dl-eq-block dl-eq-hero' }, schemeEq),
    glossary,
  );

  // ── 3. Stability ingredients ──
  const ingredient = (num: string, title: string, formula: string, why: string | Node, detail: string) =>
    h(
      'div',
      { class: 'dl-ingredient' },
      h('div', { class: 'dl-ing-head' }, h('span', { class: 'dl-ing-num' }, num), h('b', null, title)),
      eq(formula, 'm-inline'),
      h('p', { class: 'dl-ing-why' }, h('span', { class: 'dl-why' }, 'Why: '), why),
      h('p', { class: 'dl-ing-detail' }, detail),
    );
  const stability = sec(
    'stability',
    '03 · The hard part',
    'Four ingredients that keep it stable at interactive speed',
    h(
      'p',
      null,
      'One explicit update has to survive 6 m-deep river channels, centimetre-thin films on steep streets and walls one cell wide — in 32-bit floats, on a million cells at once, many times per frame. The textbook version blows up here within about ten steps (',
      h('b', null, 'Break it'),
      ' below shows it failing). Four ingredients keep Deluge stable and exact — every cubic metre is booked, so the HUD’s mass error stays below 0.01 %:',
    ),
    h(
      'div',
      { class: 'dl-ingredients' },
      ingredient(
        '1',
        'CFL-adaptive timestep',
        `${dt}${op('=')}${v('C')}${frac(dx, `${sqrt('2')}${rm('&thinsp;')}${sub(rm('max'), 'cells')}${paren(`${sqrt(`${g}${h_}`)}${op('+')}${abs(v('u'))}`)}`)}`,
        'a wave must never jump more than one cell in a single step.',
        'The fastest cell sets the pace: its wave speed √(gh) plus the flow carrying the wave. The √2 is the 2-D part: the fastest grid-scale wave runs diagonally. The plain scheme is stable while this Courant number C stays below 1; the θ-smoothing Deluge adds (it damps only divergent grid-scale modes) lowers that to √θ ≈ 0.89. Depth and speed come back from the GPU a few hundred milliseconds late, so Δt aims for C = 0.7 against a padded estimate: the live Courant number in the HUD usually reads ≈ 0.55 and never exceeds 0.85. The frame then runs as many substeps as it needs.',
      ),
      ingredient(
        '2',
        'Semi-implicit friction',
        `${qNew}${op('=')}${frac(sup(v('q'), '∗'), `1${op('+')}${frac(`${g}${dt}${sup(n, '2')}${abs(v('q'))}`, supsub(v('h'), '7/3', v('f')), 'm-small')}`)}`,
        h('span', { html: `in thin films friction is enormously stiff (∝&thinsp;<i>h</i><sup>−7/3</sup>).` }),
        'An explicit friction update overshoots, reverses the flow and blows up. Dividing the frictionless update q* by a factor ≥ 1 means friction can only ever slow water down — stable for any timestep.',
      ),
      ingredient(
        '3',
        'Positivity-preserving flux limiter',
        `${v('k')}${op('=')}${rm('min')}${paren(`1,&thinsp;${frac(v('h'), `${frac(dt, dx, 'm-small')}${rm('Σ')}${sub(v('q'), 'out')}`)}`)}`,
        'a cell can’t give away more water than it holds.',
        'Clamping negative depths to zero would silently create water. Instead each donor cell’s outflows are scaled by k, so depth stays ≥ 0 and mass stays exact — this is what makes wetting and drying robust.',
      ),
      ingredient(
        '4',
        'Well-balanced face depth',
        `${hf}${op('=')}${rm('max')}${paren(`${sub(eta, 'L')},&thinsp;${sub(eta, 'R')}`, false)}${op('−')}${rm('max')}${paren(`${sub(v('z'), 'L')},&thinsp;${sub(v('z'), 'R')}`, false)}`,
        'on steep real terrain a still lake must stay perfectly still.',
        'Naively averaging depths makes pressure and bed slope disagree, so a lake at rest starts sloshing. Using the higher surface and the higher bed makes them cancel exactly — and water can’t leak through the top of a wall.',
      ),
    ),
  );

  // ── 4. Pipeline diagram ──
  const pipelineSvg = fragment<SVGSVGElement>(`
  <svg class="dl-pipeline" viewBox="0 0 880 330" role="img" aria-label="Two GPU compute passes per substep: pass A updates the momentum flux on every cell face; pass B limits the fluxes, updates depth, adds rain, storms and rivers, removes infiltration and books the mass ledger. Repeated N times per frame; then export to the renderer and an asynchronous readback to the CPU for stats and routing.">
    <defs>
      <marker id="dl-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" class="dl-pipe-arrowhead"/>
      </marker>
      <marker id="dl-arrow-amber" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" class="dl-pipe-arrowhead-amber"/>
      </marker>
    </defs>
    <rect x="6" y="6" width="652" height="318" rx="16" class="dl-pipe-region"/>
    <text x="24" y="32" class="dl-pipe-region-label">GPU · WebGPU compute shaders · 16×16 workgroups</text>
    <rect x="676" y="178" width="198" height="146" rx="16" class="dl-pipe-region dl-pipe-region-cpu"/>
    <text x="694" y="204" class="dl-pipe-region-label dl-pipe-cpu-label">CPU · main thread</text>

    <path d="M560 84 V62 H112 V80" class="dl-pipe-loop" marker-end="url(#dl-arrow)"/>
    <rect x="226" y="50" width="220" height="24" rx="12" class="dl-pipe-pill"/>
    <text x="336" y="66.5" text-anchor="middle" class="dl-pipe-pill-text">repeat N× per frame · Δt from CFL</text>

    <g class="dl-pipe-box">
      <rect x="22" y="84" width="248" height="94" rx="12"/>
      ${svgBadge(39, 98, 1)}
      <text x="146" y="110" text-anchor="middle" class="dl-pipe-title">Pass A · Momentum</text>
      <text x="146" y="130" text-anchor="middle" class="dl-pipe-sub">new ${svgSub('q', 'x')}, ${svgSub('q', 'y')} on every cell face:</text>
      <text x="146" y="146" text-anchor="middle" class="dl-pipe-sub">surface slope · upwind advection</text>
      <text x="146" y="162" text-anchor="middle" class="dl-pipe-sub">semi-implicit friction · θ-smoothing</text>
    </g>
    <path d="M270 131 H300" class="dl-pipe-flow" marker-end="url(#dl-arrow)"/>
    <g class="dl-pipe-box">
      <rect x="302" y="84" width="336" height="94" rx="12"/>
      ${svgBadge(319, 98, 2)}
      <text x="470" y="110" text-anchor="middle" class="dl-pipe-title">Pass B · Continuity</text>
      <text x="470" y="130" text-anchor="middle" class="dl-pipe-sub">flux limiter (depth stays ≥ 0) · h ← h + in − out</text>
      <text x="470" y="146" text-anchor="middle" class="dl-pipe-sub">rain · storms · river inflows &amp; stages · infiltration</text>
      <text x="470" y="162" text-anchor="middle" class="dl-pipe-sub">mass ledger: every m³ in and out</text>
    </g>

    <path d="M470 178 V206 H112 V228" class="dl-pipe-flow" marker-end="url(#dl-arrow)"/>
    <text x="300" y="199" text-anchor="middle" class="dl-pipe-note">when the picture refreshes</text>

    <g class="dl-pipe-box dl-pipe-box-alt">
      <rect x="22" y="230" width="180" height="78" rx="12"/>
      ${svgBadge(39, 244, 3)}
      <text x="112" y="258" text-anchor="middle" class="dl-pipe-title">Export</text>
      <text x="112" y="278" text-anchor="middle" class="dl-pipe-sub">h, u, v, max depth →</text>
      <text x="112" y="294" text-anchor="middle" class="dl-pipe-sub">terrain &amp; water renderer</text>
    </g>
    <path d="M202 269 H270" class="dl-pipe-flow" marker-end="url(#dl-arrow)"/>
    <text x="236" y="259" text-anchor="middle" class="dl-pipe-note">~3 Hz</text>
    <g class="dl-pipe-box dl-pipe-box-alt">
      <rect x="272" y="230" width="210" height="78" rx="12"/>
      ${svgBadge(289, 244, 4)}
      <text x="381" y="258" text-anchor="middle" class="dl-pipe-title">Async readback</text>
      <text x="377" y="278" text-anchor="middle" class="dl-pipe-sub">depth + mass ledger copied</text>
      <text x="377" y="294" text-anchor="middle" class="dl-pipe-sub">&amp; zeroed in one encoder</text>
    </g>
    <path d="M482 269 H692" class="dl-pipe-flow dl-pipe-flow-amber" marker-end="url(#dl-arrow-amber)"/>
    <text x="587" y="259" text-anchor="middle" class="dl-pipe-note">mapAsync, never blocks</text>
    <g class="dl-pipe-box dl-pipe-box-cpu">
      <rect x="694" y="220" width="162" height="88" rx="12"/>
      <text x="775" y="246" text-anchor="middle" class="dl-pipe-title">Stats &amp; routing</text>
      <text x="775" y="266" text-anchor="middle" class="dl-pipe-sub">mass balance (Float64)</text>
      <text x="775" y="282" text-anchor="middle" class="dl-pipe-sub">road flooding</text>
      <text x="775" y="298" text-anchor="middle" class="dl-pipe-sub">evacuation re-plan</text>
    </g>
  </svg>`);

  const pipeStats = h('div', { class: 'dl-pipe-stats' });
  const pipeStat = (labelText: string) => {
    const val = h('b', null, '—');
    pipeStats.append(h('div', { class: 'dl-pipe-stat' }, val, h('span', null, labelText)));
    return val;
  };
  const psCells = pipeStat('cells per pass');
  const psSub = pipeStat('substeps this frame');
  const psDt = pipeStat('Δt per substep');
  const psGpu = pipeStat('GPU');
  bind((s) => (s.grid ? `${s.grid.nx} × ${s.grid.ny}` : '—'), (x) => setText(psCells, x));
  bind((s) => (s.stepInfo ? String(s.stepInfo.substeps) : '—'), (x) => setText(psSub, x));
  bind((s) => (s.stepInfo ? `${fmtNum(s.stepInfo.dt, 2)} s` : '—'), (x) => setText(psDt, x));
  bind((s) => s.gpuInfo || 'WebGPU', (x) => {
    setText(psGpu, x);
    psGpu.title = x;
  });

  const pipeline = sec(
    'pipeline',
    '04 · On the GPU',
    'Two compute passes per substep',
    h(
      'p',
      null,
      'All state lives in GPU textures that ping-pong between the two passes: momentum writes the face fluxes, continuity turns them into new depths. Every substep of a frame is encoded into a single command buffer; the result is exported to the renderer when it redraws the water (about every other frame) and — a few times a second — read back asynchronously for statistics and routing. The CPU never waits for the GPU.',
    ),
    h('div', { class: 'dl-pipe-wrap' }, pipelineSvg),
    pipeStats,
  );

  // ── 5. Data ──
  const dataRow = (ic: Parameters<typeof icon>[0], title: string, text: string) =>
    h('div', { class: 'dl-data-row' }, h('span', { class: 'dl-data-icon' }, icon(ic, 18)), h('div', null, h('b', null, title), h('p', null, text)));
  const data = sec(
    'data',
    '05 · Real places',
    'Data sources',
    h(
      'div',
      { class: 'dl-data' },
      dataRow('layers', 'USGS 3D Elevation Program (3DEP)', 'Bare-earth elevation — 1 m lidar where available, ~10 m (1/3 arc-second) elsewhere. Rivers are hydro-flattened, so Deluge burns in a channel before filling them.'),
      dataRow('globe', 'USDA NAIP · Esri World Imagery', 'Aerial photography draped over the terrain: USDA NAIP via USGS The National Map for the built-in scenarios (public domain), Esri World Imagery for live areas (Esri, Vantor, Earthstar Geographics, and the GIS User Community).'),
      dataRow('route', 'US Census Bureau TIGER/Line roads', 'Road network for flood-aware evacuation routing; roads with ≥ 30 cm of water are treated as impassable.'),
      dataRow('gauge', 'NOAA National Weather Service', 'Official flood stages and historic crests for river gauges, marked on the river-stage slider.'),
      dataRow('search', 'OpenStreetMap Nominatim', 'Place search in the location picker (© OpenStreetMap contributors).'),
      dataRow('book', 'Method', 'Bates, Horritt & Fewtrell (2010), J. Hydrology · de Almeida, Bates, Freer & Souvignet (2012), Water Resources Research.'),
    ),
    h('h4', { class: 'dl-nws-title' }, 'Checked against the National Weather Service'),
    h(
      'p',
      { class: 'dl-nws-lead' },
      'The NWS lists what floods at each stage of the Pittsburgh Point gauge. Holding each stage for 15 simulated minutes on bare-earth elevation:',
    ),
    h(
      'div',
      { class: 'dl-nws-wrap' },
      h(
        'table',
        { class: 'dl-nws' },
        h('thead', null, h('tr', null, h('th', null, 'NWS impact'), h('th', null, 'NWS'), h('th', null, 'Deluge'))),
        h(
          'tbody',
          null,
          ...(
            [
              ['Point State Park flooded to the Portal Bridge', '30 ft', 'wet at 31 ft', 'ok'],
              ['PNC Park field flooded', '31 ft', '1 m deep at 35 ft', 'ok'],
              ['Federal Street at PNC Park flooded', '40 ft', 'wet at 40 ft', 'ok'],
              ['Up to 15 ft of water in the Golden Triangle', '46 ft', '15.7 ft at the Point', 'ok'],
              ['Acrisure Stadium field; Station Square tracks', '30–31 ft', 'wet only at 40 ft', 'miss'],
              ['Wood Street T; Parkway “bathtub”', '28; 25 ft', 'wet at 46 ft; dry', 'miss'],
            ] as const
          ).map(([impact, nws, sim, kind]) => h('tr', { 'data-kind': kind }, h('td', null, impact), h('td', null, nws), h('td', null, sim))),
        ),
      ),
    ),
    h(
      'p',
      { class: 'dl-nws-note' },
      'The river surface at the Point stays within 3 cm of the gauge at every stage. The misses flood through what bare-earth elevation does not contain: storm drains, underpasses, depressed roadways and underground stations.',
    ),
  );

  // ── 6. Break it ──
  const breakBtn = h('button', { type: 'button', class: 'dl-break-btn' });
  const breakState = h('div', { class: 'dl-break-state' });
  let closeTimer = 0;
  breakBtn.addEventListener('click', () => {
    const naive = store.get().sim.stabilityMode === 'naive';
    if (naive) {
      stopBreakDemo(ctx);
      return;
    }
    // The point is to watch it happen: start the (slowed) demo and get the dialog out of the way.
    startBreakDemo(ctx);
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => ctx.setPanel('howItWorks', false), 450);
  });
  bind(
    (s) => s.sim.stabilityMode === 'naive',
    (naive) => {
      breakBtn.innerHTML = naive ? `${iconMarkup('shield', 18)}<span>Restore the robust solver</span>` : `${iconMarkup('bolt', 18)}<span>Break it</span>`;
      toggleClass(breakBtn, 'dl-restore', naive);
      toggleClass(breakCard, 'dl-broken', naive);
      breakState.innerHTML = naive
        ? `<span class="dl-dot dl-dot-danger"></span> Naive solver running — close this dialog and watch the water.`
        : `<span class="dl-dot dl-dot-ok"></span> Robust solver running.`;
    },
  );
  const breakCard = h(
    'section',
    { class: 'dl-how-sec dl-break', 'data-how': 'break' },
    h('div', { class: 'dl-how-kicker' }, '06 · See for yourself'),
    h('h3', { class: 'dl-how-title' }, 'Break it'),
    h(
      'p',
      null,
      'This switches to a textbook explicit scheme: ',
      h('b', null, 'explicit friction, no flux limiter, no smoothing, no velocity cap'),
      ', and a Courant number of ',
      h('b', null, '1.8'),
      ' — beyond its stability limit of 1. Until it blows up the clock slows to ',
      h('b', null, `${BREAK_TIME_SCALE}×`),
      ' (each step is about 1.3 simulated seconds) so you can see it start; then your speed returns.',
    ),
    h(
      'ul',
      { class: 'dl-break-list' },
      h('li', null, 'For the first few steps nothing looks wrong — the error starts far too small to see.'),
      h('li', null, 'It grows several-fold with every step wherever water moves. The demo drops one small splash into the water nearest the middle of your view, so it starts there: the surface jitters cell by cell, then depths spike to thousands of meters.'),
      h('li', null, 'Within about ten steps the numbers overflow. Those cells turn to magenta noise (depth ∞ / NaN) that spreads from there, and the HUD reports the solution has diverged.'),
    ),
    h('p', null, 'This dialog closes so you can watch. Switch back from the red banner at the bottom — the water resets and the robust solver recovers instantly.'),
    h('div', { class: 'dl-break-actions' }, breakBtn, breakState),
  );

  modal = createModal({
    id: 'how',
    title: 'How Deluge works',
    subtitle: 'Real flood physics, solved on your GPU, in a browser tab.',
    icon: 'book',
    className: 'dl-how',
    headerExtra: undefined,
    onRequestClose: () => ctx.setPanel('howItWorks', false),
    body: [nav, plain, equations, stability, pipeline, data, breakCard],
  });

  // Scroll-spy: highlight the chip of the section currently under the nav (rAF-throttled, passive).
  let spyRaf = 0;
  let activeChip = '';
  const spy = () => {
    spyRaf = 0;
    const body = modal.body;
    const probeY = body.scrollTop + 90;
    let current = sections[0][0];
    for (const [id] of sections) {
      const el = body.querySelector<HTMLElement>(`[data-how="${id}"]`);
      // offsetTop is relative to the dialog (the positioned ancestor), so subtract the body's own offset.
      if (el && el.offsetTop - body.offsetTop <= probeY) current = id;
    }
    // At the very bottom the last (short) section can never reach the top: treat it as active.
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) current = sections[sections.length - 1][0];
    if (current === activeChip) return;
    activeChip = current;
    for (const [id, chip] of chips) toggleClass(chip, 'dl-on', id === current);
  };
  modal.body.addEventListener('scroll', () => {
    if (!spyRaf) spyRaf = requestAnimationFrame(spy);
  }, { passive: true });
  modal.onOpen(() => requestAnimationFrame(spy));

  bind((s) => s.panels.howItWorks, (open) => modal.setOpen(open));
  return modal;
}

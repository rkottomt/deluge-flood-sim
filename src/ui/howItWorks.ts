/**
 * "How it works" — the judge explainer. Plain language first, then the shallow-water equations typeset
 * in HTML/CSS, the four stability ingredients, the per-substep GPU pipeline diagram, data sources, and
 * the "Break it" stability-demo toggle.
 */
import { h, fragment, setText, toggleClass, type UIContext } from './dom';
import { icon, iconMarkup } from './icons';
import { createModal, type Modal } from './modal';
import { fmtNum, siParts } from './format';

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

export function createHowItWorks(ctx: UIContext): Modal {
  const { store, actions, bind } = ctx;

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
      h('div', { class: 'dl-how-card' }, h('span', { class: 'dl-how-card-icon' }, icon('layers', 20)), h('b', null, 'Friction slows it'), h('p', null, 'Rough ground (grass, buildings, forest) drags on the flow, especially in thin sheets of water.')),
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
    `${sup(v('q'), `${v('n')}+1`)}${op('=')}${frac(
      `${v('q̃')}${op('−')}${g}${hf}${dt}${frac(`${sub(eta, 'R')}${op('−')}${sub(eta, 'L')}`, dx, 'm-small')}`,
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
        [v('q̃'), 'lightly smoothed previous flux (θ-weighting)'],
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
      'Deluge uses the ',
      h('b', null, 'local-inertial'),
      ' form of these equations — the same approximation behind production flood-inundation models (LISFLOOD-FP class; Bates et al. 2010, de Almeida et al. 2012). On a staggered grid, the flux across each cell face is updated as:',
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
    h('p', null, 'A naive explicit solver for these equations explodes on real terrain within seconds. Four ideas keep Deluge stable, exact and fast:'),
    h(
      'div',
      { class: 'dl-ingredients' },
      ingredient(
        '1',
        'CFL-adaptive timestep',
        `${dt}${op('=')}${v('C')}${frac(dx, `${sqrt(`${g}${sub(v('h'), 'max')}`)}${op('+')}${sub(abs(v('u')), 'max')}`)}`,
        'a wave must never jump more than one cell in a single step.',
        'Deep, fast water needs smaller steps. Depth and speed come back from the GPU a few times per second and Δt is re-chosen automatically — the frame then runs as many substeps as it needs.',
      ),
      ingredient(
        '2',
        'Semi-implicit friction',
        `${sup(v('q'), `${v('n')}+1`)}${op('=')}${frac(sup(v('q'), '∗'), `1${op('+')}${frac(`${g}${dt}${sup(n, '2')}${abs(v('q'))}`, supsub(v('h'), '7/3', v('f')), 'm-small')}`)}`,
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
  <svg class="dl-pipeline" viewBox="0 0 880 330" role="img" aria-label="GPU passes per substep: momentum flux, flux limiter, continuity, sources and rain, repeated N times per frame; then export to the renderer and an asynchronous readback to the CPU for stats and routing.">
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

    <path d="M570 92 V62 H112 V84" class="dl-pipe-loop" marker-end="url(#dl-arrow)"/>
    <rect x="252" y="50" width="220" height="24" rx="12" class="dl-pipe-pill"/>
    <text x="362" y="66.5" text-anchor="middle" class="dl-pipe-pill-text">repeat N× per frame · Δt from CFL</text>

    ${[
      { x: 22, n: 1, t: 'Momentum', s1: `update ${svgSub('q', 'x')}, ${svgSub('q', 'y')} on`, s2: 'every cell face' },
      { x: 182, n: 2, t: 'Limiter', s1: 'scale donor outflow', s2: 'so depth stays ≥ 0' },
      { x: 342, n: 3, t: 'Continuity', s1: 'h ← h + inflow', s2: '− outflow' },
      { x: 502, n: 4, t: 'Sources', s1: 'rain · storms · rivers', s2: 'infiltration · ledger' },
    ]
      .map(
        (b) => `
      <g class="dl-pipe-box">
        <rect x="${b.x}" y="92" width="138" height="78" rx="12"/>
        ${svgBadge(b.x + 17, 106, b.n)}
        <text x="${b.x + 73}" y="121" text-anchor="middle" class="dl-pipe-title">${b.t}</text>
        <text x="${b.x + 69}" y="140" text-anchor="middle" class="dl-pipe-sub">${b.s1}</text>
        <text x="${b.x + 69}" y="156" text-anchor="middle" class="dl-pipe-sub">${b.s2}</text>
      </g>`,
      )
      .join('')}
    <path d="M160 131 H180" class="dl-pipe-flow" marker-end="url(#dl-arrow)"/>
    <path d="M320 131 H340" class="dl-pipe-flow" marker-end="url(#dl-arrow)"/>
    <path d="M480 131 H500" class="dl-pipe-flow" marker-end="url(#dl-arrow)"/>

    <path d="M571 170 V206 H112 V228" class="dl-pipe-flow" marker-end="url(#dl-arrow)"/>
    <text x="340" y="199" text-anchor="middle" class="dl-pipe-note">once per frame</text>

    <g class="dl-pipe-box dl-pipe-box-alt">
      <rect x="22" y="230" width="180" height="78" rx="12"/>
      ${svgBadge(39, 244, 5)}
      <text x="112" y="258" text-anchor="middle" class="dl-pipe-title">Export</text>
      <text x="112" y="278" text-anchor="middle" class="dl-pipe-sub">h, u, v, max depth →</text>
      <text x="112" y="294" text-anchor="middle" class="dl-pipe-sub">terrain &amp; water renderer</text>
    </g>
    <path d="M202 269 H270" class="dl-pipe-flow" marker-end="url(#dl-arrow)"/>
    <text x="236" y="259" text-anchor="middle" class="dl-pipe-note">~4 Hz</text>
    <g class="dl-pipe-box dl-pipe-box-alt">
      <rect x="272" y="230" width="210" height="78" rx="12"/>
      ${svgBadge(289, 244, 6)}
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
    'Four compute passes per substep',
    h(
      'p',
      null,
      'All state lives in GPU textures that ping-pong between passes. Every substep of a frame is encoded into a single command buffer, then the result is exported to the renderer and — a few times a second — read back asynchronously for statistics and routing. The CPU never waits for the GPU.',
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
      dataRow('globe', 'Esri World Imagery', 'Aerial photography draped over the terrain (Esri, Maxar, Earthstar Geographics).'),
      dataRow('route', 'US Census Bureau TIGER/Line roads', 'Road network for flood-aware evacuation routing; roads with ≥ 30 cm of water are treated as impassable.'),
      dataRow('gauge', 'NOAA National Weather Service', 'Official flood stages and historic crests for river gauges, marked on the river-stage slider.'),
      dataRow('search', 'OpenStreetMap Nominatim', 'Place search in the location picker (© OpenStreetMap contributors).'),
      dataRow('book', 'Method', 'Bates, Horritt & Fewtrell (2010), J. Hydrology · de Almeida, Bates, Freer & Souvignet (2012), Water Resources Research.'),
    ),
  );

  // ── 6. Break it ──
  const breakBtn = h('button', { type: 'button', class: 'dl-break-btn' });
  const breakState = h('div', { class: 'dl-break-state' });
  let closeTimer = 0;
  breakBtn.addEventListener('click', () => {
    const naive = store.get().sim.stabilityMode === 'naive';
    actions.setStabilityDemo(!naive);
    if (!naive) {
      // The point is to watch it happen: make sure the clock runs and get the dialog out of the way.
      if (store.get().paused) store.set({ paused: false });
      clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => ctx.setPanel('howItWorks', false), 450);
    }
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
      h('b', null, 'explicit friction, no flux limiter, no velocity cap'),
      ', and a Courant number of ',
      h('b', null, '1.8'),
      ' — beyond the stability limit of 1.',
    ),
    h(
      'ul',
      { class: 'dl-break-list' },
      h('li', null, 'Within a few simulated seconds, checkerboard ripples appear in shallow water.'),
      h('li', null, 'They grow into spikes of impossible depth and speed, then NaNs spread across the map.'),
      h('li', null, 'The mass-balance error in the HUD explodes — water is being created from nothing.'),
    ),
    h('p', null, 'This dialog closes so you can watch. Switch back from the red banner at the top — the water resets and the robust solver recovers instantly.'),
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

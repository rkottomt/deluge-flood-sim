/**
 * Help overlay (? / H): keyboard shortcuts and a 30-second "try this" tour.
 */
import { h, type UIContext } from './dom';
import { icon } from './icons';
import { kbd } from './controls';
import { createModal, type Modal } from './modal';
import { TOOLS, selectTool } from './toolDefs';
import { toolIcon } from './toolbar';

export function createHelp(ctx: UIContext): Modal {
  const { store, bind } = ctx;

  const shortcutRow = (keys: Array<string>, text: string) =>
    h('div', { class: 'dl-sc-row' }, h('span', { class: 'dl-sc-keys' }, ...keys.flatMap((k, i) => (i ? [h('span', { class: 'dl-sc-or' }, '/'), kbd(k)] : [kbd(k)]))), h('span', { class: 'dl-sc-text' }, text));

  const tools = h(
    'div',
    { class: 'dl-sc-tools' },
    ...TOOLS.map((t) =>
      h(
        'button',
        {
          type: 'button',
          class: 'dl-sc-tool',
          onclick: () => {
            selectTool(store, t.id);
            ctx.setPanel('help', false);
          },
        },
        kbd(t.key),
        icon(toolIcon(t.id), 16),
        h('span', null, t.label),
      ),
    ),
  );

  const steps: Array<[string, Array<string | HTMLElement>]> = [
    ['Speed up time', ['The simulation is already running. ', h('b', null, '300×'), ' in the top bar plays it fast; when the GPU can’t keep up, the button shows the speed it really reaches (e.g. 300× → 44×). ', kbd('Space'), ' pauses.']],
    ['Raise the river', ['In ', h('b', null, 'Weather & rivers'), ', click the highest historic-crest chip (or crank the rain). The river rises along its whole length over a few simulated minutes and the flood spreads from every bank — watch the low-lying districts go under, street by street.']],
    ['Build a levee', ['Press ', kbd('2'), ' and drag a wall across a low gap where the water gets in, tying both ends into high ground. The tool card checks the height against the flood (red = overtopped); water finds its way around open ends.']],
    ['Get people out', ['Press ', kbd('8'), ' and click a house (or use ', h('b', null, 'Evacuate'), ' in the Try-it strip). The route to the nearest dry shelter re-plans as roads flood — or turns red.']],
    ['See the hazard', ['In ', h('b', null, 'View'), ', switch to ', h('b', null, 'Depth'), ' or ', h('b', null, 'Speed'), '. Press ', kbd('0'), ' and hover to probe any spot.']],
    ['Break the math', ['Open ', h('b', null, 'How it works'), ' and hit ', h('b', null, 'Break it'), ' to see why a stable GPU solver is hard.']],
  ];

  const tour = h(
    'ol',
    { class: 'dl-tour' },
    ...steps.map(([title, body], i) =>
      h('li', { class: 'dl-tour-step' }, h('span', { class: 'dl-tour-num' }, String(i + 1)), h('div', null, h('div', { class: 'dl-tour-title' }, title), h('p', null, ...body))),
    ),
  );

  let modal: Modal;
  const startBtn = h(
    'button',
    {
      type: 'button',
      class: 'dl-btn dl-btn-primary',
      onclick: () => {
        store.set({ paused: false });
        ctx.setSim({ timeScale: 300 });
        ctx.setPanel('help', false);
      },
    },
    icon('play', 14),
    h('span', null, 'Start at 300×'),
  );

  modal = createModal({
    id: 'help',
    title: 'Quick guide',
    subtitle: 'Everything is live — the water you see is being solved on your GPU right now.',
    icon: 'help',
    className: 'dl-help',
    onRequestClose: () => ctx.setPanel('help', false),
    body: [
      h(
        'div',
        { class: 'dl-help-grid' },
        h('section', { class: 'dl-help-col' }, h('h3', { class: 'dl-h3' }, icon('spark', 16), 'Try this in 30 seconds'), tour),
        h(
          'section',
          { class: 'dl-help-col' },
          h('h3', { class: 'dl-h3' }, icon('keyboard', 16), 'Tools'),
          tools,
          h('h3', { class: 'dl-h3' }, icon('mouse', 16), 'Shortcuts'),
          h(
            'div',
            { class: 'dl-sc' },
            shortcutRow(['Space'], 'Play / pause'),
            shortcutRow(['R'], 'Reset water'),
            shortcutRow(['F'], 'Frame the whole map'),
            shortcutRow(['T'], 'Top-down view'),
            shortcutRow(['[', ']'], 'Smaller / larger brush'),
            shortcutRow(['Shift'], 'Drain, raise ground, or continue a wall'),
            shortcutRow(['Esc'], 'Cancel a wall · close dialogs'),
            shortcutRow(['?', 'H'], 'This guide'),
          ),
          h(
            'div',
            { class: 'dl-mouse-hints' },
            h('span', null, h('b', null, 'Drag'), ' orbit (Navigate & Probe tools)'),
            h('span', null, h('b', null, 'Right-drag'), ' pan'),
            h('span', null, h('b', null, 'Scroll'), ' zoom'),
          ),
        ),
      ),
    ],
    footer: h('footer', { class: 'dl-modal-foot' }, h('span', { class: 'dl-foot-note' }, 'Press ', kbd('?'), ' any time to reopen this guide.'), startBtn),
  });

  bind((s) => s.panels.help, (open) => modal.setOpen(open));
  return modal;
}

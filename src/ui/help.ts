/**
 * Help overlay (? / H): shortcuts and a short tour. The interactive walkthrough is Start the tour.
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
    ['Look around', ['Drag the map to spin it. Right-drag to slide. Scroll to zoom.']],
    ['Raise the river', ['Click ', h('b', null, 'Raise to 1936 record'), ' in the Try-it strip. The rivers rise and downtown goes under.']],
    ['Green pins', ['Those are ', h('b', null, 'shelters'), ' — high ground people can evacuate to. They are not the flood.']],
    ['Get people out', ['Click ', h('b', null, 'Evacuate'), '. A route is drawn to the nearest dry shelter and re-plans as streets flood.']],
    ['Hold the water back', ['Click ', h('b', null, 'Build a levee'), '. The land it keeps dry turns green. Or pick the wall tool and drag your own.']],
    ['Speed up time', ['The numbers in the top bar skip ahead so you do not wait hours. ', h('b', null, '60×'), ' is a good watching speed. ', kbd('Space'), ' pauses.']],
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
        ctx.setPanel('help', false);
        ctx.startTutorial?.();
      },
    },
    icon('spark', 14),
    h('span', null, 'Start the tour'),
  );

  modal = createModal({
    id: 'help',
    title: 'Quick guide',
    subtitle: 'A live flood on real terrain. Click around — you cannot break anything important.',
    icon: 'help',
    className: 'dl-help',
    onRequestClose: () => ctx.setPanel('help', false),
    body: [
      h(
        'div',
        { class: 'dl-help-grid' },
        h('section', { class: 'dl-help-col' }, h('h3', { class: 'dl-h3' }, icon('spark', 16), 'The idea'), tour),
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
            shortcutRow(['V'], 'Next water view: realistic, depth, max depth, speed'),
            shortcutRow(['[', ']'], 'Smaller / larger brush'),
            shortcutRow(['Shift'], 'Drain, raise ground, or continue a wall'),
            shortcutRow(['Esc'], 'Cancel a wall · close dialogs'),
            shortcutRow(['?', 'H'], 'This guide'),
          ),
          h(
            'div',
            { class: 'dl-mouse-hints' },
            h('span', null, h('b', null, 'Drag'), ' look around'),
            h('span', null, h('b', null, 'Right-drag'), ' slide the map'),
            h('span', null, h('b', null, 'Scroll'), ' zoom'),
          ),
        ),
      ),
    ],
    footer: h('footer', { class: 'dl-modal-foot' }, h('span', { class: 'dl-foot-note' }, 'Press ', kbd('?'), ' any time to reopen this. Esc closes the tour.'), startBtn),
  });

  bind((s) => s.panels.help, (open) => modal.setOpen(open));
  return modal;
}

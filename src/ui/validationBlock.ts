/**
 * "Checked against the real flood" — the Scenario section's one-line validation score for the preset on screen, from
 * public/validation/summary.json (written by scripts/validate.ts), with a link to the full report (docs/VALIDATION.md).
 *
 * The file is fetched once, from the app's own origin (it ships next to the presets, so it works offline), the first
 * time a preset with an entry is shown. A missing or unreadable file just leaves the block hidden: the validation is
 * documentation, never something the app needs to run.
 */
import type { ValidationSummary, ValidationSummaryEntry } from '../validation/types';
import { h, setText, type UIContext } from './dom';

export const VALIDATION_DOC_URL = 'https://github.com/rkottomt/deluge-flood-sim/blob/main/docs/VALIDATION.md';

export interface ValidationLine {
  label: string;
  value: string;
  note: string;
}

/**
 * What the block says for one preset: title, the score line, and the plain-language reading — and, when the scene is
 * also checked against another observed flood, one more line per comparison (`more`).
 */
export function validationText(entry: ValidationSummaryEntry | null | undefined): (ValidationLine & { more: ValidationLine[] }) | null {
  if (!entry) return null;
  if (!entry.headline) {
    return {
      label: 'Not checked against observations yet',
      value: '',
      note: 'No public flood map or surveyed high-water marks exist for this scene’s domain.',
      more: [],
    };
  }
  const more = (entry.more ?? []).map((m) => ({ label: m.label, value: m.value, note: m.note }));
  return { label: entry.headline.label, value: entry.headline.value, note: entry.headline.note, more };
}

let summaryPromise: Promise<ValidationSummary | null> | null = null;

function loadSummary(): Promise<ValidationSummary | null> {
  if (!summaryPromise) {
    const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
    const url = `${env?.BASE_URL ?? '/'}validation/summary.json`;
    summaryPromise = fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<ValidationSummary>) : null))
      .then((j) => (j && j.version === 1 && j.presets ? j : null))
      .catch(() => null);
  }
  return summaryPromise;
}

export function createValidationBlock(ctx: UIContext): HTMLElement {
  const label = h('div', { class: 'dl-validation-label' });
  const value = h('div', { class: 'dl-validation-value' });
  const note = h('div', { class: 'dl-validation-note' });
  const extra = h('div', { class: 'dl-validation-more', 'data-validation': 'more' });
  const link = h('a', { href: VALIDATION_DOC_URL, target: '_blank', rel: 'noopener noreferrer', class: 'dl-validation-link' }, 'How it compares with observed floods');
  const el = h(
    'div',
    { class: 'dl-validation', 'data-validation': 'block', hidden: true },
    h('div', { class: 'dl-validation-title' }, 'Checked against the real flood'),
    label,
    value,
    note,
    extra,
    link,
  );
  let shown: string | null = null;
  ctx.bind(
    (s) => s.presetId,
    (id) => {
      shown = id;
      if (!id) {
        el.hidden = true;
        return;
      }
      void loadSummary().then((sum) => {
        if (shown !== id) return;
        const t = validationText(sum?.presets[id]);
        el.hidden = !t;
        if (!t) return;
        setText(label, t.label);
        setText(value, t.value);
        value.hidden = !t.value;
        setText(note, t.note);
        extra.replaceChildren(
          ...t.more.map((m) =>
            h(
              'div',
              { class: 'dl-validation-item' },
              h('div', { class: 'dl-validation-label' }, m.label),
              h('div', { class: 'dl-validation-value' }, m.value),
              h('div', { class: 'dl-validation-note' }, m.note),
            ),
          ),
        );
        extra.hidden = t.more.length === 0;
      });
    },
  );
  return el;
}

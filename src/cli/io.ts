/// <reference types="node" />
/**
 * Console plumbing for the CLI: results go to stdout (or files), everything a human watches — progress, notes,
 * warnings — goes to stderr, so `deluge portfolio … --out - > results.csv` stays clean.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Log {
  /** A note on stderr (suppressed by --quiet). */
  info(msg: string): void;
  /** A warning on stderr (always). */
  warn(msg: string): void;
  /** Progress of a long step, 0–1, on stderr: a rewritten line on a terminal, else a line every 10 %. */
  progress(label: string, fraction: number, detail?: string): void;
  /** End the current progress line. */
  endProgress(): void;
}

export function createLog(opts: { quiet?: boolean; stream?: NodeJS.WritableStream & { isTTY?: boolean } } = {}): Log {
  const out = opts.stream ?? process.stderr;
  const tty = !!out.isTTY;
  let open = false;
  let lastLabel = '';
  let lastDecile = -1;
  const end = () => {
    if (open && tty) out.write('\n');
    open = false;
  };
  return {
    info(msg) {
      if (opts.quiet) return;
      end();
      out.write(`${msg}\n`);
    },
    warn(msg) {
      end();
      out.write(`warning: ${msg}\n`);
    },
    progress(label, fraction, detail = '') {
      if (opts.quiet) return;
      const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
      const pct = `${(f * 100).toFixed(0).padStart(3)} %`;
      if (tty) {
        const line = `${label} ${pct}${detail ? `  ${detail}` : ''}`;
        out.write(`\r${line.slice(0, 118).padEnd(118)}`);
        open = true;
        return;
      }
      const decile = Math.floor(f * 10);
      if (label !== lastLabel) {
        lastLabel = label;
        lastDecile = -1;
      }
      if (decile === lastDecile) return;
      lastDecile = decile;
      out.write(`${label} ${pct}${detail ? `  ${detail}` : ''}\n`);
    },
    endProgress: end,
  };
}

/** Write a text or binary result; `-` is stdout. Parent directories are created. */
export function writeOutput(file: string, data: string | ArrayBuffer | Uint8Array): void {
  if (file === '-') {
    process.stdout.write(typeof data === 'string' ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
}

/** JSON with NaN / ±Infinity as null and a trailing newline. */
export function toJson(v: unknown): string {
  return `${JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x), 2)}\n`;
}

export function fmtSeconds(s: number): string {
  if (!Number.isFinite(s)) return '—';
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

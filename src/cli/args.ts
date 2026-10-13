/**
 * Argument parsing and help for the `deluge` CLI. Pure (unit-tested): `--name value`, `--name=value`, boolean switches,
 * a strict list of options per command — an unknown option or a missing value is a usage error (exit code 2), never
 * silently ignored, because a typo in a batch job should fail loudly rather than run the wrong scenario.
 */
import { UsageError } from './scenario';

export type OptKind = 'string' | 'number' | 'boolean';

export interface OptSpec {
  name: string;
  kind: OptKind;
  /** Placeholder in the help (`<ft>`). */
  arg?: string;
  help: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  options: OptSpec[];
  examples: string[];
  notes?: string[];
}

export type ParsedOptions = Record<string, string | number | boolean | undefined>;

const SCENARIO_OPTS: OptSpec[] = [
  { name: 'preset', kind: 'string', arg: '<id>', help: 'Scenario to run (see `deluge presets`). Required.' },
  { name: 'minutes', kind: 'number', arg: '<min>', help: 'Simulated minutes per run (2–240; default 30, the app’s sweep and ensemble default).' },
  { name: 'scenario', kind: 'string', arg: '<level>', help: 'A Site check ladder level by id: rp100, record1936, x0.5 … (see `deluge presets --levels`).' },
  { name: 'stage-ft', kind: 'number', arg: '<ft>', help: 'River / sea stage as a gauge reading in feet (presets with a stage control).' },
  { name: 'rain', kind: 'number', arg: '<mm/hr>', help: 'Global rain rate, mm/hr (replaces the preset’s).' },
  { name: 'scale', kind: 'number', arg: '<k>', help: 'Multiply rain, storm cells and inflows by k.' },
  { name: 'manning', kind: 'number', arg: '<n>', help: 'Manning roughness n (default 0.035).' },
  { name: 'climate', kind: 'string', arg: '<h:p[:s]>', help: 'Future climate: 2050|2080|2100 : ssp245|ssp585 [: cc|super10|super14]. Default today.' },
];

const COMMON_OPTS: OptSpec[] = [
  { name: 'quiet', kind: 'boolean', help: 'No progress or notes on stderr (warnings and errors still).' },
  { name: 'app-cadence', kind: 'boolean', help: 'Read the GPU back on the browser’s 300 ms wall-clock cadence instead of every 60 simulated s (repeats then differ in the last digits, as in the app).' },
  { name: 'help', kind: 'boolean', help: 'This help.' },
];

export const COMMANDS: Record<string, CommandSpec> = {
  presets: {
    name: 'presets',
    summary: 'List the scenarios that ship with Deluge (offline, no GPU needed).',
    usage: 'deluge presets [--json] [--levels]',
    options: [
      { name: 'json', kind: 'boolean', help: 'Machine-readable list on stdout.' },
      { name: 'levels', kind: 'boolean', help: 'Also list each preset’s Site check ladder (the ids --scenario takes).' },
      { name: 'help', kind: 'boolean', help: 'This help.' },
    ],
    examples: ['deluge presets', 'deluge presets --levels', 'deluge presets --json > presets.json'],
  },
  run: {
    name: 'run',
    summary: 'Run one scenario on the GPU and write max depth, max speed, arrival and hazard rasters (GeoTIFF, EPSG:3857) plus a summary JSON.',
    usage: 'deluge run --preset <id> [scenario options] [--out <dir>]',
    options: [
      ...SCENARIO_OPTS,
      { name: 'out', kind: 'string', arg: '<dir>', help: 'Output directory (default results/<preset>). Created if missing.' },
      { name: 'no-rasters', kind: 'boolean', help: 'Write only summary.json.' },
      ...COMMON_OPTS,
    ],
    examples: [
      'deluge run --preset houston --minutes 60 --rain 173 --out results/harvey',
      'deluge run --preset pittsburgh --stage-ft 46 --minutes 30 --out results/1936',
      'deluge run --preset houston --climate 2050:ssp585 --out results/houston-2050',
    ],
  },
  portfolio: {
    name: 'portfolio',
    summary: 'Assess a CSV of assets (asset_id, lat, lon or wkt, values …) against a scenario: per-asset depth, speed, hazard class, arrival, damage, loss, downtime, BI and insured loss — the in-app export’s columns — optionally with ensemble p10/p50/p90.',
    usage: 'deluge portfolio --preset <id> --csv <assets.csv> [scenario options] [--members <n>] --out <results.csv>',
    options: [
      ...SCENARIO_OPTS,
      { name: 'csv', kind: 'string', arg: '<file>', help: 'Assets CSV (the app’s portfolio format; comma, semicolon or tab). Required.' },
      { name: 'out', kind: 'string', arg: '<file>', help: 'Results CSV (`-` = stdout). Required.' },
      { name: 'summary', kind: 'string', arg: '<file>', help: 'Also write a JSON summary (portfolio totals, run details, ensemble bands).' },
      { name: 'members', kind: 'number', arg: '<n>', help: 'Also run an ensemble of n perturbed members (3–32) and add p10/p50/p90 columns.' },
      { name: 'seed', kind: 'number', arg: '<n>', help: 'Ensemble seed (default 1; the same seed gives the same members).' },
      { name: 'no-dem-noise', kind: 'boolean', help: 'Ensemble without the terrain-error perturbation.' },
      ...COMMON_OPTS,
    ],
    examples: [
      'deluge portfolio --preset houston --csv public/demo/houston-portfolio.csv --out results.csv',
      'deluge portfolio --preset houston --csv assets.csv --members 12 --seed 7 --out results.csv --summary summary.json',
      'deluge portfolio --preset pittsburgh --scenario rp100 --csv assets.csv --out - > results.csv',
    ],
  },
  site: {
    name: 'site',
    summary: 'Site check of one planned building: depth, speed, hazard, arrival, egress, damage and loss for the scenario — or, with --sweep, across the preset’s ladder of flood levels with EAL, an indicative finished-floor elevation, mitigation options with BCR, and a verdict.',
    usage: 'deluge site --preset <id> --at <lat,lon> [--use <occupancy>] [--floors <n>] [--sweep] [--out <report.json>]',
    options: [
      ...SCENARIO_OPTS,
      { name: 'at', kind: 'string', arg: '<lat,lon>', help: 'The site (WGS84 degrees). Required.' },
      { name: 'ring', kind: 'string', arg: '<lat,lon;…>', help: 'Parcel outline instead of a pin: lat,lon pairs separated by ";" (3–64 corners).' },
      { name: 'name', kind: 'string', arg: '<text>', help: 'Site name for the report.' },
      { name: 'use', kind: 'string', arg: '<occupancy>', help: 'res, apt, retail, office, warehouse, industrial, hospital, school, datacenter, civic, other (default office).' },
      { name: 'floors', kind: 'number', arg: '<n>', help: 'Storeys (default 3).' },
      { name: 'value', kind: 'number', arg: '<usd>', help: 'Structure replacement value, USD (default: floor area × unit cost).' },
      { name: 'footprint', kind: 'number', arg: '<m2>', help: 'Building footprint, m² (default: the outline, or a typical one for the use).' },
      { name: 'ffh', kind: 'number', arg: '<m>', help: 'Planned first-floor height above grade, m (default 0.3).' },
      { name: 'critical', kind: 'number', arg: '<m>', help: 'Critical equipment height above grade, m.' },
      { name: 'sweep', kind: 'boolean', help: 'Run the ladder of levels (the app’s ticked defaults) and add EAL, FFE, mitigation and the verdict.' },
      { name: 'levels', kind: 'string', arg: '<ids|all>', help: 'Levels to sweep: comma-separated ids, or all (default: the app’s ticked ones).' },
      { name: 'rp', kind: 'string', arg: '<id=years,…>', help: 'Your return periods for levels without a published one (e.g. x0.5=10,x1=100).' },
      { name: 'design', kind: 'string', arg: '<id>', help: 'Design level for the FFE (default: the 1 % level, else the highest).' },
      { name: 'freeboard-ft', kind: 'number', arg: '<ft>', help: 'Freeboard above the design water, ft (default ASCE 24-14 by use).' },
      { name: 'out', kind: 'string', arg: '<file>', help: 'Report JSON (default stdout).' },
      ...COMMON_OPTS,
    ],
    examples: [
      'deluge site --preset pittsburgh --at 40.4425,-80.0085 --use office --floors 3 --sweep --out report.json',
      'deluge site --preset pittsburgh --at 40.4425,-80.0085 --stage-ft 46',
      'deluge site --preset houston --at 29.7725,-95.3837 --use warehouse --floors 1 --sweep --rp x0.5=10,x1=100',
    ],
  },
};

/** Parse `argv` (after the command) against a command's options. */
export function parseOptions(spec: CommandSpec, argv: readonly string[]): ParsedOptions {
  const byName = new Map(spec.options.map((o) => [o.name, o]));
  const out: ParsedOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      out.help = true;
      continue;
    }
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument "${a}" (options start with --)`);
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const opt = byName.get(name);
    if (!opt) throw new UsageError(`unknown option --${name} for \`deluge ${spec.name}\` (see deluge ${spec.name} --help)`);
    if (opt.kind === 'boolean') {
      if (eq > 0) {
        const v = a.slice(eq + 1).toLowerCase();
        if (!['true', 'false', '1', '0', 'yes', 'no'].includes(v)) throw new UsageError(`--${name} takes no value (or true/false)`);
        out[name] = v === 'true' || v === '1' || v === 'yes';
      } else out[name] = true;
      continue;
    }
    let raw: string | undefined;
    if (eq > 0) raw = a.slice(eq + 1);
    else {
      raw = argv[i + 1];
      // A negative number is a value (--rain -1 is caught by range checks), any other "--x" is the next option.
      if (raw === undefined || (raw.startsWith('--') && !/^-\d/.test(raw))) throw new UsageError(`--${name} needs a value${opt.arg ? ` ${opt.arg}` : ''}`);
      i++;
    }
    if (opt.kind === 'number') {
      const v = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(v)) throw new UsageError(`--${name} must be a number, got "${raw}"`);
      out[name] = v;
    } else out[name] = raw;
  }
  return out;
}

export function str(o: ParsedOptions, name: string): string | undefined {
  const v = o[name];
  return typeof v === 'string' ? v : undefined;
}
export function num(o: ParsedOptions, name: string): number | undefined {
  const v = o[name];
  return typeof v === 'number' ? v : undefined;
}
export function flag(o: ParsedOptions, name: string): boolean {
  return o[name] === true;
}

export const EXIT = {
  ok: 0,
  /** The simulation or an output failed. */
  failure: 1,
  /** Bad command line or input file. */
  usage: 2,
  /** No WebGPU adapter / Dawn could not start. */
  noGpu: 3,
} as const;

export function mainHelp(version: string): string {
  const cmds = Object.values(COMMANDS)
    .map((c) => `  ${c.name.padEnd(10)} ${c.summary}`)
    .join('\n');
  return `deluge ${version} — headless batch runs of the Deluge flood simulator (GPU, offline)

Usage: deluge <command> [options]

Commands:
${wrap(cmds, 2 + 11)}

Run \`deluge <command> --help\` for its options. Everything runs on this machine's GPU through Dawn
(the \`webgpu\` package); nothing is uploaded. Results are screening estimates, not engineering advice.

Exit codes: 0 ok · 1 simulation or output failed · 2 bad arguments or input file · 3 no WebGPU adapter.
`;
}

export function commandHelp(spec: CommandSpec): string {
  const opts = spec.options
    .map((o) => {
      const left = `  --${o.name}${o.arg ? ` ${o.arg}` : ''}`;
      return `${left.padEnd(28)} ${o.help}`;
    })
    .join('\n');
  return `${spec.usage}

${spec.summary}

Options:
${wrap(opts, 29)}

Examples:
${spec.examples.map((e) => `  ${e}`).join('\n')}
${spec.notes?.length ? `\n${spec.notes.join('\n')}\n` : ''}`;
}

/** Wrap long lines at 110 columns, continuation lines indented by `indent`. */
function wrap(text: string, indent: number, width = 110): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.length <= width) return line;
      const head = line.slice(0, indent);
      const words = line.slice(indent).split(' ').filter(Boolean);
      const lines: string[] = [];
      let cur = '';
      for (const w of words) {
        if (cur && indent + cur.length + 1 + w.length > width) {
          lines.push(cur);
          cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
      }
      if (cur) lines.push(cur);
      return head + lines.join(`\n${' '.repeat(indent)}`);
    })
    .join('\n');
}

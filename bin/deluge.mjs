#!/usr/bin/env node
/**
 * `deluge` — headless batch runs of the Deluge flood simulator on this machine's GPU (src/cli/main.ts).
 *
 *   npx deluge --help
 *   npm run deluge -- run --preset houston --minutes 60 --out results/harvey
 *
 * The CLI is the app's own TypeScript (solver, scenario wiring, loss model), run through tsx — no separate build, so
 * the numbers it prints come from exactly the code the browser runs.
 */
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli/main.ts');
const code = await main(process.argv.slice(2));
// Let stdout drain (a piped CSV), then exit: Dawn and pending timers must not keep a finished batch job alive.
process.stdout.write('', () => process.exit(code));

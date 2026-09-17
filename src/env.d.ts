/**
 * Build-time constants injected by vite.config.ts (`define`).
 *
 * `__DELUGE_DEBUG_API__` gates the automation surfaces — `window.__deluge` (src/app/debugApi.ts) and
 * `#ui-root.__delugeUI` (src/ui/index.ts). It is a build-time constant rather than a runtime `?debug` check on
 * purpose (FINDINGS.json SEC-07): a runtime check cannot be dead-code-eliminated, so the whole debug API would still
 * ship, and any link could switch it on. `vite build` leaves it `false` unless `DELUGE_DEBUG_API=1` is set, so the
 * released bundle contains none of it; `vite dev` keeps it through `import.meta.env.DEV`.
 */
declare const __DELUGE_DEBUG_API__: boolean;

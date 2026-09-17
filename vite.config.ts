import { defineConfig, type Plugin } from 'vite';
import { contentSecurityPolicy } from './src/data/csp';

const CHARSET_META = '<meta charset="UTF-8" />';

/**
 * Inject the Content-Security-Policy meta into the built index.html, right after the charset meta and therefore before
 * any script tag (a meta CSP only governs what follows it). Build-only: the dev server serves no untrusted content and
 * HMR is easier without it. The policy itself lives in src/data/csp.ts, which tests/data/csp.test.ts checks against
 * the app's real endpoint list. FINDINGS.json SEC-02.
 */
function cspMeta(): Plugin {
  return {
    name: 'deluge-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!html.includes(CHARSET_META)) throw new Error(`deluge-csp: ${CHARSET_META} not found in index.html`);
        const meta = `<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}" />`;
        return html.replace(CHARSET_META, `${CHARSET_META}\n    ${meta}`);
      },
    },
  };
}

export default defineConfig({
  // Relative asset and preset URLs: the same build works at the site root (npm run demo) and under any sub-path
  // (GitHub Pages serves a project at /<repo>/), with no server rewrites. Presets are fetched from BASE_URL.
  base: './',
  plugins: [cspMeta()],
  // Build-time gate for the automation surfaces (window.__deluge, #ui-root.__delugeUI). Off unless DELUGE_DEBUG_API=1,
  // so a released build contains none of that code; `npm run dev` keeps it via import.meta.env.DEV, and
  // scripts/e2e.mjs sets the variable before it builds. See src/env.d.ts and FINDINGS.json SEC-07.
  define: { __DELUGE_DEBUG_API__: JSON.stringify(process.env.DELUGE_DEBUG_API === '1') },
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});

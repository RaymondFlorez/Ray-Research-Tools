/**
 * The response headers PRD 7.2's client-side paragraph asks for.
 *
 * > Strict CSP with no `unsafe-eval` outside the dedicated Pyodide worker
 * > origin; the WASM sandbox runs in a separate origin with `COOP`/`COEP`
 * > isolation.
 *
 * Two details that the sentence does not settle and a browser does:
 *
 * **WebAssembly needs `'wasm-unsafe-eval'`, not `'unsafe-eval'`.** Compiling a
 * module is gated by CSP, and the pricing core is a module, so a CSP with
 * neither keyword breaks every repricing on the canvas. `'wasm-unsafe-eval'`
 * permits exactly WebAssembly compilation and leaves `eval` and
 * `new Function` refused, which is what "no `unsafe-eval`" was for.
 * `apps/canvas-demo/scripts/csp-check.mjs` checks both halves in Chromium.
 *
 * **Inline import maps and styles are allowed by hash, not by `unsafe-inline`.**
 * Each demo page carries an inline `<script type="importmap">` and a `<style>`.
 * `'unsafe-inline'` would admit them and every injected script with them; a
 * SHA-256 of each block's exact text admits those blocks and nothing else, so
 * an injected `<script>` is refused even on a page that has inline scripts of
 * its own.
 */

import { createHash } from 'node:crypto';

function hashes(html, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  for (const match of html.matchAll(pattern)) {
    // Only inline blocks: a <script src> has empty content and is covered by 'self'.
    if (tag === 'script' && /\ssrc=/.test(match[0].slice(0, match[0].indexOf('>')))) continue;
    out.push(`'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
  }
  return out;
}

/** Headers for a response. Pass the HTML for an HTML response, so its inline blocks are hashed. */
export function securityHeaders(html) {
  const scripts = html ? hashes(html, 'script') : [];
  const styles = html ? hashes(html, 'style') : [];
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${scripts.join(' ')}`.trim(),
    `style-src 'self' ${styles.join(' ')}`.trim(),
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

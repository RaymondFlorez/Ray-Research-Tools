/**
 * Builds the pricing core's WASM if it is missing or older than its source.
 *
 * Used as vitest `globalSetup` by every suite that loads the module, so the
 * build happens once, before any worker starts. It used to happen lazily in
 * a test's `beforeAll`: on a fresh clone the first suite to need it ran a
 * cargo build that outlasted vitest's ten-second hook timeout, and each
 * parallel worker could start its own.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CRATE = fileURLToPath(new URL('../crates/pricing-core', import.meta.url));
const WASM = join(CRATE, 'target/wasm32-unknown-unknown/release/pricing_core.wasm');

function newestSource(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs);
  }
  return newest;
}

export default function ensureWasm() {
  if (existsSync(WASM) && statSync(WASM).mtimeMs >= newestSource(join(CRATE, 'src'))) return;
  execFileSync('cargo', ['build', '--quiet', '--release', '--target', 'wasm32-unknown-unknown'], {
    cwd: CRATE,
    stdio: 'inherit',
  });
}

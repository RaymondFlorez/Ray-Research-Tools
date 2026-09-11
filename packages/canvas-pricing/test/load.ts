/**
 * Loads the pricing module for tests, building it if it is not there.
 *
 * Building rather than skipping: a test suite that quietly passes because the
 * artefact was missing is worse than one that takes forty seconds the first
 * time.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { instantiatePricing, type PricingExports } from '../src/module.js';

const CRATE = fileURLToPath(new URL('../../../crates/pricing-core', import.meta.url));
const WASM = `${CRATE}/target/wasm32-unknown-unknown/release/pricing_core.wasm`;

/** Newest mtime under the crate's `src`, so an edited crate rebuilds. */
function sourceMtime(): number {
  const files = execFileSync('find', [`${CRATE}/src`, '-name', '*.rs'], { encoding: 'utf8' })
    .trim()
    .split('\n');
  return Math.max(...files.map((f) => statSync(f).mtimeMs));
}

let cached: Promise<PricingExports> | undefined;

export function loadPricing(): Promise<PricingExports> {
  cached ??= (async () => {
    if (!existsSync(WASM) || statSync(WASM).mtimeMs < sourceMtime()) {
      execFileSync(
        'cargo',
        ['build', '--quiet', '--release', '--target', 'wasm32-unknown-unknown'],
        { cwd: CRATE, stdio: 'inherit' },
      );
    }
    return instantiatePricing(readFileSync(WASM));
  })();
  return cached;
}

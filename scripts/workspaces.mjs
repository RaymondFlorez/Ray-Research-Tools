#!/usr/bin/env node
/**
 * Runs an npm script in every workspace, in dependency order.
 *
 *   node scripts/workspaces.mjs build
 *
 * `npm run build --workspaces` walks workspaces alphabetically, and `tsc`
 * resolves a sibling package through its `dist`. So `canvas-agents` built
 * before `canvas-core` and a fresh clone could not build at all — every
 * green build until this script existed was green because a stale `dist`
 * was already on disk. The order here comes from the manifests themselves,
 * so it cannot drift from them, and a dependency cycle is an error rather
 * than an order that happens to work.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const script = process.argv[2];
if (!script) {
  console.error('usage: node scripts/workspaces.mjs <script>');
  process.exit(2);
}

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const dirs = root.workspaces.flatMap((pattern) => {
  if (!pattern.endsWith('/*')) return [pattern];
  const parent = pattern.slice(0, -2);
  return readdirSync(join(ROOT, parent), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, parent, d.name, 'package.json')))
    .map((d) => `${parent}/${d.name}`);
});

const manifests = new Map();
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  manifests.set(manifest.name, { dir, manifest });
}

// Depth-first topological sort over in-repo dependencies.
const order = [];
const state = new Map(); // name -> 'visiting' | 'done'
function visit(name, path) {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') {
    console.error(`dependency cycle: ${[...path, name].join(' -> ')}`);
    process.exit(1);
  }
  state.set(name, 'visiting');
  const { manifest } = manifests.get(name);
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  for (const dep of Object.keys(deps).sort()) {
    if (manifests.has(dep)) visit(dep, [...path, name]);
  }
  state.set(name, 'done');
  order.push(name);
}
for (const name of [...manifests.keys()].sort()) visit(name, []);

for (const name of order) {
  const { dir, manifest } = manifests.get(name);
  if (!manifest.scripts?.[script]) continue;
  console.log(`\n> ${name} ${script}`);
  const result = spawnSync('npm', ['run', script], { cwd: join(ROOT, dir), stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${name}: ${script} failed`);
    process.exit(result.status ?? 1);
  }
}

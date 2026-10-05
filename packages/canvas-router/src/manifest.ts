/**
 * Capability manifests (PRD 4.4).
 *
 * > Every model is registered with a capability manifest:
 * > id, version, context, modalities, tools, structured_output,
 * > cost_per_mtok_in, p50_latency_ms, p95_latency_ms, eval_scores,
 * > sensitivity_allowed.
 *
 * `parseManifest` reads that YAML shape — the flat subset the PRD's example
 * uses, parsed by hand rather than by a YAML library, which would also accept
 * anchors, tags and arbitrary object construction from a file whose job is to
 * describe a model.
 *
 * ## An unknown key is refused
 *
 * `eval_score:` for `eval_scores:` would otherwise register a model with no
 * quality numbers, which the router reads as "not evaluated" and never routes
 * to — a silent outage of a model somebody thinks they just deployed.
 *
 * ## The manifest cannot widen a hard rule
 *
 * `sensitivity_allowed` is a claim, and placement is a fact. A vendor-hosted
 * model whose manifest lists `positions` is not a vendor model that may see
 * positions; it is a misconfigured manifest, refused at registration so the
 * claim never reaches the router. The PRD's example has no placement field at
 * all, and the sensitivity line cannot be checked without one, so `placement`
 * is required here — an addition to the PRD's schema, stated as such.
 */

import type { Modality, Model, Placement, TaskClass } from './policy.js';

export class ManifestError extends Error {
  constructor(readonly line: number, detail: string) {
    super(`manifest line ${line}: ${detail}`);
    this.name = 'ManifestError';
  }
}

const KEYS = new Set([
  'id', 'version', 'vendor', 'family', 'placement', 'context', 'modalities', 'tools',
  'structured_output', 'cost_per_mtok_in', 'cost_per_mtok_out', 'p50_latency_ms', 'p95_latency_ms',
  'eval_scores', 'sensitivity_allowed', 'deterministic',
]);
const MODALITIES: readonly Modality[] = ['text', 'image', 'audio', 'table', 'code'];
const PLACEMENTS: readonly Placement[] = ['on_device', 'self_hosted', 'vendor'];
const SENSITIVITIES = ['public', 'licensed', 'positions', 'mnpi_risk'] as const;
/** What each placement may see, mirroring the router's hard rule. */
const ALLOWED: Record<Placement, readonly string[]> = {
  on_device: SENSITIVITIES,
  self_hosted: SENSITIVITIES,
  vendor: ['public', 'licensed'],
};

type Scalar = string | number | boolean;

function scalar(raw: string, line: number): Scalar {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  const quoted = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  if (quoted) return quoted[1]!;
  if (/^[A-Za-z0-9_.\-/]+$/.test(v)) return v;
  throw new ManifestError(line, `cannot read the value ${JSON.stringify(v)}`);
}

export function parseManifest(text: string): Model {
  const top: Record<string, Scalar | Scalar[]> = {};
  const evalScores: Record<string, number> = {};
  let inScores = false;

  const lines = text.split('\n');
  for (const [i, rawLine] of lines.entries()) {
    const n = i + 1;
    const line = rawLine.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (line.trim() === '') continue;
    const indented = /^\s+/.test(line);
    const match = /^\s*([A-Za-z0-9_.]+):\s*(.*)$/.exec(line);
    if (!match) throw new ManifestError(n, 'expected "key: value"');
    const [, key, value] = match as unknown as [string, string, string];
    if (indented) {
      if (!inScores) throw new ManifestError(n, 'indentation is only allowed under eval_scores');
      const score = scalar(value, n);
      if (typeof score !== 'number' || score < 0 || score > 1) {
        throw new ManifestError(n, `${key}: an eval score is a number from 0 to 1`);
      }
      evalScores[key] = score;
      continue;
    }
    inScores = false;
    if (!KEYS.has(key)) throw new ManifestError(n, `unknown key "${key}"`);
    if (key in top || (key === 'eval_scores' && Object.keys(evalScores).length > 0)) {
      throw new ManifestError(n, `"${key}" appears twice`);
    }
    if (key === 'eval_scores') {
      if (value.trim() !== '') throw new ManifestError(n, 'eval_scores is a map, one score per line below it');
      inScores = true;
      top[key] = '';
      continue;
    }
    const list = /^\[(.*)\]$/.exec(value.trim());
    top[key] = list
      ? list[1]!.split(',').map((v) => v.trim()).filter((v) => v !== '').map((v) => scalar(v, n))
      : scalar(value, n);
  }

  const need = (key: string) => {
    if (!(key in top)) throw new ManifestError(0, `missing required key "${key}"`);
    return top[key]!;
  };
  const num = (key: string) => {
    const v = need(key);
    if (typeof v !== 'number') throw new ManifestError(0, `${key} must be a number`);
    return v;
  };
  const str = (key: string) => {
    const v = need(key);
    if (typeof v !== 'string') throw new ManifestError(0, `${key} must be text`);
    return v;
  };
  const list = (key: string) => {
    const v = need(key);
    if (!Array.isArray(v)) throw new ManifestError(0, `${key} must be a [list]`);
    return v.map(String);
  };

  const placement = str('placement') as Placement;
  if (!PLACEMENTS.includes(placement)) throw new ManifestError(0, `placement "${placement}" is not one of ${PLACEMENTS.join(', ')}`);
  const modalities = list('modalities');
  for (const m of modalities) {
    if (!MODALITIES.includes(m as Modality)) throw new ManifestError(0, `"${m}" is not a modality`);
  }
  const sensitivity = list('sensitivity_allowed');
  for (const c of sensitivity) {
    if (!(SENSITIVITIES as readonly string[]).includes(c)) throw new ManifestError(0, `"${c}" is not a data class`);
    if (!ALLOWED[placement].includes(c)) {
      throw new ManifestError(
        0,
        `a ${placement} model cannot be allowed ${c} data: the manifest claims more than its placement permits, ` +
          'and a manifest does not get to widen a hard rule',
      );
    }
  }
  const tools = need('tools');
  if (typeof tools !== 'boolean') throw new ManifestError(0, 'tools must be true or false');
  const structured = str('structured_output');
  const costIn = num('cost_per_mtok_in');
  const costOut = 'cost_per_mtok_out' in top ? num('cost_per_mtok_out') : costIn;
  const p50 = num('p50_latency_ms');
  const p95 = num('p95_latency_ms');
  if (p95 < p50) throw new ManifestError(0, 'p95 latency is below p50');
  if (Object.keys(evalScores).length === 0) {
    throw new ManifestError(0, 'no eval_scores: the router would never route to this model');
  }

  return {
    id: str('id'),
    version: String(need('version')),
    vendor: 'vendor' in top ? str('vendor') : 'open',
    ...('family' in top ? { family: str('family') } : {}),
    placement,
    modalities: modalities as Modality[],
    tools,
    structuredOutput: structured === 'json_schema',
    // Dollars per million tokens to cents per thousand, input and output
    // averaged, since the router's cost estimate takes one blended rate.
    centsPerKiloToken: ((costIn + costOut) / 2) * 0.1,
    latencyMsP50: p50,
    latencyMsP95: p95,
    quality: evalScores as Partial<Record<TaskClass, number>>,
    deterministic: 'deterministic' in top ? need('deterministic') === true : true,
    contextTokens: num('context'),
  };
}

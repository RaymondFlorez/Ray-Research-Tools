import { describe, expect, it } from 'vitest';
import { ManifestError, parseManifest } from '../src/manifest.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { route, type RoutingFeatures } from '../src/router.js';

/** PRD 4.4's example, verbatim, plus the placement the example leaves out. */
const PRD_EXAMPLE = `
id: qwen-coder-32b-instruct
version: "2025-11-a"
placement: self_hosted
context: 131072
modalities: [text]
tools: true
structured_output: json_schema
cost_per_mtok_in: 0.0    # self-hosted, amortized separately
p50_latency_ms: 900
p95_latency_ms: 2400
eval_scores:
  quant.codegen: 0.87
  sql.generate: 0.94
  doc.extract: 0.71
sensitivity_allowed: [public, licensed, positions, mnpi_risk]
`;

describe('reading a manifest', () => {
  it('reads the PRD example into a model the router can use', () => {
    const model = parseManifest(PRD_EXAMPLE);
    expect(model).toMatchObject({
      id: 'qwen-coder-32b-instruct',
      version: '2025-11-a',
      placement: 'self_hosted',
      contextTokens: 131072,
      modalities: ['text'],
      tools: true,
      structuredOutput: true,
      centsPerKiloToken: 0,
      latencyMsP50: 900,
      latencyMsP95: 2400,
      quality: { 'quant.codegen': 0.87, 'sql.generate': 0.94, 'doc.extract': 0.71 },
    });
  });

  it('refuses an unknown key, which would otherwise be a silent outage', () => {
    // eval_score for eval_scores: a model with no quality numbers is never routed to.
    expect(() => parseManifest(PRD_EXAMPLE.replace('eval_scores:', 'eval_score:'))).toThrow(/unknown key "eval_score"/);
  });

  it('refuses a manifest that claims more than its placement permits', () => {
    const vendor = PRD_EXAMPLE.replace('placement: self_hosted', 'placement: vendor');
    expect(() => parseManifest(vendor)).toThrow(/does not get to widen a hard rule/);
    const honest = vendor.replace('[public, licensed, positions, mnpi_risk]', '[public, licensed]');
    expect(parseManifest(honest).placement).toBe('vendor');
  });

  it('requires a placement, which the PRD example leaves out', () => {
    expect(() => parseManifest(PRD_EXAMPLE.replace('placement: self_hosted\n', ''))).toThrow(/missing required key "placement"/);
  });

  it('refuses a manifest with no eval scores', () => {
    const none = PRD_EXAMPLE.replace(/eval_scores:\n(  .*\n)+/, '');
    expect(() => parseManifest(none)).toThrow(/never route to this model/);
  });

  it('refuses nonsense values, with the line they are on', () => {
    expect(() => parseManifest(PRD_EXAMPLE.replace('quant.codegen: 0.87', 'quant.codegen: 1.7'))).toThrow(ManifestError);
    expect(() => parseManifest(PRD_EXAMPLE.replace('modalities: [text]', 'modalities: [text, smell]'))).toThrow(/not a modality/);
    expect(() => parseManifest(PRD_EXAMPLE.replace('p95_latency_ms: 2400', 'p95_latency_ms: 400'))).toThrow(/below p50/);
    expect(() => parseManifest(`${PRD_EXAMPLE}id: again\n`)).toThrow(/appears twice/);
  });

  it('does not construct anything a YAML library would', () => {
    // Anchors, tags and flow maps are not part of the format.
    expect(() => parseManifest(PRD_EXAMPLE.replace('id: qwen-coder-32b-instruct', 'id: !!js/function "x"'))).toThrow(
      ManifestError,
    );
  });
});

describe('the capabilities the manifest declares are hard rules', () => {
  function request(overrides: Partial<RoutingFeatures>): RoutingFeatures {
    return {
      taskClass: 'doc.extract',
      inputTokens: 4_000,
      expectedOutputTokens: 400,
      modalities: ['text'],
      toolsRequired: [],
      rigorFlag: false,
      dataSensitivity: 'public',
      costCeilingCents: 50,
      latencyBudgetMs: 3_000,
      determinismRequired: false,
      priorFailures: [],
      ...overrides,
    };
  }

  it('never routes an image to a model that cannot read one', () => {
    const decision = route(DEFAULT_POLICY, request({ modalities: ['text', 'image'] }));
    expect(decision.model.modalities).toContain('image');
    expect(decision.excluded.find((e) => e.modelId === 'qwen-coder-32b')?.rule).toContain('does not take image');
  });

  it('never routes a tool-calling request to a model that cannot call tools', () => {
    const decision = route(
      DEFAULT_POLICY,
      request({ taskClass: 'intent.classify', toolsRequired: ['palette.open'], latencyBudgetMs: 120 }),
    );
    expect(decision.model.tools).toBe(true);
    expect(decision.excluded.find((e) => e.modelId === 'local-3b')?.rule).toContain('cannot call tools');
  });

  it('refuses outright when nothing in the tenant can read the input', () => {
    // Positions-classified page images: only vendor models read images, and
    // positions may not reach a vendor.
    expect(() =>
      route(DEFAULT_POLICY, request({ modalities: ['text', 'image'], dataSensitivity: 'positions' })),
    ).toThrow(/no model can serve/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  DuplicateTask,
  InferenceQueue,
  NoEligibleModel,
  type Model,
  type RoutingFeatures,
  type RoutingPolicy,
  type TaskClass,
} from '../src/index.js';

function fleetWithout(...placements: Array<Model['placement']>): RoutingPolicy {
  return { ...DEFAULT_POLICY, models: DEFAULT_POLICY.models.filter((m) => !placements.includes(m.placement)) };
}

function features(taskClass: TaskClass, over: Partial<RoutingFeatures> = {}): RoutingFeatures {
  return {
    taskClass,
    inputTokens: 3_000,
    expectedOutputTokens: 600,
    modalities: ['text'],
    toolsRequired: [],
    rigorFlag: false,
    dataSensitivity: 'public',
    costCeilingCents: 100,
    latencyBudgetMs: 60_000,
    determinismRequired: false,
    priorFailures: [],
    ...over,
  };
}

// Rung 2: only the on-device model is reachable.
const saturated = fleetWithout('vendor', 'self_hosted');
const selfHostedBack = fleetWithout('vendor');

describe('InferenceQueue (PRD 7.4 rung 2, 7.3)', () => {
  it('routes what the degraded fleet can still serve, without queueing it', () => {
    const queue = new InferenceQueue(DEFAULT_POLICY);
    const admission = queue.submit({ id: 'c1', features: features('intent.classify'), priority: 'interactive' }, saturated);
    expect(admission.kind).toBe('routed');
    expect(admission.kind === 'routed' && admission.decision.model.id).toBe('local-3b');
    expect(queue.length).toBe(0);
  });

  it('queues heavy work with a position instead of refusing it', () => {
    const queue = new InferenceQueue(DEFAULT_POLICY);
    const admission = queue.submit({ id: 'g1', features: features('quant.codegen'), priority: 'interactive' }, saturated);
    expect(admission).toMatchObject({ kind: 'queued', position: 1 });
    expect(admission.kind === 'queued' && admission.reason).toMatch(/no model can serve quant.codegen/);
  });

  it('puts interactive work ahead of batch, and a waiting batch task\'s position moves back', () => {
    const queue = new InferenceQueue(DEFAULT_POLICY);
    queue.submit({ id: 'refresh', features: features('quant.codegen'), priority: 'batch' }, saturated);
    queue.submit({ id: 'embed', features: features('quant.codegen'), priority: 'batch' }, saturated);
    expect(queue.position('refresh')).toBe(1);
    const late = queue.submit({ id: 'ask', features: features('quant.codegen'), priority: 'interactive' }, saturated);
    expect(late).toMatchObject({ kind: 'queued', position: 1 });
    expect(queue.positions()).toEqual([
      { id: 'ask', priority: 'interactive', position: 1 },
      { id: 'refresh', priority: 'batch', position: 2 },
      { id: 'embed', priority: 'batch', position: 3 },
    ]);
  });

  it('drains in queue order once the fleet recovers, and only what it can now serve', () => {
    const queue = new InferenceQueue(DEFAULT_POLICY);
    queue.submit({ id: 'batch-code', features: features('quant.codegen'), priority: 'batch' }, saturated);
    queue.submit({ id: 'ask-code', features: features('quant.codegen'), priority: 'interactive' }, saturated);
    // Released as one batch, interactive first.
    const released = queue.drain(selfHostedBack);
    expect(released.map((r) => r.id)).toEqual(['ask-code', 'batch-code']);
    expect(released.every((r) => r.decision.model.placement !== 'vendor')).toBe(true);
    expect(queue.length).toBe(0);
  });

  it('refuses at once what no recovery could admit, rather than queueing it forever', () => {
    const queue = new InferenceQueue(DEFAULT_POLICY);
    // A request no model in the healthy fleet can take: codegen from audio,
    // a modality no codegen model accepts.
    const impossible = features('quant.codegen', { modalities: ['audio'] });
    let thrown: unknown;
    try {
      queue.submit({ id: 'x', features: impossible, priority: 'interactive' }, saturated);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NoEligibleModel);
    // The healthy fleet's refusal — including the self-hosted and vendor
    // models the degraded fleet never saw — so the reason is the permanent one.
    expect((thrown as Error).message).toMatch(/qwen-coder-32b/);
    expect(queue.length).toBe(0);
  });

  it('cancels, and refuses a duplicate id', () => {
    const queue = new InferenceQueue(DEFAULT_POLICY);
    queue.submit({ id: 'g', features: features('quant.codegen'), priority: 'batch' }, saturated);
    expect(() => queue.submit({ id: 'g', features: features('quant.codegen'), priority: 'batch' }, saturated)).toThrow(DuplicateTask);
    expect(queue.cancel('g')).toBe(true);
    expect(queue.position('g')).toBeUndefined();
    expect(queue.cancel('g')).toBe(false);
  });
});

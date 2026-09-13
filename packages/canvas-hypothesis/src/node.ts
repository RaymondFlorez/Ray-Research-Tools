/**
 * `HypothesisNode` on the canvas (PRD 3.3, 3.5).
 *
 * The node holds the claim in `params`, so `@picasso/canvas-core` derives a
 * cache key that changes when the claim does — which matters more here than
 * elsewhere. A claim edited after the data arrives is a different claim, and
 * the key is what keeps a quietly-moved threshold from inheriting the old one's
 * track record.
 */

import {
  createNode,
  type NodeID,
  type ParamValue,
  type PicassoNode,
  type Port,
  type Vec2,
} from '@picasso/canvas-core';
import { calibrate, trackRecord, type Calibration, type Scored } from './calibration.js';
import { resolve, validate, type Hypothesis, type Observation, type Resolution } from './hypothesis.js';

export function hypothesisPorts(): { inputs: Port[]; outputs: Port[] } {
  return {
    inputs: [
      // "wires in the data that would confirm or falsify it" — PRD 3.5.
      { id: 'evidence', name: 'Evidence', type: 'series', cardinality: 'many', required: false },
    ],
    outputs: [
      { id: 'status', name: 'Status', type: 'signal', cardinality: 'one', required: false },
      { id: 'record', name: 'Track record', type: 'table', cardinality: 'one', required: false },
    ],
  };
}

export interface HypothesisNodeInput {
  id: NodeID;
  hypothesis: Hypothesis;
  position?: Vec2;
  binding?: PicassoNode['binding'];
}

export function createHypothesisNode(input: HypothesisNodeInput): PicassoNode {
  const { hypothesis } = input;
  return createNode({
    id: input.id,
    kind: 'HypothesisNode',
    // A hypothesis is a commitment, so it is wired by default: a claim nobody
    // is tracking is the mood board this node exists to replace.
    binding: input.binding ?? 'wired',
    position: input.position ?? { x: 0, y: 0 },
    size: { w: 340, h: 240 },
    ...hypothesisPorts(),
    params: {
      claim: hypothesis.claim,
      confidence: hypothesis.confidence,
      createdAt: hypothesis.createdAt,
      observables: hypothesis.observables.map((o) => ({
        id: o.id,
        name: o.name,
        direction: o.direction,
        threshold: o.threshold,
        falsifier: o.falsifier,
        dueBy: o.dueBy,
        unit: o.unit ?? '',
      })),
    } satisfies Record<string, ParamValue>,
    nodeVersion: '1',
  });
}

export function readHypothesis(node: PicassoNode): Hypothesis {
  const params = node.params as unknown as Omit<Hypothesis, 'id'>;
  return { id: node.id, ...params };
}

export interface HypothesisEvaluation {
  resolution: Resolution;
  /** The analyst's record on comparable claims, when any were supplied. */
  calibration?: Calibration;
  /** The one-line record the Critic cites. */
  record?: string;
  /** What the node shows under the claim. */
  badge: string;
  problems: string[];
}

/**
 * Evaluates the node, writing the outcome into its runtime state.
 *
 * The status mapping is deliberate. A contradicted claim is not an *error* —
 * being wrong is the system working — so it goes to `ready` with the verdict on
 * the badge. What does go to `error` is a claim that cannot be tested at all,
 * because that is a defect in the claim rather than news about the world.
 */
export function evaluateHypothesis(
  node: PicassoNode,
  observations: readonly Observation[],
  now: string,
  history: readonly Scored[] = [],
): HypothesisEvaluation {
  const hypothesis = readHypothesis(node);
  const problems = validate(hypothesis);
  if (problems.length > 0) {
    node.state = {
      status: 'error',
      error: { code: 'untestable_claim', message: problems[0] as string, retriable: false },
    };
    return {
      resolution: {
        status: 'undetermined',
        outcomes: [],
        explanation: problems[0] as string,
      },
      badge: 'not testable',
      problems,
    };
  }

  const resolution = resolve(hypothesis, observations, now);
  const at = Date.parse(now);
  node.state = {
    status: resolution.status === 'undetermined' ? 'stale' : 'ready',
    ...(Number.isFinite(at) ? { lastComputedAt: at } : {}),
  };

  const calibration = history.length > 0 ? calibrate(history) : undefined;
  const record = history.length > 0 ? trackRecord(history) : undefined;

  return {
    resolution,
    ...(calibration !== undefined ? { calibration } : {}),
    ...(record !== undefined ? { record } : {}),
    badge: badgeFor(resolution, hypothesis.confidence),
    problems,
  };
}

function badgeFor(resolution: Resolution, confidence: number): string {
  const stated = `${Math.round(confidence * 100)}%`;
  switch (resolution.status) {
    case 'supported':
      return `supported — called at ${stated}`;
    case 'contradicted':
      return `contradicted — called at ${stated}`;
    case 'expired':
      return 'expired — the data never arrived';
    default: {
      const awaited = resolution.outcomes.filter((o) => o.value === undefined).length;
      return awaited > 0
        ? `open — ${awaited} observation${awaited === 1 ? '' : 's'} awaited`
        : 'inconclusive — landed between threshold and falsifier';
    }
  }
}

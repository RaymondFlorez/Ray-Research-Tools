/**
 * The inference queue: what rung 2 of the degradation ladder does with work
 * the fleet cannot take right now (PRD 7.4, 7.3).
 *
 * > GPU fleet saturated → local 3B handles classification and autocomplete;
 * > heavy tasks queue with a visible position indicator.
 *
 * > Requests queue with priority: interactive over batch, and batch work
 * > (overnight canvas refresh, bulk embedding) is preempted.
 *
 * The router alone can only refuse: on a fleet reduced to the on-device 3B, a
 * codegen request throws `NoEligibleModel`, which is right — answering it from
 * the 3B would be the silent substitution rung 1 forbids — but a refusal is
 * not a queue, and the analyst gets an error where the PRD promised a place in
 * line.
 *
 * So `submit` routes against the fleet that is up, and when that fails it asks
 * a second question: **would the healthy fleet have served this?** If yes, the
 * failure is capacity and the task queues with its position. If no, the
 * failure is policy — a positions-classified prompt with no self-hosted model,
 * a modality nobody serves — and queueing it would leave it waiting for a
 * recovery that can never admit it, so it is refused now with the router's own
 * reasons.
 *
 * Positions are interactive-first, then oldest-first. A batch task's position
 * can get worse while it waits, every time an interactive task arrives; that
 * is what "interactive over batch" means, and the position reported is the
 * true one rather than its place at arrival.
 */

import { NoEligibleModel, route, type RoutingDecision, type RoutingFeatures, type RouterOptions } from './router.js';
import type { RoutingPolicy } from './policy.js';

export type QueuePriority = 'interactive' | 'batch';

export interface InferenceTask {
  id: string;
  features: RoutingFeatures;
  priority: QueuePriority;
}

export type Admission =
  | { kind: 'routed'; decision: RoutingDecision }
  | {
      kind: 'queued';
      /** 1-based, interactive work first. */
      position: number;
      /** The router's refusal on the degraded fleet, kept for the badge's tooltip. */
      reason: string;
    };

interface Waiting {
  task: InferenceTask;
  sequence: number;
}

export class DuplicateTask extends Error {
  constructor(readonly id: string) {
    super(`task ${id} is already queued`);
    this.name = 'DuplicateTask';
  }
}

export class InferenceQueue {
  #waiting: Waiting[] = [];
  #sequence = 0;

  /**
   * @param healthy The fleet at full strength — the test of whether a refusal
   *   on today's fleet is capacity or policy.
   */
  constructor(
    private readonly healthy: RoutingPolicy,
    private readonly options: RouterOptions = {},
  ) {}

  /** Routes now if the fleet that is up can serve it; otherwise queues or refuses. */
  submit(task: InferenceTask, available: RoutingPolicy): Admission {
    if (this.#waiting.some((w) => w.task.id === task.id)) throw new DuplicateTask(task.id);
    try {
      return { kind: 'routed', decision: route(available, task.features, this.options) };
    } catch (error) {
      if (!(error instanceof NoEligibleModel)) throw error;
      // Policy, not capacity: a healthy fleet would refuse it too, so there is
      // nothing to wait for. The healthy fleet's refusal is the one thrown,
      // because its reasons are the permanent ones.
      route(this.healthy, task.features, this.options);
      this.#waiting.push({ task, sequence: this.#sequence++ });
      return { kind: 'queued', position: this.position(task.id) as number, reason: error.message };
    }
  }

  /** The task's place in line, 1-based, or undefined once it has left. */
  position(id: string): number | undefined {
    const index = this.#ordered().findIndex((w) => w.task.id === id);
    return index < 0 ? undefined : index + 1;
  }

  /** Every waiting task with its position — what the badges render. */
  positions(): Array<{ id: string; priority: QueuePriority; position: number }> {
    return this.#ordered().map((w, i) => ({ id: w.task.id, priority: w.task.priority, position: i + 1 }));
  }

  get length(): number {
    return this.#waiting.length;
  }

  /** Withdraws a waiting task. True if it was there. */
  cancel(id: string): boolean {
    const before = this.#waiting.length;
    this.#waiting = this.#waiting.filter((w) => w.task.id !== id);
    return this.#waiting.length < before;
  }

  /**
   * Routes, in queue order, every waiting task the fleet that is up can now
   * serve; the rest keep their order. A partly recovered fleet — self-hosted
   * back, vendor still out — releases what it can and no more.
   */
  drain(available: RoutingPolicy): Array<{ id: string; decision: RoutingDecision }> {
    const released: Array<{ id: string; decision: RoutingDecision }> = [];
    const kept: Waiting[] = [];
    for (const waiting of this.#ordered()) {
      try {
        released.push({ id: waiting.task.id, decision: route(available, waiting.task.features, this.options) });
      } catch (error) {
        if (!(error instanceof NoEligibleModel)) throw error;
        kept.push(waiting);
      }
    }
    this.#waiting = kept;
    return released;
  }

  #ordered(): Waiting[] {
    const rank = (p: QueuePriority) => (p === 'interactive' ? 0 : 1);
    return [...this.#waiting].sort((a, b) => rank(a.task.priority) - rank(b.task.priority) || a.sequence - b.sequence);
  }
}

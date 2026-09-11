/**
 * Binding-state machine: loose <-> bound <-> wired (PRD 3.2.1).
 *
 * The load-bearing invariant is guardrail #4: "Nothing crosses a binding
 * boundary without the analyst pressing something." That is enforced here by
 * splitting promotion into two calls. `proposePromotion` is pure and produces a
 * proposal the UI renders as a ghost overlay; `applyPromotion` will not move a
 * node without an `AnalystCommit`, which only a real input event can mint. No
 * code path in this module promotes a node on its own.
 */

import type {
  BindingState,
  FrameMode,
  FrozenSnapshot,
  NodeKind,
  ParamValue,
  PicassoNode,
} from './types.js';

/** Proof that a human pressed something. Required by every binding change. */
export interface AnalystCommit {
  actor: string;
  at: number;
  /** How the analyst asked for it. `plan` covers nodes a Deep Inquiry created. */
  via: 'keyboard' | 'affordance' | 'menu' | 'plan';
}

export type PromotionTarget = Exclude<BindingState, 'loose'>;

export interface PromotionProposal {
  ok: true;
  nodeId: string;
  from: BindingState;
  to: PromotionTarget;
  /** The kind the semantic pass proposes when promoting ink (PRD 3.7). */
  proposedKind?: NodeKind;
  /** Params the proposal would set, shown in the ghost overlay for editing. */
  proposedParams?: Record<string, ParamValue>;
  /** Recognizer confidence, when the proposal came from ink. */
  confidence?: number;
}

export interface PromotionBlocked {
  ok: false;
  code: 'already_wired' | 'sketch_frame' | 'not_promotable';
  message: string;
}

export type PromotionResult = PromotionProposal | PromotionBlocked;

/** Context the promotion rules need beyond the node itself. */
export interface PromotionContext {
  /** The frame the node sits in, if any. */
  frame?: { id: string; frameMode?: FrameMode } | undefined;
  /** Output of the semantic ink pass, when the object is a sketch. */
  recognition?: {
    kind: NodeKind;
    params?: Record<string, ParamValue>;
    confidence: number;
  };
}

const LADDER: readonly BindingState[] = ['loose', 'bound', 'wired'];

function step(from: BindingState, direction: 1 | -1): BindingState | undefined {
  const next = LADDER.indexOf(from) + direction;
  return LADDER[next];
}

/**
 * `Cmd ↑`. Produces the proposal for one step up the ladder. Pure: it never
 * mutates the node and never commits.
 */
export function proposePromotion(node: PicassoNode, ctx: PromotionContext = {}): PromotionResult {
  if (node.binding === 'wired') {
    return { ok: false, code: 'already_wired', message: 'Already wired.' };
  }

  // PRD 3.2.4: inside a sketch frame the system stops offering to help.
  // An explicit keystroke still works; what is suppressed is the affordance,
  // which `shouldOfferPromotion` handles. A direct request is honored.
  const to = step(node.binding, 1) as PromotionTarget | undefined;
  if (!to) {
    return { ok: false, code: 'not_promotable', message: 'Nothing above wired.' };
  }

  const proposal: PromotionProposal = {
    ok: true,
    nodeId: node.id,
    from: node.binding,
    to,
  };
  if (ctx.recognition) {
    proposal.proposedKind = ctx.recognition.kind;
    proposal.confidence = ctx.recognition.confidence;
    if (ctx.recognition.params) proposal.proposedParams = ctx.recognition.params;
  }
  return proposal;
}

/**
 * Commits a proposal. Returns a new node; the caller writes it back into the
 * document so the change lands on the single shared undo stack (guardrail #1).
 */
export function applyPromotion(
  node: PicassoNode,
  proposal: PromotionProposal,
  commit: AnalystCommit,
  edits?: { kind?: NodeKind; params?: Record<string, ParamValue> },
): PicassoNode {
  if (proposal.nodeId !== node.id) {
    throw new Error(`Proposal is for ${proposal.nodeId}, not ${node.id}`);
  }
  if (proposal.from !== node.binding) {
    throw new Error(`Proposal is stale: node is ${node.binding}, proposal assumed ${proposal.from}`);
  }
  void commit; // the type is the enforcement; the value is written to the audit log by the caller

  const kind = edits?.kind ?? proposal.proposedKind ?? node.kind;
  const params = { ...node.params, ...proposal.proposedParams, ...edits?.params };

  const next: PicassoNode = {
    ...node,
    kind,
    params,
    binding: proposal.to,
    // A promoted node has not computed yet; it is stale, not ready.
    state: { ...node.state, status: 'stale' },
  };
  // Promotion off `loose` clears the frozen card: the node is live again.
  delete next.frozen;
  return next;
}

export type DemotionMode = 'unwire' | 'freeze';

export interface DemotionOptions {
  mode?: DemotionMode;
  /** Values to stamp into the frozen card. Defaults to the node's params. */
  values?: Record<string, ParamValue>;
  /** Canvas asof to stamp on the frozen card. */
  asof?: string;
  now?: number;
}

/**
 * `Cmd ↓`. "A wired node unwires to `bound`, or freezes to `loose`."
 * Freezing snapshots the last computed values into a static card stamped with
 * the asof timestamp, so a chart in a presentation region does not silently
 * repaint during a meeting.
 */
export function applyDemotion(
  node: PicassoNode,
  commit: AnalystCommit,
  options: DemotionOptions = {},
): PicassoNode {
  void commit;
  const mode: DemotionMode = options.mode ?? (node.binding === 'wired' ? 'unwire' : 'freeze');
  const to = mode === 'freeze' ? 'loose' : step(node.binding, -1);
  if (!to) return node;

  if (to === 'loose') {
    const frozen: FrozenSnapshot = {
      values: options.values ?? { ...node.params },
      asof: options.asof ?? node.provenance.asof,
      frozenAt: options.now ?? Date.now(),
      previousBinding: node.binding,
    };
    return {
      ...node,
      binding: 'loose',
      frozen,
      // PRD 3.2: loose objects never enter the scheduler and hold no cache key.
      state: { status: 'idle' },
    };
  }

  return { ...node, binding: to, state: { ...node.state, status: 'stale' } };
}

/** Ambient promote affordance state (PRD 3.2.1, path 2). */
export interface SuggestionState {
  nodeId: string;
  /** When the affordance first appeared. */
  shownAt: number;
  /** Last edit to the object; a later edit re-arms a dismissed suggestion. */
  lastEditedAt?: number;
  /** Set once the affordance has faded without being taken. */
  dismissedAt?: number;
}

/** "It fades after 20 seconds and does not return for that object unless the object is edited." */
export const SUGGESTION_FADE_MS = 20_000;

/** The recognizer confidence floor for offering an ambient affordance. */
export const SUGGESTION_CONFIDENCE_FLOOR = 0.85;

/**
 * Whether the corner dot should be offered at all. Sketch frames suppress it
 * entirely; so does a low-confidence recognition or a resolution failure.
 */
export function shouldOfferPromotion(
  node: PicassoNode,
  ctx: PromotionContext & { semanticResolved?: boolean } = {},
): boolean {
  if (node.binding === 'wired') return false;
  if (ctx.frame?.frameMode === 'sketch') return false;
  if (!ctx.recognition) return false;
  if (ctx.recognition.confidence <= SUGGESTION_CONFIDENCE_FLOOR) return false;
  return ctx.semanticResolved !== false;
}

/**
 * Whether the affordance is currently on screen. It does not pulse, animate,
 * interrupt or auto-apply; it only exists or does not.
 */
export function isSuggestionVisible(state: SuggestionState, now: number): boolean {
  const rearmed = state.dismissedAt !== undefined
    && state.lastEditedAt !== undefined
    && state.lastEditedAt > state.dismissedAt;
  const anchor = rearmed ? (state.lastEditedAt as number) : state.shownAt;
  if (state.dismissedAt !== undefined && !rearmed) return false;
  return now - anchor < SUGGESTION_FADE_MS;
}

/** Default binding for a new object, decided by the frame it lands in (PRD 3.2.4). */
export function defaultBindingForFrame(frameMode: FrameMode | undefined): BindingState {
  if (frameMode === 'live') return 'bound';
  return 'loose';
}

/** PRD 3.2: loose objects never enter the scheduler. */
export function participatesInScheduler(node: PicassoNode): boolean {
  return node.binding !== 'loose';
}

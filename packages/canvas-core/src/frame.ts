/**
 * Frames, and collapsing them (PRD 3.8, 3.2.4).
 *
 * > | Frame | `Cmd G` on selection | Creates a collapsible `FrameNode` |
 *
 * A frame is a node that owns other nodes. Three things follow from that and
 * each is a decision rather than a detail.
 *
 * **Framing does not move anything.** The frame is fitted around the selection
 * where the selection already is. An operation that rearranged the canvas to
 * tidy the frame would destroy the layout the analyst built, and the layout is
 * part of the analysis.
 *
 * **Collapsing hides members from the scene, not from the graph.** A collapsed
 * frame's members keep computing, keep their cache keys, and keep feeding
 * whatever they fed. Collapse is a view operation: an analyst who folds away
 * the twelve nodes that produced a number still wants the number. Treating it
 * as a graph operation would mean unfolding a frame recomputed everything
 * inside it, which is the opposite of why anyone folds one.
 *
 * **Edges that cross the boundary are the interesting case.** When a frame is
 * collapsed, an edge from outside into a hidden member has to attach
 * somewhere, and `crossings` reports those so the renderer can draw them to the
 * frame's own edge. An edge wholly inside is hidden with its endpoints; an edge
 * wholly outside is untouched.
 */

import type { CanvasDocument, Edge, FrameMode, NodeID, PicassoNode } from './types.js';
import type { Rect } from './viewport.js';

/** Padding between the selection's bounds and the frame's, in world units. */
export const FRAME_PADDING = 32;

/** Extra space at the top for the frame's title bar. */
export const FRAME_HEADER = 28;

export interface FrameOptions {
  id: NodeID;
  title?: string;
  /** PRD 3.2.4. A `sketch` frame suppresses promotion affordances inside it. */
  mode?: FrameMode;
  padding?: number;
}

export class EmptyFrame extends Error {
  constructor() {
    super('a frame needs at least one node in it');
    this.name = 'EmptyFrame';
  }
}

export class FrameWouldNest extends Error {
  constructor(readonly nodeId: NodeID) {
    super(`${nodeId} is already inside another frame`);
    this.name = 'FrameWouldNest';
  }
}

/**
 * `Cmd G`: wrap a selection in a frame.
 *
 * Mutates the document — the members gain a `parentFrame` and the frame is
 * added — and returns the frame. A node already inside a frame is refused
 * rather than silently re-parented, because a node can only have one owner and
 * quietly moving it is an edit the analyst did not ask for.
 */
export function frameSelection(
  doc: CanvasDocument,
  selection: Iterable<NodeID>,
  options: FrameOptions,
): PicassoNode {
  const members: PicassoNode[] = [];
  for (const id of selection) {
    const node = doc.nodes.get(id);
    if (!node) continue;
    if (node.parentFrame !== undefined) throw new FrameWouldNest(id);
    members.push(node);
  }
  if (members.length === 0) throw new EmptyFrame();

  const padding = options.padding ?? FRAME_PADDING;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let lowestZ = Infinity;
  for (const node of members) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + node.size.w);
    maxY = Math.max(maxY, node.position.y + node.size.h);
    lowestZ = Math.min(lowestZ, node.z);
  }

  const frame: PicassoNode = {
    id: options.id,
    kind: 'FrameNode',
    binding: 'loose',
    position: { x: minX - padding, y: minY - padding - FRAME_HEADER },
    size: { w: maxX - minX + padding * 2, h: maxY - minY + padding * 2 + FRAME_HEADER },
    // Behind its members, so framing does not cover what it framed.
    z: lowestZ - 1,
    inputs: [],
    outputs: [],
    params: { title: options.title ?? 'Frame', collapsed: false },
    // A frame holds nothing and computes nothing, so it is idle rather than
    // stale — the same rule every loose object follows.
    state: { status: 'idle' },
    provenance: { datasetSnapshots: {}, asof: '', verified: true },
    entitlementTags: [],
    createdBy: 'user',
    ...(options.mode !== undefined ? { frameMode: options.mode } : {}),
  };

  doc.nodes.set(frame.id, frame);
  for (const node of members) node.parentFrame = frame.id;
  return frame;
}

/** Direct members of a frame. */
export function membersOf(doc: CanvasDocument, frameId: NodeID): NodeID[] {
  const ids: NodeID[] = [];
  for (const node of doc.nodes.values()) {
    if (node.parentFrame === frameId) ids.push(node.id);
  }
  return ids.sort();
}

/**
 * Members, and members of frames inside it, to any depth.
 *
 * `frameSelection` refuses to nest, but a frame can be nested by hand or by a
 * peer's edit arriving over sync, and a collapse that only hid direct members
 * would leave the inner frame's contents on screen with nothing around them.
 */
export function descendantsOf(doc: CanvasDocument, frameId: NodeID): Set<NodeID> {
  const found = new Set<NodeID>();
  const stack: NodeID[] = [frameId];
  while (stack.length > 0) {
    const current = stack.pop() as NodeID;
    for (const id of membersOf(doc, current)) {
      if (found.has(id)) continue;
      found.add(id);
      stack.push(id);
    }
  }
  return found;
}

export function isCollapsed(node: PicassoNode): boolean {
  return node.kind === 'FrameNode' && node.params.collapsed === true;
}

/** Fold or unfold a frame. A view operation; nothing is invalidated. */
export function setCollapsed(doc: CanvasDocument, frameId: NodeID, collapsed: boolean): void {
  const frame = doc.nodes.get(frameId);
  if (!frame || frame.kind !== 'FrameNode') return;
  frame.params = { ...frame.params, collapsed };
}

export interface CollapseView {
  /** Nodes the renderer should not draw. */
  hidden: Set<NodeID>;
  /**
   * Edges with exactly one endpoint hidden, and the frame to draw them to.
   *
   * An edge from outside into a folded frame still carries data and still has
   * to be visible, or the analyst loses the only sign that the frame is wired
   * into anything.
   */
  crossings: Array<{ edge: Edge; frameId: NodeID; hiddenEnd: 'from' | 'to' }>;
}

/**
 * What a set of collapsed frames hides, and what has to be re-attached.
 *
 * Takes the whole document rather than one frame, because an edge can cross
 * two folded frames at once and the answer for it is not the union of two
 * single-frame answers — both ends are hidden, so it is hidden too.
 */
export function collapseView(doc: CanvasDocument): CollapseView {
  const hidden = new Set<NodeID>();
  const frameOf = new Map<NodeID, NodeID>();

  for (const node of doc.nodes.values()) {
    if (!isCollapsed(node)) continue;
    for (const id of descendantsOf(doc, node.id)) {
      hidden.add(id);
      // The outermost collapsed frame wins: an edge into a folded frame inside
      // another folded frame attaches to the one the analyst can actually see.
      if (!frameOf.has(id) || frameOf.get(id) === node.id) frameOf.set(id, node.id);
    }
  }

  // Resolve to the outermost collapsed ancestor.
  for (const id of hidden) {
    let owner = frameOf.get(id) as NodeID;
    let guard = 0;
    while (hidden.has(owner) && frameOf.has(owner) && guard < 64) {
      owner = frameOf.get(owner) as NodeID;
      guard += 1;
    }
    frameOf.set(id, owner);
  }

  const crossings: CollapseView['crossings'] = [];
  for (const edge of doc.edges.values()) {
    const fromHidden = hidden.has(edge.from.nodeId);
    const toHidden = hidden.has(edge.to.nodeId);
    if (fromHidden === toHidden) continue;
    const hiddenEnd = fromHidden ? 'from' : 'to';
    const frameId = frameOf.get(fromHidden ? edge.from.nodeId : edge.to.nodeId) as NodeID;
    crossings.push({ edge, frameId, hiddenEnd });
  }

  return { hidden, crossings };
}

/** The rectangle a frame occupies, for hit testing and fly-to. */
export function frameRect(frame: PicassoNode): Rect {
  return {
    minX: frame.position.x,
    minY: frame.position.y,
    maxX: frame.position.x + frame.size.w,
    maxY: frame.position.y + frame.size.h,
  };
}

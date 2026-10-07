/**
 * Tools, not modes (PRD 3.2.3).
 *
 * "The pen, the pointer, and the wire tool are tool selections in the sense
 * that Figma has tool selections, not application modes. Switching tools
 * changes what a drag does. It never changes what is visible, never re-lays-out
 * the canvas, and never hides the other class of object."
 *
 * That sentence is enforced by what this module can reach. `ToolState` holds
 * the analyst's choice and which pointers are down, and nothing else: no
 * document, no viewport, no visibility. `dragIntent` takes the tool and what is
 * under the pointer and returns what the drag *will* do; it mutates nothing.
 * The scene builder, for its part, takes no tool. So a tool switch has no path
 * to the picture — not by discipline, but because neither side holds the other.
 *
 * | Key | Tool    | Drag                                                     |
 * |-----|---------|----------------------------------------------------------|
 * | V   | Pointer | select, move, resize — on everything, any binding state  |
 * | P   | Pen     | ink: loose strokes                                       |
 * | W   | Wire    | from a port, a data edge with live type checking; from   |
 * |     |         | anywhere else, an annotation arrow                       |
 * | C   | Causal  | a causal edge, and the sign/lag/elasticity editor opens  |
 * | T   | Text    | a loose sticky note; `Shift T`, a bound TextPad           |
 *
 * "Stylus input auto-selects the Pen tool on pen-tip contact and restores the
 * previous tool on lift, so a pen user never presses `P`. Finger and mouse
 * never auto-switch, which kills the classic palm-and-scroll conflict." The
 * second half is a rule about touches as well as tools: while a stylus is on the
 * glass, a touch is the hand holding it, and it is refused rather than allowed
 * to pan the canvas out from under the stroke.
 */

import type { CanvasDocument, NodeID } from './types.js';
import { connect, type ConnectResult } from './document.js';
import { compatibleInputPorts, type ConnectionFix } from './ports.js';
import { wouldCreateCycle } from './graph.js';

export type Tool = 'pointer' | 'pen' | 'wire' | 'causal' | 'text';

/** `PointerEvent.pointerType`. */
export type InputDevice = 'mouse' | 'touch' | 'pen';

export type TextVariant = 'sticky' | 'textpad';

export interface KeyInput {
  /** `KeyboardEvent.key`. */
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  /** True when focus is in something that takes text: a sticky, a TextPad, a field. */
  editingText?: boolean;
}

const KEYS: Record<string, Tool> = { v: 'pointer', p: 'pen', w: 'wire', c: 'causal', t: 'text' };

export type PointerDecision =
  | { accepted: true; tool: Tool }
  /** A touch while a stylus is down: the palm, not a gesture. */
  | { accepted: false; reason: 'palm' };

export class ToolState {
  private chosen: Tool = 'pointer';
  private variant: TextVariant = 'sticky';
  /** Pens currently on the glass, by pointer id. */
  private readonly stylus = new Set<number>();
  /** Pointers accepted at down, so their up is matched and a refused one is not. */
  private readonly accepted = new Set<number>();

  /** The tool the analyst chose. */
  get selected(): Tool {
    return this.chosen;
  }

  /** The tool a drag starting now would use: the pen while a stylus is down. */
  get active(): Tool {
    return this.stylus.size > 0 ? 'pen' : this.chosen;
  }

  get textVariant(): TextVariant {
    return this.variant;
  }

  /**
   * Applies a key. Returns whether the key was a tool switch.
   *
   * A key with Ctrl, Cmd or Alt is somebody else's shortcut — `Ctrl V` is
   * paste, not the pointer — and a key typed into a note is text. Neither
   * switches anything.
   */
  key(input: KeyInput): boolean {
    if (input.ctrl || input.meta || input.alt || input.editingText) return false;
    const tool = KEYS[input.key.toLowerCase()];
    if (!tool) return false;
    this.chosen = tool;
    if (tool === 'text') this.variant = input.shift ? 'textpad' : 'sticky';
    return true;
  }

  /**
   * A pointer touched down. A stylus puts the pen over the chosen tool until
   * it lifts; a mouse or a finger never changes the tool.
   */
  pointerDown(pointerId: number, device: InputDevice): PointerDecision {
    if (device === 'touch' && this.stylus.size > 0) return { accepted: false, reason: 'palm' };
    if (device === 'pen') this.stylus.add(pointerId);
    this.accepted.add(pointerId);
    return { accepted: true, tool: this.active };
  }

  /** A pointer lifted, or was cancelled. The chosen tool is what remains. */
  pointerUp(pointerId: number): void {
    this.stylus.delete(pointerId);
    this.accepted.delete(pointerId);
  }

  /** Whether a pointer's moves belong to a drag: false for a refused palm. */
  isTracked(pointerId: number): boolean {
    return this.accepted.has(pointerId);
  }
}

/** What is under the pointer when a drag starts. */
export type Hit =
  | { kind: 'empty' }
  | { kind: 'node'; nodeId: NodeID; resizeHandle?: boolean }
  | { kind: 'port'; nodeId: NodeID; portId: string; side: 'input' | 'output' };

export type PortRef = { nodeId: NodeID; portId: string; side: 'input' | 'output' };

export type DragIntent =
  | { kind: 'marquee' }
  | { kind: 'move'; nodeId: NodeID }
  | { kind: 'resize'; nodeId: NodeID }
  /** A loose stroke, wherever it starts — over a node too. */
  | { kind: 'ink' }
  /** A data edge from this port, type-checked live as it is dragged. */
  | { kind: 'wire'; anchor: PortRef }
  /** An annotation arrow; resolved by `resolveDrawnArrow` when it lands on something. */
  | { kind: 'arrow'; from?: NodeID }
  /** A causal edge; the sign, lag and elasticity editor opens when it lands. */
  | { kind: 'causal'; from?: NodeID }
  | { kind: 'text'; variant: TextVariant; binding: 'loose' | 'bound' };

/** What a drag with `tool` does, starting on `hit`. Pure. */
export function dragIntent(tool: Tool, hit: Hit, textVariant: TextVariant = 'sticky'): DragIntent {
  const on = hit.kind === 'empty' ? undefined : hit.nodeId;
  switch (tool) {
    case 'pointer':
      if (hit.kind === 'empty') return { kind: 'marquee' };
      if (hit.kind === 'node' && hit.resizeHandle) return { kind: 'resize', nodeId: hit.nodeId };
      return { kind: 'move', nodeId: hit.nodeId };
    case 'pen':
      return { kind: 'ink' };
    case 'wire':
      if (hit.kind === 'port') return { kind: 'wire', anchor: { nodeId: hit.nodeId, portId: hit.portId, side: hit.side } };
      return on === undefined ? { kind: 'arrow' } : { kind: 'arrow', from: on };
    case 'causal':
      return on === undefined ? { kind: 'causal' } : { kind: 'causal', from: on };
    case 'text':
      return { kind: 'text', variant: textVariant, binding: textVariant === 'textpad' ? 'bound' : 'loose' };
  }
}

/**
 * PRD 3.8: "incompatible ports dim" while a wire is dragged. Every port the
 * wire could legally land on, in the direction it is being drawn — checked with
 * the same validation `connect` will run, including cardinality and cycles, so
 * a port that lights up is one that will take the edge.
 */
export function wireTargets(doc: CanvasDocument, anchor: PortRef): PortRef[] {
  const anchorNode = doc.nodes.get(anchor.nodeId);
  if (!anchorNode) return [];
  const options = {
    edges: [...doc.edges.values()],
    wouldCreateCycle: (from: NodeID, to: NodeID) => wouldCreateCycle(doc, from, to),
  };
  const out: PortRef[] = [];
  for (const node of doc.nodes.values()) {
    if (node.id === anchor.nodeId) continue;
    if (anchor.side === 'output') {
      for (const port of compatibleInputPorts(anchorNode, anchor.portId, node, options)) {
        out.push({ nodeId: node.id, portId: port.id, side: 'input' });
      }
    } else {
      for (const port of node.outputs) {
        if (compatibleInputPorts(node, port.id, anchorNode, options).some((p) => p.id === anchor.portId)) {
          out.push({ nodeId: node.id, portId: port.id, side: 'output' });
        }
      }
    }
  }
  return out;
}

export type WireOutcome =
  | { kind: 'connected'; result: Extract<ConnectResult, { ok: true }> }
  /** Landed on a port that will not take it: the reason and the fix, inline. */
  | { kind: 'refused'; reason: string; fix?: ConnectionFix }
  /** Landed on nothing a wire can attach to. Nothing is added. */
  | { kind: 'cancelled' };

/** Releases a wire drag over `hit`. Only a port on the opposite side can take it. */
export function finishWire(doc: CanvasDocument, anchor: PortRef, hit: Hit, edgeId: string): WireOutcome {
  if (hit.kind !== 'port' || hit.side === anchor.side) return { kind: 'cancelled' };
  const [from, to] =
    anchor.side === 'output'
      ? [anchor, hit]
      : [{ nodeId: hit.nodeId, portId: hit.portId }, { nodeId: anchor.nodeId, portId: anchor.portId }];
  const result = connect(doc, {
    id: edgeId,
    from: { nodeId: from.nodeId, portId: from.portId },
    to: { nodeId: to.nodeId, portId: to.portId },
  });
  if (result.ok) return { kind: 'connected', result };
  const refused: WireOutcome = { kind: 'refused', reason: result.rejection.message };
  if (result.rejection.fix) refused.fix = result.rejection.fix;
  return refused;
}

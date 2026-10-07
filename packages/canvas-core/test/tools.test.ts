import { describe, expect, it } from 'vitest';
import { addNode, createDocument } from '../src/document.js';
import { dragIntent, finishWire, ToolState, wireTargets, type Hit, type Tool } from '../src/tools.js';
import { node, port } from './fixtures.js';

describe('the keys', () => {
  it('select the five tools, and Shift T a bound TextPad', () => {
    const tools = new ToolState();
    expect(tools.selected).toBe('pointer');
    const seen: Tool[] = [];
    for (const key of ['p', 'W', 'c', 't', 'v']) {
      expect(tools.key({ key })).toBe(true);
      seen.push(tools.selected);
    }
    expect(seen).toEqual(['pen', 'wire', 'causal', 'text', 'pointer']);
    tools.key({ key: 't' });
    expect(tools.textVariant).toBe('sticky');
    tools.key({ key: 'T', shift: true });
    expect([tools.selected, tools.textVariant]).toEqual(['text', 'textpad']);
  });

  it('leave other shortcuts and typed text alone', () => {
    const tools = new ToolState();
    tools.key({ key: 'w' });
    // Ctrl V is paste; Cmd C is copy; a P typed into a sticky is a letter.
    expect(tools.key({ key: 'v', ctrl: true })).toBe(false);
    expect(tools.key({ key: 'c', meta: true })).toBe(false);
    expect(tools.key({ key: 'p', editingText: true })).toBe(false);
    expect(tools.key({ key: 'x' })).toBe(false);
    expect(tools.selected).toBe('wire');
  });
});

describe('the stylus', () => {
  it('takes the pen on contact and gives the chosen tool back on lift', () => {
    const tools = new ToolState();
    tools.key({ key: 'w' });
    expect(tools.pointerDown(1, 'pen')).toEqual({ accepted: true, tool: 'pen' });
    expect([tools.active, tools.selected]).toEqual(['pen', 'wire']);
    tools.pointerUp(1);
    expect(tools.active).toBe('wire');
  });

  it('restores whatever was chosen while it was down', () => {
    const tools = new ToolState();
    tools.pointerDown(1, 'pen');
    tools.key({ key: 'c' });
    expect(tools.active).toBe('pen');
    tools.pointerUp(1);
    expect(tools.active).toBe('causal');
  });

  it('never moves for a mouse or a finger', () => {
    const tools = new ToolState();
    tools.key({ key: 'c' });
    expect(tools.pointerDown(1, 'mouse')).toEqual({ accepted: true, tool: 'causal' });
    expect(tools.pointerDown(2, 'touch')).toEqual({ accepted: true, tool: 'causal' });
  });

  it('refuses the palm while the pen is on the glass, and only then', () => {
    const tools = new ToolState();
    tools.pointerDown(1, 'pen');
    expect(tools.pointerDown(2, 'touch')).toEqual({ accepted: false, reason: 'palm' });
    expect(tools.isTracked(2)).toBe(false);
    // A mouse is not a palm.
    expect(tools.pointerDown(3, 'mouse').accepted).toBe(true);
    tools.pointerUp(1);
    expect(tools.pointerDown(4, 'touch').accepted).toBe(true);
  });
});

describe('what a drag does', () => {
  const port_: Hit = { kind: 'port', nodeId: 'a', portId: 'out', side: 'output' };
  const body: Hit = { kind: 'node', nodeId: 'a' };
  const empty: Hit = { kind: 'empty' };

  it('follows the PRD 3.2.3 table', () => {
    expect(dragIntent('pointer', empty)).toEqual({ kind: 'marquee' });
    expect(dragIntent('pointer', body)).toEqual({ kind: 'move', nodeId: 'a' });
    expect(dragIntent('pointer', port_)).toEqual({ kind: 'move', nodeId: 'a' });
    expect(dragIntent('pointer', { ...body, resizeHandle: true })).toEqual({ kind: 'resize', nodeId: 'a' });
    // The pen inks wherever it starts, over a node too.
    for (const hit of [empty, body, port_]) expect(dragIntent('pen', hit)).toEqual({ kind: 'ink' });
    expect(dragIntent('wire', port_)).toEqual({ kind: 'wire', anchor: { nodeId: 'a', portId: 'out', side: 'output' } });
    expect(dragIntent('wire', empty)).toEqual({ kind: 'arrow' });
    expect(dragIntent('wire', body)).toEqual({ kind: 'arrow', from: 'a' });
    expect(dragIntent('causal', body)).toEqual({ kind: 'causal', from: 'a' });
    expect(dragIntent('text', empty)).toEqual({ kind: 'text', variant: 'sticky', binding: 'loose' });
    expect(dragIntent('text', empty, 'textpad')).toEqual({ kind: 'text', variant: 'textpad', binding: 'bound' });
  });
});

describe('the wire', () => {
  function canvas() {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'src', outputs: [port('s', 'series', { emits: { frequency: 'daily' } })] }));
    addNode(doc, node({ id: 'daily', inputs: [port('in', 'series', { constraints: { frequency: ['daily'] } })] }));
    addNode(doc, node({ id: 'monthly', inputs: [port('in', 'series', { constraints: { frequency: ['monthly'] } })] }));
    addNode(doc, node({ id: 'book', inputs: [port('x', 'portfolio')] }));
    addNode(doc, node({ id: 'loose', binding: 'loose', inputs: [port('in', 'series')] }));
    return doc;
  }

  it('lights up exactly the ports that will take it', () => {
    const doc = canvas();
    expect(wireTargets(doc, { nodeId: 'src', portId: 's', side: 'output' })).toEqual([
      { nodeId: 'daily', portId: 'in', side: 'input' },
    ]);
    // Dragged backwards from an input, it finds the outputs that could feed it.
    expect(wireTargets(doc, { nodeId: 'daily', portId: 'in', side: 'input' })).toEqual([
      { nodeId: 'src', portId: 's', side: 'output' },
    ]);
  });

  it('connects where it lit up, refuses with the reason elsewhere, and adds nothing on empty space', () => {
    const doc = canvas();
    const anchor = { nodeId: 'src', portId: 's', side: 'output' } as const;
    expect(finishWire(doc, anchor, { kind: 'empty' }, 'e0').kind).toBe('cancelled');
    const refused = finishWire(doc, anchor, { kind: 'port', nodeId: 'book', portId: 'x', side: 'input' }, 'e1');
    expect(refused.kind).toBe('refused');
    // A frequency mismatch is refused with the one-click resample fix attached.
    const monthly = finishWire(doc, anchor, { kind: 'port', nodeId: 'monthly', portId: 'in', side: 'input' }, 'e1b');
    expect(monthly).toMatchObject({ kind: 'refused', fix: { kind: 'insert_node', op: 'resample', to: 'monthly' } });
    expect(doc.edges.size).toBe(0);
    const made = finishWire(doc, anchor, { kind: 'port', nodeId: 'daily', portId: 'in', side: 'input' }, 'e2');
    expect(made.kind).toBe('connected');
    expect(doc.edges.get('e2')?.class).toBe('data');
    // The port is now occupied, so it no longer lights up.
    expect(wireTargets(doc, anchor)).toEqual([]);
  });

  it('lands the same edge when drawn from the input end', () => {
    const doc = canvas();
    const made = finishWire(
      doc,
      { nodeId: 'daily', portId: 'in', side: 'input' },
      { kind: 'port', nodeId: 'src', portId: 's', side: 'output' },
      'e3',
    );
    expect(made.kind).toBe('connected');
    expect(doc.edges.get('e3')).toMatchObject({ from: { nodeId: 'src', portId: 's' }, to: { nodeId: 'daily', portId: 'in' } });
  });
});

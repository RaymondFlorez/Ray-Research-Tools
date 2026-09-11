import { createNode } from '../src/document.js';
import type { NodeKind, PicassoNode, Port, PortType } from '../src/types.js';

let seq = 0;
export function nextId(prefix = 'n'): string {
  seq += 1;
  return `${prefix}${seq}`;
}

export function port(
  id: string,
  type: PortType,
  overrides: Partial<Port> = {},
): Port {
  return {
    id,
    name: overrides.name ?? id,
    type,
    cardinality: overrides.cardinality ?? 'one',
    required: overrides.required ?? true,
    ...(overrides.constraints ? { constraints: overrides.constraints } : {}),
    ...(overrides.emits ? { emits: overrides.emits } : {}),
  };
}

export interface NodeOptions {
  id?: string;
  kind?: NodeKind;
  binding?: PicassoNode['binding'];
  inputs?: Port[];
  outputs?: Port[];
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  verified?: boolean;
  status?: PicassoNode['state']['status'];
  params?: PicassoNode['params'];
  cacheKey?: string;
  pinned?: boolean;
}

export function node(options: NodeOptions = {}): PicassoNode {
  const n = createNode({
    id: options.id ?? nextId(),
    kind: options.kind ?? 'ChartNode',
    binding: options.binding ?? 'wired',
    position: { x: options.x ?? 0, y: options.y ?? 0 },
    size: { w: options.w ?? 100, h: options.h ?? 100 },
    inputs: options.inputs ?? [],
    outputs: options.outputs ?? [],
    params: options.params ?? {},
    provenance: {
      datasetSnapshots: {},
      asof: '2026-01-02T00:00:00Z',
      verified: options.verified ?? true,
    },
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
  });
  n.state = { status: options.status ?? 'ready' };
  if (options.cacheKey) n.state.cacheKey = options.cacheKey;
  return n;
}

/**
 * Snapshots and named versions (PRD 3.9).
 *
 * "Named versions ("pre-CPI", "bear case") are immutable snapshots referencing
 * dataset snapshot IDs, so reopening a version reproduces the exact numbers."
 *
 * That last clause is the whole point, and it is why a version is not just a
 * copy of the document. The document says which nodes exist and how they are
 * wired; the dataset snapshot IDs say which data they were computed against.
 * Reopening a version without them reproduces the structure and silently
 * recomputes against today's data, which is the restatement leak the canvas
 * exists to prevent.
 */

import * as Y from 'yjs';
import { SyncedCanvas } from './canvas.js';

/** The document as bytes. Persisted to Postgres every 30s and on idle. */
export function encodeSnapshot(canvas: SyncedCanvas): Uint8Array {
  return Y.encodeStateAsUpdate(canvas.doc);
}

export function restoreSnapshot(update: Uint8Array): SyncedCanvas {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return new SyncedCanvas({ doc });
}

export interface NamedVersion {
  name: string;
  createdAt: number;
  createdBy: string;
  /** The document at the moment the version was taken. */
  update: Uint8Array;
  /** source -> Iceberg snapshot ID. Without these the version is not reproducible. */
  datasetSnapshots: Record<string, string>;
  /** Canvas time the version was taken at. */
  asof: string;
  note?: string;
}

export interface CreateVersionInput {
  name: string;
  createdBy: string;
  datasetSnapshots: Record<string, string>;
  asof: string;
  now?: number;
  note?: string;
}

export function createNamedVersion(
  canvas: SyncedCanvas,
  input: CreateVersionInput,
): NamedVersion {
  const version: NamedVersion = {
    name: input.name,
    createdAt: input.now ?? Date.now(),
    createdBy: input.createdBy,
    update: encodeSnapshot(canvas),
    datasetSnapshots: { ...input.datasetSnapshots },
    asof: input.asof,
  };
  if (input.note !== undefined) version.note = input.note;
  return version;
}

export function openVersion(version: NamedVersion): SyncedCanvas {
  return restoreSnapshot(version.update);
}

/**
 * A canvas template: structure without instrument bindings, so a completed
 * analysis re-runs against a new ticker in one action (PRD 3.9).
 *
 * The params listed in `bindingParams` are what makes a canvas about one name
 * rather than about a method; stripping them is what turns an analysis into a
 * reusable one.
 */
export const DEFAULT_BINDING_PARAMS = ['ticker', 'instrument', 'symbol', 'universe', 'portfolio'];

export function stripInstrumentBindings(
  canvas: SyncedCanvas,
  bindingParams: readonly string[] = DEFAULT_BINDING_PARAMS,
): SyncedCanvas {
  const template = restoreSnapshot(encodeSnapshot(canvas));
  template.transact(() => {
    for (const node of template.snapshot().nodes.values()) {
      for (const key of bindingParams) {
        if (key in node.params) template.setParam(node.id, key, null);
      }
    }
  });
  return template;
}

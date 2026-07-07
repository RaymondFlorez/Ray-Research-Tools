import {
  applyPatch as jsonApplyPatch,
  deepClone,
  validate as jsonValidateOps,
  type Operation,
} from 'fast-json-patch';
import { SceneStateSchema } from './schema';
import type { SceneState } from './types';

/** An RFC 6902 JSON Patch operation. */
export type PatchOp = Operation;

/** Thrown when a patch is malformed or would produce an invalid Scene State. */
export class ScenePatchError extends Error {
  constructor(
    message: string,
    /** 'operation' = the patch itself is malformed; 'schema' = the result is invalid. */
    readonly kind: 'operation' | 'schema',
  ) {
    super(message);
    this.name = 'ScenePatchError';
  }
}

/**
 * Apply an RFC 6902 patch to a Scene State **immutably**, rejecting the change if the
 * operations are malformed or the result violates the schema. The input `scene` is
 * never mutated. This is the single chokepoint every mutation (UI or agent) flows
 * through, which is what keeps the client from ever holding an invalid scene.
 */
export function applyScenePatch(scene: SceneState, ops: readonly PatchOp[]): SceneState {
  // 1. Reject malformed operations (bad op name, missing path, etc.) before touching state.
  const opError = jsonValidateOps(ops as Operation[], deepClone(scene));
  if (opError) {
    throw new ScenePatchError(`Invalid patch operation: ${opError.message}`, 'operation');
  }

  // 2. Apply to a deep clone so the caller's scene stays untouched.
  const working = deepClone(scene);
  const { newDocument } = jsonApplyPatch(working, ops as Operation[], true, true);

  // 3. The result must still be a valid Scene State, or the whole patch is rejected.
  const parsed = SceneStateSchema.safeParse(newDocument);
  if (!parsed.success) {
    throw new ScenePatchError(
      `Patch produced an invalid Scene State: ${parsed.error.message}`,
      'schema',
    );
  }
  return parsed.data;
}

/**
 * Validate + normalize an arbitrary value into a Scene State (applies schema defaults).
 * Throws if the value is not a valid scene.
 */
export function parseScene(value: unknown): SceneState {
  return SceneStateSchema.parse(value);
}

/** Build the default empty scene (camera centered, no data layers). */
export function createInitialScene(): SceneState {
  return SceneStateSchema.parse({
    viewport: { longitude: 0, latitude: 20, zoom: 0.9 },
    selection: null,
  });
}

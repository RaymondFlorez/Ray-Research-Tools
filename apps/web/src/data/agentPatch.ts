import type { PatchOp, SceneState } from '@geoglobe/scene-schema';

/**
 * The agent addresses layers by id (`/layers/~<id>` or `/layers/~<id>/<field>`) because
 * it doesn't track array indices. Resolve those into standard RFC 6902 index paths
 * against the current scene before the store applies them. Ops without the `~id`
 * convention pass through unchanged.
 */
export function resolveAgentOps(scene: SceneState, ops: PatchOp[]): PatchOp[] {
  return ops.map((op) => {
    const match = /^\/layers\/~([^/]+)(\/.*)?$/.exec(op.path);
    if (!match) return op;
    const id = decodeURIComponent(match[1]);
    const rest = match[2] ?? '';
    const index = scene.layers.findIndex((l) => l.id === id);
    if (index === -1) {
      throw new Error(`agent referenced unknown layer '${id}'`);
    }
    return { ...op, path: `/layers/${index}${rest}` };
  });
}

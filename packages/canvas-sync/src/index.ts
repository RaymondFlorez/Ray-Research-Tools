/**
 * @picasso/canvas-sync
 *
 * Collaboration for the Picasso canvas: the Yjs document schema, the bindings
 * that keep the plain document model and the CRDT in step, presence, offline
 * reconciliation, and snapshots.
 *
 * The rule that shapes all of it: the document syncs, the computation does not.
 */

export * from './schema.js';
export * from './canvas.js';
export * from './transport.js';
export * from './presence.js';
export * from './snapshot.js';

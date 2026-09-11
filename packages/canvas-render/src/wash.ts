/**
 * Passive-mode live wash and anomaly halos (PRD 3.6).
 *
 * "A translucent heat layer paints over nodes whose underlying data has moved
 * beyond a per-node z-threshold in the current session. Intensity decays with a
 * 20 minute half-life so the canvas shows recent, not cumulative, motion."
 *
 * The decay is the whole point: a wash that accumulates tells you what moved
 * today, which by 4pm is everything. This one tells you what moved just now.
 */

import type { NodeID } from '@picasso/canvas-core';
import type { Theme } from './theme.js';

export const WASH_HALF_LIFE_MS = 20 * 60 * 1000;

/** Below this the wash is not worth a draw call. */
export const WASH_EPSILON = 0.02;

export type Severity = 'low' | 'medium' | 'high';

/**
 * Maps a move to wash intensity in [0, 1]. A move at the threshold registers
 * faintly; saturation is three thresholds out.
 */
export function washIntensity(zScore: number, threshold = 2): number {
  const z = Math.abs(zScore);
  if (z < threshold) return 0;
  return Math.min(1, (z - threshold) / (threshold * 2) + 0.2);
}

/** Exponential decay with a 20 minute half-life. */
export function decay(intensity: number, elapsedMs: number, halfLifeMs = WASH_HALF_LIFE_MS): number {
  if (elapsedMs <= 0) return intensity;
  return intensity * Math.pow(0.5, elapsedMs / halfLifeMs);
}

export function severityFor(zScore: number, threshold = 2): Severity {
  const z = Math.abs(zScore);
  if (z >= threshold * 2.5) return 'high';
  if (z >= threshold * 1.5) return 'medium';
  return 'low';
}

export function haloColor(severity: Severity, theme: Theme): string {
  switch (severity) {
    case 'low':
      return theme.haloLow;
    case 'medium':
      return theme.haloMedium;
    case 'high':
      return theme.haloHigh;
  }
}

interface WashEntry {
  intensity: number;
  at: number;
  severity: Severity;
}

/**
 * Per-node wash state. Bumping an already-hot node takes the max of the decayed
 * value and the new one rather than summing, so a series that ticks constantly
 * does not pin itself at full heat.
 */
export class WashLayer {
  private entries = new Map<NodeID, WashEntry>();

  constructor(private readonly halfLifeMs = WASH_HALF_LIFE_MS) {}

  /** Records a move. Returns the resulting intensity. */
  bump(nodeId: NodeID, zScore: number, now: number, threshold = 2): number {
    const incoming = washIntensity(zScore, threshold);
    if (incoming <= 0) return this.intensityAt(nodeId, now);

    const current = this.intensityAt(nodeId, now);
    const intensity = Math.max(current, incoming);
    this.entries.set(nodeId, { intensity, at: now, severity: severityFor(zScore, threshold) });
    return intensity;
  }

  intensityAt(nodeId: NodeID, now: number): number {
    const entry = this.entries.get(nodeId);
    if (!entry) return 0;
    return decay(entry.intensity, now - entry.at, this.halfLifeMs);
  }

  severityOf(nodeId: NodeID): Severity | undefined {
    return this.entries.get(nodeId)?.severity;
  }

  /** Everything still worth painting, hottest first. */
  active(now: number): Array<{ nodeId: NodeID; intensity: number; severity: Severity }> {
    const out: Array<{ nodeId: NodeID; intensity: number; severity: Severity }> = [];
    for (const [nodeId, entry] of this.entries) {
      const intensity = decay(entry.intensity, now - entry.at, this.halfLifeMs);
      if (intensity >= WASH_EPSILON) out.push({ nodeId, intensity, severity: entry.severity });
    }
    return out.sort((a, b) => b.intensity - a.intensity);
  }

  /** Drops entries that have decayed below the draw threshold. */
  prune(now: number): number {
    let dropped = 0;
    for (const [nodeId, entry] of this.entries) {
      if (decay(entry.intensity, now - entry.at, this.halfLifeMs) < WASH_EPSILON) {
        this.entries.delete(nodeId);
        dropped += 1;
      }
    }
    return dropped;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

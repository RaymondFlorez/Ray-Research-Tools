/**
 * The surface seam: canvas-pricing's StrategyNode → canvas-render's
 * SurfaceNode (PRD 3.3, 5.4).
 *
 * The engine prices a grid; the surface module draws and picks a grid. Each is
 * tested alone. What neither can check is that they mean the same grid: that a
 * cell's spot is the column the heatmap puts it in, that vol runs the way the
 * picture says, that what the cursor reads in 3D is the number the engine
 * produced at that point, and that the break-even line sits where the engine's
 * P&L changes sign.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { addNode, connect, createDocument } from '@picasso/canvas-core';
import { createStrategyNode, evaluateStrategy, GridPricer, pnlSurface, type GridResult, type Leg } from '@picasso/canvas-pricing';
import {
  contour,
  createSurfaceNode,
  heatmapCells,
  heatmapPick,
  project,
  surfaceMesh,
  surfacePick,
  valueAt,
  worldPoint,
  zDomain,
  type SurfaceGrid,
} from '@picasso/canvas-render';
import { loadPricing } from './load.js';

const leg = (strike: number, kind: Leg['kind'], quantity: number, vol: number): Leg => ({
  strike, kind, quantity, vol, time: 0.5, style: 'european', multiplier: 100,
});
// A short strangle: makes money in the middle, loses on both wings and on vol.
const legs = [leg(90, 'put', -20, 0.31), leg(110, 'call', -20, 0.26)];
const market = { spot: 100, rate: 0.045, dividend: 0.017 };
const rect = { minX: 0, minY: 0, maxX: 500, maxY: 300 };

let result: GridResult;
let grid: SurfaceGrid;

beforeAll(async () => {
  const doc = createDocument('c');
  const strategy = addNode(doc, createStrategyNode({
    id: 'strangle', legs, market,
    grid: { spotSteps: 25, spotRange: 0.25, volSteps: 15, volRange: 0.1 },
  }));
  addNode(doc, createSurfaceNode({ id: 'surface', view: '3d' }));
  // The StrategyNode's P&L port and the SurfaceNode's input are the same type.
  const wired = connect(doc, { id: 'e', from: { nodeId: 'strangle', portId: 'pnl' }, to: { nodeId: 'surface', portId: 'grid' } });
  expect(wired.ok).toBe(true);
  const evaluated = evaluateStrategy(strategy, new GridPricer(await loadPricing()));
  if (!evaluated.ok) throw new Error(evaluated.message);
  result = evaluated.result;
  grid = pnlSurface(result);
});

describe('the surface draws the grid the engine priced', () => {
  it('puts spot across and vol up, and reads back the engine\'s P&L at every cell', () => {
    const base = result.cell(12, 7).value;
    expect(valueAt(grid, 12, 7)).toBe(0);
    for (const cell of heatmapCells(grid, rect)) {
      const centre = { x: (cell.rect.minX + cell.rect.maxX) / 2, y: (cell.rect.minY + cell.rect.maxY) / 2 };
      const picked = heatmapPick(grid, rect, centre)!;
      expect(picked.value).toBe(result.cell(picked.i, picked.j).value - base);
      expect(picked.x).toBe(result.spotAxis[picked.i]);
      expect(picked.y).toBe(result.volAxis[picked.j]);
    }
    // Left is lower spot, top is higher vol: a short strangle loses more at the
    // top of the picture than the bottom, at the money.
    expect(result.spotAxis[0]).toBeLessThan(result.spotAxis[24]!);
    expect(valueAt(grid, 12, 14)).toBeLessThan(valueAt(grid, 12, 0));
  });

  it('reads the engine\'s number under the cursor in 3D, wherever the point is visible', () => {
    const camera = { azimuth: 0.7, elevation: 0.55, distance: 4, rect };
    const mesh = surfaceMesh(grid, camera);
    const d = zDomain(grid);
    let read = 0;
    for (let j = 0; j < 15; j += 3) {
      for (let i = 0; i < 25; i += 3) {
        const p = project(camera, worldPoint(grid, d, i, j, valueAt(grid, i, j)));
        const picked = surfacePick(grid, mesh, { x: p.x, y: p.y });
        if (!picked || picked.i !== i || picked.j !== j) continue; // hidden behind a ridge
        expect(picked.value).toBe(result.cell(i, j).value - result.cell(12, 7).value);
        read += 1;
      }
    }
    expect(read).toBeGreaterThan(30);
  });

  it('draws break-even between engine cells of opposite sign, and nowhere else', () => {
    const segments = contour(grid);
    expect(segments.length).toBeGreaterThan(5);
    const pnl = (i: number, j: number) => result.cell(i, j).value - result.cell(12, 7).value;
    for (const [a, b] of segments) {
      for (const p of [a, b]) {
        const [i0, i1] = [Math.floor(p.i), Math.ceil(p.i)];
        const [j0, j1] = [Math.floor(p.j), Math.ceil(p.j)];
        expect(Math.sign(pnl(i0, j0)) !== Math.sign(pnl(i1, j1)) || pnl(i0, j0) === 0).toBe(true);
      }
    }
  });
});

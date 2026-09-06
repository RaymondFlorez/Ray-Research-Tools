/**
 * Canvas2D painter for a Scene.
 *
 * This is a reference painter, not the shipping renderer: the real one puts
 * edges, ink and LOD proxies on the GPU and mounts React DOM for LOD2 nodes.
 * What it proves is that the draw list carries everything a renderer needs, and
 * that the binding signatures and the LOD ladder read correctly on screen.
 */

import {
  pulsePhase,
  sampleQuadratic,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type Theme,
} from '@picasso/canvas-render';

export interface DrawOptions {
  theme: Theme;
  now: number;
  /** Device pixel ratio the context is already scaled by. */
  dpr: number;
}

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, options: DrawOptions): void {
  const { theme } = options;
  const { width, height } = scene.viewport;

  ctx.save();
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, scene, theme);

  // Edges under nodes, so a wire never covers the thing it feeds.
  for (const edge of scene.edges) drawEdge(ctx, edge, options);

  for (const node of scene.quads) drawQuad(ctx, node, theme);
  for (const node of scene.tiles) drawTile(ctx, node, theme);
  for (const node of scene.dom) drawFull(ctx, node, theme);

  ctx.restore();
}

/** A faint world grid, so pan and zoom are legible at any LOD. */
function drawGrid(ctx: CanvasRenderingContext2D, scene: Scene, theme: Theme): void {
  const { viewport } = scene;
  // Grid spacing snaps to a power of ten that keeps lines 60-600px apart.
  const target = 120 / viewport.scale;
  const spacing = Math.pow(10, Math.ceil(Math.log10(target)));
  const step = spacing * viewport.scale;
  if (step < 8) return;

  ctx.save();
  ctx.strokeStyle = theme.border;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const startX = -((viewport.x * viewport.scale) % step);
  for (let x = startX; x < viewport.width; x += step) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, viewport.height);
  }
  const startY = -((viewport.y * viewport.scale) % step);
  for (let y = startY; y < viewport.height; y += step) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(viewport.width, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function drawEdge(ctx: CanvasRenderingContext2D, edge: SceneEdge, options: DrawOptions): void {
  const { p0, c, p1 } = edge.screen;
  const { style } = edge;

  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.setLineDash(style.dash);
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.quadraticCurveTo(c.x, c.y, p1.x, p1.y);
  ctx.stroke();
  ctx.setLineDash([]);

  if (style.pulse) {
    // A bead running the curve while the target computes.
    const t = pulsePhase(options.now);
    const head = sampleQuadratic(edge.screen, t);
    ctx.fillStyle = style.color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(head.x, head.y, style.width * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  if (style.arrowhead) drawArrowhead(ctx, edge, style.color, style.width);

  if (style.label) {
    const mid = sampleQuadratic(edge.screen, 0.5);
    ctx.globalAlpha = 0.95;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(style.label).width + 8;
    ctx.fillStyle = options.theme.background;
    ctx.globalAlpha = 0.82;
    ctx.fillRect(mid.x - w / 2, mid.y - 8, w, 16);
    ctx.fillStyle = style.color;
    ctx.fillText(style.label, mid.x, mid.y);
  }

  ctx.restore();
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  edge: SceneEdge,
  color: string,
  width: number,
): void {
  const tip = edge.screen.p1;
  const before = sampleQuadratic(edge.screen, 0.94);
  const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
  const size = 4 + width * 1.6;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - size * Math.cos(angle - 0.4), tip.y - size * Math.sin(angle - 0.4));
  ctx.lineTo(tip.x - size * Math.cos(angle + 0.4), tip.y - size * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  radius: number,
): void {
  const { minX, minY, maxX, maxY } = node.screenRect;
  const w = maxX - minX;
  const h = maxY - minY;
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(minX + r, minY);
  ctx.arcTo(maxX, minY, maxX, maxY, r);
  ctx.arcTo(maxX, maxY, minX, maxY, r);
  ctx.arcTo(minX, maxY, minX, minY, r);
  ctx.arcTo(minX, minY, maxX, minY, r);
  ctx.closePath();
}

/** Halo and wash sit behind the node body. */
function drawPassiveLayers(ctx: CanvasRenderingContext2D, node: SceneNode, theme: Theme): void {
  if (node.halo) {
    ctx.save();
    ctx.strokeStyle = node.halo.color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 6;
    roundedRect(ctx, node, node.style.cornerRadius + 4);
    ctx.stroke();
    ctx.restore();
  }
  if (node.wash !== undefined) {
    ctx.save();
    ctx.fillStyle = theme.wash;
    ctx.globalAlpha = node.wash * 0.35;
    roundedRect(ctx, node, node.style.cornerRadius);
    ctx.fill();
    ctx.restore();
  }
}

/** LOD0: a colored rectangle, a type glyph and a status dot. */
function drawQuad(ctx: CanvasRenderingContext2D, node: SceneNode, theme: Theme): void {
  const { screenRect: r, style } = node;
  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.fillStyle = style.fill;
  ctx.fillRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.strokeWidth;
  ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
  ctx.restore();

  drawPassiveLayers(ctx, node, theme);

  const w = r.maxX - r.minX;
  const h = r.maxY - r.minY;
  if (w > 10 && h > 8) {
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = theme.textMuted;
    ctx.font = `${Math.min(14, Math.max(7, h * 0.5))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(node.glyph, (r.minX + r.maxX) / 2, (r.minY + r.maxY) / 2);
    ctx.restore();
  }
  if (w > 14) {
    ctx.fillStyle = style.statusColor;
    ctx.beginPath();
    ctx.arc(r.maxX - 4, r.minY + 4, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** LOD1: title, headline metric, sparkline. One canvas tile, no DOM. */
function drawTile(ctx: CanvasRenderingContext2D, node: SceneNode, theme: Theme): void {
  const { screenRect: r, style } = node;
  drawPassiveLayers(ctx, node, theme);

  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.fillStyle = style.fill;
  roundedRect(ctx, node, style.cornerRadius);
  ctx.fill();
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.strokeWidth;
  if (style.strokeStyle === 'soft') ctx.setLineDash([5, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = theme.text;
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(clip(ctx, `${node.glyph} ${node.title}`, r.maxX - r.minX - 10), r.minX + 6, r.minY + 5);

  drawSparkline(ctx, node);
  drawBindingMarks(ctx, node, theme);
  ctx.restore();
}

/** LOD2/LOD3: full node chrome. The shipping renderer mounts React here. */
function drawFull(ctx: CanvasRenderingContext2D, node: SceneNode, theme: Theme): void {
  const { screenRect: r, style } = node;
  drawPassiveLayers(ctx, node, theme);

  ctx.save();
  ctx.globalAlpha = style.opacity;
  ctx.fillStyle = style.fill;
  roundedRect(ctx, node, style.cornerRadius);
  ctx.fill();
  ctx.strokeStyle = node.selected ? theme.borderStrong : style.stroke;
  ctx.lineWidth = style.strokeWidth;
  if (style.strokeStyle === 'soft') ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Title bar.
  ctx.fillStyle = theme.text;
  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(clip(ctx, node.title, r.maxX - r.minX - 60), r.minX + 10, r.minY + 9);

  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = theme.textMuted;
  ctx.fillText(clip(ctx, node.kind, r.maxX - r.minX - 60), r.minX + 10, r.minY + 25);

  drawSparkline(ctx, node);
  drawBindingMarks(ctx, node, theme);
  ctx.restore();
}

/**
 * The binding signature: port dots on wired, a live dot on bound, a status chip
 * on wired at LOD2 and above. This is guardrail #2 made visible.
 */
function drawBindingMarks(ctx: CanvasRenderingContext2D, node: SceneNode, theme: Theme): void {
  const { screenRect: r, style } = node;

  if (style.showPortDots) {
    ctx.fillStyle = theme.port;
    const midY = (r.minY + r.maxY) / 2;
    for (const [x, count] of [[r.minX, 2] as const, [r.maxX, 1] as const]) {
      for (let i = 0; i < count; i++) {
        const y = midY + (i - (count - 1) / 2) * 14;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (style.showLiveDot) {
    ctx.fillStyle = theme.live;
    ctx.beginPath();
    ctx.arc(r.maxX - 10, r.minY + 10, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (style.showStatusChip) {
    const w = 10;
    ctx.fillStyle = style.statusColor;
    ctx.beginPath();
    ctx.arc(r.maxX - 14, r.minY + 14, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.25;
    ctx.fillRect(r.maxX - 14 - w, r.maxY - 6, w * 2, 3);
    ctx.globalAlpha = 1;
  }
}

/** A deterministic pseudo-series, purely so a tile looks like a tile. */
function drawSparkline(ctx: CanvasRenderingContext2D, node: SceneNode): void {
  const { screenRect: r } = node;
  const w = r.maxX - r.minX;
  const h = r.maxY - r.minY;
  if (w < 60 || h < 40) return;

  const left = r.minX + 8;
  const right = r.maxX - 8;
  const bottom = r.maxY - 10;
  const top = Math.max(r.minY + h * 0.45, bottom - h * 0.4);

  let seed = 0;
  for (let i = 0; i < node.id.length; i++) seed = (seed * 31 + node.id.charCodeAt(i)) >>> 0;

  ctx.save();
  ctx.strokeStyle = node.style.statusColor;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  const steps = 24;
  let value = 0.5;
  for (let i = 0; i <= steps; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    value = Math.min(1, Math.max(0, value + ((seed >>> 16) / 65536 - 0.5) * 0.28));
    const x = left + ((right - left) * i) / steps;
    const y = bottom - (bottom - top) * value;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function clip(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

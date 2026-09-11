/**
 * Ink surface: capture, commit, recognize.
 *
 * Draw with a mouse, finger or stylus. On pen lift the stroke commits, the
 * recognition scheduler waits out its 300ms, and the shape pass runs locally —
 * no model, no network. The proposal is shown as a ghost overlay and is never
 * applied on its own: promotion needs a press, per PRD 3.2.1.
 */

import {
  RecognitionScheduler,
  StrokeBuilder,
  groupStrokes,
  mergeGroup,
  pressureWidth,
  recognizeShape,
  strokePoints,
  type InkPoint,
  type InkStroke,
  type Recognition,
} from '@picasso/canvas-ink';
import { lightTheme } from '@picasso/canvas-render';

const canvas = document.getElementById('ink') as HTMLCanvasElement;
const readout = document.getElementById('readout') as HTMLElement;
const context = canvas.getContext('2d');
if (!context) throw new Error('Canvas2D unavailable');
const ctx = context;

const theme = lightTheme;
const strokes: InkStroke[] = [];
const scheduler = new RecognitionScheduler<string>();
let builder: StrokeBuilder | null = null;
let strokeSeq = 0;
let latest: { recognition: Recognition; groupIndex: number } | null = null;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/**
 * PRD 3.7: pointer events are read through getCoalescedEvents() for the full
 * stylus sample rate. Taking only the event's own coordinates throws away most
 * of the ink on a 240Hz pen at 60Hz frames.
 */
function samplesFrom(event: PointerEvent): InkPoint[] {
  const events = typeof event.getCoalescedEvents === 'function'
    ? event.getCoalescedEvents()
    : [event];
  const source = events.length > 0 ? events : [event];
  return source.map((e) => ({
    x: e.clientX,
    y: e.clientY,
    pressure: e.pressure > 0 ? e.pressure : 0.5,
    t: e.timeStamp,
    ...(e.pointerType === 'pen' ? { tilt: (e.tiltX * Math.PI) / 180 } : {}),
  }));
}

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  // Never recognize while the pen is down. Without this, a shape drawn in
  // several strokes gets recognized from a partial group the moment the hand
  // pauses longer than the delay, and the analyst sees a proposal for half of
  // what they are drawing.
  scheduler.cancel('active');
  builder = new StrokeBuilder(`s${strokeSeq++}`, { color: theme.text, width: 3 });
  builder.append(samplesFrom(event));
});

canvas.addEventListener('pointermove', (event) => {
  if (!builder) return;
  builder.append(samplesFrom(event));
});

function endStroke(event: PointerEvent): void {
  if (!builder) return;
  builder.append(samplesFrom(event));
  const committed = builder.commit();
  strokes.push(committed);
  builder = null;
  // The countdown restarts on every lift, so a shape drawn in four strokes is
  // recognized once, when the hand actually stops.
  scheduler.touch('active', event.timeStamp);
}

canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

window.addEventListener('keydown', (event) => {
  if (event.key === 'c' || event.key === 'Escape') {
    strokes.length = 0;
    latest = null;
    scheduler.cancel('active');
  }
});

function recognizeIfDue(now: number): void {
  if (scheduler.due(now).length === 0) return;
  const groups = groupStrokes(strokes);
  const last = groups[groups.length - 1];
  if (!last) return;
  latest = { recognition: recognizeShape(mergeGroup(last)), groupIndex: groups.length - 1 };
}

function drawStroke(stroke: InkStroke): void {
  const points = strokePoints(stroke);
  if (points.length < 2) return;
  ctx.strokeStyle = stroke.color ?? theme.text;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as InkPoint;
    const b = points[i] as InkPoint;
    // Width follows pressure, which is what the SDF shader does on the GPU.
    ctx.lineWidth = pressureWidth((a.pressure + b.pressure) / 2, stroke.width ?? 3);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
}

/** The proposal, drawn as a ghost over the ink. Accepting it is the analyst's. */
function drawProposal(recognition: Recognition): void {
  const f = recognition.features;
  if (!f || recognition.kind === 'unknown') return;

  ctx.save();
  ctx.strokeStyle = theme.computing;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);

  const { minX, minY, maxX, maxY } = f.box;
  if (recognition.kind === 'rectangle') {
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  } else if (recognition.kind === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse((minX + maxX) / 2, (minY + maxY) / 2, (maxX - minX) / 2, (maxY - minY) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    const first = f.samples[0];
    const last = f.samples[f.samples.length - 1];
    if (first && last) {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function frame(now: number): void {
  recognizeIfDue(now);

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  for (const stroke of strokes) drawStroke(stroke);
  if (builder) drawStroke(builder.current);
  if (latest) drawProposal(latest.recognition);

  const points = strokes.reduce((sum, s) => sum + strokePoints(s).length, 0);
  readout.textContent = latest
    ? [
        `${latest.recognition.kind}  confidence ${latest.recognition.confidence.toFixed(2)}`,
        Object.entries(latest.recognition.scores)
          .sort((a, b) => b[1] - a[1])
          .map(([kind, score]) => `${kind} ${score.toFixed(2)}`)
          .join('  '),
        `${strokes.length} strokes · ${points} points after simplify`,
      ].join('\n')
    : 'draw a shape · c to clear';

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

declare global {
  interface Window {
    __ink?: {
      result: () => { kind: string; confidence: number } | null;
      strokeCount: () => number;
      clear: () => void;
    };
  }
}
window.__ink = {
  result: () =>
    latest ? { kind: latest.recognition.kind, confidence: latest.recognition.confidence } : null,
  strokeCount: () => strokes.length,
  clear: () => {
    strokes.length = 0;
    latest = null;
  },
};

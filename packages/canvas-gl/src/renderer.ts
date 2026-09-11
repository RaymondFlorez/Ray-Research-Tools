/**
 * The WebGL2 renderer.
 *
 * A frame is: pack the scene into two Float32Arrays, upload both, issue two
 * instanced draw calls. Node count does not appear in that sentence, which is
 * the property the PRD's 5,000-nodes-at-60fps target depends on — the DOM path
 * dies past ~300 nodes because every node is work for the browser, and this
 * path does not care.
 */

import type { Scene } from '@picasso/canvas-render';
import type { Theme } from '@picasso/canvas-render';
import {
  EDGE_STRIDE,
  NODE_STRIDE,
  ensureCapacity,
  packEdges,
  packNodes,
  parseColor,
} from './instances.js';
import {
  EDGE_FRAGMENT,
  EDGE_SEGMENTS,
  EDGE_VERTEX,
  NODE_FRAGMENT,
  NODE_VERTEX,
} from './shaders.js';

export interface FrameStats {
  /** Instanced draws issued. Two, whatever the scene holds. */
  drawCalls: number;
  nodeInstances: number;
  edgeInstances: number;
  /** CPU time packing the instance buffers. */
  packMs: number;
  /** CPU time issuing the frame, upload included. GPU time is not measurable here. */
  cpuMs: number;
  /** Bytes uploaded this frame. */
  uploadedBytes: number;
}

export class ShaderError extends Error {
  constructor(stage: string, log: string) {
    super(`${stage}: ${log}`);
    this.name = 'ShaderError';
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new ShaderError('createShader', 'returned null');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown';
    gl.deleteShader(shader);
    throw new ShaderError(type === gl.VERTEX_SHADER ? 'vertex' : 'fragment', log);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new ShaderError('createProgram', 'returned null');
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown';
    gl.deleteProgram(program);
    throw new ShaderError('link', log);
  }
  return program;
}

/** Attribute layout: location, floats, offset in floats. */
const NODE_ATTRIBUTES: Array<[number, number, number]> = [
  [0, 4, 0],   // a_rect
  [1, 4, 4],   // a_fill
  [2, 4, 8],   // a_stroke
  [3, 4, 12],  // a_status
  [4, 4, 16],  // a_params
];

const EDGE_ATTRIBUTES: Array<[number, number, number]> = [
  [0, 2, 0],   // a_p0
  [1, 2, 2],   // a_c
  [2, 2, 4],   // a_p1
  [3, 4, 6],   // a_color
  [4, 2, 10],  // a_style
];

function bindInstanced(
  gl: WebGL2RenderingContext,
  buffer: WebGLBuffer,
  stride: number,
  attributes: ReadonlyArray<[number, number, number]>,
): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const [location, size, offset] of attributes) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride * 4, offset * 4);
    gl.vertexAttribDivisor(location, 1);
  }
}

export interface GLRendererOptions {
  /** Segments each bezier is walked in. */
  edgeSegments?: number;
}

export class GLRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly nodeProgram: WebGLProgram;
  private readonly edgeProgram: WebGLProgram;
  private readonly nodeVao: WebGLVertexArrayObject;
  private readonly edgeVao: WebGLVertexArrayObject;
  private readonly nodeBuffer: WebGLBuffer;
  private readonly edgeBuffer: WebGLBuffer;
  private readonly edgeSegments: number;

  /** Reused across frames so a steady-state frame allocates nothing. */
  private nodeScratch = ensureCapacity(undefined, 0, NODE_STRIDE);
  private edgeScratch = ensureCapacity(undefined, 0, EDGE_STRIDE);

  private lastStats: FrameStats = {
    drawCalls: 0,
    nodeInstances: 0,
    edgeInstances: 0,
    packMs: 0,
    cpuMs: 0,
    uploadedBytes: 0,
  };

  constructor(gl: WebGL2RenderingContext, options: GLRendererOptions = {}) {
    this.gl = gl;
    this.edgeSegments = options.edgeSegments ?? EDGE_SEGMENTS;

    this.nodeProgram = link(gl, NODE_VERTEX, NODE_FRAGMENT);
    this.edgeProgram = link(gl, EDGE_VERTEX, EDGE_FRAGMENT);

    const nodeVao = gl.createVertexArray();
    const edgeVao = gl.createVertexArray();
    const nodeBuffer = gl.createBuffer();
    const edgeBuffer = gl.createBuffer();
    if (!nodeVao || !edgeVao || !nodeBuffer || !edgeBuffer) {
      throw new ShaderError('allocate', 'could not create VAOs or buffers');
    }
    this.nodeVao = nodeVao;
    this.edgeVao = edgeVao;
    this.nodeBuffer = nodeBuffer;
    this.edgeBuffer = edgeBuffer;

    gl.bindVertexArray(this.nodeVao);
    bindInstanced(gl, this.nodeBuffer, NODE_STRIDE, NODE_ATTRIBUTES);
    gl.bindVertexArray(this.edgeVao);
    bindInstanced(gl, this.edgeBuffer, EDGE_STRIDE, EDGE_ATTRIBUTES);
    gl.bindVertexArray(null);

    // Premultiplied alpha: the shaders emit rgb * a, so this is the correct
    // blend and it composites layered nodes without darkening the seams.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
  }

  get stats(): FrameStats {
    return this.lastStats;
  }

  /** Draws one frame. Two instanced draws, whatever the scene holds. */
  render(scene: Scene, theme: Theme): FrameStats {
    const gl = this.gl;
    const started = performance.now();

    const width = scene.viewport.width;
    const height = scene.viewport.height;

    const packStarted = performance.now();
    const nodes = [...scene.quads, ...scene.tiles, ...scene.dom];
    this.nodeScratch = ensureCapacity(this.nodeScratch, nodes.length, NODE_STRIDE);
    this.edgeScratch = ensureCapacity(this.edgeScratch, scene.edges.length, EDGE_STRIDE);
    const packedNodes = packNodes(nodes, this.nodeScratch);
    const packedEdges = packEdges(scene.edges, this.edgeScratch);
    const packMs = performance.now() - packStarted;

    const background = parseColor(theme.background);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(background[0], background[1], background[2], background[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let drawCalls = 0;
    let uploadedBytes = 0;

    // Edges under nodes, so a wire never covers the thing it feeds.
    if (packedEdges.count > 0) {
      const bytes = packedEdges.count * EDGE_STRIDE * 4;
      gl.useProgram(this.edgeProgram);
      gl.bindVertexArray(this.edgeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, packedEdges.data, gl.DYNAMIC_DRAW, 0, packedEdges.count * EDGE_STRIDE);
      this.setVec2(this.edgeProgram, 'u_resolution', width, height);
      this.setFloat(this.edgeProgram, 'u_segments', this.edgeSegments);
      this.setFloat(this.edgeProgram, 'u_dashScale', 40);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (this.edgeSegments + 1) * 2, packedEdges.count);
      drawCalls += 1;
      uploadedBytes += bytes;
    }

    if (packedNodes.count > 0) {
      const bytes = packedNodes.count * NODE_STRIDE * 4;
      gl.useProgram(this.nodeProgram);
      gl.bindVertexArray(this.nodeVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, packedNodes.data, gl.DYNAMIC_DRAW, 0, packedNodes.count * NODE_STRIDE);
      this.setVec2(this.nodeProgram, 'u_resolution', width, height);
      const wash = parseColor(theme.wash);
      this.setVec4(this.nodeProgram, 'u_wash', wash);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, packedNodes.count);
      drawCalls += 1;
      uploadedBytes += bytes;
    }

    gl.bindVertexArray(null);

    this.lastStats = {
      drawCalls,
      nodeInstances: packedNodes.count,
      edgeInstances: packedEdges.count,
      packMs,
      cpuMs: performance.now() - started,
      uploadedBytes,
    };
    return this.lastStats;
  }

  private setVec2(program: WebGLProgram, name: string, x: number, y: number): void {
    this.gl.uniform2f(this.gl.getUniformLocation(program, name), x, y);
  }

  private setVec4(program: WebGLProgram, name: string, value: readonly number[]): void {
    this.gl.uniform4f(
      this.gl.getUniformLocation(program, name),
      value[0] as number,
      value[1] as number,
      value[2] as number,
      value[3] as number,
    );
  }

  private setFloat(program: WebGLProgram, name: string, value: number): void {
    this.gl.uniform1f(this.gl.getUniformLocation(program, name), value);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.nodeProgram);
    gl.deleteProgram(this.edgeProgram);
    gl.deleteVertexArray(this.nodeVao);
    gl.deleteVertexArray(this.edgeVao);
    gl.deleteBuffer(this.nodeBuffer);
    gl.deleteBuffer(this.edgeBuffer);
  }
}

/** Acquires a context with the settings the renderer assumes. */
export function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  return canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    // The renderer draws the whole frame every time, so there is nothing to preserve.
    preserveDrawingBuffer: false,
  });
}

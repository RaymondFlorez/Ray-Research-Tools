/**
 * GLSL for the two batches.
 *
 * Both are attributeless in the vertex sense: geometry comes from
 * `gl_VertexID`, and everything that varies per node or per edge arrives as an
 * instanced attribute. That keeps a frame down to a buffer upload and a draw
 * call, with no vertex buffer to rebuild when the scene changes shape.
 */

export const NODE_VERTEX = `#version 300 es
precision highp float;

// Per instance.
layout(location = 0) in vec4 a_rect;    // x, y, w, h in screen pixels
layout(location = 1) in vec4 a_fill;
layout(location = 2) in vec4 a_stroke;
layout(location = 3) in vec4 a_status;
layout(location = 4) in vec4 a_params;  // cornerRadius, strokeWidth, soft, wash

uniform vec2 u_resolution;

out vec2 v_local;      // pixels from the rect centre
out vec2 v_half;       // half extent, in pixels
out vec4 v_fill;
out vec4 v_stroke;
out vec4 v_status;
out vec4 v_params;

void main() {
  // A unit quad from the vertex id, grown by a pixel of padding so the
  // antialiased border and the outer edge of the stroke are not clipped.
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vec2 half_extent = a_rect.zw * 0.5;
  float pad = a_params.y + 2.0;
  vec2 centre = a_rect.xy + half_extent;
  vec2 offset = (corner * 2.0 - 1.0) * (half_extent + pad);
  vec2 pixel = centre + offset;

  v_local = offset;
  v_half = half_extent;
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_status = a_status;
  v_params = a_params;

  // Screen pixels to clip space, y down.
  vec2 clip = (pixel / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

export const NODE_FRAGMENT = `#version 300 es
precision highp float;

in vec2 v_local;
in vec2 v_half;
in vec4 v_fill;
in vec4 v_stroke;
in vec4 v_status;
in vec4 v_params;

uniform vec4 u_wash;

out vec4 outColor;

// Signed distance to a rounded rectangle, negative inside.
float roundedBox(vec2 p, vec2 half_extent, float radius) {
  vec2 q = abs(p) - half_extent + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

void main() {
  float radius = min(v_params.x, min(v_half.x, v_half.y));
  float dist = roundedBox(v_local, v_half, radius);

  // One pixel of analytic antialiasing, which is what the DOM path gets free
  // and the Canvas2D path pays for in overdraw.
  float aa = 1.0;
  float inside = 1.0 - smoothstep(-aa, aa, dist);

  float stroke_width = v_params.y;
  // A soft stroke reads as a lighter, wider edge: at LOD0 a dash pattern is
  // smaller than a pixel, and the binding still has to be legible.
  float soft = v_params.z;
  stroke_width *= mix(1.0, 1.8, soft);
  float band = 1.0 - smoothstep(-stroke_width - aa, -stroke_width + aa, dist);
  float border = clamp(inside - band, 0.0, 1.0) * mix(1.0, 0.55, soft);

  vec4 color = v_fill * inside;
  color = mix(color, v_stroke, border * v_stroke.a);

  // Passive-mode wash, painted inside the body only.
  float wash = v_params.w;
  color = mix(color, vec4(u_wash.rgb, color.a), wash * 0.35 * band);

  // Status dot in the top-right corner, drawn only when the node is big
  // enough for it to mean anything.
  vec2 dot_centre = vec2(v_half.x - 6.0, -v_half.y + 6.0);
  float dot_dist = length(v_local - dot_centre) - 2.5;
  float dot_mask = (1.0 - smoothstep(-aa, aa, dot_dist)) * step(14.0, v_half.x * 2.0);
  color = mix(color, v_status, dot_mask * v_status.a);

  if (color.a < 0.004) discard;
  outColor = vec4(color.rgb * color.a, color.a);
}
`;

/** Segments each bezier is walked in. Doubling this doubles vertices, not draws. */
export const EDGE_SEGMENTS = 24;

export const EDGE_VERTEX = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_p0;
layout(location = 1) in vec2 a_c;
layout(location = 2) in vec2 a_p1;
layout(location = 3) in vec4 a_color;
layout(location = 4) in vec2 a_style;   // width, dashed

uniform vec2 u_resolution;
uniform float u_segments;

out vec4 v_color;
out float v_edge;    // -1..1 across the ribbon, for antialiasing
out float v_t;
out float v_dashed;

vec2 quadratic(vec2 p0, vec2 c, vec2 p1, float t) {
  float u = 1.0 - t;
  return u * u * p0 + 2.0 * u * t * c + t * t * p1;
}

vec2 tangent(vec2 p0, vec2 c, vec2 p1, float t) {
  return 2.0 * (1.0 - t) * (c - p0) + 2.0 * t * (p1 - c);
}

void main() {
  // A triangle strip along the curve: two vertices per step, offset either
  // side of the tangent. The geometry is derived, so there is no vertex buffer.
  int vid = gl_VertexID;
  float step_index = floor(float(vid) * 0.5);
  float side = (vid % 2 == 0) ? -1.0 : 1.0;
  float t = clamp(step_index / u_segments, 0.0, 1.0);

  vec2 point = quadratic(a_p0, a_c, a_p1, t);
  vec2 dir = tangent(a_p0, a_c, a_p1, t);
  float len = max(length(dir), 1e-5);
  vec2 normal = vec2(-dir.y, dir.x) / len;

  float half_width = max(a_style.x, 1.0) * 0.5 + 0.75;
  vec2 pixel = point + normal * side * half_width;

  v_color = a_color;
  v_edge = side;
  v_t = t;
  v_dashed = a_style.y;

  vec2 clip = (pixel / u_resolution) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

export const EDGE_FRAGMENT = `#version 300 es
precision highp float;

in vec4 v_color;
in float v_edge;
in float v_t;
in float v_dashed;

uniform float u_dashScale;

out vec4 outColor;

void main() {
  // Soften the ribbon edge rather than relying on multisampling.
  float alpha = 1.0 - smoothstep(0.55, 1.0, abs(v_edge));

  // Reference edges are dotted. The pattern runs in curve parameter rather
  // than arc length, which is close enough at these curvatures and costs
  // nothing; arc length would need a prefix sum per edge.
  if (v_dashed > 0.5) {
    float phase = fract(v_t * u_dashScale);
    alpha *= step(0.45, phase);
  }

  float a = v_color.a * alpha;
  if (a < 0.004) discard;
  outColor = vec4(v_color.rgb * a, a);
}
`;

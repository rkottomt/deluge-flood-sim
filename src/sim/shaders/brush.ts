/**
 * Brush pass: GPU edit operations over a bounding rectangle. Reads the current state, ground and barrier;
 * writes edited copies into scratch textures which the CPU side then copies back (rect only). The same math
 * runs on the CPU (src/sim/brush.ts) to keep the ground/barrier mirrors in sync.
 *
 * kind 0 wall     : barrier = max(barrier, height · (1 − smoothstep(r, r+1, d)))   (capsule a→b)
 * kind 1 eraseWall: barrier = barrier · smoothstep(r, r+1, d)                        (capsule a→b)
 * kind 2 water    : h = max(0, h + amount · falloff(d/r))                            (disc at a)
 * kind 3 terrain  : ground = ground + delta · falloff(d/r)                           (disc at a)
 * falloff(t) = (1 − t²)² for t < 1.
 * When the bed rises under water, h is kept (the water is lifted) — simple and mass-conserving.
 * Water edits are accounted in the mass-balance buffer.
 */
import { ACC_PER_CELL } from './common';

export const BRUSH_UNIFORM_BYTES = 64;

export const brushWGSL = /* wgsl */ `
struct Brush {
  kind: i32, nx: i32, ny: i32, _p0: i32,
  x0: i32, y0: i32, w: i32, h: i32,
  a: vec2f, b: vec2f,
  radius: f32, value: f32, z0: f32, _p1: f32,
};
@group(0) @binding(0) var<uniform> br: Brush;
@group(0) @binding(1) var stateTex: texture_2d<f32>;
@group(0) @binding(2) var groundTex: texture_2d<f32>;
@group(0) @binding(3) var barrierTex: texture_2d<f32>;
@group(0) @binding(4) var stateOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(5) var groundOut: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var barrierOut: texture_storage_2d<r32float, write>;
@group(0) @binding(7) var bedOut: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var<storage, read_write> acc: array<f32>;

fn capsuleDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * t);
}

fn falloff(d: f32, r: f32) -> f32 {
  if (d >= r) { return 0.0; }
  let t = d / r;
  let s = 1.0 - t * t;
  return s * s;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (i32(id.x) >= br.w || i32(id.y) >= br.h) { return; }
  let q = vec2i(i32(id.x) + br.x0, i32(id.y) + br.y0);
  if (q.x < 0 || q.y < 0 || q.x >= br.nx || q.y >= br.ny) { return; }
  let s = textureLoad(stateTex, q, 0);
  var ground = textureLoad(groundTex, q, 0).r;
  var barrier = textureLoad(barrierTex, q, 0).r;
  var h = s.r;
  let p = vec2f(q) + vec2f(0.5, 0.5);
  let r = br.radius;
  if (br.kind == 0) {
    let d = capsuleDist(p, br.a, br.b);
    barrier = max(barrier, br.value * (1.0 - smoothstep(r, r + 1.0, d)));
  } else if (br.kind == 1) {
    let d = capsuleDist(p, br.a, br.b);
    barrier = barrier * smoothstep(r, r + 1.0, d);
  } else if (br.kind == 2) {
    let d = distance(p, br.a);
    let before = h;
    h = max(0.0, h + br.value * falloff(d, r));
    let dv = h - before;
    let idx = ${ACC_PER_CELL}u * (u32(q.y) * u32(br.nx) + u32(q.x));
    if (dv > 0.0) { acc[idx] = acc[idx] + dv; }
    if (dv < 0.0) { acc[idx + 1u] = acc[idx + 1u] - dv; }
  } else {
    let d = distance(p, br.a);
    ground = ground + br.value * falloff(d, r);
  }
  let bed = ground + barrier;
  textureStore(stateOut, q, vec4f(h, s.g, s.b, bed - br.z0));
  textureStore(groundOut, q, vec4f(ground, 0.0, 0.0, 0.0));
  textureStore(barrierOut, q, vec4f(barrier, 0.0, 0.0, 0.0));
  textureStore(bedOut, q, vec4f(bed, 0.0, 0.0, 0.0));
}
`;

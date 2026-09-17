/**
 * Raise pass: lift the water surface in place to a target elevation (rivers rising to a new stage).
 *
 *   h = max(h, (base − z0) + offset − z)       for every cell whose base is a real level
 *
 * `base` is an r32float texture of datum-relative water-surface elevations uploaded once per base array; cells to
 * leave alone hold −1e30 (a sentinel rather than NaN, which fast-math shader compilers may assume away). The
 * discharge is kept, and the added depth is booked as external inflow in the accounting buffer, so volumeIn and
 * SimStats.massError stay exact. Writes the full state into the other ping-pong texture.
 */
export const RAISE_UNIFORM_BYTES = 16;

export const raiseWGSL = /* wgsl */ `
struct Raise { nx: i32, ny: i32, offset: f32, _p: f32 };
@group(0) @binding(0) var<uniform> rs: Raise;
@group(0) @binding(1) var stateTex: texture_2d<f32>;
@group(0) @binding(2) var baseTex: texture_2d<f32>;
@group(0) @binding(3) var stateOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(4) var<storage, read_write> acc: array<f32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let q = vec2i(id.xy);
  if (q.x >= rs.nx || q.y >= rs.ny) { return; }
  let s = textureLoad(stateTex, q, 0);
  var h = s.r;
  let goal = textureLoad(baseTex, q, 0).r + rs.offset - s.a;
  if (goal > h) {
    let idx = 2u * (u32(q.y) * u32(rs.nx) + u32(q.x));
    acc[idx] = acc[idx] + (goal - h);
    h = goal;
  }
  textureStore(stateOut, q, vec4f(h, s.g, s.b, s.a));
}
`;

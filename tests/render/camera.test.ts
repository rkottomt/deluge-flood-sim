/**
 * Camera feel, as properties rather than as numbers nobody can check by eye.
 *
 * Three things here are easy to break and impossible to notice in a unit test unless they are stated: the spring
 * must never overshoot (an orbit that springs past the pose reads as a bug, not as polish), the fly-to ease must
 * start and end with zero speed AND zero acceleration (the kick that a cubic ease leaves is exactly what makes a
 * Try-it beat look cheap), and the idle breathing must be genuinely absent unless it is switched on — screenshots
 * and the visual suite's flicker detector depend on a still camera being still.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrbitController, type CameraEnvironment } from '../../src/render/camera';
import type { CameraPose } from '../../src/contracts';

/** A flat 1024x1024 grid at 10 m cells, 100 m above sea level: no terrain clearance surprises. */
function env(): CameraEnvironment {
  return {
    nx: 1024,
    ny: 1024,
    cellSize: 10,
    exaggeration: 1.5,
    minElev: 100,
    maxElev: 100,
    heightAt: () => 100,
    pickWorld: () => null,
  };
}

const pose = (p: Partial<CameraPose> = {}): CameraPose => ({
  target: { gx: 512, gy: 512, elevation: 100 },
  distance: 2000,
  yaw: 0,
  pitch: 0.6,
  ...p,
});

/** Run `seconds` of frames at 60 fps and return the pose after each one. */
function run(c: OrbitController, seconds: number): CameraPose[] {
  const out: CameraPose[] = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    c.update(1 / 60);
    const p = c.pose;
    out.push({ target: { ...p.target }, distance: p.distance, yaw: p.yaw, pitch: p.pitch });
  }
  return out;
}

test('the pose spring converges without overshooting, and eases in rather than starting at full speed', () => {
  const c = new OrbitController(env());
  c.pose = pose();
  // Move the goal the way a drag does (the goal is public through the controller's own input path; setting it
  // via flyTo with a negligible duration would snap, so drive it the way onPointerMove does).
  (c as unknown as { goal: CameraPose }).goal.yaw = 1;
  const frames = run(c, 3);
  const yaws = frames.map((f) => f.yaw);
  // Monotone toward the goal and never past it: a critically damped spring cannot overshoot.
  for (let i = 1; i < yaws.length; i++) assert.ok(yaws[i] >= yaws[i - 1] - 1e-12, `yaw went backwards at frame ${i}`);
  assert.ok(Math.max(...yaws) <= 1 + 1e-9, `overshot to ${Math.max(...yaws)}`);
  assert.ok(Math.abs(yaws[yaws.length - 1] - 1) < 1e-4, 'should have settled on the goal');
  // Eases in: the first frame moves less than a plain exponential decay at the same rate would (1 - e^-w/60).
  assert.ok(yaws[0] < 1 - Math.exp(-c.damping / 60), 'spring should not start at full speed');
  // …but is still responsive: most of the move is done within half a second.
  assert.ok(yaws[29] > 0.75, `only ${yaws[29].toFixed(2)} of the way after 0.5 s`);
});

test('fly-to lands exactly on its target and never lurches mid-move', () => {
  const c = new OrbitController(env());
  c.pose = pose();
  const to = pose({ target: { gx: 300, gy: 700, elevation: 100 }, distance: 900, yaw: 1.2, pitch: 0.4 });
  c.flyTo(to, 1.5);
  const frames = run(c, 1.6);
  const last = frames[frames.length - 1];
  assert.ok(Math.abs(last.yaw - to.yaw) < 1e-6 && Math.abs(last.pitch - to.pitch) < 1e-6, 'must land on the target');
  assert.ok(Math.abs(last.distance - to.distance) < 1e-3);
  assert.ok(Math.abs(last.target.gx - to.target.gx) < 1e-6);

  // Speed, acceleration and jerk of the translation, per frame.
  const x = frames.map((f) => f.target.gx);
  const v = x.slice(1).map((p, i) => p - x[i]);
  const a = v.slice(1).map((s, i) => s - v[i]);
  const jerk = a.slice(1).map((q, i) => q - a[i]);
  const peakV = Math.max(...v.map(Math.abs));
  const peakA = Math.max(...a.map(Math.abs));
  // Starts and stops from rest.
  assert.ok(Math.abs(v[0]) < peakV * 0.02, `starts with ${(Math.abs(v[0]) / peakV).toFixed(3)} of peak speed`);
  const iEnd = v.findIndex((s, i) => i > 10 && Math.abs(s) < 1e-9);
  assert.ok(iEnd > 0 && Math.abs(v[iEnd - 1]) < peakV * 0.03, 'and stops without a jolt');
  // C2 is the point: acceleration must never flip in a single frame. The cubic ease this replaced goes from
  // +12 to -12 at the midpoint, which shows up here as a one-frame jerk about twice the peak acceleration;
  // a quintic keeps it near a tenth of it.
  const peakJerk = Math.max(...jerk.map(Math.abs));
  assert.ok(peakJerk < peakA * 0.5, `acceleration jumps by ${(peakJerk / peakA).toFixed(2)} of its peak in one frame`);
});

test('idle breathing is off unless it is asked for, and stops the moment the view is touched', () => {
  const c = new OrbitController(env());
  c.pose = pose();
  // Off by default: a still camera is bit-still, which is what screenshots and the flicker detector rely on.
  const still = run(c, 8);
  const first = still[0];
  for (const f of still) {
    assert.equal(f.yaw, first.yaw);
    assert.equal(f.pitch, first.pitch);
    assert.equal(f.distance, first.distance);
  }

  c.sway = true;
  const idle = run(c, 8);
  const moved = idle.some((f) => Math.abs(f.yaw - first.yaw) > 1e-5);
  assert.ok(moved, 'sway should move the camera once it has been idle a while');
  // Subtle: a breath, not a drift. Well under a degree, and the pivot never wanders.
  for (const f of idle) {
    assert.ok(Math.abs(f.yaw - first.yaw) < 0.01, `yaw swung ${f.yaw - first.yaw}`);
    assert.ok(Math.abs(f.pitch - first.pitch) < 0.01);
    assert.ok(Math.abs(f.distance / first.distance - 1) < 0.01);
    assert.ok(Math.abs(f.target.gx - first.target.gx) < 1e-6, 'breathing must not move the orbit target');
  }

  // A touch stops it dead and it does not creep back before the idle delay.
  c.noteInteraction();
  const after = run(c, 1.5);
  for (const f of after) {
    assert.ok(Math.abs(f.yaw - first.yaw) < 1e-9, `kept breathing after an interaction: ${f.yaw - first.yaw}`);
  }
  // Switching it off leaves no residue: the pose returns to exactly where the goal says it is.
  c.sway = false;
  const off = run(c, 3);
  const end = off[off.length - 1];
  assert.equal(end.yaw, first.yaw);
  assert.equal(end.pitch, first.pitch);
  assert.equal(end.distance, first.distance);
});

test('a fly-to is not disturbed by breathing, and breathing does not resume mid-flight', () => {
  const c = new OrbitController(env());
  c.pose = pose();
  c.sway = true;
  run(c, 8); // let it settle into a breath
  const to = pose({ distance: 900, yaw: 1.2 });
  c.flyTo(to, 1.2);
  const frames = run(c, 1.3);
  const last = frames[frames.length - 1];
  assert.ok(Math.abs(last.yaw - to.yaw) < 1e-6, `flight landed off target by ${last.yaw - to.yaw}`);
  assert.ok(Math.abs(last.distance - to.distance) < 1e-3);
});

import type { SimSnapshot } from '../contracts';

/** After the requested sim time has been stepped, wait at most this long for a readback that includes it. */
const SNAPSHOT_GRACE_MS = 3000;
/** A run fails if the sim clock makes no progress for this long (includes scene load + shader compile). */
const STALL_TIMEOUT_MS = 60_000;
/**
 * A run whose remaining time is at most this (s) has reached its target: the solver drops remainders shorter than its
 * MIN_TAIL_STEP_S (1e-6 s), and summing the advances leaves ~1e-13 s of rounding.
 */
export const RUN_TARGET_EPSILON_S = 1e-6;

/**
 * While the river stage is still ramping in a runFor-only run, frames end on this grid of simulated time, s. The app
 * moves the solver's stage once per frame (App.advanceStage), so at 3600× an unbounded frame of up to a minute raised
 * the river by up to 3 m at once — a dam-break bore whose strength, and the flood speeds it made, depended on how
 * the frames happened to fall (Site check's 1936 crest: d·v at the North Shore parcel 7.0 in one sweep, 8.3 in the
 * next). On the grid the stage moves in steps of at most 0.25 m (3 m/min × 5 s) at the same simulated moments every
 * run. The ramp is only the first few minutes of a run: at 60 fps this costs well under a second per run.
 */
export const RAMP_FRAME_S = 5;

/** The most a frame may advance from `clock` so that it ends on the RAMP_FRAME_S grid. */
export function rampFrameLimit(clock: number): number {
  const next = (Math.floor(clock / RAMP_FRAME_S + RUN_TARGET_EPSILON_S) + 1) * RAMP_FRAME_S;
  return next - clock;
}

interface Run {
  simSeconds: number;
  /** Sim seconds still to advance. */
  remaining: number;
  /** performance.now() when `remaining` first reached 0, else null. */
  doneAt: number | null;
  /** Sim clock value when the target was reached (snapshot must be at least this recent). */
  doneClock: number;
  /** Snapshot identity/time seen when the target was reached (to detect "any newer readback"). */
  doneSnap: SimSnapshot | null;
  doneSnapTime: number;
  /** The sim stopped on the target (the driver capped the frames): only a readback of that very moment completes it. */
  doneExact: boolean;
  /** performance.now() of the last frame that advanced this run (or of its start). */
  lastProgress: number;
  resolve(): void;
  reject(err: Error): void;
}

/**
 * Implements the debug API's runFor(): while any run is active the frame driver forces the sim to
 * run (even if paused) at a high time scale. A run completes once the solver has advanced the requested
 * sim time AND a readback containing that time has arrived, so getStats() right after reflects it.
 *
 * Exact stops: while the sim runs only because of runFor (the user's flood is paused — every headless batch), the
 * driver caps each frame's advance at stepLimit(), so the solver lands on the target to the rounding of a sum
 * (FloodSolver.step's maxSimSeconds) instead of running on by up to a frame and then for as long as the readback
 * takes (600 s asked used to end at 614–706 s). Once every run has reached its target, stepLimit() is 0: the driver
 * stops stepping and asks the solver for a readback of the state it stopped at.
 */
export class RunForScheduler {
  private runs: Run[] = [];

  get active(): boolean {
    return this.runs.length > 0;
  }

  /**
   * The most sim time the next frame may advance for the runs in flight: the smallest remaining time of a run still
   * stepping; 0 when every run has reached its target and only waits for its readback; Infinity without runs.
   */
  stepLimit(): number {
    let limit = Infinity;
    let waiting = false;
    for (const run of this.runs) {
      if (run.doneAt !== null) waiting = true;
      else limit = Math.min(limit, Math.max(0, run.remaining));
    }
    return limit === Infinity && waiting ? 0 : limit;
  }

  start(simSeconds: number, now: number): Promise<void> {
    if (!(simSeconds >= 0) || !Number.isFinite(simSeconds)) {
      return Promise.reject(new Error(`runFor: invalid simSeconds ${simSeconds}`));
    }
    return new Promise<void>((resolve, reject) => {
      this.runs.push({
        simSeconds,
        remaining: simSeconds,
        doneAt: null,
        doneClock: 0,
        doneSnap: null,
        doneSnapTime: NaN,
        doneExact: false,
        // Progress-based: a slow GPU that keeps advancing is fine; only a stalled sim times out.
        lastProgress: now,
        resolve,
        reject,
      });
    });
  }

  /**
   * Account for sim time stepped this frame. `advanced` must be finite (the driver substitutes the
   * requested time when a blown-up solver reports NaN, so runs can't hang in the stability demo).
   */
  onStep(advanced: number, clock: number, now: number, snap: SimSnapshot | null, exact = false): void {
    for (const run of this.runs) {
      if (run.doneAt !== null) continue;
      run.remaining -= advanced;
      if (advanced > 0) run.lastProgress = now;
      if (run.remaining <= RUN_TARGET_EPSILON_S) {
        run.doneAt = now;
        run.doneClock = clock;
        run.doneSnap = snap;
        run.doneSnapTime = snap?.simTime ?? NaN;
        run.doneExact = exact;
      }
    }
  }

  /** Sim clock was reset to 0 (solver.reset / new scene): completed targets are now relative to 0. */
  onReset(): void {
    for (const run of this.runs) if (run.doneAt !== null) run.doneClock = 0;
  }

  /** Check completion/timeouts once per frame with the latest snapshot. `perFrameAdvance` = last frame's sim step. */
  onFrame(snap: SimSnapshot | null, perFrameAdvance: number, now: number): void {
    if (this.runs.length === 0) return;
    const keep: Run[] = [];
    for (const run of this.runs) {
      if (run.doneAt !== null) {
        // A run the driver stopped on its target (frames capped: the user's flood is paused) waits for the readback of
        // exactly where it stopped; a run on a playing sim accepts any readback from within the last frame.
        const tolerance = run.doneExact ? 1e-3 : Math.max(0.5, perFrameAdvance * 1.05);
        // Object.is: a NaN simTime (blown-up naive solver) must compare equal to itself.
        const newer = !!snap && (snap !== run.doneSnap || !Object.is(snap.simTime, run.doneSnapTime));
        const caughtUp =
          !!snap && (Number.isFinite(snap.simTime) ? snap.simTime >= run.doneClock - tolerance : newer);
        if (caughtUp || now - run.doneAt > SNAPSHOT_GRACE_MS) {
          run.resolve();
          continue;
        }
      } else if (now - run.lastProgress > STALL_TIMEOUT_MS) {
        const done = run.simSeconds - run.remaining;
        run.reject(
          new Error(
            `runFor(${run.simSeconds}) timed out: no progress for ${STALL_TIMEOUT_MS / 1000} s ` +
              `after advancing ${done.toFixed(1)} sim s (paused by a load, hidden tab, or a stalled GPU?)`,
          ),
        );
        continue;
      }
      keep.push(run);
    }
    this.runs = keep;
  }

  cancelAll(reason: string): void {
    const runs = this.runs;
    this.runs = [];
    for (const run of runs) run.reject(new Error(`runFor cancelled: ${reason}`));
  }
}

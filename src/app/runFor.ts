import type { SimSnapshot } from '../contracts';

/** After the requested sim time has been stepped, wait at most this long for a readback that includes it. */
const SNAPSHOT_GRACE_MS = 3000;

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
  deadline: number;
  resolve(): void;
  reject(err: Error): void;
}

/**
 * Implements the debug API's runFor(): while any run is active the frame driver forces the sim to
 * run (even if paused) at a high time scale. A run completes once the solver has advanced the requested
 * sim time AND a readback containing that time has arrived, so getStats() right after reflects it.
 */
export class RunForScheduler {
  private runs: Run[] = [];

  get active(): boolean {
    return this.runs.length > 0;
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
        // Generous: assumes ≥ 20 sim-seconds per real second after a 45 s allowance (loading, shader compile).
        deadline: now + 45_000 + simSeconds * 50,
        resolve,
        reject,
      });
    });
  }

  /**
   * Account for sim time stepped this frame. `advanced` must be finite (the driver substitutes the
   * requested time when a blown-up solver reports NaN, so runs can't hang in the stability demo).
   */
  onStep(advanced: number, clock: number, now: number, snap: SimSnapshot | null): void {
    for (const run of this.runs) {
      if (run.doneAt !== null) continue;
      run.remaining -= advanced;
      if (run.remaining <= 0) {
        run.doneAt = now;
        run.doneClock = clock;
        run.doneSnap = snap;
        run.doneSnapTime = snap?.simTime ?? NaN;
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
        const tolerance = Math.max(0.5, perFrameAdvance * 1.05);
        // Object.is: a NaN simTime (blown-up naive solver) must compare equal to itself.
        const newer = !!snap && (snap !== run.doneSnap || !Object.is(snap.simTime, run.doneSnapTime));
        const caughtUp =
          !!snap && (Number.isFinite(snap.simTime) ? snap.simTime >= run.doneClock - tolerance : newer);
        if (caughtUp || now - run.doneAt > SNAPSHOT_GRACE_MS) {
          run.resolve();
          continue;
        }
      } else if (now > run.deadline) {
        const done = run.simSeconds - run.remaining;
        run.reject(
          new Error(`runFor(${run.simSeconds}) timed out after advancing ${done.toFixed(1)} sim s`),
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

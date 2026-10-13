/**
 * Beat scheduling for a story, with no DOM and no app in it: the player (src/ui/storyPlayer.ts) supplies the
 * environment — how to show a beat, run an action, wait for a simulation condition, and keep time — and the runner
 * decides when to move on. Unit-tested with fake timers in tests/ui/story.test.ts.
 *
 * A beat moves on when all three are done:
 *   1. its actions, run in order (a levee build, an evacuation plan…);
 *   2. its reading time, `durationMs × pace`, counted from the moment the beat appears;
 *   3. its `until` condition, started once the actions are done, given up after `maxWaitMs` (the story never stalls
 *      on a slow GPU: it moves on and the caption's live tokens still say where the simulation really is).
 *
 * Pause stops both clocks (reading time and the wait cap) and tells the environment, which pauses the simulation, so
 * a paused story waits for nothing. Next / previous abandon the beat in progress (its wait is aborted) and resume.
 */
import { DEFAULT_MAX_WAIT_MS, type Beat, type SimAction, type Story, type UntilSpec } from './types';

export interface RunnerEnv {
  /** A beat is about to start: show its caption, highlights, camera. */
  enter(index: number, beat: Beat): void;
  /** Run one action (resolves when done; may resolve early once `signal` aborts). */
  act(action: SimAction, beat: Beat, signal: AbortSignal): Promise<void>;
  /** Resolve true once the condition holds, false when `signal` aborts. */
  waitUntil(until: UntilSpec, signal: AbortSignal): Promise<boolean>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  /** The user paused (true) or resumed (false) the story. */
  onPause?(paused: boolean): void;
  /** Anything in RunnerState changed. */
  onChange?(state: RunnerState): void;
  /** The last beat has finished. */
  onFinish?(): void;
  /** An action threw (the story carries on). */
  onError?(err: unknown, action: SimAction): void;
}

export type BeatPhase = 'actions' | 'waiting' | 'reading' | 'done';

export interface RunnerState {
  index: number;
  total: number;
  paused: boolean;
  finished: boolean;
  phase: BeatPhase;
  /** The current beat's `until` gave up at its cap. */
  timedOut: boolean;
  /** Reading time left on the current beat, ms. */
  holdRemainingMs: number;
}

export interface RunnerOptions {
  /** Multiplies every beat's reading time (e2e: 0.05; 1 = as written). */
  pace?: number;
  /** Upper bound on any beat's `until` wait, ms (e2e and recordings on a slow GPU). */
  maxWaitCapMs?: number;
}

/** Reading time of a beat at a pace, ms. */
export function holdMs(beat: Pick<Beat, 'durationMs'>, pace = 1): number {
  return Math.max(0, Math.round(beat.durationMs * (Number.isFinite(pace) && pace >= 0 ? pace : 1)));
}

/** How long a beat waits for its `until` at most, ms. */
export function waitCapMs(beat: Pick<Beat, 'maxWaitMs'>, opts: RunnerOptions = {}): number {
  const own = beat.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  return Math.max(0, Math.min(own, opts.maxWaitCapMs ?? Infinity));
}

/** A one-shot timer that can be paused and resumed (built on the environment's timers). */
class PausableTimer {
  private handle: unknown = null;
  private startedAt = 0;
  private remaining: number;
  private running = false;
  done = false;
  constructor(
    private readonly env: Pick<RunnerEnv, 'setTimer' | 'clearTimer' | 'now'>,
    ms: number,
    private readonly fire: () => void,
  ) {
    this.remaining = ms;
  }
  start(): void {
    if (this.done || this.running) return;
    if (this.remaining <= 0) {
      this.done = true;
      this.fire();
      return;
    }
    this.running = true;
    this.startedAt = this.env.now();
    this.handle = this.env.setTimer(() => {
      this.handle = null;
      this.running = false;
      this.remaining = 0;
      this.done = true;
      this.fire();
    }, this.remaining);
  }
  pause(): void {
    if (!this.running) return;
    this.env.clearTimer(this.handle);
    this.handle = null;
    this.running = false;
    this.remaining = Math.max(0, this.remaining - (this.env.now() - this.startedAt));
  }
  cancel(): void {
    if (this.handle !== null) this.env.clearTimer(this.handle);
    this.handle = null;
    this.running = false;
  }
  left(): number {
    if (this.done) return 0;
    return this.running ? Math.max(0, this.remaining - (this.env.now() - this.startedAt)) : this.remaining;
  }
}

export class StoryRunner {
  private gen = 0;
  private index = -1;
  private paused = false;
  private finished = false;
  private phase: BeatPhase = 'done';
  private timedOut = false;
  private abort: AbortController | null = null;
  private hold: PausableTimer | null = null;
  private cap: PausableTimer | null = null;
  private actionsDone = false;
  private untilDone = true;
  private readonly opts: RunnerOptions;

  constructor(
    readonly story: Story,
    private readonly env: RunnerEnv,
    opts: RunnerOptions = {},
  ) {
    this.opts = { ...opts };
  }

  get state(): RunnerState {
    return {
      index: this.index,
      total: this.story.beats.length,
      paused: this.paused,
      finished: this.finished,
      phase: this.phase,
      timedOut: this.timedOut,
      holdRemainingMs: this.hold?.left() ?? 0,
    };
  }

  /** Start (or restart) at beat `index`. */
  start(index = 0): void {
    this.finished = false;
    this.setPaused(false);
    this.go(index);
  }

  next(): void {
    if (this.finished || this.index < 0) return;
    this.setPaused(false);
    if (this.index >= this.story.beats.length - 1) this.finish();
    else this.go(this.index + 1);
  }

  prev(): void {
    if (this.index < 0) return;
    // From the end card, "previous" replays the last beat; otherwise it steps back one.
    const back = this.finished ? 0 : 1;
    this.finished = false;
    this.setPaused(false);
    this.go(Math.max(0, this.index - back));
  }

  /** Jump to a beat (the progress bar). */
  seek(index: number): void {
    if (this.index < 0) return;
    this.finished = false;
    this.setPaused(false);
    this.go(index);
  }

  pause(): void {
    if (this.finished || this.paused) return;
    this.setPaused(true);
    this.emit();
  }

  resume(): void {
    if (this.finished || !this.paused) return;
    this.setPaused(false);
    this.emit();
    this.check(this.gen);
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  /** Stop for good (the player is closing): nothing more happens, no onFinish. */
  stop(): void {
    this.gen++;
    this.teardownBeat();
    this.phase = 'done';
    this.finished = true;
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────────────────────────

  private setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    if (p) {
      this.hold?.pause();
      this.cap?.pause();
    } else {
      this.hold?.start();
      this.cap?.start();
    }
    this.env.onPause?.(p);
  }

  private teardownBeat(): void {
    this.abort?.abort();
    this.abort = null;
    this.hold?.cancel();
    this.cap?.cancel();
    this.hold = null;
    this.cap = null;
  }

  private go(i: number): void {
    const beats = this.story.beats;
    if (!beats.length) return this.finish();
    const index = Math.max(0, Math.min(beats.length - 1, Math.floor(i)));
    this.teardownBeat();
    const g = ++this.gen;
    const beat = beats[index];
    this.index = index;
    this.finished = false;
    this.timedOut = false;
    this.actionsDone = false;
    this.untilDone = !beat.until;
    this.phase = 'actions';
    const abort = new AbortController();
    this.abort = abort;
    this.hold = new PausableTimer(this.env, holdMs(beat, this.opts.pace), () => this.check(g));
    this.env.enter(index, beat);
    if (g !== this.gen) return; // enter() moved the story on itself
    if (!this.paused) this.hold.start();
    this.emit();
    void this.runBeat(g, beat, abort.signal);
  }

  private async runBeat(g: number, beat: Beat, signal: AbortSignal): Promise<void> {
    for (const action of beat.actions ?? []) {
      if (signal.aborted || g !== this.gen) return;
      try {
        await this.env.act(action, beat, signal);
      } catch (err) {
        this.env.onError?.(err, action);
      }
    }
    if (g !== this.gen) return;
    this.actionsDone = true;
    if (beat.until) {
      this.phase = 'waiting';
      this.emit();
      const waitAbort = new AbortController();
      const onAbort = () => waitAbort.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.cap = new PausableTimer(this.env, waitCapMs(beat, this.opts), () => {
        if (g !== this.gen) return;
        this.timedOut = true;
        waitAbort.abort();
      });
      if (!this.paused) this.cap.start();
      try {
        await this.env.waitUntil(beat.until, waitAbort.signal);
      } catch {
        /* a failed wait is a finished wait */
      }
      signal.removeEventListener('abort', onAbort);
      if (g !== this.gen) return;
      this.cap.cancel();
      this.untilDone = true;
    }
    this.phase = 'reading';
    this.emit();
    this.check(g);
  }

  private check(g: number): void {
    if (g !== this.gen || this.finished || this.paused) return;
    if (!this.actionsDone || !this.untilDone || !this.hold?.done) return;
    this.phase = 'done';
    if (this.index >= this.story.beats.length - 1) this.finish();
    else this.go(this.index + 1);
  }

  private finish(): void {
    this.gen++;
    this.teardownBeat();
    this.finished = true;
    this.phase = 'done';
    this.emit();
    this.env.onFinish?.();
  }

  private emit(): void {
    this.env.onChange?.(this.state);
  }
}

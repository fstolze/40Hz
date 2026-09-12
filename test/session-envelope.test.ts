/**
 * Playback envelope scheduling.
 *
 * `tools/verify.ts` and the offline renderer exercise the DSP core, not a Web
 * Audio graph, so neither can say anything about automation. These drive the
 * scheduling against a fake `AudioParam` that records what was asked of it,
 * and evaluate the resulting curve — which is what actually reaches the ear.
 *
 * The real graph is proven in the Electron smoke test.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  MIN_RAMP_SECONDS,
  cancelSessionEnvelope,
  scheduleOpenEnvelope,
  scheduleSessionEnvelope,
  type EnvelopeParam,
} from '../src/audio/session-envelope.ts';

interface Automation {
  kind: 'set' | 'ramp';
  value: number;
  time: number;
  /** Insertion order, to break ties at identical times. */
  seq: number;
}

/**
 * A fake AudioParam that models the automation timeline, not just the calls.
 *
 * Recording which methods were invoked would prove almost nothing here: the
 * required behaviours — that stopping mid-ramp is continuous, and that
 * Preview restarts from the level it was left at — are properties of the
 * resulting curve. So cancellation actually mutates the timeline the way the
 * Web Audio specification says it does: `cancelScheduledValues` drops events
 * at or after the cancel time and lets the value revert to the last remaining
 * anchor, while `cancelAndHoldAtTime` first pins the value it would have had.
 * The difference between those two is exactly why the envelope prefers hold.
 */
class FakeParam implements EnvelopeParam {
  /** The instant `value` reads from, as an AudioContext clock would. */
  now = 0;
  /** Names of the automation methods called, in order. */
  readonly calls: string[] = [];
  readonly supportsHold: boolean;

  private timeline: Automation[] = [];
  private initialValue = 0;
  private seq = 0;

  // Explicit field rather than a constructor parameter property: the project
  // is erasable TypeScript only, enforced by `erasableSyntaxOnly`.
  constructor(supportsHold = true) {
    this.supportsHold = supportsHold;
    if (!supportsHold) {
      (this as { cancelAndHoldAtTime?: unknown }).cancelAndHoldAtTime = undefined;
    }
  }

  get value(): number {
    return this.valueAt(this.now);
  }

  set value(v: number) {
    this.initialValue = v;
    this.timeline = [];
  }

  setValueAtTime(value: number, time: number): void {
    this.calls.push('set');
    this.insert({ kind: 'set', value, time, seq: this.seq++ });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.calls.push('ramp');
    this.insert({ kind: 'ramp', value, time, seq: this.seq++ });
  }

  cancelScheduledValues(time: number): void {
    this.calls.push('cancel');
    // Removes scheduled events at or after `time`. A ramp in progress loses
    // its end point, so the value snaps back to the last anchor before it.
    this.timeline = this.timeline.filter((e) => e.time < time);
  }

  cancelAndHoldAtTime(time: number): void {
    if (!this.supportsHold) throw new Error('cancelAndHoldAtTime unsupported');
    this.calls.push('hold');
    const held = this.valueAt(time);
    const rampInProgress = this.timeline.some((e) => e.kind === 'ramp' && e.time > time);
    this.timeline = this.timeline.filter((e) => e.time < time);
    // Preserve the shape up to the cancel instant, then pin the value there,
    // so anything scheduled afterwards continues from where it truly was.
    this.insert({
      kind: rampInProgress ? 'ramp' : 'set',
      value: held,
      time,
      seq: this.seq++,
    });
  }

  private insert(event: Automation): void {
    this.timeline.push(event);
    this.timeline.sort((a, b) => a.time - b.time || a.seq - b.seq);
  }

  /**
   * Value of the curve at `t`.
   *
   * A linear ramp interpolates from the event immediately preceding it. An
   * event scheduled after `t` is not an anchor for the present — between a
   * ramp and a later set, the value simply holds.
   */
  valueAt(t: number): number {
    let value = this.initialValue;
    let previousTime = Number.NEGATIVE_INFINITY;
    for (const e of this.timeline) {
      if (e.time <= t) {
        value = e.value;
        previousTime = e.time;
        continue;
      }
      if (e.kind === 'ramp' && previousTime !== Number.NEGATIVE_INFINITY) {
        const span = e.time - previousTime;
        if (span <= 0) return e.value;
        const frac = Math.min(1, Math.max(0, (t - previousTime) / span));
        return value + (e.value - value) * frac;
      }
      return value;
    }
    return value;
  }

  get peak(): number {
    return this.timeline.reduce((m, e) => Math.max(m, e.value), this.initialValue);
  }
}

const START = 100;

describe('session envelope', () => {
  it('is silent at the start and at the end', () => {
    const p = new FakeParam();
    scheduleSessionEnvelope(p, {
      startAt: START,
      rampInSeconds: 3,
      fadeStartAt: START + 600 - 1.5,
      fadeOutSeconds: 1.5,
    });
    expect(p.valueAt(START)).toBe(0);
    expect(p.valueAt(START + 600)).toBeCloseTo(0, 10);
  });

  it('reaches full level after the ramp-in and holds there', () => {
    const p = new FakeParam();
    scheduleSessionEnvelope(p, {
      startAt: START,
      rampInSeconds: 3,
      fadeStartAt: START + 600 - 1.5,
      fadeOutSeconds: 1.5,
    });
    expect(p.valueAt(START + 1.5)).toBeCloseTo(0.5, 6);
    expect(p.valueAt(START + 3)).toBeCloseTo(1, 10);
    // The steady part must not sag toward the fade.
    expect(p.valueAt(START + 300)).toBeCloseTo(1, 10);
    expect(p.valueAt(START + 590)).toBeCloseTo(1, 10);
  });

  it('lands silence exactly at the planned end, not after it', () => {
    // The defect this whole node exists to prevent: fading *from* the planned
    // end leaves the session audible past its own duration.
    const p = new FakeParam();
    const planned = 600;
    scheduleSessionEnvelope(p, {
      startAt: START,
      rampInSeconds: 3,
      fadeStartAt: START + planned - 1.5,
      fadeOutSeconds: 1.5,
    });
    expect(p.valueAt(START + planned - 1.5)).toBeCloseTo(1, 10);
    expect(p.valueAt(START + planned - 0.75)).toBeCloseTo(0.5, 6);
    expect(p.valueAt(START + planned)).toBeCloseTo(0, 10);
  });

  it('never schedules above unity, so headroom upstream still holds', () => {
    const p = new FakeParam();
    scheduleSessionEnvelope(p, {
      startAt: START,
      rampInSeconds: 3,
      fadeStartAt: START + 600,
      fadeOutSeconds: 1.5,
    });
    expect(p.peak).toBeLessThanOrEqual(1);
  });

  it('rises only as far as it gets when the session is shorter than its ramps', () => {
    // 2 s planned, 3 s ramp-in, 1.5 s ramp-out: the fade is due at 0.5 s, by
    // which point a 3 s ramp has only reached one sixth.
    const p = new FakeParam();
    scheduleSessionEnvelope(p, {
      startAt: START,
      rampInSeconds: 3,
      fadeStartAt: START + 0.5,
      fadeOutSeconds: 1.5,
    });
    expect(p.valueAt(START + 0.5)).toBeCloseTo(1 / 6, 6);
    expect(p.peak).toBeCloseTo(1 / 6, 6);
    expect(p.valueAt(START + 2)).toBeCloseTo(0, 10);
  });

  it('stays silent when there is no room to rise at all', () => {
    const p = new FakeParam();
    scheduleSessionEnvelope(p, {
      startAt: START,
      rampInSeconds: 3,
      fadeStartAt: START,
      fadeOutSeconds: 1.5,
    });
    expect(p.peak).toBe(0);
  });
});

/** A full-length session envelope, for tests that then interrupt it. */
function scheduleStandard(p: FakeParam, planned = 600): void {
  scheduleSessionEnvelope(p, {
    startAt: START,
    rampInSeconds: 3,
    fadeStartAt: START + planned - 1.5,
    fadeOutSeconds: 1.5,
  });
}

describe('stopping early', () => {
  it('is continuous when stopped during the ramp-in', () => {
    const p = new FakeParam();
    scheduleStandard(p);
    const stopAt = START + 1.5;
    const before = p.valueAt(stopAt);
    expect(before).toBeCloseTo(0.5, 6);

    cancelSessionEnvelope(p, { at: stopAt, fadeOutSeconds: 1.5 });

    // The level must not move at the instant of stopping. A jump here is
    // audible as a click, and is exactly what a bare cancel would produce.
    expect(p.valueAt(stopAt)).toBeCloseTo(before, 9);
    expect(p.valueAt(stopAt + 0.75)).toBeCloseTo(before / 2, 6);
    expect(p.valueAt(stopAt + 1.5)).toBeCloseTo(0, 9);
  });

  it('is continuous when stopped during the steady part', () => {
    const p = new FakeParam();
    scheduleStandard(p);
    const stopAt = START + 300;
    expect(p.valueAt(stopAt)).toBeCloseTo(1, 9);

    cancelSessionEnvelope(p, { at: stopAt, fadeOutSeconds: 1.5 });

    expect(p.valueAt(stopAt)).toBeCloseTo(1, 9);
    expect(p.valueAt(stopAt + 1.5)).toBeCloseTo(0, 9);
    // And nothing from the original schedule survives to raise it again.
    expect(p.valueAt(START + 600)).toBeCloseTo(0, 9);
  });

  it('steepens a fade already under way rather than jumping', () => {
    const p = new FakeParam();
    const planned = 600;
    scheduleStandard(p, planned);
    const stopAt = START + planned - 1;
    const before = p.valueAt(stopAt);
    // One second before the end of a 1.5 s fade: two thirds of the way down.
    expect(before).toBeCloseTo(2 / 3, 6);

    cancelSessionEnvelope(p, { at: stopAt, fadeOutSeconds: 0.2 });

    expect(p.valueAt(stopAt)).toBeCloseTo(before, 9);
    expect(p.valueAt(stopAt + 0.2)).toBeCloseTo(0, 9);
  });

  it('reaches silence and stays there', () => {
    const p = new FakeParam();
    scheduleStandard(p);
    cancelSessionEnvelope(p, { at: START + 10, fadeOutSeconds: 1.5 });
    expect(p.valueAt(START + 11.5)).toBeCloseTo(0, 9);
    expect(p.valueAt(START + 60)).toBeCloseTo(0, 9);
    expect(p.valueAt(START + 10_000)).toBeCloseTo(0, 9);
  });

  it('honours a minimum ramp, so a zero-length stop is not a step', () => {
    const p = new FakeParam();
    scheduleStandard(p);
    const stopAt = START + 300;
    cancelSessionEnvelope(p, { at: stopAt, fadeOutSeconds: 0 });
    expect(p.valueAt(stopAt)).toBeCloseTo(1, 9);
    expect(p.valueAt(stopAt + MIN_RAMP_SECONDS)).toBeCloseTo(0, 9);
  });
});

describe('why the envelope holds before fading', () => {
  it('a bare cancel mid-ramp would jump the level', () => {
    // Not a use of the envelope API — this is the behaviour being avoided,
    // pinned so the reason for preferring cancelAndHoldAtTime stays visible.
    const p = new FakeParam();
    scheduleStandard(p);
    const at = START + 1.5;
    expect(p.valueAt(at)).toBeCloseTo(0.5, 6);
    p.cancelScheduledValues(at);
    // The ramp lost its end point, so the value snaps back to its anchor.
    expect(p.valueAt(at)).toBeCloseTo(0, 9);
  });

  it('the envelope does not, because it holds first', () => {
    const p = new FakeParam();
    scheduleStandard(p);
    const at = START + 1.5;
    cancelSessionEnvelope(p, { at, fadeOutSeconds: 1.5 });
    expect(p.valueAt(at)).toBeCloseTo(0.5, 6);
    expect(p.calls.includes('hold')).toBe(true);
  });
});

describe('without cancelAndHoldAtTime', () => {
  it('is still continuous, via the observed value', () => {
    const p = new FakeParam(false);
    scheduleStandard(p);
    const stopAt = START + 1.5;
    p.now = stopAt; // the fallback reads `value`, as an engine would
    const before = p.valueAt(stopAt);
    expect(before).toBeCloseTo(0.5, 6);

    cancelSessionEnvelope(p, { at: stopAt, fadeOutSeconds: 1.5 });

    expect(p.calls.includes('hold')).toBe(false);
    expect(p.valueAt(stopAt)).toBeCloseTo(before, 9);
    expect(p.valueAt(stopAt + 1.5)).toBeCloseTo(0, 9);
  });
});

describe('open envelope', () => {
  it('ramps up and holds indefinitely', () => {
    const p = new FakeParam();
    scheduleOpenEnvelope(p, START, 3);
    expect(p.valueAt(START)).toBeCloseTo(0, 9);
    expect(p.valueAt(START + 1.5)).toBeCloseTo(0.5, 6);
    expect(p.valueAt(START + 3)).toBeCloseTo(1, 9);
    expect(p.valueAt(START + 10_000)).toBeCloseTo(1, 9);
  });

  it('restarting preview mid-fade resumes from the level it was left at', () => {
    const p = new FakeParam();
    scheduleOpenEnvelope(p, START, 3);
    const stopAt = START + 3;
    cancelSessionEnvelope(p, { at: stopAt, fadeOutSeconds: 1.5 });

    // Half a second into a 1.5 s fade from full: two thirds remain.
    const restartAt = stopAt + 0.5;
    const level = p.valueAt(restartAt);
    expect(level).toBeCloseTo(2 / 3, 6);

    p.now = restartAt;
    scheduleOpenEnvelope(p, restartAt, 3);

    // Continuous across the restart, then up to full — not from zero.
    expect(p.valueAt(restartAt)).toBeCloseTo(level, 9);
    expect(p.valueAt(restartAt + 1.5)).toBeGreaterThan(level);
    expect(p.valueAt(restartAt + 3)).toBeCloseTo(1, 9);
  });
});

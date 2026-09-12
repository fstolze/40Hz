/**
 * When a pass is taken, and what a run of changes costs.
 *
 * The policy, driven by hand: a fake timer, a fake host, and a pass whose
 * completion the test controls. What is being pinned is the behaviour a user
 * produces without thinking about it — dragging a slider is dozens of changes
 * in a second, and the version of this that refuses them while a pass is
 * running discards the only one that matters, which is the last.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { CaptureSchedule, type CaptureHost } from '../src/integrity/capture-schedule.ts';
import type { MeasurableOutput, CaptureSource } from '../src/integrity/capture-run.ts';
import type { CaptureOutcome } from '../src/integrity/capture-client.ts';
import type { Finding } from '../src/integrity/findings.ts';
import type { Schedule } from '../src/lib/schedule.ts';
import { DEFAULT_PARAMS, type EntrainmentParams } from '../src/audio/dsp/entrainment-core.ts';
import { renderOffline } from '../src/audio/dsp/render-offline.ts';
import { openSteady } from '../src/audio/steady-window.ts';

const SR = 48000;

/**
 * A timer whose firing moves the clock the schedule reads.
 *
 * Both, together, on purpose: the schedule re-checks the audio clock when it
 * wakes and reschedules if the moment has not arrived, so a fake that fired
 * without time passing would reschedule for ever — which is the correct
 * behaviour for a clock that never advances, and useless as a fixture.
 */
class FakeSchedule implements Schedule {
  delays: number[] = [];
  readonly clock = { now: 0 };
  private pending: (() => void) | null = null;
  private delayMs = 0;

  after(delayMs: number, fire: () => void): void {
    this.delays.push(delayMs);
    this.delayMs = delayMs;
    this.pending = fire;
  }

  cancel(): void {
    this.pending = null;
  }

  get scheduled(): boolean {
    return this.pending !== null;
  }

  fire(): void {
    const pending = this.pending;
    this.pending = null;
    this.clock.now += this.delayMs / 1000;
    pending?.();
  }
}

/** A tap whose answer the test releases, so a pass can be held open. */
class HeldTap implements CaptureSource {
  calls = 0;
  private release: (() => void) | null = null;
  private held = false;

  hold(): void {
    this.held = true;
  }

  open(): void {
    this.held = false;
    this.release?.();
    this.release = null;
  }

  async capture(frames: number): Promise<CaptureOutcome> {
    this.calls += 1;
    if (this.held) await new Promise<void>((resolve) => (this.release = resolve));
    const rendered = renderOffline(DEFAULT_PARAMS, SR, frames);
    return {
      type: 'capture',
      id: this.calls,
      ok: true,
      left: Float32Array.from(rendered.left),
      right: Float32Array.from(rendered.right),
      frames,
      epoch: 0,
      // Well inside steady playback, so the pass measures rather than refuses.
      startFrame: 100 * SR,
      startedAt: 100,
    };
  }
}

interface Harness {
  schedule: CaptureSchedule;
  timer: FakeSchedule;
  taps: { entrainment: HeldTap; master: HeldTap };
  recorded: Finding[][];
  errors: unknown[];
  params: EntrainmentParams;
}

function harness(over: Partial<MeasurableOutput> = {}): Harness {
  const taps = { entrainment: new HeldTap(), master: new HeldTap() };
  const recorded: Finding[][] = [];
  const errors: unknown[] = [];
  const state = { params: { ...DEFAULT_PARAMS } };

  const output: MeasurableOutput = {
    sampleRate: SR,
    capacityFrames: 8 * SR,
    steadyPlayback: () => openSteady(0, 3),
    entrainment: taps.entrainment,
    master: taps.master,
    ceiling: 0.8,
    ...over,
  };

  const timer = new FakeSchedule();
  const host: CaptureHost = {
    output: () => output,
    params: () => state.params,
    now: () => timer.clock.now,
    record: (findings) => recorded.push(findings),
    onError: (error) => errors.push(error),
  };

  return {
    schedule: new CaptureSchedule(host, timer),
    timer,
    taps,
    recorded,
    errors,
    params: state.params,
  };
}

/** Let every queued microtask run, so an awaited pass can finish. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve();
}

describe('when a change arrives', () => {
  it('withdraws what was measured under the old configuration', async () => {
    // The findings describe settings no longer in force, and the ring is
    // epoched at that moment. Leaving them up until a new pass lands would
    // show a measurement of audio nobody is hearing.
    const { schedule, recorded } = harness();
    schedule.changed();
    expect(recorded.length).toBe(1);
    expect(recorded[0].length).toBe(0);
  });

  it('schedules a pass a whole window past steadiness', () => {
    const { schedule, timer } = harness();
    schedule.changed();
    expect(timer.scheduled).toBe(true);
    // 3 s of ramp, plus the window itself — never at the moment steadiness
    // opens, which would reach back through the ramp.
    expect(timer.delays[0] > 3000).toBe(true);
  });

  it('coalesces a run of them onto one pass', async () => {
    // A slider drag. Each change replaces the pending pass rather than adding
    // one, so fifty changes cost a single measurement.
    const { schedule, timer, taps } = harness();
    for (let i = 0; i < 50; i++) schedule.changed();
    expect(timer.delays.length).toBe(50);

    timer.fire();
    await settle();
    expect(taps.master.calls).toBe(1);
  });

  it('takes no pass at all while there is nothing steady to measure', () => {
    const { schedule, timer } = harness({ steadyPlayback: () => ({ from: 0, until: 1 }) });
    schedule.changed();
    // A window cannot fit before the fade, so a pass could only be refused.
    expect(timer.scheduled).toBe(false);
  });
});

describe('a change arriving during a pass', () => {
  it('is not discarded, and becomes the trailing pass', async () => {
    // The failure an in-flight guard produces on its own: the last slider
    // position is the one that matters, and refusing it leaves the newest
    // configuration unmeasured until something else happens to change.
    const { schedule, timer, taps, recorded } = harness();
    taps.master.hold();

    schedule.changed();
    timer.fire();
    await settle();
    expect(taps.master.calls).toBe(1);

    // The user moves the slider again while the first pass is still waiting.
    schedule.changed();
    taps.master.open();
    await settle();

    // The pass that was in flight is not recorded — it describes the old
    // configuration — and a fresh one is scheduled for the new one.
    expect(recorded.every((set) => set.length === 0)).toBe(true);
    expect(timer.scheduled).toBe(true);

    timer.fire();
    await settle();
    expect(taps.master.calls).toBe(2);
    expect(recorded[recorded.length - 1].length > 0).toBe(true);
  });

  it('discards a pass that lands after the configuration moved', async () => {
    // The generation check, and the reason it is rechecked after the await
    // rather than only claimed before it.
    const { schedule, timer, taps, recorded } = harness();
    taps.master.hold();
    schedule.changed();
    timer.fire();
    await settle();

    schedule.changed();
    taps.master.open();
    await settle();

    expect(recorded.some((set) => set.length > 0)).toBe(false);
  });
});

describe('the manual check', () => {
  it('measures now rather than waiting for the schedule', async () => {
    const { schedule, timer, taps, recorded } = harness();
    // Well into steady playback, as it would be when a user presses it.
    timer.clock.now = 60;
    await schedule.runNow();
    await settle();

    expect(taps.master.calls).toBe(1);
    expect(recorded[recorded.length - 1].length > 0).toBe(true);
  });

  it('measures during a ramp too, rather than quietly rescheduling', async () => {
    // The clock is at zero, so the automatic path would wait several seconds.
    // A button that returns having scheduled something is a button that did
    // nothing: the busy state clears, the panel is unchanged, and the user
    // presses it again. It runs, and the pass says what it found.
    const { schedule, taps, recorded } = harness();
    await schedule.runNow();
    await settle();

    expect(taps.master.calls).toBe(1);
    expect(recorded[recorded.length - 1].length > 0).toBe(true);
  });

  it('leaves the automatic pass to come', async () => {
    // Cancelling it would trade the measurement the user asked for against
    // the one that was coming anyway — and the second is the one that will
    // have a judgeable window.
    const { schedule, timer, taps } = harness();
    schedule.changed();
    expect(timer.scheduled).toBe(true);

    await schedule.runNow();
    await settle();
    expect(taps.master.calls).toBe(1);
    expect(timer.scheduled).toBe(true);

    timer.fire();
    await settle();
    expect(taps.master.calls).toBe(2);
  });
});

describe('stopping', () => {
  it('cancels a pending pass', () => {
    const { schedule, timer } = harness();
    schedule.changed();
    schedule.stopped();
    expect(timer.scheduled).toBe(false);
  });

  it('leaves the last measurement standing', () => {
    // Nothing about the audio that played became untrue because playback
    // ended, which is what separates a stop from a configuration change.
    const { schedule, recorded } = harness();
    schedule.stopped();
    expect(recorded.length).toBe(0);
  });

  it('discards a pass still in flight', async () => {
    const { schedule, timer, taps, recorded } = harness();
    taps.master.hold();
    schedule.changed();
    timer.fire();
    await settle();

    schedule.stopped();
    taps.master.open();
    await settle();

    expect(recorded.some((set) => set.length > 0)).toBe(false);
  });
});

describe('when there is no graph', () => {
  it('schedules nothing and records nothing', async () => {
    const { schedule, timer, recorded } = harness();
    const empty = new CaptureSchedule(
      {
        output: () => null,
        params: () => ({ ...DEFAULT_PARAMS }),
        now: () => timer.clock.now,
        record: (findings) => recorded.push(findings),
        onError: () => undefined,
      },
      timer,
    );
    empty.changed();
    await empty.runNow();
    expect(timer.scheduled).toBe(false);
    // The withdrawal still happens: a change with no graph to measure means
    // whatever was shown is no longer current either.
    expect(recorded.length).toBe(1);
    expect(schedule instanceof CaptureSchedule).toBe(true);
  });
});

describe('the wall clock against the audio clock', () => {
  it('reschedules rather than measuring early when the moment has not arrived', async () => {
    // The two clocks drift: a context does not advance its own while it is
    // suspended or resuming, so a wall-clock delay can land before the audio
    // clock has reached the boundary. Measured on a real graph, a pass aimed
    // at the boundary arrived with the window starting 98 ms before it, and
    // the steadiness check refused it — which is a pass that never measures.
    const { schedule, timer, taps } = harness();
    schedule.changed();

    // The timer fires, but the audio clock lagged: only half the delay passed.
    const planned = timer.delays[0];
    timer.clock.now -= planned / 2000;
    timer.fire();
    await settle();

    // Nothing was measured, and it is waiting again rather than having given
    // up or asked anyway.
    expect(taps.master.calls).toBe(0);
    expect(timer.scheduled).toBe(true);

    timer.fire();
    await settle();
    expect(taps.master.calls).toBe(1);
  });
});

describe('an automatic pass colliding with a manual one', () => {
  it('does not treat it as a change, and leaves the manual result standing', async () => {
    // The two were one flag, so a timer that happened to fire during a manual
    // check made the schedule behave as though the configuration had moved:
    // it withdrew the result the check had just produced, bumped the
    // generation, and scheduled a third pass. Nothing had changed.
    const { schedule, timer, taps, recorded } = harness();
    timer.clock.now = 60;

    // A pass is pending, as it would be after playback started.
    schedule.changed();
    expect(recorded.length).toBe(1);
    expect(recorded[0].length).toBe(0);

    // The user presses the button, and the timer fires while it is still
    // capturing.
    taps.master.hold();
    const manual = schedule.runNow();
    await settle();
    timer.fire();
    await settle();

    taps.master.open();
    await manual;
    await settle();

    // The manual findings are the last thing recorded — not withdrawn behind
    // the user's back — and the follow-up ran rather than being scheduled
    // afresh with everything unsaid.
    expect(recorded[recorded.length - 1].length > 0).toBe(true);
    expect(recorded.filter((set) => set.length === 0).length).toBe(1);
    expect(taps.master.calls).toBe(2);
  });

  it('still honours a real change that arrives during a pass', async () => {
    // The other half: a change must still withdraw and reschedule, which is
    // what separating the two flags has to preserve.
    const { schedule, timer, taps, recorded } = harness();
    timer.clock.now = 60;

    taps.master.hold();
    const manual = schedule.runNow();
    await settle();
    schedule.changed();
    taps.master.open();
    await manual;
    await settle();

    expect(recorded.every((set) => set.length === 0)).toBe(true);
    expect(timer.scheduled).toBe(true);
  });
});

describe('the manual check while a pass is already running', () => {
  it('waits for it rather than returning having measured nothing', async () => {
    // The button shows "Checking…" until this promise settles. Returning while
    // a pass is still in flight clears that with the panel unchanged, which
    // reads as a button that does not work — and then measures a second window
    // afterwards for nobody.
    const { schedule, timer, taps, recorded } = harness();
    timer.clock.now = 60;

    taps.master.hold();
    schedule.changed();
    timer.fire();
    await settle();
    expect(taps.master.calls).toBe(1);

    let settled = false;
    const manual = schedule.runNow().then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);

    taps.master.open();
    await manual;

    expect(settled).toBe(true);
    // Joined rather than repeated: the pass in flight was already measuring
    // this configuration, so a second window would answer the same question.
    expect(taps.master.calls).toBe(1);
    expect(recorded[recorded.length - 1].length > 0).toBe(true);
  });

  it('measures again when the pass it joined was discarded', async () => {
    // A configuration change during that pass throws its result away, so the
    // question the user asked is still unanswered when it resolves.
    const { schedule, timer, taps } = harness();
    timer.clock.now = 60;

    taps.master.hold();
    schedule.changed();
    timer.fire();
    await settle();

    const manual = schedule.runNow();
    await settle();
    schedule.changed();
    taps.master.open();
    await manual;
    await settle();

    expect(taps.master.calls).toBe(2);
  });
});

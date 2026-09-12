/**
 * When the master bus may be measured, and when measuring it would report the
 * graph failing at exactly the moment it is behaving.
 *
 * Every master-tap bound is absolute — a peak, a coverage — so a window that
 * clips a ramp carries a deliberate attenuation into the result. This is the
 * arithmetic that keeps that from happening, and it lives here rather than in
 * `graph.ts` because a boundary a few milliseconds out is invisible to a
 * listener and obvious to an assertion.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  NEVER_STEADY,
  deferSteady,
  endSteady,
  isSteady,
  openSteady,
  sessionSteady,
} from '../src/audio/steady-window.ts';
import { captureFramesFor } from '../src/integrity/measure.ts';
import { CAPTURE_RING_SECONDS } from '../src/audio/graph.ts';
import { DEFAULT_PARAMS } from '../src/audio/dsp/entrainment-core.ts';

describe('before anything plays', () => {
  it('is never steady', () => {
    expect(isSteady(NEVER_STEADY, 0, 1)).toBe(false);
    expect(isSteady(NEVER_STEADY, 1e9, 1)).toBe(false);
  });

  it('cannot be edited into meaning something else', () => {
    // A shared singleton, so this is not one graph's problem: setting `from` to
    // zero would make "never steady" pass for every graph the process creates.
    try {
      (NEVER_STEADY as { from: number }).from = 0;
    } catch {
      // Frozen, which is the point. Strict mode throws rather than ignoring it.
    }
    expect(NEVER_STEADY.from).toBe(Infinity);
    expect(isSteady(NEVER_STEADY, 0, 1)).toBe(false);
  });
});

describe('untimed playback', () => {
  it('becomes steady when the ramp finishes, and stays open', () => {
    const window = openSteady(10, 3);
    expect(window.from).toBe(13);
    expect(window.until).toBe(Infinity);
  });

  it('refuses a window that starts inside the ramp', () => {
    const window = openSteady(10, 3);
    expect(isSteady(window, 12.9, 1)).toBe(false);
    expect(isSteady(window, 13, 1)).toBe(true);
  });
});

describe('a timed session', () => {
  it('ends steadiness where the fade begins, not where the session does', () => {
    // The fade lands on the planned end, so the last seconds are a deliberate
    // attenuation. Measuring them would report a fault the graph does not have.
    const window = sessionSteady(100, 3, 100 + 600 - 1.5);
    expect(window.from).toBe(103);
    expect(window.until).toBe(698.5);
  });

  it('refuses a window that would run into the fade', () => {
    const window = sessionSteady(100, 3, 700);
    expect(isSteady(window, 698, 1)).toBe(true);
    expect(isSteady(window, 699.5, 1)).toBe(false);
  });

  it('reports no steady time at all for a session shorter than its ramps', () => {
    // Better than a window that ends before it begins, which `isSteady` would
    // answer for in confusing ways.
    const window = sessionSteady(100, 5, 102);
    expect(window.until >= window.from).toBe(true);
    expect(isSteady(window, 100, 0.1)).toBe(false);
  });
});

describe('a gain ramp during playback', () => {
  it('pushes the start of steadiness past the ramp', () => {
    // A configuration change re-applies headroom, which ramps the master gain.
    // Emptying the capture ring at the same moment says nothing about that: the
    // first window recorded afterwards would contain the transition.
    const playing = openSteady(0, 1);
    const changed = deferSteady(playing, 50, 0.05);
    expect(changed.from).toBe(50.05);
    expect(isSteady(changed, 50, 1)).toBe(false);
    expect(isSteady(changed, 50.05, 1)).toBe(true);
  });

  it('only ever moves the boundary later', () => {
    // Two changes in quick succession leave the later one deciding, and a
    // change during the initial ramp-in must not shorten it.
    const playing = openSteady(0, 3);
    const during = deferSteady(playing, 1, 0.05);
    expect(during.from).toBe(3);

    const second = deferSteady(deferSteady(playing, 50, 0.05), 40, 0.05);
    expect(second.from).toBe(50.05);
  });

  it('leaves the end of a timed session alone', () => {
    const session = sessionSteady(0, 3, 600);
    expect(deferSteady(session, 100, 0.05).until).toBe(600);
  });
});

describe('stopping', () => {
  it('ends steadiness at the moment the fade starts', () => {
    const playing = openSteady(0, 1);
    expect(endSteady(playing, 42).until).toBe(42);
  });

  it('never extends a fade boundary already in the past', () => {
    // A stop after a session's own fade began cannot make the audio in between
    // steady again.
    const session = sessionSteady(0, 3, 600);
    expect(endSteady(session, 700).until).toBe(600);
  });
});

describe('the capture ring against the windows the checks ask for', () => {
  it('holds a whole window at ordinary modulation rates', () => {
    // The invariant that makes the cap work: at rates anyone actually uses, the
    // ring is long enough that the caller's request is never shortened.
    for (const rate of [44100, 48000, 96000]) {
      for (const modulationHz of [4, 10, 40, 200]) {
        const wanted = captureFramesFor({ ...DEFAULT_PARAMS, modulationHz }, rate);
        const capacity = CAPTURE_RING_SECONDS * rate;
        const label = `${rate} Hz at ${modulationHz} Hz`;
        expect(`${label}: ${wanted <= capacity}`).toBe(`${label}: true`);
      }
    }
  });

  it('is deliberately too short for the slowest the engine allows', () => {
    // Eight periods at 0.5 Hz is sixteen seconds, which rounds up to 2,097,152
    // frames — 21.8 seconds at 96 kHz, and 33.6 MB for two stereo rings. The
    // caller caps instead, and continuity reports that the window was too short
    // to judge, where refusing the request outright would report nothing.
    const wanted = captureFramesFor({ ...DEFAULT_PARAMS, modulationHz: 0.5 }, 48000);
    expect(wanted > CAPTURE_RING_SECONDS * 48000).toBe(true);
  });
});

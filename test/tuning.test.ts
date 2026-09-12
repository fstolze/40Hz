/**
 * Pitch conversion and the carrier's range policy.
 *
 * The behaviour worth pinning is not the arithmetic — it is what happens at
 * the edges of the UI range, where the two kinds of control have to behave
 * differently. A frequency control clamps; a note control refuses. Getting
 * that backwards silently changes the pitch class a user was aligning to,
 * which is the entire point of aligning by note.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  A4_HZ,
  CARRIER_TRACK_MAX,
  CARRIER_TRACK_MIN,
  CARRIER_TRACK_STEP,
  CARRIER_UI_MAX,
  CARRIER_UI_MIN,
  carrierHzFromTrack,
  carrierTrackFromHz,
  clampCarrierHz,
  frequencyToMidi,
  isOnGrid,
  midiToFrequency,
  noteAndCents,
  referenceFromCents,
  snapToNearestNote,
  stepBySemitones,
} from '../src/audio/tuning.ts';

describe('pitch conversion', () => {
  it('anchors A4 at the reference', () => {
    expect(frequencyToMidi(A4_HZ)).toBeCloseTo(69, 9);
    expect(midiToFrequency(69)).toBeCloseTo(A4_HZ, 9);
  });

  it('round-trips across the range', () => {
    for (const midi of [40, 57, 69, 83]) {
      expect(frequencyToMidi(midiToFrequency(midi))).toBeCloseTo(midi, 9);
    }
  });

  it('names notes and reports drift', () => {
    const a3 = noteAndCents(220);
    expect(a3?.name).toBe('A');
    expect(a3?.octave).toBe(3);
    expect(Math.round(a3?.cents ?? NaN)).toBe(0);
  });

  it('has no reading for anything that is not a pitch', () => {
    // A plausible-looking C-1 for zero would be worse than saying nothing.
    expect(noteAndCents(0)).toBe(null);
    expect(noteAndCents(-100)).toBe(null);
    expect(noteAndCents(Number.NaN)).toBe(null);
    expect(noteAndCents(220, 0)).toBe(null);
  });
});

describe('cents at the octave boundary', () => {
  it('stays on the nearer note rather than flipping octave', () => {
    // 261 Hz is just under C4, so it reads C4 flat — not B3 very sharp.
    const justUnderC4 = noteAndCents(261);
    expect(justUnderC4?.name).toBe('C');
    expect(justUnderC4?.octave).toBe(4);
    expect(justUnderC4?.cents).toBeLessThan(0);
  });

  it('crosses to the note below once past the midpoint', () => {
    const b3 = noteAndCents(254);
    expect(b3?.name).toBe('B');
    expect(b3?.octave).toBe(3);
    expect(b3?.cents).toBeGreaterThan(0);
  });
});

describe('a non-440 reference', () => {
  it('makes its own pitch the zero point', () => {
    const reference = 432;
    const reading = noteAndCents(432, reference);
    expect(reading?.name).toBe('A');
    expect(reading?.octave).toBe(4);
    expect(Math.round(reading?.cents ?? NaN)).toBe(0);
  });

  it('reports concert pitch as sharp against it', () => {
    // 1200 * log2(440/432) = 31.8 cents.
    expect(Math.round(noteAndCents(440, 432)?.cents ?? 0)).toBe(32);
  });

  it('is reachable from a cents offset', () => {
    expect(referenceFromCents(0)).toBeCloseTo(A4_HZ, 9);
    expect(referenceFromCents(-31.77)).toBeCloseTo(432, 1);
  });
});

describe('frequency-relative controls clamp', () => {
  it('brings anything into the UI range', () => {
    expect(clampCarrierHz(20)).toBe(CARRIER_UI_MIN);
    expect(clampCarrierHz(8000)).toBe(CARRIER_UI_MAX);
    expect(clampCarrierHz(220)).toBe(220);
  });

  it('answers a non-finite request with the floor rather than NaN', () => {
    expect(clampCarrierHz(Number.NaN)).toBe(CARRIER_UI_MIN);
  });
});

describe('note-relative controls refuse rather than clamp', () => {
  it('steps along the grid inside the range', () => {
    // A3 up an octave is A4, still a note and still in range.
    expect(stepBySemitones(220, 12)).toBeCloseTo(440, 6);
    expect(stepBySemitones(220, -12)).toBeCloseTo(110, 6);
  });

  it('returns null instead of a different pitch class at the floor', () => {
    // The whole finding. Clamping here would answer with the frequency of the
    // range floor, which is not the note the user was moving between.
    expect(stepBySemitones(CARRIER_UI_MIN, -1)).toBe(null);
    expect(stepBySemitones(110, -12)).toBe(null);
  });

  it('returns null instead of a different pitch class at the ceiling', () => {
    expect(stepBySemitones(880, 12)).toBe(null);
    expect(stepBySemitones(CARRIER_UI_MAX, 1)).toBe(null);
  });

  it('never answers with a frequency outside the range', () => {
    // Swept, because a step that lands outside is exactly the bug, and one
    // hand-picked pair would not have caught an off-by-one in the bounds.
    for (let hz = CARRIER_UI_MIN; hz <= CARRIER_UI_MAX; hz += 3) {
      for (const step of [-24, -12, -1, 1, 12, 24]) {
        const next = stepBySemitones(hz, step);
        if (next === null) continue;
        expect(next).toBeGreaterThanOrEqual(CARRIER_UI_MIN);
        expect(next).toBeLessThanOrEqual(CARRIER_UI_MAX);
      }
    }
  });

  it('returns to the grid from an off-grid carrier', () => {
    // 225 Hz is A3 +39 cents. Up one semitone is A♯3 exactly, not 225 * 2^(1/12).
    const next = stepBySemitones(225, 1);
    expect(noteAndCents(next ?? 0)?.cents).toBe(0);
    expect(noteAndCents(next ?? 0)?.name).toBe('A♯');
  });
});

describe('display rounding versus control state', () => {
  it('reports an exact deviation alongside the rounded one', () => {
    // 440.1 Hz is about 0.39 cents sharp. It displays as in tune, and a
    // control deciding from that figure would refuse to correct it.
    const reading = noteAndCents(440.1);
    // What a readout would show, versus what the reading actually holds.
    expect(Math.round(reading?.cents ?? 0)).toBe(0);
    expect(Math.abs(reading?.cents ?? 0)).toBeGreaterThan(0.3);
    expect(Math.abs(reading?.cents ?? 0)).toBeLessThan(0.5);
  });

  it('is exactly zero only when the frequency really is on the grid', () => {
    expect(noteAndCents(440)?.cents).toBeCloseTo(0, 12);
    expect(noteAndCents(midiToFrequency(57))?.cents).toBeCloseTo(0, 12);
  });
});

describe('the on-grid decision', () => {
  /**
   * The decision Snap is enabled by, tested without a renderer.
   *
   * A test that only proved `centsExact` exists would stay green against a
   * component that went on using the rounded figure — which is what disabled
   * Snap for a carrier a third of a cent sharp.
   */
  it('is false for a frequency that merely displays as in tune', () => {
    expect(Math.round(noteAndCents(440.1)?.cents ?? 0)).toBe(0);
    expect(isOnGrid(440.1)).toBe(false);
  });

  it('is true only on the grid itself', () => {
    expect(isOnGrid(440)).toBe(true);
    expect(isOnGrid(midiToFrequency(57))).toBe(true);
    expect(isOnGrid(220.5)).toBe(false);
  });

  it('follows the reference pitch', () => {
    expect(isOnGrid(432, 432)).toBe(true);
    expect(isOnGrid(440, 432)).toBe(false);
  });

  it('agrees with what snapping produces', () => {
    // The two have to be consistent, or Snap either refuses when it would
    // help or offers to move a carrier that is already exact.
    for (const hz of [80, 137.5, 220, 440.1, 999]) {
      expect(isOnGrid(snapToNearestNote(hz))).toBe(true);
    }
  });
});

describe('snapping to a note', () => {
  it('lands exactly on the grid', () => {
    expect(noteAndCents(snapToNearestNote(225))?.cents).toBe(0);
  });

  it('picks a note inside the range when the nearest one is not', () => {
    // 80 Hz sits below the lowest whole note the range contains, so the
    // mathematically nearest note is unreachable. Snapping must still answer
    // with a note, and it must be in range.
    const snapped = snapToNearestNote(CARRIER_UI_MIN);
    expect(snapped).toBeGreaterThanOrEqual(CARRIER_UI_MIN);
    expect(noteAndCents(snapped)?.cents).toBe(0);
  });

  it('stays in range at the ceiling too', () => {
    const snapped = snapToNearestNote(CARRIER_UI_MAX);
    expect(snapped).toBeLessThanOrEqual(CARRIER_UI_MAX);
    expect(noteAndCents(snapped)?.cents).toBe(0);
  });
});

describe("the Carrier slider's track", () => {
  it('is worth the same pitch everywhere along its length', () => {
    /*
     * The whole point of the coordinate. In Hz the slider gave 20.7 cents a
     * pixel at 220 and about 3 at the top, because 3.6 octaves were mapped
     * linearly; in cents every pixel is worth the same interval.
     *
     * Measured as the pitch change across one track step at points spread over
     * the range, in cents — which is what "same sensitivity" has to mean for a
     * control that sets a frequency.
     */
    // Walked along the track itself. Going through `carrierTrackFromHz` to pick
    // the positions would have made this pass while that function was linear,
    // since the interval measured depends only on where the track lands — the
    // pair being inverses is the next test's job, not this one's.
    // Strictly inside the ends: the bounds are rounded outward and clamped, so
    // the first and last positions are pinned to 80 and 1000 rather than to the
    // cent the grid would put them on. That clamp is the previous test's subject.
    const ends = CARRIER_TRACK_MAX - CARRIER_TRACK_STEP - 1;
    for (let at = CARRIER_TRACK_MIN + 1; at <= ends; at += 331) {
      const here = carrierHzFromTrack(at);
      const next = carrierHzFromTrack(at + CARRIER_TRACK_STEP);
      const cents = 1200 * Math.log2(next / here);
      expect(Math.abs(cents - CARRIER_TRACK_STEP)).toBeLessThan(1e-9);
    }
  });

  it('reaches both ends of the range exactly', () => {
    /*
     * A range input can only land on `min + n * step`, so a max off that grid is
     * unreachable and the top of the slider stops short. The bounds are whole
     * cents rounded outward for that reason, and the clamp brings the overshoot
     * back — so these are exact, not close.
     */
    expect(carrierHzFromTrack(CARRIER_TRACK_MIN)).toBe(CARRIER_UI_MIN);
    expect(carrierHzFromTrack(CARRIER_TRACK_MAX)).toBe(CARRIER_UI_MAX);
    expect(Number.isInteger(CARRIER_TRACK_MIN)).toBe(true);
    expect(Number.isInteger(CARRIER_TRACK_MAX)).toBe(true);
    expect((CARRIER_TRACK_MAX - CARRIER_TRACK_MIN) % CARRIER_TRACK_STEP).toBe(0);
  });

  it('covers the range and no more', () => {
    // A step beyond either end must not reach a frequency outside the policy,
    // because the input can be driven there by a keyboard as well as a pointer.
    expect(carrierHzFromTrack(CARRIER_TRACK_MIN - 50)).toBe(CARRIER_UI_MIN);
    expect(carrierHzFromTrack(CARRIER_TRACK_MAX + 50)).toBe(CARRIER_UI_MAX);
    expect(carrierHzFromTrack(Number.NaN)).toBe(CARRIER_UI_MIN);
  });

  it('round-trips a frequency the user is already on', () => {
    // Dragging away and back must not leave the carrier somewhere else, and
    // rendering the control must not move it: the position is derived from the
    // value on every render, so a lossy round trip would drift.
    for (const hz of [80, 220, 261.6255653005986, 440, 1000]) {
      expect(carrierHzFromTrack(carrierTrackFromHz(hz))).toBeCloseTo(hz, 9);
    }
  });

  it('rises with frequency, so the control is not inverted anywhere', () => {
    let previous = -Infinity;
    for (let cents = CARRIER_TRACK_MIN; cents <= CARRIER_TRACK_MAX; cents += 37) {
      const here = carrierHzFromTrack(cents);
      expect(here).toBeGreaterThanOrEqual(previous);
      previous = here;
    }
  });

  it('is anchored on A440, not on the tuner reference', () => {
    /*
     * The reference pitch is a statement about the material being played along
     * with. Letting it into this mapping would slide the whole track under the
     * user's hand the moment they changed it, so the anchor is fixed and the
     * reference is left to the readout, where a listener wants it.
     *
     * Pinned as the anchor itself rather than by recomputing the formula with a
     * different reference: in `100 * (toMidi(f, ref) - toMidi(440, ref))` the
     * reference cancels algebraically, so a version that threaded one through
     * would return the same numbers and 'proof' by that route asserts nothing.
     * The first version of this test did exactly that, and its mutation only
     * failed on 7e-13 of floating-point noise.
     *
     * A real leak re-anchors — cents from the reference rather than from A440 —
     * and that moves 440 Hz off zero, which is what these pin.
     */
    expect(carrierTrackFromHz(A4_HZ)).toBe(0);
    expect(carrierTrackFromHz(A4_HZ / 2)).toBeCloseTo(-1200, 9);
    expect(carrierTrackFromHz(A4_HZ * 2)).toBeCloseTo(1200, 9);

    // The control: a reference-anchored coordinate really would differ, so
    // these assertions are capable of failing.
    const ifAnchoredOn432 = 1200 * Math.log2(A4_HZ / 432);
    expect(Math.abs(ifAnchoredOn432)).toBeGreaterThan(30);
  });
});

/**
 * Equal-tempered pitch, and the carrier's UI range policy.
 *
 * Deliberately free of Web Audio and of the renderer. Three callers need the
 * same conversions and must not disagree about them: the Studio tuner, the
 * carrier readout, and — once it exists — the key detector's carrier
 * suggestion. A second implementation of "which note is this" is a second
 * answer to it.
 *
 * The reference pitch is a parameter rather than a constant. A recording can
 * be at 432 Hz or at a historical pitch, and a tuner that cannot be told so is
 * a tuner that is wrong about that recording. It is always supplied by the
 * user; nothing here infers it.
 */

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** Concert pitch, and the default reference. */
export const A4_HZ = 440;

/** MIDI note number of A4, the anchor for every conversion here. */
const A4_MIDI = 69;

/**
 * The carrier range the UI offers, which is narrower than the engine's.
 *
 * `sanitizeParams` admits 20 Hz to 8 kHz because the engine is correct there.
 * These are a product decision about what is useful as a carrier for a bed:
 * low enough to sit under an ambience, high enough to stay clear of it. This
 * is not a replacement for `sanitizeParams` — that clamp still guards the
 * audio thread against everything that does not come from this UI.
 */
export const CARRIER_UI_MIN = 80;
export const CARRIER_UI_MAX = 1000;

/** A reference pitch expressed as cents of detune from A440. */
export function referenceFromCents(cents: number): number {
  if (!Number.isFinite(cents)) return A4_HZ;
  return A4_HZ * Math.pow(2, cents / 1200);
}

/** Fractional MIDI note number. Not rounded — the fraction is the tuning. */
export function frequencyToMidi(freq: number, referenceHz: number = A4_HZ): number {
  return A4_MIDI + 12 * Math.log2(freq / referenceHz);
}

export function midiToFrequency(midi: number, referenceHz: number = A4_HZ): number {
  return referenceHz * Math.pow(2, (midi - A4_MIDI) / 12);
}

export interface NoteReading {
  /** Fractional MIDI number, carrying the deviation. */
  midi: number;
  /** Nearest whole MIDI number. */
  nearestMidi: number;
  /** Note name without the octave, e.g. `A♯`. */
  name: string;
  /** Scientific pitch notation octave, so A4 is 440 Hz at the default reference. */
  octave: number;
  /**
   * Deviation from the nearest note, in cents. Negative is flat.
   *
   * Unrounded, and deliberately the only figure offered. Rounding belongs to
   * whatever is drawing it: 440.1 Hz is a third of a cent sharp and displays
   * as "in tune", and a control that decided from that rounded value refused
   * to correct a carrier that was not on the grid. Leaving no rounded field
   * here means a caller has to round explicitly to make that mistake.
   */
  cents: number;
}

/**
 * Which note a frequency is, and how far off it sits.
 *
 * Null rather than a fallback reading for anything that is not a pitch: zero
 * and negative frequencies have no note, and returning a plausible-looking
 * `C-1` for them would be worse than saying so.
 */
export function noteAndCents(freq: number, referenceHz: number = A4_HZ): NoteReading | null {
  if (!Number.isFinite(freq) || freq <= 0) return null;
  if (!Number.isFinite(referenceHz) || referenceHz <= 0) return null;

  const midi = frequencyToMidi(freq, referenceHz);
  const nearestMidi = Math.round(midi);
  return {
    midi,
    nearestMidi,
    name: NOTE_NAMES[((nearestMidi % 12) + 12) % 12],
    octave: Math.floor(nearestMidi / 12) - 1,
    cents: (midi - nearestMidi) * 100,
  };
}

/**
 * Whether a frequency sits exactly on the note grid.
 *
 * Here rather than in the component because it is a decision, not a rendering:
 * the displayed deviation is rounded to whole cents, so a carrier a third of a
 * cent sharp reads "in tune", and a control deciding from that figure would
 * refuse to correct it. Extracting it also makes it testable without a
 * renderer, which the component's `disabled` attribute is not.
 */
export function isOnGrid(freq: number, referenceHz: number = A4_HZ): boolean {
  const reading = noteAndCents(freq, referenceHz);
  return reading !== null && Math.abs(reading.cents) < 1e-6;
}

/**
 * Bring a frequency into the UI range.
 *
 * For frequency-relative controls only — the slider and direct entry, where
 * the user asked for a frequency and the nearest available one answers them.
 * Never use it on a note-relative control: clamping the *frequency* of a note
 * lands on a different pitch class, which is the one thing a note control
 * exists to prevent.
 */
export function clampCarrierHz(freq: number): number {
  if (!Number.isFinite(freq)) return CARRIER_UI_MIN;
  return Math.min(CARRIER_UI_MAX, Math.max(CARRIER_UI_MIN, freq));
}

/**
 * The Carrier slider's own coordinate: cents from A440.
 *
 * The range is 80–1000 Hz, which is 3.6 octaves. Mapped linearly onto a track
 * of a few hundred pixels, the *bottom* of it — where a carrier usually sits —
 * gets the coarsest resolution in pitch: measured in the running app at
 * 1440x1024, one pixel was 2.644 Hz, which at 220 Hz is **20.7 cents**, a fifth
 * of a semitone, against 3 cents at the top of the range. Every other control
 * in the product is under one step per pixel, and an arrow key here was 0.1 Hz
 * — 2.16 cents at 80 Hz, 0.8 at 220, 0.17 at 1000.
 *
 * So the control's precision varied by a factor of seven across its own travel,
 * and its pointer and keyboard resolutions differed by a factor of twenty-six.
 * In cents both are uniform: about 12.4 a pixel at that width, one cent an
 * arrow key, everywhere.
 *
 * **This is a consistency argument and not an audibility one.** A coarse
 * resolution here was once proposed as the explanation for a roughness reported
 * on this control, and the carrier glide was built on that reading. The glide
 * did not fix the report: three separately measured improvements to the
 * carrier's trajectory produced no audible change at all. The cause was repeated
 * rescheduling of the master ramp. Nothing here should be read as claiming that
 * this mapping makes the app sound different.
 *
 * **Fixed at A440, deliberately, and not the user's reference pitch.** The
 * tuner's reference is a statement about the material being played along with;
 * letting it into this mapping would slide the whole track under the user's
 * hand when they changed it. What the reference does affect is the *readout*,
 * which is where a listener actually wants it.
 */
export function carrierTrackFromHz(freq: number): number {
  return 100 * (frequencyToMidi(freq) - frequencyToMidi(A4_HZ));
}

/** The frequency a track position means, brought into the UI range. */
export function carrierHzFromTrack(cents: number): number {
  if (!Number.isFinite(cents)) return CARRIER_UI_MIN;
  return clampCarrierHz(midiToFrequency(frequencyToMidi(A4_HZ) + cents / 100));
}

/**
 * One cent per arrow key, uniformly.
 *
 * Coarser than the 0.1 Hz it replaces at the top of the range and finer at the
 * bottom — 0.17, 0.8 and 2.16 cents at 1000, 220 and 80 Hz became 1 everywhere
 * — and a cent is inaudible at any of them. Exact 0.1 Hz entry has not gone: it
 * is the tuner's number field, which is where someone asking for a specific
 * frequency is already working.
 */
export const CARRIER_TRACK_STEP = 1;

/*
 * Whole cents, and outward.
 *
 * A range input can only land on `min + n * step`, so a max that is not on that
 * grid is unreachable — the top of the slider would stop short of 1000 Hz by a
 * fraction. Rounding the ends outward keeps both endpoints on the grid, and
 * `carrierHzFromTrack` clamps the overshoot back to exactly 80 and 1000.
 */
export const CARRIER_TRACK_MIN = Math.floor(carrierTrackFromHz(CARRIER_UI_MIN));
export const CARRIER_TRACK_MAX = Math.ceil(carrierTrackFromHz(CARRIER_UI_MAX));

/** Whole MIDI numbers whose frequency falls inside the UI range. */
function midiRange(referenceHz: number): { lo: number; hi: number } {
  return {
    lo: Math.ceil(frequencyToMidi(CARRIER_UI_MIN, referenceHz)),
    hi: Math.floor(frequencyToMidi(CARRIER_UI_MAX, referenceHz)),
  };
}

/**
 * The nearest note that is actually reachable.
 *
 * At the bottom of the range the mathematically nearest note can sit below it
 * — 80 Hz is between D♯2 and E2, and at some references the nearer of the two
 * is out of range. Clamping the MIDI number keeps the result on the note grid;
 * clamping the frequency afterwards would not.
 */
export function snapToNearestNote(freq: number, referenceHz: number = A4_HZ): number {
  const reading = noteAndCents(freq, referenceHz);
  if (reading === null) return CARRIER_UI_MIN;
  const { lo, hi } = midiRange(referenceHz);
  const midi = Math.min(hi, Math.max(lo, reading.nearestMidi));
  return midiToFrequency(midi, referenceHz);
}

/**
 * Move by whole semitones along the note grid, or null if that leaves the range.
 *
 * Null is the whole point: a note-relative control that cannot take its step
 * must be *disabled*, not clamped. Clamping an octave-down at the bottom of
 * the range produces a different pitch class, which is precisely the alignment
 * the control was being used to preserve.
 *
 * The step is taken from the nearest note rather than from the exact current
 * frequency, so a carrier tuned a few cents off returns to the grid on the
 * first press rather than carrying its offset forever.
 */
export function stepBySemitones(
  freq: number,
  semitones: number,
  referenceHz: number = A4_HZ,
): number | null {
  const reading = noteAndCents(freq, referenceHz);
  if (reading === null) return null;
  const target = reading.nearestMidi + semitones;
  const { lo, hi } = midiRange(referenceHz);
  if (target < lo || target > hi) return null;
  return midiToFrequency(target, referenceHz);
}

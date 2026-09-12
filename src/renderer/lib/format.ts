/** Display helpers for the Studio readouts. */

import { A4_HZ, noteAndCents } from '../../audio/tuning.ts';

/**
 * Nearest equal-tempered note name for a frequency, with cents deviation.
 *
 * The source specification recommends aligning the carrier to the musical key
 * of the underlying soundscape; showing the note is what makes that alignment
 * possible by hand.
 *
 * The pitch maths lives in `audio/tuning.ts` because the tuner and the key
 * detector's carrier suggestion need the same answers. This is only the
 * string.
 */
export function noteName(freq: number, referenceHz: number = A4_HZ): string {
  const reading = noteAndCents(freq, referenceHz);
  if (reading === null) return '—';
  const { name, octave } = reading;
  // Rounded here, where it is being drawn. `noteAndCents` deliberately hands
  // back the exact figure so no control can decide from a rounded one.
  const cents = Math.round(reading.cents);
  const drift = cents === 0 ? '' : ` ${cents > 0 ? '+' : ''}${cents}¢`;
  return `${name}${octave}${drift}`;
}

export function hz(value: number, digits = 0): string {
  return `${value.toFixed(digits)} Hz`;
}

/** Linear gain as dBFS, floored for display. */
export function gainToDb(gain: number): string {
  if (gain <= 0.0001) return '−∞ dB';
  return `${(20 * Math.log10(gain)).toFixed(1)} dB`;
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

/** `mm:ss`, or `h:mm:ss` past an hour. Rounded up, so a countdown never shows 0:00 early. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`;
}

/** A day's listening time, in the plainest terms that fit. */
export function listeningTime(seconds: number): string {
  // Nothing is not a small amount of something. On a day with no sessions
  // "under a minute" reads as a claim about listening that did not happen.
  if (seconds <= 0) return 'none';
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

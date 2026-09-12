/**
 * Display helpers.
 *
 * Small, but the countdown is the thing a listener watches for an hour, so its
 * rounding is worth pinning: floor would show 0:00 for a whole second while
 * sound was still playing.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { clock, listeningTime } from '../src/renderer/lib/format.ts';

describe('countdown', () => {
  it('formats minutes and seconds', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(9)).toBe('0:09');
    expect(clock(60)).toBe('1:00');
    expect(clock(599)).toBe('9:59');
  });

  it('grows an hours field only when needed', () => {
    expect(clock(3600)).toBe('1:00:00');
    expect(clock(3661)).toBe('1:01:01');
  });

  it('rounds up, so it never reads zero while sound remains', () => {
    expect(clock(0.1)).toBe('0:01');
    expect(clock(59.4)).toBe('1:00');
  });

  it('never goes negative', () => {
    expect(clock(-5)).toBe('0:00');
  });
});

describe('listening time', () => {
  it('says something honest about a very short session', () => {
    // A day with no sessions says so, rather than claiming a small amount.
    expect(listeningTime(0)).toBe('none');
    expect(listeningTime(45)).toBe('under a minute');
  });

  it('rounds to minutes', () => {
    expect(listeningTime(90)).toBe('2 min');
    expect(listeningTime(1800)).toBe('30 min');
  });

  it('breaks into hours past the hour', () => {
    expect(listeningTime(3600)).toBe('1 h');
    expect(listeningTime(5400)).toBe('1 h 30 min');
    expect(listeningTime(9000)).toBe('2 h 30 min');
  });
});

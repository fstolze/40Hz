/**
 * Stored session record validation.
 *
 * The cases that matter are the ones that would otherwise reach the day's
 * listening total or the advisory as nonsense — a NaN duration, an absurd
 * one, or a record with no start instant to place it on any day.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { normalizeSessionRecord } from '../src/session/normalize.ts';
import { DEFAULT_MASTER_LEVEL, defaultConfiguration } from '../src/audio/configuration.ts';
import { DEFAULT_PARAMS } from '../src/audio/dsp/entrainment-core.ts';

const VALID = {
  id: 'r1',
  presetId: 'focus',
  startedAt: 1_700_000_000_000,
  plannedSeconds: 1800,
  actualSeconds: 1200,
  completionReason: 'stopped',
  integrityStatus: 'ok',
  initialConfiguration: defaultConfiguration(),
  finalConfiguration: defaultConfiguration(),
  edited: false,
};

describe('accepting a record', () => {
  it('keeps a well-formed one intact', () => {
    const r = normalizeSessionRecord(VALID);
    expect(r?.id).toBe('r1');
    expect(r?.presetId).toBe('focus');
    expect(r?.actualSeconds).toBe(1200);
    expect(r?.completionReason).toBe('stopped');
    expect(r?.integrityStatus).toBe('ok');
  });

  it('carries scheduledFor when present and omits it otherwise', () => {
    expect(normalizeSessionRecord({ ...VALID, scheduledFor: 123 })?.scheduledFor).toBe(123);
    expect('scheduledFor' in normalizeSessionRecord(VALID)!).toBe(false);
  });
});

describe('rejecting a non-record', () => {
  it('needs an identity', () => {
    expect(normalizeSessionRecord({ ...VALID, id: undefined })).toBe(null);
    expect(normalizeSessionRecord({ ...VALID, id: '' })).toBe(null);
  });

  it('needs a start instant, since history is grouped by day', () => {
    expect(normalizeSessionRecord({ ...VALID, startedAt: undefined })).toBe(null);
    expect(normalizeSessionRecord({ ...VALID, startedAt: Number.NaN })).toBe(null);
    expect(normalizeSessionRecord({ ...VALID, startedAt: 'yesterday' })).toBe(null);
  });

  it('rejects anything that is not an object', () => {
    expect(normalizeSessionRecord(null)).toBe(null);
    expect(normalizeSessionRecord('r1')).toBe(null);
    expect(normalizeSessionRecord(42)).toBe(null);
  });
});

describe('coercing fields', () => {
  it('replaces non-finite durations rather than passing NaN to the day total', () => {
    const r = normalizeSessionRecord({
      ...VALID,
      plannedSeconds: Number.NaN,
      actualSeconds: Number.POSITIVE_INFINITY,
    });
    expect(r?.plannedSeconds).toBe(0);
    expect(r?.actualSeconds).toBe(0);
  });

  it('bounds an absurd duration so one record cannot dominate the advisory', () => {
    const r = normalizeSessionRecord({ ...VALID, actualSeconds: 9_999_999 });
    expect(r?.actualSeconds).toBe(24 * 60 * 60);
  });

  it('floors a negative duration at zero', () => {
    expect(normalizeSessionRecord({ ...VALID, actualSeconds: -600 })?.actualSeconds).toBe(0);
  });

  it('treats an unrecognised ending as an interruption, not a completion', () => {
    // Claiming a session finished when the file cannot say so would overstate
    // what happened.
    expect(
      normalizeSessionRecord({ ...VALID, completionReason: 'vanished' })?.completionReason,
    ).toBe('interrupted');
    expect(
      normalizeSessionRecord({ ...VALID, completionReason: undefined })?.completionReason,
    ).toBe('interrupted');
  });

  it('keeps only coverage this build could have checked, canonically ordered', () => {
    // The file survives across versions and can be hand-edited. A record
    // claiming `delivery` was covered is the overclaim this whole subsystem
    // exists to refuse, arriving by the one route the type system cannot see.
    const r = normalizeSessionRecord({
      ...VALID,
      integrityCoverage: ['graph', 'delivery', 'engine', 'graph', 'bluetooth'],
    });
    expect(r?.integrityCoverage.join(',')).toBe('engine,graph');
  });

  it('reads a record written before coverage existed as nothing checked', () => {
    // Which is what a v1 record means: no producer existed, so no scope was
    // examined — never that they all passed.
    expect(normalizeSessionRecord(VALID)?.integrityCoverage.length).toBe(0);
    expect(
      normalizeSessionRecord({ ...VALID, integrityCoverage: 'engine' })?.integrityCoverage.length,
    ).toBe(0);
  });

  it('falls back to unknown integrity', () => {
    expect(normalizeSessionRecord({ ...VALID, integrityStatus: 'great' })?.integrityStatus).toBe(
      'unknown',
    );
  });

  it('defaults a missing preset id to empty rather than dropping the record', () => {
    expect(normalizeSessionRecord({ ...VALID, presetId: 42 })?.presetId).toBe('');
  });

  it('treats a non-boolean edited flag as false', () => {
    expect(normalizeSessionRecord({ ...VALID, edited: 'yes' })?.edited).toBe(false);
    expect(normalizeSessionRecord({ ...VALID, edited: true })?.edited).toBe(true);
  });
});

describe('configurations', () => {
  it('rebuilds a corrupt configuration from defaults', () => {
    const r = normalizeSessionRecord({
      ...VALID,
      initialConfiguration: { params: { carrierHz: Number.NaN }, soundscape: { color: 'puce' } },
    });
    expect(r?.initialConfiguration.params.carrierHz).toBe(DEFAULT_PARAMS.carrierHz);
    expect(r?.initialConfiguration.soundscape.color).toBe('pink');
    expect(r?.initialConfiguration.masterLevel).toBe(DEFAULT_MASTER_LEVEL);
  });

  it('falls back to the initial configuration when the final one is missing', () => {
    const r = normalizeSessionRecord({
      ...VALID,
      initialConfiguration: { ...defaultConfiguration(), masterLevel: 0.42 },
      finalConfiguration: undefined,
    });
    expect(r?.finalConfiguration.masterLevel).toBe(0.42);
  });

  it('does not alias the two configurations when it falls back', () => {
    const r = normalizeSessionRecord({ ...VALID, finalConfiguration: undefined })!;
    r.finalConfiguration.masterLevel = 0.1;
    expect(r.initialConfiguration.masterLevel).toBe(DEFAULT_MASTER_LEVEL);
  });
});

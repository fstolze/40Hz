/**
 * Runtime validation for stored session records.
 *
 * Disk and IPC are untrusted input for the same reasons localStorage was: a
 * file survives across versions, can be hand-edited, and can be left half
 * written by a crash. A record that reaches the day's listening total or the
 * advisory has to be a record, not whatever JSON happened to parse.
 *
 * Identity and a start instant are the only hard requirements. Everything else
 * falls back, because a partially readable record is still better history than
 * no history.
 */

import {
  asNumber,
  asMember,
  asRecord,
  clampOr,
  normalizeConfiguration,
  snapshotConfiguration,
  type SessionConfiguration,
} from '../audio/configuration.ts';
import { COMPLETION_REASONS, INTEGRITY_STATUSES, type SessionRecord } from './session.ts';
import { normalizeCoverage } from '../integrity/normalize.ts';
import type { Checkpoint } from './coordinator.ts';

/**
 * Longest a single record may claim, in seconds.
 *
 * A corrupt duration would otherwise dominate the day's listening total and,
 * through it, the advisory. 24 hours is well past any real session and still
 * bounds the damage.
 */
const MAX_RECORD_SECONDS = 24 * 60 * 60;

/** Longest session a request may ask for. */
const MAX_PLANNED_SECONDS = 8 * 60 * 60;

/**
 * Rebuild a start request arriving over IPC.
 *
 * The renderer is not trusted with these: a nonsensical duration would reach
 * the audio executor and the history record, and an absent preset id would
 * leave a record pointing at nothing.
 */
export function normalizeStartRequest(value: unknown): {
  presetId: string;
  configuration: SessionConfiguration;
  plannedSeconds: number;
  scheduledFor?: number;
} | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  const plannedSeconds = asNumber(r.plannedSeconds);
  // A session with no duration is not a session.
  if (plannedSeconds === undefined || plannedSeconds <= 0) return null;
  // Nor is one that cannot say what it played: a record with no preset id
  // could never be traced back to its source.
  if (typeof r.presetId !== 'string' || r.presetId === '') return null;

  const out: {
    presetId: string;
    configuration: SessionConfiguration;
    plannedSeconds: number;
    scheduledFor?: number;
  } = {
    presetId: r.presetId,
    configuration: normalizeConfiguration(asRecord(r.configuration)),
    plannedSeconds: Math.min(plannedSeconds, MAX_PLANNED_SECONDS),
  };
  const scheduledFor = asNumber(r.scheduledFor);
  if (scheduledFor !== undefined) out.scheduledFor = scheduledFor;
  return out;
}

export function normalizeSessionRecord(value: unknown): SessionRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;

  if (typeof r.id !== 'string' || r.id === '') return null;
  const startedAt = asNumber(r.startedAt);
  // Without a start instant the record cannot be placed on any day, which is
  // most of what history is for.
  if (startedAt === undefined) return null;

  const initial = normalizeConfiguration(asRecord(r.initialConfiguration));

  const record: SessionRecord = {
    id: r.id,
    presetId: typeof r.presetId === 'string' ? r.presetId : '',
    startedAt,
    plannedSeconds: clampOr(asNumber(r.plannedSeconds), 0, MAX_RECORD_SECONDS, 0),
    actualSeconds: clampOr(asNumber(r.actualSeconds), 0, MAX_RECORD_SECONDS, 0),
    // An unrecognised ending is treated as an interruption rather than a
    // completion: claiming a session finished when the file cannot say so
    // would overstate what actually happened.
    completionReason: asMember(r.completionReason, COMPLETION_REASONS) ?? 'interrupted',
    integrityStatus: asMember(r.integrityStatus, INTEGRITY_STATUSES) ?? 'unknown',
    // Allowlisted, deduplicated, canonically ordered and detached. Absent is
    // a v1 record, which means nothing was checked — never that everything
    // was, and never a scope this build has no checker for.
    integrityCoverage: normalizeCoverage(r.integrityCoverage),
    initialConfiguration: initial,
    // Copied, never the same object as the initial one: sharing it would make
    // an edit to either endpoint appear on both.
    finalConfiguration:
      r.finalConfiguration === undefined
        ? snapshotConfiguration(initial)
        : normalizeConfiguration(asRecord(r.finalConfiguration)),
    edited: r.edited === true,
  };

  const scheduledFor = asNumber(r.scheduledFor);
  if (scheduledFor !== undefined) record.scheduledFor = scheduledFor;

  return record;
}

/**
 * Drop `graph` coverage from a record written before it meant a measurement.
 *
 * That scope was once recorded on the strength of `maxChannelCount`, which
 * turned out to describe the app's own graph rather than the output device and
 * was withdrawn as a check. Such a record claims our output was verified when
 * nothing measured it — and left alone it would be indistinguishable from the
 * records real capture measurements will produce, which is the worse half.
 *
 * The status is deliberately untouched: it was the worst verdict among checks
 * that ran, and those checks did run. Only the coverage claim was wrong.
 *
 * Lives here rather than beside either store because both of them need it —
 * the disk store applies it to files below the current version, and the
 * browser store to anything under its pre-boundary key.
 */
export function withoutWithdrawnCoverage(record: SessionRecord): SessionRecord {
  return {
    ...record,
    integrityCoverage: record.integrityCoverage.filter((scope) => scope !== 'graph'),
  };
}

/**
 * Rebuild a checkpoint, or discard it.
 *
 * A checkpoint drives what gets written to history on recovery, so a
 * half-understood one is worse than none: anything that does not add up is
 * dropped rather than guessed at. Shared by the disk store and the browser
 * one, because both read a file a previous version wrote.
 */
export function normalizeCheckpoint(value: unknown): Checkpoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Record<string, unknown>;

  if (c.phase === 'starting') {
    if (typeof c.id !== 'string' || c.id === '') return null;
    return {
      phase: 'starting',
      id: c.id,
      presetId: typeof c.presetId === 'string' ? c.presetId : '',
      reservedAtWall: typeof c.reservedAtWall === 'number' ? c.reservedAtWall : 0,
    };
  }

  if (c.phase !== 'active') return null;
  const session = c.session as Record<string, unknown> | undefined;
  if (session === undefined || typeof session.id !== 'string' || session.id === '') return null;
  if (typeof session.startedAt !== 'number' || !Number.isFinite(session.startedAt)) return null;

  const elapsed = typeof c.elapsedSecondsAtHeartbeat === 'number' ? c.elapsedSecondsAtHeartbeat : 0;
  return {
    phase: 'active',
    session: {
      id: session.id,
      presetId: typeof session.presetId === 'string' ? session.presetId : '',
      startedAt: session.startedAt,
      plannedSeconds: typeof session.plannedSeconds === 'number' ? session.plannedSeconds : 0,
      rampInSeconds: typeof session.rampInSeconds === 'number' ? session.rampInSeconds : 0,
      rampOutSeconds: typeof session.rampOutSeconds === 'number' ? session.rampOutSeconds : 0,
      initialConfiguration: normalizeConfiguration(session.initialConfiguration),
      ...(typeof session.scheduledFor === 'number' ? { scheduledFor: session.scheduledFor } : {}),
    },
    elapsedSecondsAtHeartbeat: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
    configuration: normalizeConfiguration(c.configuration),
    edited: c.edited === true,
  };
}

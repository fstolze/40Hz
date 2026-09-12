/**
 * Session model and timing.
 *
 * Clock-injected throughout: every function takes the current time rather than
 * reading it, so the phase machine is tested exactly rather than by waiting.
 * Same reasoning as the DSP core taking a sample rate instead of an
 * AudioContext — correctness is established offline, and a fault at runtime is
 * never ambiguous between "the logic is wrong" and "the timer drifted".
 *
 * The caller decides what "now" means. The coordinator feeds these functions a
 * monotonic-derived instant rather than wall-clock time, so a system clock
 * correction cannot change how long a session appears to have run.
 *
 * No Electron and no Web Audio imports. The main process, Studio, and the
 * Session popover all need this, so it belongs to none of them.
 */

import { snapshotConfiguration } from '../audio/configuration.ts';
import type { SessionConfiguration } from '../audio/configuration.ts';
// Type-only, so the pair does not become a runtime cycle: `findings.ts` reads
// the status enum from here, and only the type of a coverage list goes back.
import type { CheckableScope } from '../integrity/findings.ts';

/** Durations Session offers, in minutes. */
export const DURATION_CHOICES = [10, 20, 30, 45, 60] as const;

/**
 * When the stabilization indicator flips.
 *
 * The source specification puts cortical alignment at 5–6 minutes of
 * uninterrupted exposure. This marks the lower bound of that window — the
 * point from which the stimulus can be assumed to be doing its work, not a
 * measurement that it is.
 */
export const STABILIZATION_SECONDS = 5 * 60;

export const SESSION_PHASES = [
  'idle',
  'ramping-in',
  'stabilizing',
  'stabilized',
  'ending',
  'complete',
] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];

export const COMPLETION_REASONS = ['completed', 'stopped', 'interrupted'] as const;

/**
 * Why a session ended.
 *
 * `completed` ran its planned duration, `stopped` was ended by the user, and
 * `interrupted` covers everything outside their control — a crash, a sleep, a
 * renderer lost mid-session.
 */
export type CompletionReason = (typeof COMPLETION_REASONS)[number];

export const INTEGRITY_STATUSES = ['unknown', 'ok', 'warning', 'failed'] as const;

/** Populated by the step 4 subsystem; `unknown` until it exists. */
export type IntegrityStatus = (typeof INTEGRITY_STATUSES)[number];

/** A session in progress. */
export interface ActiveSession {
  id: string;
  presetId: string;
  /** Epoch milliseconds. */
  startedAt: number;
  plannedSeconds: number;
  rampInSeconds: number;
  rampOutSeconds: number;
  /** Configuration applied when the session started. */
  initialConfiguration: SessionConfiguration;
  /**
   * Epoch milliseconds, when the session began from a reminder.
   *
   * Carried so scheduled notifications can be added later without reshaping
   * the record. A reminder still only ever prompts — reaching this point at
   * all means the user pressed start.
   */
  scheduledFor?: number;
}

/** A finished session, as stored in history. */
export interface SessionRecord {
  id: string;
  presetId: string;
  startedAt: number;
  plannedSeconds: number;
  actualSeconds: number;
  completionReason: CompletionReason;
  /**
   * The worst verdict among the checks that actually ran.
   *
   * Scopes nothing looked at do not drag this down — on macOS and Linux the
   * downstream ones can never be checked, so folding them in would record
   * `unknown` for every healthy session ever run there. What was looked at is
   * the separate question below.
   */
  integrityStatus: IntegrityStatus;
  /**
   * Which scopes held at least one check that ran, in signal-path order.
   *
   * Stored beside the status so "the app was fine and nothing downstream was
   * ever examined" is something the record states rather than something a
   * reader has to infer from a status that looks clean. Empty is the honest
   * value for a session nothing reported on, and for every record written
   * before this field existed.
   */
  integrityCoverage: CheckableScope[];
  /** Configuration the session started from. */
  initialConfiguration: SessionConfiguration;
  /**
   * Configuration the session ended on.
   *
   * These two are endpoints, not a timeline. Studio stays editable during a
   * session, so this says where the session finished — not every state it
   * passed through. Do not read the pair as a full account of what was heard.
   */
  finalConfiguration: SessionConfiguration;
  /** True when the configuration changed at any point during the session. */
  edited: boolean;
  scheduledFor?: number;
}

export interface BeginSessionInput {
  id: string;
  presetId: string;
  /** Epoch milliseconds, stamped once audio has actually started. */
  startedAt: number;
  plannedSeconds: number;
  rampInSeconds: number;
  rampOutSeconds: number;
  configuration: SessionConfiguration;
  scheduledFor?: number;
}

/**
 * Open a session, taking its own copy of the configuration.
 *
 * Constructing an `ActiveSession` by hand would keep a live reference to the
 * caller's configuration, and Studio stays editable during a session — so the
 * "initial" configuration would quietly track the edits instead of recording
 * where the session began.
 */
export function beginSession(input: BeginSessionInput): ActiveSession {
  const session: ActiveSession = {
    id: input.id,
    presetId: input.presetId,
    startedAt: input.startedAt,
    plannedSeconds: input.plannedSeconds,
    rampInSeconds: input.rampInSeconds,
    rampOutSeconds: input.rampOutSeconds,
    initialConfiguration: snapshotConfiguration(input.configuration),
  };
  if (input.scheduledFor !== undefined) session.scheduledFor = input.scheduledFor;
  return session;
}

/**
 * A detached copy of a running session, safe to publish.
 *
 * Published snapshots cross a process boundary under Electron, which clones
 * them — but the browser coordinator is in-process, where a subscriber holding
 * a reference could rewrite the canonical timing or initial configuration.
 */
export function snapshotActiveSession(session: ActiveSession): ActiveSession {
  return {
    ...session,
    initialConfiguration: snapshotConfiguration(session.initialConfiguration),
  };
}

/**
 * A detached copy of a finished record, safe to hand out.
 *
 * A spread alone is not one: both configurations and the coverage array would
 * stay shared, so a caller could reach through a returned record and rewrite
 * stored history.
 */
export function snapshotRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    initialConfiguration: snapshotConfiguration(record.initialConfiguration),
    finalConfiguration: snapshotConfiguration(record.finalConfiguration),
    // An array is as shared as an object under a spread, and this one crosses
    // the same boundaries the configurations do.
    integrityCoverage: [...record.integrityCoverage],
  };
}

export function elapsedSeconds(session: ActiveSession, nowMs: number): number {
  return Math.max(0, (nowMs - session.startedAt) / 1000);
}

export function remainingSeconds(session: ActiveSession, nowMs: number): number {
  return Math.max(0, session.plannedSeconds - elapsedSeconds(session, nowMs));
}

/** 0 at the start, 1 once the planned duration is reached. */
export function progress(session: ActiveSession, nowMs: number): number {
  if (session.plannedSeconds <= 0) return 1;
  return Math.min(1, elapsedSeconds(session, nowMs) / session.plannedSeconds);
}

/**
 * When the fade should begin, so silence *lands* at the planned endpoint.
 *
 * Starting the fade at the planned end instead would leave a session audible
 * past its own duration while the record capped at it, and while `phaseAt`
 * already reported `ending` — the UI, the audio, and the stored record all
 * disagreeing. Clamped at the start instant so a session shorter than its own
 * ramp-out still fades from the beginning rather than before it.
 */
export function fadeStartMs(session: ActiveSession): number {
  const offset = Math.max(0, session.plannedSeconds - session.rampOutSeconds);
  return session.startedAt + offset * 1000;
}

/** When the session reaches silence and is finalized. */
export function endMs(session: ActiveSession): number {
  return session.startedAt + session.plannedSeconds * 1000;
}

/**
 * Which phase the session is in.
 *
 * Ordered so the ends win. On a session short enough for the ramp-in and
 * ramp-out windows to overlap, the overlap reports `ending` rather than
 * `ramping-in` — what the listener is about to hear matters more than what
 * they just heard.
 */
export function phaseAt(session: ActiveSession, nowMs: number): SessionPhase {
  const elapsed = elapsedSeconds(session, nowMs);
  if (elapsed >= session.plannedSeconds) return 'complete';
  if (elapsed >= session.plannedSeconds - session.rampOutSeconds) return 'ending';
  if (elapsed < session.rampInSeconds) return 'ramping-in';
  if (elapsed < STABILIZATION_SECONDS) return 'stabilizing';
  return 'stabilized';
}

/** True once past the 5-minute mark, whatever phase the session is otherwise in. */
export function isStabilized(session: ActiveSession, nowMs: number): boolean {
  return elapsedSeconds(session, nowMs) >= STABILIZATION_SECONDS;
}

/** True when the planned duration has elapsed and the session should finalize. */
export function hasCompleted(session: ActiveSession, nowMs: number): boolean {
  return elapsedSeconds(session, nowMs) >= session.plannedSeconds;
}

export interface CompleteOptions {
  integrityStatus?: IntegrityStatus;
  /** Defaults to nothing checked, which is what an unreported session means. */
  integrityCoverage?: readonly CheckableScope[];
  /** Defaults to the configuration the session started from. */
  finalConfiguration?: SessionConfiguration;
  /** Defaults to false; set when Studio reported a change mid-session. */
  edited?: boolean;
}

/**
 * Close out a session into a history record.
 *
 * `actualSeconds` is capped at the planned duration: a session ends itself at
 * that point, so a longer elapsed time means the tick that stopped it was
 * late, not that the listener heard more.
 */
export function completeSession(
  session: ActiveSession,
  nowMs: number,
  completionReason: CompletionReason,
  options: CompleteOptions = {},
): SessionRecord {
  const record: SessionRecord = {
    id: session.id,
    presetId: session.presetId,
    startedAt: session.startedAt,
    plannedSeconds: session.plannedSeconds,
    actualSeconds: Math.min(elapsedSeconds(session, nowMs), session.plannedSeconds),
    completionReason,
    integrityStatus: options.integrityStatus ?? 'unknown',
    // Copied for the same reason the configurations are: the caller keeps its
    // own aggregate and goes on merging into it after this returns.
    integrityCoverage: [...(options.integrityCoverage ?? [])],
    // Copied, not referenced — and never the same object twice, or an edit to
    // one endpoint would appear to change the other.
    initialConfiguration: snapshotConfiguration(session.initialConfiguration),
    finalConfiguration: snapshotConfiguration(
      options.finalConfiguration ?? session.initialConfiguration,
    ),
    edited: options.edited ?? false,
  };
  if (session.scheduledFor !== undefined) record.scheduledFor = session.scheduledFor;
  return record;
}

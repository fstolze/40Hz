/**
 * Runtime validation for integrity data arriving from somewhere else.
 *
 * Two boundaries, one set of rules. A report crosses IPC from the renderer
 * that holds the graph, and coverage comes back off disk in a file an older
 * build wrote or a hand edited — both untrusted for the same reasons the
 * session record already is.
 *
 * What makes this more than shape-checking: the type system refuses a checked
 * finding in a scope nothing can check, and the compiler never sees a value
 * that arrived over a wire. So the claim `delivery` has no checker is only as
 * true as this module makes it.
 */

import { asMember, asRecord } from '../audio/configuration.ts';
import { INTEGRITY_STATUSES } from '../session/session.ts';
import {
  CHECKABLE_SCOPES,
  SCOPES,
  type CheckableScope,
  type Finding,
  type Scope,
} from './findings.ts';

/**
 * Most a single report may carry.
 *
 * Per message, which on its own bounds nothing: the aggregate is keyed by id
 * and lives for the length of a session, so a hundred conforming reports with
 * fresh ids accumulate a hundred times this. `MAX_SESSION_FINDINGS` is the
 * bound that matters; this one only keeps a single message from reaching it in
 * one go.
 */
export const MAX_FINDINGS = 64;

/**
 * Most distinct findings one session's aggregate may hold.
 *
 * Applied by whoever owns the aggregate, since only it knows what a session
 * has already accumulated. A real producer emits a fixed handful of ids and
 * reports them again as the session runs, so this never binds on the intended
 * use — it bounds the renderer that invents an id per report, whose aggregate
 * would otherwise grow without limit and be copied whole on every merge.
 */
export const MAX_SESSION_FINDINGS = 128;

/**
 * Longest a finding id may be.
 *
 * Refused rather than truncated: two distinct checks cut to the same prefix
 * would merge into one, and a merge keyed on a mangled id silently replaces
 * one check's answer with another's.
 */
const MAX_ID = 128;

/** Copy enough to say what happened, and not enough to be a payload. */
const MAX_TITLE = 200;
const MAX_DETAIL = 1000;

function asText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

/**
 * Rebuild one finding, or refuse it.
 *
 * Refused rather than repaired in two cases, both of which are claims rather
 * than damage:
 *
 * - **no usable id.** Merging is keyed on it, so a finding without one cannot
 *   replace its own previous answer and would accumulate beside it instead. An
 *   id longer than `MAX_ID` is refused for the same reason it is not
 *   truncated: an unbounded key is unbounded memory, and a shortened one
 *   collides.
 * - **a checked `delivery`.** Nothing on any platform observes the DAC, the
 *   transducer, or the air. Rewriting that into an unchecked finding would
 *   invent a report nobody made; dropping it leaves the scope uncovered, which
 *   is what it is.
 *
 * Everything else falls back. An unreadable status on a check that ran becomes
 * `unknown` — it ran, and what it concluded cannot be read — rather than being
 * dropped, since silence there is how a gap turns into a clean result.
 */
function normalizeFinding(value: unknown): Finding | null {
  const r = asRecord(value);
  if (typeof r.id !== 'string' || r.id === '' || r.id.length > MAX_ID) return null;

  const scope = asMember<Scope>(r.scope, SCOPES);
  if (scope === undefined) return null;

  const base = {
    id: r.id,
    scope,
    title: asText(r.title, MAX_TITLE),
    detail: asText(r.detail, MAX_DETAIL),
  };

  // Anything short of an explicit `true` is a check that did not run, and
  // there is only one honest status for that.
  if (r.checked !== true) return { ...base, checked: false, status: 'unknown' };

  const checkable = asMember<CheckableScope>(r.scope, CHECKABLE_SCOPES);
  if (checkable === undefined) return null;

  return {
    ...base,
    scope: checkable,
    checked: true,
    status: asMember(r.status, INTEGRITY_STATUSES) ?? 'unknown',
  };
}

/**
 * Rebuild a report.
 *
 * Anything that is not an array of findings is an empty report, never a
 * partial one taken on trust. An empty result and a refused one look the same
 * from here on purpose: neither says anything about any scope, which is the
 * only safe reading of a message that could not be understood.
 */
export function normalizeFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  const out: Finding[] = [];
  for (const entry of value) {
    if (out.length >= MAX_FINDINGS) break;
    const finding = normalizeFinding(entry);
    if (finding !== null) out.push(finding);
  }
  return out;
}

/**
 * Rebuild the coverage list stored on a session record.
 *
 * Allowlisted, deduplicated, and in the canonical signal-path order, so two
 * equal sets cannot render differently — and detached, since it is built here
 * rather than taken from the caller's array. Deep-copying makes the array
 * unshared; it does not make what came off disk trustworthy, and those are
 * different problems.
 *
 * Absent is `[]`, which is what every v1 record means: nothing was checked,
 * because nothing could report.
 */
export function normalizeCoverage(value: unknown): CheckableScope[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(value.filter((entry): entry is string => typeof entry === 'string'));
  return CHECKABLE_SCOPES.filter((scope) => seen.has(scope));
}

/**
 * What the integrity subsystem knows, and how sure it is.
 *
 * Pure and portable like `src/session/` — no Electron, no Web Audio — so the
 * precedence rules and the merge semantics are asserted offline, before
 * anything is wired to a graph or a window.
 *
 * The whole point of this module is to keep two things apart that look alike:
 * a check that ran and could not conclude, and a check that never ran. Both
 * read as "unknown", and conflating them is how incomplete evidence turns
 * into a green tick.
 */

import { type IntegrityStatus } from '../session/session.ts';

/**
 * Where in the chain a finding applies, from the engine outwards.
 *
 * Deliberately four rather than "our output" and "everything after". The two
 * downstream halves have completely different prospects, and an earlier draft
 * that merged them ended up claiming Windows loopback verified what the
 * listener hears:
 *
 * - `engine` — the offline DSP. Checkable everywhere.
 * - `graph` — our own output, taken before `AudioContext.destination`.
 *   Checkable everywhere.
 * - `systemMix` — what the OS audio engine mixed. Windows only, and only once
 *   loopback lands; it also contains every other application's audio.
 * - `delivery` — the DAC, the transducer, the air. **No checker exists on any
 *   platform**, so this is permanently `unknown`. It stays in the model rather
 *   than being left implied, because a scope nobody can check is exactly the
 *   thing a badge would otherwise quietly imply was fine.
 *
 * The order is the signal path, and it is canonical: coverage is reported in
 * it so two equal sets of scopes cannot render differently.
 */
export const SCOPES = ['engine', 'graph', 'systemMix', 'delivery'] as const;

export type Scope = (typeof SCOPES)[number];

/**
 * The scopes something could actually check.
 *
 * `delivery` is excluded because nothing on any platform can observe it — not
 * loopback, which stops at the OS mix. Saying that in prose and then letting
 * the type admit a checked `delivery` finding is how the claim quietly stops
 * being true: an earlier draft of the tests constructed exactly that state and
 * asserted a clean result from it.
 *
 * Widen this only when a checker genuinely exists, which for `delivery` would
 * mean measuring sound in the room.
 */
export type CheckableScope = Exclude<Scope, 'delivery'>;

/**
 * The same list at runtime, derived rather than written out a second time, so
 * the two cannot drift. Coverage is reported in this order for the same reason
 * `SCOPES` is ordered: two equal sets must render identically.
 */
export const CHECKABLE_SCOPES: readonly CheckableScope[] = SCOPES.filter(
  (scope): scope is CheckableScope => scope !== 'delivery',
);

interface FindingBase {
  /**
   * Identifies the check, not the occasion.
   *
   * Merging is keyed on it: the same probe reporting again over a session must
   * replace its own previous answer, not accumulate beside it.
   */
  readonly id: string;
  readonly scope: Scope;
  readonly title: string;
  readonly detail: string;
}

/**
 * A check that ran. `unknown` here means it ran and could not conclude.
 *
 * Narrowed to `CheckableScope`: a scope with no checker cannot have produced a
 * result, so the type does not offer a way to claim one. The normalization at
 * the IPC boundary has to reject the same thing, since a report arriving from
 * a renderer is untrusted input rather than something the compiler saw.
 */
export interface CheckedFinding extends FindingBase {
  readonly checked: true;
  readonly scope: CheckableScope;
  readonly status: IntegrityStatus;
}

/**
 * A check that did not run, in any scope at all — including the one that never
 * can, which is the only way `delivery` is ever representable.
 *
 * `status` is the literal `'unknown'` rather than the general type, which is
 * what makes the invariant structural: there is no way to *write* an unchecked
 * finding claiming to have passed, because the type has no such inhabitant.
 * An earlier draft left `status: IntegrityStatus` on a single interface and
 * called the constructors sufficient — they are not, since nothing stops a
 * caller assembling the object by hand.
 */
export interface UncheckedFinding extends FindingBase {
  readonly checked: false;
  readonly status: 'unknown';
}

/**
 * One thing that was looked at, or deliberately was not.
 *
 * `checked` is the field that makes this module worth having, and the reason
 * this is a union rather than a record with a boolean: `status` alone cannot
 * distinguish "ran, inconclusive" from "never ran", and coverage — which is
 * what the session record stores — depends on exactly that difference.
 *
 * Every field is `readonly`, so an aggregate cannot be edited through a
 * reference a caller still holds. That is a compile-time guarantee; the
 * runtime one comes from `mergeFindings` copying what it keeps, and from the
 * normalization every report will pass through at the IPC boundary.
 */
export type Finding = CheckedFinding | UncheckedFinding;

/** A detached copy, so a stored finding cannot be edited through a reference. */
export function snapshotFinding(finding: Finding): Finding {
  return finding.checked
    ? {
        id: finding.id,
        scope: finding.scope,
        title: finding.title,
        detail: finding.detail,
        checked: true,
        status: finding.status,
      }
    : {
        id: finding.id,
        scope: finding.scope,
        title: finding.title,
        detail: finding.detail,
        checked: false,
        status: 'unknown',
      };
}

/**
 * Precedence, worst first, and the reason `unknown` outranks `ok`.
 *
 * The surface is asked "should I trust this right now?", and absence of
 * evidence is a real answer to that. A run where half the checks never
 * happened is not the same as one where they all passed, so an unchecked scope
 * keeps the overall answer off `ok` rather than being ignored for being quiet.
 */
const RANK: Record<IntegrityStatus, number> = {
  ok: 0,
  unknown: 1,
  warning: 2,
  failed: 3,
};

function worse(a: IntegrityStatus, b: IntegrityStatus): IntegrityStatus {
  return RANK[b] > RANK[a] ? b : a;
}

/** A check that ran. Its status is whatever it concluded, `unknown` included. */
export function checkedFinding(finding: Omit<CheckedFinding, 'checked'>): CheckedFinding {
  return { ...finding, checked: true };
}

/**
 * A check that did not run, and why.
 *
 * The status is not a parameter: there is only one honest answer for something
 * nobody looked at. Recording it — rather than omitting the finding — is what
 * keeps an unrunnable check visible instead of silently absent.
 */
export function uncheckedFinding(finding: FindingBase): UncheckedFinding {
  return { ...finding, status: 'unknown', checked: false };
}

/**
 * The answer for the surface: should this be trusted right now?
 *
 * Worst of everything reported — **and of every scope nothing reported on**.
 * The second half is not a detail. Reading only the findings present would let
 * a partial report reach `ok` by omission: one cheerful `engine` result and no
 * mention of anything downstream would render green, which is precisely the
 * "coverage read as correctness" failure this subsystem exists to avoid. A
 * producer that forgets to emit a placeholder is then a silent bug rather than
 * a visible gap, so the rule is structural here instead of a convention
 * callers have to keep.
 *
 * **This therefore never returns `ok`.** `delivery` is not a `CheckableScope`,
 * so it can never be covered, so the floor is always at least `unknown`. That
 * is the honest answer to "should I trust this right now?" for an app that
 * cannot hear its own output, and it is why the surface is a coverage summary
 * rather than a status light — a light with an unreachable colour is broken.
 *
 * The coverage test is written out rather than short-circuited to `unknown`,
 * so it states the reason instead of the conclusion. If a scope ever gains a
 * checker, this keeps answering correctly rather than staying wrong quietly.
 */
export function overallStatus(findings: readonly Finding[]): IntegrityStatus {
  const covered = new Set<Scope>(findings.filter((f) => f.checked).map((f) => f.scope));
  const start: IntegrityStatus = SCOPES.every((scope) => covered.has(scope)) ? 'ok' : 'unknown';
  return findings.reduce<IntegrityStatus>((worst, f) => worse(worst, f.status), start);
}

/**
 * The answer for the session record: what did we actually verify?
 *
 * Worst among the checks that **ran**. Unchecked findings do not drag this
 * down, which is the whole reason it is a separate function: on macOS the
 * downstream scopes can never be checked, so folding them in would record
 * `unknown` for every healthy session ever run there and the field would carry
 * no information at all.
 *
 * A checked finding that concluded `unknown` still counts — it ran, and
 * inconclusive is its result. What it means alongside a clean check is
 * answered by `checkedScopes`, not by this.
 */
export function recordedStatus(findings: readonly Finding[]): IntegrityStatus {
  const ran = findings.filter((f) => f.checked);
  if (ran.length === 0) return 'unknown';
  return ran.reduce<IntegrityStatus>((worst, f) => worse(worst, f.status), 'ok');
}

/**
 * Which scopes were actually looked at, in signal-path order.
 *
 * A scope is covered when it holds at least one checked finding. Stored beside
 * the recorded status so "the app was fine and nothing downstream was ever
 * examined" is something the record can state, rather than something a reader
 * has to infer from a status that looks clean.
 */
export function checkedScopes(findings: readonly Finding[]): CheckableScope[] {
  const covered = new Set<Scope>(findings.filter((f) => f.checked).map((f) => f.scope));
  return CHECKABLE_SCOPES.filter((scope) => covered.has(scope));
}

/**
 * Replace what a producer said last time with what it says now.
 *
 * The *current* view, and deliberately not `mergeFindings`. The two answer
 * different questions and must not be conflated:
 *
 * - this one answers **"what do the checks say now?"** — the newest answer per
 *   id wins outright, including a clean one replacing a warning, because a
 *   fault that has been fixed is no longer a fault;
 * - `mergeFindings` answers **"what was the worst checked result during this
 *   session?"** — which is history, and history does not improve.
 *
 * A surface built on the second would show a warning about a headset the user
 * has already swapped, for the rest of the session. A record built on the first
 * would forget the fault entirely the moment it stopped. Their disagreement is
 * intentional, and each belongs to exactly one owner: this to the renderer's
 * current view, the merge to the coordinator's session aggregate.
 *
 * An unchecked finding replaces a checked one here, unlike in the merge. That
 * is the same rule stated once more: if a check can no longer run, "not
 * checked" is what is true now.
 */
export function replaceFindings(
  previous: readonly Finding[],
  incoming: readonly Finding[],
): Finding[] {
  const current = new Map<string, Finding>();
  for (const finding of previous) current.set(finding.id, snapshotFinding(finding));
  for (const finding of incoming) current.set(finding.id, snapshotFinding(finding));
  return [...current.values()];
}

/**
 * Fold a new report into what the session has seen so far.
 *
 * Per `id`, and checked-aware. Merging on status alone is broken by the very
 * ordering that makes the surface honest: an unchecked placeholder is
 * `unknown`, `unknown` outranks `ok`, so a plain worst-value merge would keep
 * that placeholder for the rest of the session and coverage would never
 * advance past the first report. The rules, in order:
 *
 * - a **checked** finding supersedes an unchecked one for the same id;
 * - an **unchecked** finding never erases a checked one;
 * - among two checked values, the **worse** status wins — a warning seen once
 *   is a warning the session saw, and a later clean pass does not unsee it;
 * - equally bad checked values take the newer one, so the wording follows the
 *   most recent evidence.
 *
 * Order is the previous report's, with ids it had never seen appended in the
 * order they arrived — stable, so a surface built from this does not reshuffle
 * between reports.
 */
export function mergeFindings(
  previous: readonly Finding[],
  incoming: readonly Finding[],
): Finding[] {
  // Everything stored is a copy. The aggregate outlives the report it came
  // from, and a caller that mutates a finding it still holds must not be able
  // to change what the session recorded — the aliasing bug this project has
  // already fixed three times, in a place where it would rewrite history
  // rather than merely confuse a display.
  const merged = new Map<string, Finding>();
  for (const finding of previous) merged.set(finding.id, snapshotFinding(finding));

  for (const finding of incoming) {
    const existing = merged.get(finding.id);
    if (existing === undefined) {
      merged.set(finding.id, snapshotFinding(finding));
      continue;
    }
    if (!finding.checked) continue;
    if (!existing.checked) {
      merged.set(finding.id, snapshotFinding(finding));
      continue;
    }
    // Both ran: keep the worse verdict, and its own wording with it. `>=`
    // rather than `>` so an equal status takes the newer finding.
    if (RANK[finding.status] >= RANK[existing.status])
      merged.set(finding.id, snapshotFinding(finding));
  }

  return [...merged.values()];
}

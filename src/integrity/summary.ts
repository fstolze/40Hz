/**
 * The coverage summary, in words.
 *
 * Not a traffic light, and the reason is structural rather than aesthetic:
 * `delivery` has no checker on any platform and `systemMix` has none outside
 * Windows, so `overallStatus` can never reach `ok` on the machines most people
 * run this on. A status light whose green is unreachable is a light that reads
 * amber forever, which is a light nobody looks at.
 *
 * So the surface states **coverage** — what was checked, and what was not — and
 * changes appearance only when something that *ran* came back wrong. Absence of
 * evidence is reported as absence of evidence, in a sentence, rather than
 * dressed as a fault.
 *
 * Everything here is present tense on purpose. This describes what the checks
 * say **now**; the session record keeps the worst result seen during a session,
 * and those two answers are allowed to differ. Saying "currently" is what stops
 * a reader taking one for the other.
 */

import { CHECKABLE_SCOPES, SCOPES, checkedScopes, type Finding, type Scope } from './findings.ts';
import type { IntegrityStatus } from '../session/session.ts';

/**
 * What each scope is called on screen.
 *
 * "App output" rather than "graph": the reader is not holding our source tree.
 * "Delivery" is spelled out where it appears, since the word alone claims less
 * than the thing it stands for.
 */
export const SCOPE_LABELS: Record<Scope, string> = {
  engine: 'engine',
  graph: 'app output',
  systemMix: 'system mix',
  delivery: 'delivery',
};

export interface CoverageSummary {
  /** The one line the footer shows. */
  headline: string;
  /**
   * Whether the summary should draw attention to itself.
   *
   * True only when a check that **ran** came back `warning` or `failed`. An
   * uncovered scope never sets this: it is the ordinary state of this app on
   * every platform, and escalating it would make the surface permanently loud
   * about something nobody can act on.
   */
  escalated: boolean;
  /** The worst status among checks that ran, for styling and for tests. */
  worstChecked: IntegrityStatus;
  checked: Scope[];
  unchecked: Scope[];
}

function list(scopes: readonly Scope[]): string {
  const labels = scopes.map((scope) => SCOPE_LABELS[scope]);
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

const RANK: Record<IntegrityStatus, number> = { ok: 0, unknown: 1, warning: 2, failed: 3 };

function worstOf(findings: readonly Finding[]): IntegrityStatus {
  let worst: IntegrityStatus = 'ok';
  for (const finding of findings) {
    if (RANK[finding.status] > RANK[worst]) worst = finding.status;
  }
  return worst;
}

/**
 * Summarize what the checks currently say.
 *
 * Coverage comes from checked findings only — the distinction the whole model
 * exists for — and the trailing clause reports the verdict among those. A scope
 * with no finding at all counts as unchecked, so a producer that never ran
 * leaves a visible gap rather than a silent pass.
 */
export function coverageSummary(findings: readonly Finding[]): CoverageSummary {
  const ran = findings.filter((f) => f.checked);
  const covered = checkedScopes(findings);
  const isCovered = new Set<string>(covered);
  const uncovered = SCOPES.filter((scope) => !isCovered.has(scope));

  const worstChecked = ran.length === 0 ? 'unknown' : worstOf(ran);
  const escalated = worstChecked === 'warning' || worstChecked === 'failed';

  if (covered.length === 0) {
    // Before anything has played. Not a fault, and not a pass: nothing has been
    // asked yet, and the honest sentence says so in those words.
    return {
      headline: `Nothing checked yet — ${list(uncovered)} unverified`,
      escalated: false,
      worstChecked,
      checked: [],
      unchecked: uncovered,
    };
  }

  const verdict =
    worstChecked === 'failed'
      ? `${String(ran.filter((f) => f.status === 'failed').length)} failed`
      : worstChecked === 'warning'
        ? `${String(ran.filter((f) => f.status === 'warning').length)} warning`
        : worstChecked === 'unknown'
          ? 'inconclusive'
          : 'clear';

  const tail = uncovered.length === 0 ? '' : ` · not checked: ${list(uncovered)}`;

  return {
    headline: `Currently checked: ${list(covered)} — ${verdict}${tail}`,
    escalated,
    worstChecked,
    checked: [...covered],
    unchecked: uncovered,
  };
}

/** Findings for one scope, in the order they were reported. */
export function findingsInScope(findings: readonly Finding[], scope: Scope): Finding[] {
  return findings.filter((finding) => finding.scope === scope);
}

/**
 * The scopes to show in the detail panel, in signal-path order.
 *
 * All four, always. A panel that listed only the scopes with something to say
 * would quietly drop the two that matter most for honesty — the ones nothing
 * checked.
 */
export const PANEL_SCOPES: readonly Scope[] = SCOPES;

/** True where a scope could in principle be checked by this build. */
export function isCheckable(scope: Scope): boolean {
  return (CHECKABLE_SCOPES as readonly Scope[]).includes(scope);
}

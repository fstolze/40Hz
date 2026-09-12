/**
 * The integrity model, and above all the difference between "checked and
 * inconclusive" and "never checked".
 *
 * Both read as `unknown`, and every way this subsystem can lie to a user goes
 * through confusing them: a badge that goes green because nobody looked, or a
 * session record that says `unknown` forever because a scope that can never be
 * checked dragged it down. The precedence and the merge rules are the whole of
 * that promise, so they are asserted here rather than left to the surfaces.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  CHECKABLE_SCOPES,
  SCOPES,
  checkedFinding,
  checkedScopes,
  mergeFindings,
  overallStatus,
  recordedStatus,
  uncheckedFinding,
  type CheckableScope,
  type Finding,
  type Scope,
} from '../src/integrity/findings.ts';
import { INTEGRITY_STATUSES, type IntegrityStatus } from '../src/session/session.ts';

const ran = (id: string, scope: CheckableScope, status: IntegrityStatus): Finding =>
  checkedFinding({ id, scope, status, title: id, detail: `${id} detail` });

const skipped = (id: string, scope: Scope): Finding =>
  uncheckedFinding({ id, scope, title: id, detail: `${id} was not checked` });

describe('the shape of a finding', () => {
  it('reuses the four statuses already persisted', () => {
    expect(INTEGRITY_STATUSES.join(',')).toBe('unknown,ok,warning,failed');
  });

  it('orders scopes along the signal path', () => {
    expect(SCOPES.join(',')).toBe('engine,graph,systemMix,delivery');
  });

  it('cannot describe an unchecked finding as anything but unknown', () => {
    const finding = skipped('loopback', 'systemMix');
    expect(finding.checked).toBe(false);
    expect(finding.status).toBe('unknown');
  });

  it('has no type at all for a delivery finding that ran', () => {
    // Nothing on any platform can observe what reaches the ear — not loopback,
    // which stops at the OS mix. Saying so in prose while the type admitted a
    // checked `delivery` finding is how the claim stops being true: an earlier
    // version of this suite constructed exactly that and asserted a clean
    // result from it, enshrining the contradiction instead of catching it.
    // @ts-expect-error -- 'delivery' is not a CheckableScope
    checkedFinding({ id: 'acoustic', scope: 'delivery', status: 'ok', title: 'a', detail: 'd' });

    // The unchecked branch still accepts it, which is the only way the scope is
    // ever representable at all.
    expect(skipped('acoustic', 'delivery').scope).toBe('delivery');
  });

  it('has no type at all for an unchecked finding that passed', () => {
    // The invariant, enforced by the shape rather than by the constructors —
    // which was the earlier draft's mistake, since nothing stops a caller
    // assembling the object by hand. This assertion is the compiler's: if the
    // union ever admits this again, `@ts-expect-error` becomes an unused
    // directive and `npm run typecheck` fails on this line.
    // @ts-expect-error -- checked: false admits only status: 'unknown'
    const impossible: Finding = {
      id: 'loopback',
      scope: 'systemMix',
      title: 'loopback',
      detail: 'claims to have passed without running',
      checked: false,
      status: 'ok',
    };
    expect(impossible.checked).toBe(false);
  });

  it('lets a check that ran report unknown for itself', () => {
    // Ran, could not conclude. Distinct from the above in the field that
    // coverage depends on, and identical in the one a naive reader looks at.
    const finding = ran('device-label', 'graph', 'unknown');
    expect(finding.checked).toBe(true);
    expect(finding.status).toBe('unknown');
  });
});

describe('precedence for the surface', () => {
  it('answers unknown when nothing was reported at all', () => {
    // An empty report is an absence of evidence, not a clean bill.
    expect(overallStatus([])).toBe('unknown');
  });

  it('ranks every pair the same way round', () => {
    // Asserted through `recordedStatus`, which is worst-among-checked with no
    // coverage floor under it, so this measures the precedence alone.
    // `overallStatus` cannot express the `ok` half of this table — see below.
    const order: IntegrityStatus[] = ['ok', 'unknown', 'warning', 'failed'];
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j < order.length; j += 1) {
        const pair = [ran('a', 'engine', order[i]), ran('b', 'graph', order[j])];
        expect(recordedStatus(pair)).toBe(order[Math.max(i, j)]);
      }
    }
  });

  it('keeps a single unknown from reading as ok', () => {
    // The reason `unknown` outranks `ok` here: the surface is asked whether to
    // trust this now, and a check that never ran is a real answer to that.
    const findings = [ran('engine-selftest', 'engine', 'ok'), skipped('loopback', 'systemMix')];
    expect(overallStatus(findings)).toBe('unknown');
  });

  it('still lets a real fault outrank an unknown', () => {
    const findings = [skipped('loopback', 'systemMix'), ran('envelope', 'graph', 'failed')];
    expect(overallStatus(findings)).toBe('failed');
  });

  it('does not go green just because nobody mentioned the rest', () => {
    // A partial report, with no placeholder standing in for what is missing.
    // Reading only what is present would answer `ok` here — coverage read as
    // correctness, which is the largest risk this subsystem carries. Omission
    // has to be as loud as an explicit gap, or a producer that forgets to emit
    // one is a silent bug.
    expect(overallStatus([ran('engine-selftest', 'engine', 'ok')])).toBe('unknown');
  });

  it('never reaches ok, however much was checked and passed', () => {
    // Not pessimism for its own sake: `delivery` is not checkable, so it can
    // never be covered, so the floor never lifts. This is the honest answer for
    // an app that cannot hear its own output, and the reason the surface is a
    // coverage summary rather than a light with a colour it can never show.
    const everythingCheckable = CHECKABLE_SCOPES.map((scope) => ran(`${scope}-probe`, scope, 'ok'));
    expect(overallStatus(everythingCheckable)).toBe('unknown');

    // It still escalates, which is the part that has to keep working.
    expect(overallStatus([...everythingCheckable, ran('envelope', 'graph', 'warning')])).toBe(
      'warning',
    );
  });
});

describe('what the session record stores', () => {
  it('is not dragged down by a scope nobody could check', () => {
    // The contradiction that sank an earlier draft: on macOS the downstream
    // scopes can never be checked, so folding them in would record `unknown`
    // for every healthy session ever run there.
    const findings = [
      ran('engine-selftest', 'engine', 'ok'),
      ran('envelope', 'graph', 'ok'),
      skipped('loopback', 'systemMix'),
      skipped('acoustic', 'delivery'),
    ];
    expect(recordedStatus(findings)).toBe('ok');
    expect(overallStatus(findings)).toBe('unknown');
  });

  it('counts a check that ran and could not conclude', () => {
    // It ran; inconclusive is its result. What that means next to a clean
    // check is answered by coverage, not by hiding it here.
    const findings = [
      ran('engine-selftest', 'engine', 'ok'),
      ran('device-label', 'graph', 'unknown'),
    ];
    expect(recordedStatus(findings)).toBe('unknown');
  });

  it('is unknown when nothing ran', () => {
    expect(recordedStatus([skipped('loopback', 'systemMix')])).toBe('unknown');
    expect(recordedStatus([])).toBe('unknown');
  });

  it('records coverage in signal-path order, however the findings arrived', () => {
    const findings = [
      ran('envelope', 'graph', 'ok'),
      ran('engine-selftest', 'engine', 'ok'),
      ran('sidebands', 'graph', 'ok'),
    ];
    expect(checkedScopes(findings).join(',')).toBe('engine,graph');
  });

  it('never covers a scope that only holds unchecked findings', () => {
    const findings = [ran('engine-selftest', 'engine', 'ok'), skipped('loopback', 'systemMix')];
    expect(checkedScopes(findings).join(',')).toBe('engine');
  });

  it('leaves delivery uncovered and unknown whatever else passed', () => {
    // No checker exists for it on any platform. A healthy engine and graph
    // must not imply anything about what reached the ear.
    const findings = [
      ran('engine-selftest', 'engine', 'ok'),
      ran('envelope', 'graph', 'ok'),
      skipped('acoustic', 'delivery'),
    ];
    // Coverage cannot even hold it — `checkedScopes` returns `CheckableScope[]`,
    // so asking whether `delivery` is in there is now a type error rather than
    // a runtime check. What remains worth asserting is that it neither appears
    // nor drags anything down.
    expect(checkedScopes(findings).join(',')).toBe('engine,graph');
    expect(findings.find((f) => f.scope === 'delivery')?.status).toBe('unknown');
    expect(recordedStatus(findings)).toBe('ok');
    expect(overallStatus(findings)).toBe('unknown');
  });
});

describe('folding reports together over a session', () => {
  it('lets a real check replace the placeholder that stood in for it', () => {
    // The bug a plain worst-value merge would have: the placeholder is
    // `unknown`, `unknown` outranks `ok`, so the first report would pin the
    // aggregate for the whole session and coverage would never advance.
    const before = [skipped('envelope', 'graph')];
    const after = mergeFindings(before, [ran('envelope', 'graph', 'ok')]);

    expect(after.length).toBe(1);
    expect(after[0].checked).toBe(true);
    expect(recordedStatus(after)).toBe('ok');
    expect(checkedScopes(after).join(',')).toBe('graph');
  });

  it('does not let a placeholder erase a check that ran', () => {
    // A later report that simply could not gather this one says nothing about
    // it, and must not overwrite what was already observed.
    const before = [ran('envelope', 'graph', 'ok')];
    const after = mergeFindings(before, [skipped('envelope', 'graph')]);

    expect(after[0].checked).toBe(true);
    expect(after[0].status).toBe('ok');
    expect(checkedScopes(after).join(',')).toBe('graph');
  });

  it('remembers a warning after a later clean pass', () => {
    // The aggregate is the worst valid observation of the session, not the
    // latest one — a moment of recovery must not unsee a real fault.
    const first = mergeFindings([], [ran('envelope', 'graph', 'ok')]);
    const second = mergeFindings(first, [ran('envelope', 'graph', 'warning')]);
    const third = mergeFindings(second, [ran('envelope', 'graph', 'ok')]);

    expect(third.length).toBe(1);
    expect(third[0].status).toBe('warning');
    expect(recordedStatus(third)).toBe('warning');
  });

  it('takes the newer wording when the verdict is unchanged', () => {
    const before = [ran('envelope', 'graph', 'warning')];
    const after = mergeFindings(before, [
      checkedFinding({
        id: 'envelope',
        scope: 'graph',
        status: 'warning',
        title: 'envelope',
        detail: 'measured 12% against 40% commanded',
      }),
    ]);
    expect(after[0].detail).toBe('measured 12% against 40% commanded');
  });

  it('keeps one entry per check rather than a pile of them', () => {
    const findings = [ran('envelope', 'graph', 'ok'), ran('sidebands', 'graph', 'ok')];
    const after = mergeFindings(findings, findings);
    expect(after.length).toBe(2);
    expect(after.map((f) => f.id).join(',')).toBe('envelope,sidebands');
  });

  it('keeps its own copies, so a caller cannot rewrite history afterwards', () => {
    // The aliasing bug this project has already fixed three times, in a place
    // where it would change what a session recorded rather than only what a
    // panel displays.
    const reported = { ...ran('envelope', 'graph', 'ok') } as { status: string };
    const aggregate = mergeFindings([], [reported as unknown as Finding]);

    reported.status = 'failed';

    expect(aggregate[0].status).toBe('ok');
    expect(recordedStatus(aggregate)).toBe('ok');
  });

  it('copies what it carries over from the previous aggregate too', () => {
    const previous = mergeFindings([], [ran('envelope', 'graph', 'warning')]);
    const next = mergeFindings(previous, [ran('sidebands', 'graph', 'ok')]);

    (previous[0] as { status: string }).status = 'ok';

    expect(next[0].status).toBe('warning');
  });

  it('holds its order so a surface built from it does not reshuffle', () => {
    // Previous order first, then ids never seen before in the order they came.
    const before = [ran('engine-selftest', 'engine', 'ok'), ran('envelope', 'graph', 'ok')];
    const after = mergeFindings(before, [
      ran('sidebands', 'graph', 'ok'),
      ran('envelope', 'graph', 'warning'),
    ]);
    expect(after.map((f) => f.id).join(',')).toBe('engine-selftest,envelope,sidebands');
  });
});

/**
 * The current view, and the sentence that describes it.
 *
 * Two states in this app answer questions that sound the same and are not:
 * what the checks say **now**, and what the worst checked result was **during a
 * session**. The renderer owns the first, the coordinator owns the second, and
 * their disagreement is intentional history rather than a bug. Everything here
 * is about keeping that line visible — in the merge rule, and in the words.
 */

import { describe, it, expect } from './helpers/expect.ts';
import {
  checkedFinding,
  mergeFindings,
  replaceFindings,
  uncheckedFinding,
  type CheckableScope,
  type Finding,
} from '../src/integrity/findings.ts';
import { coverageSummary, findingsInScope, isCheckable } from '../src/integrity/summary.ts';
import { missingScopeFindings } from '../src/integrity/rules.ts';
import type { IntegrityStatus } from '../src/session/session.ts';

const ran = (id: string, scope: CheckableScope, status: IntegrityStatus): Finding =>
  checkedFinding({ id, scope, status, title: id, detail: `${id} detail` });

const skipped = (id: string, scope: CheckableScope): Finding =>
  uncheckedFinding({ id, scope, title: id, detail: `${id} not run` });

describe('the current view against the session aggregate', () => {
  it('lets a clean result replace a warning, which the aggregate never does', () => {
    // The whole reason these are two functions. A headset swapped mid-session
    // fixes the fault: the panel must stop warning, and the record must not
    // forget that the listener heard it.
    const before = [ran('stereo', 'graph', 'warning')];
    const after = [ran('stereo', 'graph', 'ok')];

    expect(replaceFindings(before, after)[0].status).toBe('ok');
    expect(mergeFindings(before, after)[0].status).toBe('warning');
  });

  it('lets "not checked" replace a result, which the aggregate also refuses', () => {
    // If a check can no longer run, that is what is true now — while the
    // session's history keeps the answer from when it could.
    const before = [ran('stereo', 'graph', 'ok')];
    const after = [skipped('stereo', 'graph')];

    expect(replaceFindings(before, after)[0].checked).toBe(false);
    expect(mergeFindings(before, after)[0].checked).toBe(true);
  });

  it('keeps one entry per id, and the order it first saw them', () => {
    const current = replaceFindings(
      [ran('a', 'engine', 'ok'), ran('b', 'graph', 'ok')],
      [ran('b', 'graph', 'warning'), ran('c', 'engine', 'ok')],
    );
    expect(current.map((f) => f.id).join(',')).toBe('a,b,c');
    expect(current.length).toBe(3);
  });

  it('stores copies, so a producer cannot rewrite the view it handed over', () => {
    const source = ran('a', 'engine', 'ok');
    const current = replaceFindings([], [source]);
    expect(current[0]).toBe(current[0]);
    expect(current[0] === source).toBe(false);
  });
});

describe('the coverage summary', () => {
  /** What the panel shows for scopes nothing has reported on. */
  const missing = (reported: readonly Finding[] = []): Finding[] =>
    missingScopeFindings(reported).filter((f) => f.scope !== 'engine' && f.scope !== 'graph');

  it('says nothing has been checked before anything has played', () => {
    // Not a pass and not a fault. The words have to be neither, because this is
    // the state the app is in every time it starts.
    const summary = coverageSummary([...missing(), skipped('stereo', 'graph')]);
    expect(summary.headline).toBe(
      'Nothing checked yet — engine, app output, system mix and delivery unverified',
    );
    expect(summary.escalated).toBe(false);
    expect(summary.checked.length).toBe(0);
  });

  it('names what was checked, and what was not, in signal-path order', () => {
    const summary = coverageSummary([
      ...missing(),
      ran('self-test', 'engine', 'ok'),
      ran('stereo', 'graph', 'ok'),
    ]);
    expect(summary.headline).toBe(
      'Currently checked: engine and app output — clear · not checked: system mix and delivery',
    );
    expect(summary.escalated).toBe(false);
  });

  it('does not escalate for a scope nobody can check', () => {
    // The reason this is a coverage summary rather than a status light:
    // `delivery` is never checked anywhere, so a light would sit amber forever
    // and be ignored by the second day.
    const summary = coverageSummary([...missing(), ran('self-test', 'engine', 'ok')]);
    expect(summary.worstChecked).toBe('ok');
    expect(summary.escalated).toBe(false);
  });

  it('escalates only for a check that ran and came back wrong', () => {
    const warned = coverageSummary([...missing(), ran('stereo', 'graph', 'warning')]);
    expect(warned.escalated).toBe(true);
    expect(warned.headline).toBe(
      'Currently checked: app output — 1 warning · not checked: engine, system mix and delivery',
    );

    const failed = coverageSummary([
      ...missing(),
      ran('stereo', 'graph', 'warning'),
      ran('envelope', 'graph', 'failed'),
    ]);
    expect(failed.worstChecked).toBe('failed');
    expect(failed.headline.includes('1 failed')).toBe(true);
  });

  it('calls a check that ran without concluding inconclusive, not clear', () => {
    const summary = coverageSummary([...missing(), ran('envelope', 'graph', 'unknown')]);
    expect(summary.headline.includes('inconclusive')).toBe(true);
    // It ran, so it does not shout — but it must not read as a pass either.
    expect(summary.escalated).toBe(false);
    expect(summary.headline.includes('clear')).toBe(false);
  });

  it('speaks in the present tense, since the record answers a different question', () => {
    // "Currently" is the word doing the work: the session record keeps the
    // worst result seen during the session, and a reader who takes one for the
    // other has been misled by the surface rather than by the data.
    const summary = coverageSummary([...missing(), ran('self-test', 'engine', 'ok')]);
    expect(summary.headline.startsWith('Currently checked:')).toBe(true);
  });
});

describe('the scopes nothing has reported on', () => {
  it('accounts for every scope that is silent, and only those', () => {
    // A scope with no finding looks exactly like one that passed. These are the
    // reason the panel can tell a reader why — and which scopes need one
    // follows from what has been reported, so `graph` stops needing a
    // placeholder the moment something measures it.
    expect(
      missingScopeFindings([])
        .map((f) => f.scope)
        .join(','),
    ).toBe('engine,graph,systemMix,delivery');
    expect(missingScopeFindings([]).every((f) => !f.checked)).toBe(true);
    expect(
      missingScopeFindings([ran('self-test', 'engine', 'ok')])
        .map((f) => f.scope)
        .join(','),
    ).toBe('graph,systemMix,delivery');
  });

  it('explains each one differently, because the reasons differ', () => {
    const [, , systemMix, delivery] = missingScopeFindings([]);
    // One is a capability this stack does not reach, on the platform where it
    // is closest — and the copy has to say "this stack" rather than "no API
    // exists", which is the claim the platform validation falsified.
    expect(/Windows/.test(systemMix.detail)).toBe(true);
    expect(/Electron/.test(systemMix.detail)).toBe(true);
    expect(/no API for it at all/.test(systemMix.detail)).toBe(false);
    // The other is not a matter of effort, or of stack, at all.
    expect(/stops at the operating system/.test(delivery.detail)).toBe(true);
    expect(isCheckable('delivery')).toBe(false);
    expect(isCheckable('systemMix')).toBe(true);
  });

  it('groups by scope for the panel', () => {
    // A reported finding replaces its scope's placeholder rather than joining
    // it: `missingScopeFindings` is asked what is still silent.
    const reported = [ran('stereo', 'graph', 'ok')];
    const findings = [...missingScopeFindings(reported), ...reported];
    expect(findingsInScope(findings, 'graph').length).toBe(1);
    expect(findingsInScope(findings, 'delivery').length).toBe(1);
    // Silent too, and accounted for: the engine placeholder is there because
    // the self-test has not run in this construction, not because the scope is
    // absent from the panel.
    expect(findingsInScope(findings, 'engine').length).toBe(1);
  });
});

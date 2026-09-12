/**
 * The current view, assembled per producer.
 *
 * The regression this exists for is specific and was found before the wiring
 * that would have shipped it: a capture pass emits a *different set* of
 * findings depending on what it could measure, so a view that merged by finding
 * id kept a refusal standing forever. One timeout, one configuration change
 * mid-window, one ramp overlap, and the panel would say the output was never
 * measured for the rest of the run, however many clean passes followed.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { CurrentView } from '../src/integrity/current-view.ts';
import { checkedFinding, uncheckedFinding, type Finding } from '../src/integrity/findings.ts';
import { coverageSummary } from '../src/integrity/summary.ts';

/** What a refused capture pass reports: one finding, saying why. */
const refusedPass = (): Finding[] => [
  uncheckedFinding({
    id: 'graph-master-window',
    scope: 'graph',
    title: 'Master output not measured',
    detail: 'The window overlapped a ramp.',
  }),
];

/** What a successful one reports: several, none sharing an id with the above. */
const measuredPass = (): Finding[] => [
  checkedFinding({
    id: 'graph-envelope-depth',
    scope: 'graph',
    status: 'ok',
    title: 'Envelope depth',
    detail: 'as commanded',
  }),
  checkedFinding({
    id: 'graph-master-signal',
    scope: 'graph',
    status: 'ok',
    title: 'Master signal',
    detail: 'present and continuous',
  }),
];

const selfTest = (): Finding[] => [
  checkedFinding({
    id: 'engine-envelope',
    scope: 'engine',
    status: 'ok',
    title: 'Envelope',
    detail: 'as commanded',
  }),
];

const ids = (view: CurrentView): string[] => view.findings.map((f) => f.id);

describe('a producer replacing its own answer', () => {
  it('clears a refusal that a later success never mentions', () => {
    // The blocking defect. Merging by id cannot do this: nothing in a
    // successful pass shares an id with `graph-master-window`.
    const view = new CurrentView();
    view.record('capture', refusedPass());
    expect(ids(view).includes('graph-master-window')).toBe(true);

    view.record('capture', measuredPass());

    expect(ids(view).includes('graph-master-window')).toBe(false);
    expect(ids(view).includes('graph-master-signal')).toBe(true);
    // And the summary a reader sees agrees: the scope is checked and clear,
    // rather than carrying a refusal from minutes ago.
    const summary = coverageSummary(view.findings);
    expect(summary.checked.join(',')).toBe('graph');
    expect(summary.headline.includes('clear')).toBe(true);
  });

  it('clears a success that a later refusal never mentions', () => {
    // The same rule in the other direction: if a pass could not measure, the
    // last pass's verdicts are no longer what the checks say now.
    const view = new CurrentView();
    view.record('capture', measuredPass());
    view.record('capture', refusedPass());

    expect(ids(view).includes('graph-master-signal')).toBe(false);
    expect(coverageSummary(view.findings).checked.length).toBe(0);
  });

  it('leaves other producers alone', () => {
    const view = new CurrentView();
    view.record('self-test', selfTest());
    view.record('capture', refusedPass());
    view.record('capture', measuredPass());

    expect(ids(view).includes('engine-envelope')).toBe(true);
    expect(coverageSummary(view.findings).checked.join(',')).toBe('engine,graph');
  });

  it('withdraws a producer that now says nothing', () => {
    // Not ignored: a producer with nothing to say must leave its scope looking
    // unreported rather than leave its last answer standing as though current.
    const view = new CurrentView();
    view.record('capture', measuredPass());
    view.record('capture', []);

    expect(ids(view).includes('graph-master-signal')).toBe(false);
    expect(ids(view).includes('graph-unreported')).toBe(true);
  });

  it('keeps the order producers first reported in', () => {
    const view = new CurrentView();
    view.record('self-test', selfTest());
    view.record('capture', measuredPass());
    view.record('self-test', selfTest());

    expect(view.reported.map((f) => f.id).join(',')).toBe(
      'engine-envelope,graph-envelope-depth,graph-master-signal',
    );
  });

  it('stores copies, so a producer cannot rewrite what is shown', () => {
    const view = new CurrentView();
    const reported = measuredPass();
    view.record('capture', reported);
    expect(view.reported[0] === reported[0]).toBe(false);
  });

  it('hands out copies, so a reader cannot rewrite it either', () => {
    // The array was already new; the findings in it were not. A caller editing
    // one would have changed what every later view showed.
    const view = new CurrentView();
    view.record('capture', measuredPass());

    const handed = view.reported[0] as { status: string; title: string };
    handed.status = 'failed';
    handed.title = 'rewritten';

    expect(view.reported[0].status).toBe('ok');
    expect(view.findings.find((f) => f.id === 'graph-envelope-depth')?.title).toBe(
      'Envelope depth',
    );
  });
});

describe('scopes still silent', () => {
  it('accounts for them, and stops once a producer covers them', () => {
    const view = new CurrentView();
    expect(ids(view).join(',')).toBe(
      'engine-unreported,graph-unreported,systemMix-unreported,delivery-unreported',
    );

    view.record('capture', measuredPass());
    expect(ids(view).includes('graph-unreported')).toBe(false);
    expect(ids(view).includes('engine-unreported')).toBe(true);
  });

  it('counts a refusal as having reported, since it says why', () => {
    // An unchecked finding naming a reason is better than the generic
    // placeholder, and replacing it with one would lose the reason.
    const view = new CurrentView();
    view.record('capture', refusedPass());
    expect(ids(view).includes('graph-unreported')).toBe(false);
    expect(ids(view).includes('graph-master-window')).toBe(true);
  });
});

/**
 * What the integrity boundary accepts, and what it refuses.
 *
 * The type system is what keeps `delivery` uncheckable and an unchecked
 * finding from claiming to have passed — and the compiler never sees a report
 * that arrived over IPC or a coverage list that came off disk. So every
 * invariant `findings.ts` states structurally has to be restated here as a
 * runtime rule, or it holds only for the code we happened to write.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { MAX_FINDINGS, normalizeCoverage, normalizeFindings } from '../src/integrity/normalize.ts';
import { checkedScopes, recordedStatus } from '../src/integrity/findings.ts';

const ran = (id: string, scope: string, status: string): Record<string, unknown> => ({
  id,
  scope,
  status,
  checked: true,
  title: id,
  detail: `${id} detail`,
});

describe('rebuilding a report', () => {
  it('keeps a well-formed finding whole', () => {
    const [finding] = normalizeFindings([ran('envelope', 'graph', 'warning')]);
    expect(finding.id).toBe('envelope');
    expect(finding.scope).toBe('graph');
    expect(finding.status).toBe('warning');
    expect(finding.checked).toBe(true);
    expect(finding.title).toBe('envelope');
    expect(finding.detail).toBe('envelope detail');
  });

  it('refuses a checked delivery finding rather than rewriting it', () => {
    // The scope with no checker on any platform. The type has no inhabitant
    // for this, so it can only arrive from outside — and accepting it as an
    // unchecked finding would invent a report nobody made, while accepting it
    // as checked would put `delivery` in a session record's coverage and make
    // the app claim it verified what the listener heard.
    const findings = normalizeFindings([
      ran('acoustic', 'delivery', 'ok'),
      ran('envelope', 'graph', 'ok'),
    ]);
    expect(findings.length).toBe(1);
    expect(findings[0].scope).toBe('graph');
    expect(checkedScopes(findings).join(',')).toBe('graph');
  });

  it('still admits an unchecked delivery finding, which is how it is recorded at all', () => {
    const [finding] = normalizeFindings([
      { id: 'acoustic', scope: 'delivery', checked: false, title: 'a', detail: 'no checker' },
    ]);
    expect(finding.scope).toBe('delivery');
    expect(finding.checked).toBe(false);
    expect(finding.status).toBe('unknown');
  });

  it('never lets a report claim a pass it did not run', () => {
    // `checked: false` with `status: 'ok'` is the exact shape the type refuses
    // to construct. Off a wire it has to be refused again.
    const [finding] = normalizeFindings([
      { id: 'loopback', scope: 'systemMix', checked: false, status: 'ok', title: 'l', detail: 'd' },
    ]);
    expect(finding.status).toBe('unknown');
    expect(recordedStatus([finding])).toBe('unknown');
    expect(checkedScopes([finding]).length).toBe(0);
  });

  it('treats anything short of an explicit true as not checked', () => {
    const [finding] = normalizeFindings([
      { id: 'x', scope: 'graph', checked: 'yes', status: 'ok', title: 't', detail: 'd' },
    ]);
    expect(finding.checked).toBe(false);
    expect(finding.status).toBe('unknown');
  });

  it('keeps a check that ran with an unreadable status, as inconclusive', () => {
    // It ran; what it concluded cannot be read. Dropping it would remove the
    // scope from coverage as well, which is how a gap becomes a clean result.
    const [finding] = normalizeFindings([ran('sidebands', 'graph', 'excellent')]);
    expect(finding.checked).toBe(true);
    expect(finding.status).toBe('unknown');
    expect(checkedScopes([finding]).join(',')).toBe('graph');
  });

  it('drops a finding with no id, since merging is keyed on it', () => {
    expect(normalizeFindings([ran('', 'graph', 'ok')]).length).toBe(0);
    expect(normalizeFindings([{ scope: 'graph', checked: true, status: 'ok' }]).length).toBe(0);
  });

  it('drops a finding whose scope is not one of ours', () => {
    expect(normalizeFindings([ran('x', 'bluetooth', 'failed')]).length).toBe(0);
  });

  it('supplies empty copy rather than carrying a non-string through', () => {
    const [finding] = normalizeFindings([
      { id: 'x', scope: 'graph', checked: true, status: 'ok', title: 42, detail: null },
    ]);
    expect(finding.title).toBe('');
    expect(finding.detail).toBe('');
  });

  it('refuses an id too long to be one, rather than cutting it down', () => {
    // An unbounded key is unbounded memory, and a truncated one collides: two
    // distinct checks cut to the same prefix would merge into one, and the
    // second would silently replace the first's answer.
    const long = 'f'.repeat(200);
    expect(normalizeFindings([ran(long, 'graph', 'ok')]).length).toBe(0);
    expect(normalizeFindings([ran('f'.repeat(128), 'graph', 'ok')]).length).toBe(1);
  });

  it('bounds the copy and the count a single report can carry', () => {
    // The aggregate is keyed by id and lives for the length of a session, so
    // an unbounded report is unbounded memory in the main process.
    const many = Array.from({ length: MAX_FINDINGS + 10 }, (_, i) => ran(`f${i}`, 'graph', 'ok'));
    expect(normalizeFindings(many).length).toBe(MAX_FINDINGS);

    const [finding] = normalizeFindings([
      { id: 'x', scope: 'graph', checked: true, status: 'ok', title: 'a'.repeat(5000), detail: '' },
    ]);
    expect(finding.title.length).toBeLessThanOrEqual(200);
  });

  it('reads anything that is not a list of findings as an empty report', () => {
    // Empty and refused look the same on purpose: neither says anything about
    // any scope, which is the only safe reading of a message we cannot parse.
    expect(normalizeFindings(null).length).toBe(0);
    expect(normalizeFindings('findings').length).toBe(0);
    expect(normalizeFindings({ findings: [ran('x', 'graph', 'ok')] }).length).toBe(0);
    expect(normalizeFindings([null, 7, 'x']).length).toBe(0);
  });
});

describe('rebuilding coverage off disk', () => {
  it('keeps only scopes something could have checked', () => {
    // A file claiming `delivery` was covered is the same overclaim in another
    // form, and the one an older or hand-edited record could carry.
    expect(normalizeCoverage(['engine', 'delivery', 'graph']).join(',')).toBe('engine,graph');
    expect(normalizeCoverage(['bluetooth']).length).toBe(0);
  });

  it('deduplicates and returns the canonical signal-path order', () => {
    // Two equal sets must render identically, whatever order they were
    // written in.
    expect(normalizeCoverage(['graph', 'engine', 'graph']).join(',')).toBe('engine,graph');
  });

  it('reads a missing or unusable list as nothing checked', () => {
    // Which is exactly what every v1 record means: no producer existed.
    expect(normalizeCoverage(undefined).length).toBe(0);
    expect(normalizeCoverage('engine').length).toBe(0);
    expect(normalizeCoverage([1, null]).length).toBe(0);
  });

  it('answers with an array of its own', () => {
    const source = ['engine'];
    const coverage = normalizeCoverage(source);
    coverage.push('graph');
    expect(source.length).toBe(1);
  });
});

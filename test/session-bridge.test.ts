/**
 * The session client the UI holds, on its Electron wiring.
 *
 * Small, and worth pinning for one reason: this is the layer that decides what
 * a producer can know. An integrity report has an answer — recorded, or
 * refused because the executor was superseded or the record already written —
 * and a client that dropped it on the floor would leave every future caller
 * unable to tell the two apart, however carefully the coordinator distinguishes
 * them. That is exactly what the first version of this did.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { desktopSessionClient } from '../src/renderer/lib/session-bridge.ts';
import { defaultConfiguration } from '../src/audio/configuration.ts';
import { checkedFinding, type Finding } from '../src/integrity/findings.ts';
import type { SessionRecord } from '../src/session/session.ts';

const warning: Finding = checkedFinding({
  id: 'envelope',
  scope: 'graph',
  status: 'warning',
  title: 'Envelope',
  detail: 'shallower than the offline render',
});

/** Only what this module actually touches; the rest of the bridge is Electron's. */
function fakeBridge(): NonNullable<Window['desktop']> {
  return {
    session: {
      subscribe: async () => ({ snapshot: null, revision: 0 }),
      start: async () => null,
      stop: async () => null,
      preview: async () => null,
    },
  } as unknown as NonNullable<Window['desktop']>;
}

const noHistory = async (): Promise<SessionRecord[]> => [];

describe('reporting integrity through the session client', () => {
  it('carries the answer back rather than dropping it', async () => {
    const client = desktopSessionClient(
      fakeBridge(),
      {
        reportConfiguration: () => {},
        reportIntegrity: async () => true,
      },
      noHistory,
    );
    expect(await client.reportIntegrity('s1', [warning])).toBe(true);
  });

  it('carries a refusal back too, which is the half that changes what a caller does', async () => {
    const client = desktopSessionClient(
      fakeBridge(),
      {
        reportConfiguration: () => {},
        reportIntegrity: async () => false,
      },
      noHistory,
    );
    expect(await client.reportIntegrity('s1', [warning])).toBe(false);
  });

  it('reports against the session it names, with the findings it was given', async () => {
    const seen: { sessionId: string; ids: string[] }[] = [];
    const client = desktopSessionClient(
      fakeBridge(),
      {
        reportConfiguration: () => {},
        reportIntegrity: async (sessionId, findings) => {
          seen.push({ sessionId, ids: findings.map((f) => f.id) });
          return true;
        },
      },
      noHistory,
    );

    await client.reportIntegrity('s1', [warning]);
    expect(seen.length).toBe(1);
    expect(seen[0].sessionId).toBe('s1');
    expect(seen[0].ids.join(',')).toBe('envelope');
  });

  it('still reports an edit without waiting for one', () => {
    // The asymmetry is deliberate: an edit is superseded by the next edit, so
    // there is nothing for a caller to do with its outcome.
    const seen: number[] = [];
    const client = desktopSessionClient(
      fakeBridge(),
      {
        reportConfiguration: (configuration) => seen.push(configuration.masterLevel),
        reportIntegrity: async () => true,
      },
      noHistory,
    );
    client.reportConfiguration({ ...defaultConfiguration(), masterLevel: 0.42 });
    expect(seen.join(',')).toBe('0.42');
  });
});

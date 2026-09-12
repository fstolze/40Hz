/**
 * What a failed write is allowed to tell the user.
 *
 * Two rules, and they pull in opposite directions: the category has to survive,
 * because a permission error and a full disk call for different responses; and
 * the path must not, because it names an internal profile directory and a
 * process-numbered temp file that no reader can act on.
 */

import { describe, it, expect } from './helpers/expect.ts';
import { failureReason } from '../src/renderer/lib/errors.ts';

/** The shape Electron's IPC actually delivers, prefix and all. */
const overIpc = (channel: string, cause: string) =>
  new Error(`Error invoking remote method '${channel}': Error: ${cause}`);

const PROFILE = '/var/folders/1j/6whx9xy13nzbwfd5frk7f82c0000gn/T/fortyhz-e2e-aerh5J';

describe('what a failure is allowed to say', () => {
  it('strips the IPC channel, which names nothing the reader can use', () => {
    const said = failureReason(overIpc('history:remove', `EACCES: permission denied, open '/x'`));
    expect(said.includes('invoking remote method')).toBe(false);
    expect(said.includes('history:remove')).toBe(false);
  });

  for (const [code, expected] of [
    ['EACCES', 'Permission was denied'],
    ['EPERM', 'Permission was denied'],
    ['ENOSPC', 'no space left'],
    ['EROFS', 'read-only'],
    ['EBUSY', 'in use'],
  ] as const) {
    it(`names ${code} as something the reader can act on`, () => {
      const said = failureReason(
        overIpc('history:remove', `${code}: whatever libuv said, open '${PROFILE}/history.json'`),
      );
      expect(said.includes(expected)).toBe(true);
      expect(said.includes(code)).toBe(false);
    });
  }

  it('never lets the profile path or a temp filename through', () => {
    /*
     * The whole reason this function grew a table.
     *
     * The message the review saw in production was "That session was not
     * deleted. EACCES: permission denied, open
     * '/var/folders/…/fortyhz-e2e-aerh5J/history.json.13075.tmp'" — the longest
     * part of the sentence, and the part with the least in it for the reader.
     */
    for (const raw of [
      `EACCES: permission denied, open '${PROFILE}/history.json.13075.tmp'`,
      `ENOSPC: no space left on device, write '${PROFILE}/presets.json.2646.tmp'`,
      `EBADTHING: something new, open '${PROFILE}/history.json'`,
    ]) {
      const said = failureReason(overIpc('history:remove', raw));
      expect(said.includes('/var/folders')).toBe(false);
      expect(said.includes('fortyhz-e2e-aerh5J')).toBe(false);
      expect(said.includes('.tmp')).toBe(false);
    }
  });

  it('keeps an unrecognised message rather than inventing a summary', () => {
    // The reasoning the verbatim version was right about: an error nobody
    // anticipated is exactly where a friendly summary would destroy the only
    // description that exists. It keeps the words and loses only the path.
    const said = failureReason(overIpc('history:remove', `EBADTHING: the vault is haunted`));
    expect(said).toBe('EBADTHING: the vault is haunted');
  });

  it('substitutes the quoted path rather than deleting it, so the sentence stands', () => {
    const said = failureReason(new Error(`EWEIRD: could not rewrite '${PROFILE}/history.json'`));
    expect(said).toBe('EWEIRD: could not rewrite the file');
  });

  it('survives something that is not an Error at all', () => {
    expect(failureReason('plain string')).toBe('plain string');
    expect(failureReason(undefined)).toBe('undefined');
  });
});

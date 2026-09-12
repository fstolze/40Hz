/**
 * What went wrong, in terms the reader can act on.
 *
 * Two things have to be stripped, for different reasons.
 *
 * The plumbing: a rejected `invoke` arrives as "Error invoking remote method
 * 'presets:upsert': Error: EACCES…", which opens with the name of an internal
 * channel — the one part of the sentence the reader can do nothing with.
 *
 * The path: Node's filesystem errors end in the file they were opening, and for
 * this app that is the profile directory and a process-numbered temp name —
 * `/var/folders/1j/6whx…/T/fortyhz-e2e-aerh5J/history.json.13075.tmp`. It is
 * the longest part of the message and the least useful; it names an internal
 * location the user has no reason to visit, and it pushes the part that decides
 * what to do next off the end of a modal-width paragraph.
 *
 * An earlier version of this kept the cause verbatim, on the reasoning that a
 * permission error and a full disk call for different responses and a friendly
 * summary would throw that difference away. That reasoning is right and is kept
 * — but it argues for naming the *category*, not for reprinting the raw string.
 * The table below is that distinction: each entry says what happened and what
 * to do, and none of them says where.
 *
 * Shared rather than written twice. The preset dialog and History need the same
 * channel-prefix removal; two copies of a rule about someone else's error format
 * is two copies that drift.
 */

/**
 * The filesystem failures a user can actually respond to.
 *
 * Worded to follow a caller's own sentence — `"…" was not saved. ${this}` — so
 * each is a complete sentence that names the cause and the move. Deliberately
 * generic about *which* file: this serves presets and history both, and the
 * only file either of them writes is the one the action was about.
 */
const CAUSES: Record<string, string> = {
  EACCES: 'Permission was denied writing the file. Check its permissions and try again.',
  EPERM: 'Permission was denied writing the file. Check its permissions and try again.',
  EROFS: 'The storage is read-only, so nothing can be written to it.',
  ENOSPC: 'There is no space left on the disk. Free some space and try again.',
  EDQUOT: 'The disk quota is full. Free some space and try again.',
  EBUSY: 'The file is in use by another program. Try again in a moment.',
  ENOENT: 'The file or the folder holding it is missing.',
  EIO: 'The disk reported a read/write error.',
};

export function failureReason(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '');

  const code = /^([A-Z]{3,12})(?::|,|\s)/.exec(message)?.[1];
  if (code !== undefined && code in CAUSES) return CAUSES[code];

  /*
   * Nothing recognised, so the message is kept — minus anything quoted.
   *
   * Quotes are where Node puts the path, and an unrecognised error is exactly
   * the case where inventing a summary would lose the only description that
   * exists. Substituting rather than deleting, so a sentence built around the
   * path does not lose its object and read as a fragment.
   */
  return message.replace(/'[^']*'/g, 'the file');
}

/**
 * Run asynchronous work one piece at a time, in the order it was submitted.
 *
 * Used wherever interleaving would lose data or invert intent: the audio
 * graph's context transitions, and the store's read-modify-write mutations,
 * where two concurrent saves would otherwise both read the same state and the
 * second would overwrite the first.
 */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Queue `work`, resolving with its result.
   *
   * A failing item must not wedge everything behind it, so the internal chain
   * absorbs rejections while the caller still receives them.
   */
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

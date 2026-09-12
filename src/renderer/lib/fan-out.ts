/**
 * One underlying subscription, many local listeners.
 *
 * The preload keeps a single handler slot per channel on purpose: installing
 * one per call would stack them, and a message would be delivered once for
 * every subscription ever made. But that makes the last subscriber in a window
 * displace the one before it — opening the Settings dialog silently replaced
 * the session panel's settings subscriber, and closing the dialog left the
 * replacement installed, so the panel's advisory and listening total simply
 * stopped updating.
 *
 * So the single slot stays where it is and the fan-out lives here: one
 * registration per channel per window, any number of components watching it.
 *
 * Two properties matter and are easy to lose:
 *
 * - **No gap.** These channels answer with the current value as part of
 *   subscribing, and a late subscriber is handed the most recent value rather
 *   than the one that arrived first — by then that is stale.
 * - **Unsubscription.** Components mount and unmount; a dialog's panel mounts
 *   every time it is opened. A listener that is never removed accumulates and
 *   keeps writing into a component nobody can see.
 */

export type Unsubscribe = () => void;

export function fanOut<T>(
  subscribeOnce: (onChange: (value: T) => void) => Promise<T>,
): (onChange: (value: T) => void) => Unsubscribe {
  const listeners = new Set<(value: T) => void>();
  let started: Promise<T> | null = null;
  // Boxed, so a legitimately null or undefined value is not mistaken for
  // "nothing has arrived yet".
  let latest: { value: T } | null = null;

  return (onChange) => {
    listeners.add(onChange);
    started ??= subscribeOnce((value) => {
      latest = { value };
      // A copy: a listener may unsubscribe while being called, and shortening
      // the set mid-iteration would skip whoever came after it.
      for (const listener of [...listeners]) listener(value);
    });

    if (latest !== null) {
      onChange(latest.value);
    } else {
      void started.then((value) => {
        latest ??= { value };
        // It may have unsubscribed while the first registration was in flight.
        if (listeners.has(onChange)) onChange(latest.value);
      });
    }

    return () => {
      listeners.delete(onChange);
    };
  };
}

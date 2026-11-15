import { fanOut } from './fan-out.ts';

/** One preload subscription even when Settings is repeatedly opened. */
export const subscribeTrayAvailability = fanOut<boolean | null>(async (changed) => {
  const bridge = globalThis.window?.desktop;
  return bridge ? bridge.windows.subscribeTray(changed) : false;
});

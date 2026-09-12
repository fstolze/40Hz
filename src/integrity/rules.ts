/**
 * Observations to findings.
 *
 * **No rules.** That is the finding of this step, arrived at the hard way: of
 * everything the platform will tell us about the output path, nothing supports
 * a conclusion a listener could act on.
 *
 * The last candidate was `maxChannelCount` — warn when the routing needs one
 * tone per ear and the device accepts one channel. It was written, shipped, and
 * then never once fired. Across three platforms it read 2 for a physically mono
 * speakerphone, a deliberately one-channel PipeWire sink, Galaxy Buds in their
 * mono hands-free profile, and finally with Windows' **Mono audio** setting
 * switched on — which combines left and right into one and so destroys a
 * binaural beat outright. If the reading cannot see that, it cannot see
 * anything: it describes what our graph may emit, not what the listener gets.
 *
 * So the channel count joined the other three as a fact in `deviceFacts`, and
 * what is left here is the copy for scopes nothing has reported on. The
 * conclusion this leaves is uncomfortable and correct: **channels summed below
 * the app are undetectable from Web Audio**, and the only mechanism reachable
 * from this stack that could ever catch it is 4C's Windows loopback, measuring
 * the system mix directly. Native code has more routes, and none of them are
 * open from here.
 */

import { SCOPES, uncheckedFinding, type Finding, type Scope } from './findings.ts';

/**
 * What to do so a binaural pair survives, in the words the user needs.
 *
 * Unconditional guidance now, rather than the remedy on a warning: nothing can
 * detect when it is needed, so it is said wherever the routing is chosen and
 * left to the listener. Kept here, beside the copy for the scopes that cannot
 * check it, so the app says one thing about this in one voice.
 */
export const STEREO_REMEDY =
  'Use wired stereo headphones, and turn off any spatial or “enhanced” audio processing.';

/** Why a scope has nothing to show, one reason each. */
const NOTHING_REPORTED: Record<Scope, { title: string; detail: string }> = {
  engine: {
    title: 'Engine not checked',
    detail:
      'The offline self-test has not run in this window yet. It needs no audio device and no playback, so this state should not last.',
  },
  graph: {
    title: 'App output not measured',
    detail:
      'Nothing has measured what this app produces. The capture taps and the metrics exist and are proved offline, but nothing drives them during playback yet, so no window of real output has been examined. The output device’s channel count is reported as a fact below; it is not a measurement of the audio.',
  },
  systemMix: {
    title: 'System mix not checked',
    detail:
      'Reading back what the operating system mixed needs loopback capture. This app is built on Electron, which offers it on Windows only, and this build does not do it yet — the systems themselves have their own routes to it, but nothing here can reach them. It is also the only thing that could ever notice the system combining the channels below this app.',
  },
  delivery: {
    title: 'Delivery not checked, on any platform',
    detail:
      'Nothing here observes the converter, the headphones, or the air — not even loopback, which stops at the operating system’s mix. Bluetooth transport, spatial processing and device enhancements all live past this point, so the guidance beside the routing control is the protection that remains.',
  },
};

/**
 * A finding for every scope nothing has reported on.
 *
 * The load-bearing half of the whole subsystem: a scope that produces no
 * finding at all looks exactly like one that passed. `overallStatus` treats an
 * uncovered scope as `unknown` structurally, but the panel cannot say *why*
 * unless someone says why — and the why differs. One has no API on this
 * platform, one has none on any platform, and one is simply not wired up yet.
 *
 * None of them is a fault, and the copy has to make that plain: a permanent
 * amber warning about a scope nobody could ever check teaches the user to
 * ignore the surface that exists to be believed.
 */
export function missingScopeFindings(reported: readonly Finding[]): Finding[] {
  const spokenFor = new Set<Scope>(reported.map((finding) => finding.scope));
  return SCOPES.filter((scope) => !spokenFor.has(scope)).map((scope) =>
    uncheckedFinding({ id: `${scope}-unreported`, scope, ...NOTHING_REPORTED[scope] }),
  );
}

/**
 * Making an imported bed loop without a seam.
 *
 * `noise.ts` chose procedural synthesis partly to avoid this problem: noise
 * generated in the audio thread is infinite by construction, with no loop
 * point to hide. A user-supplied file brings the seam back, because
 * `AudioBufferSourceNode` with `loop = true` splices the end to the start and
 * any discontinuity there is a click, once per loop, for the length of a
 * session.
 *
 * The source specification's answer was two buffers crossfaded at playback
 * time. This is cheaper and it is verifiable offline: fold a crossfade into
 * the buffer once, at import, and the loop is seamless for every play
 * afterwards with no runtime machinery at all.
 *
 * Written in erasable TypeScript only, so it runs under Node's native type
 * stripping without a build.
 */

/**
 * How much of the tail is folded over the head, by default.
 *
 * Long enough to hide a discontinuity at any frequency the bed carries, short
 * enough that the loop point does not audibly repeat material. A bed shorter
 * than twice this gets a proportionally shorter fade rather than a refusal.
 */
export const DEFAULT_CROSSFADE_SECONDS = 0.05;

/**
 * The result of folding the seam, plus what it cost.
 *
 * `frames` shrinks: the tail is consumed by the fold rather than kept, so the
 * looping region is the original minus the crossfade.
 */
export interface SeamlessBed {
  channels: Float32Array[];
  frames: number;
  crossfadeFrames: number;
}

/**
 * Equal-power crossfade gains at position `t` in [0, 1].
 *
 * Equal power, not linear, because the tail and the head of a recording are
 * *uncorrelated* — they are different moments of different material. Summing
 * two uncorrelated signals adds power, not amplitude, so cos/sin keeps the
 * perceived level constant across the fold where a linear pair would dip.
 *
 * Note that this is the opposite of the right choice for crossfading two
 * filter chains carrying the *same* signal, where the correlated sum needs
 * gains that add to one. Same operation, different statistics, different
 * answer.
 */
function equalPower(t: number): { out: number; in: number } {
  return { out: Math.cos((t * Math.PI) / 2), in: Math.sin((t * Math.PI) / 2) };
}

/**
 * Fold the tail of `channels` over its head so the loop point is continuous.
 *
 * Returns new buffers; the input is not modified. The caller normalises
 * *after* this, never before — an equal-power overlap of two same-polarity
 * samples near unity reaches √2, so normalising first would be undone here.
 */
export function makeSeamless(
  channels: readonly Float32Array[],
  sampleRate: number,
  crossfadeSeconds: number = DEFAULT_CROSSFADE_SECONDS,
): SeamlessBed {
  const sourceFrames = channels.length === 0 ? 0 : channels[0].length;

  // A fade cannot consume more than half the material, or the head it folds
  // onto would itself be part of the tail.
  const wanted = Math.floor(Math.max(0, crossfadeSeconds) * sampleRate);
  const crossfadeFrames = Math.max(0, Math.min(wanted, Math.floor(sourceFrames / 2)));
  const frames = sourceFrames - crossfadeFrames;

  if (crossfadeFrames === 0 || frames <= 0) {
    // Nothing to fold — too short to have a seam worth hiding. Copy anyway, so
    // the caller always owns its buffers and never aliases the decoded audio.
    return {
      channels: channels.map((c) => c.slice(0, Math.max(0, frames))),
      frames: Math.max(0, frames),
      crossfadeFrames: 0,
    };
  }

  const out = channels.map((channel) => {
    const kept = channel.slice(0, frames);
    for (let i = 0; i < crossfadeFrames; i++) {
      // The direction is the whole trick, and getting it backwards makes the
      // seam worse rather than better.
      //
      // The new head *begins* as the tail and fades into the original head. So
      // the last frame played before the loop point is original[frames - 1],
      // and the first frame after it is original[frames] — adjacent samples in
      // the source, hence continuous. Starting from the original head instead
      // would leave the splice exactly where it was.
      const gains = equalPower(i / crossfadeFrames);
      kept[i] = channel[frames + i] * gains.out + kept[i] * gains.in;
    }
    return kept;
  });

  return { channels: out, frames, crossfadeFrames };
}

/**
 * The largest jump between the last frame and the first, across all channels.
 *
 * What a listener hears at the seam is this discontinuity, so it is what the
 * tests assert on rather than the shape of the fade. Compared against the
 * material's own typical step so that a quiet bed is not judged by an absolute
 * figure that a loud one would fail.
 */
export function seamDiscontinuity(channels: readonly Float32Array[], frames: number): number {
  let worst = 0;
  for (const channel of channels) {
    if (frames < 2) continue;
    const first = channel[0];
    const last = channel[frames - 1];
    // NaN rather than zero, and the distinction is the whole point. Every
    // comparison with NaN is false, so `jump > worst` simply skips a broken
    // sample and the function returns 0 — a *perfect* seam, reported for audio
    // that could not be measured at all. Refusing to answer is the honest
    // result; guarding the comparison alone would not have changed anything.
    if (!Number.isFinite(first) || !Number.isFinite(last)) return Number.NaN;
    const jump = Math.abs(first - last);
    if (jump > worst) worst = jump;
  }
  return worst;
}

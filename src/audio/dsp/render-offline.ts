/**
 * Offline rendering of the entrainment core.
 *
 * Used by the test suite and by the in-app Layer 1 self-test. Rendering in
 * chunks mirrors the AudioWorklet's 128-frame render quantum: at 48 kHz the
 * modulation period is 1200 samples and 1200 / 128 = 9.375, so period
 * boundaries fall mid-block. Chunked and single-shot renders must agree.
 */

import {
  render,
  createState,
  type EntrainmentParams,
  type EngineState,
} from './entrainment-core.ts';

export interface OfflineRender {
  left: Float64Array;
  right: Float64Array;
  sampleRate: number;
  state: EngineState;
}

export function renderOffline(
  params: EntrainmentParams,
  sampleRate: number,
  frames: number,
  chunkFrames = 0,
  state: EngineState = createState(),
): OfflineRender {
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const chunk = chunkFrames > 0 ? chunkFrames : frames;

  const lBuf = new Float32Array(chunk);
  const rBuf = new Float32Array(chunk);

  let done = 0;
  while (done < frames) {
    const n = Math.min(chunk, frames - done);
    render(params, state, sampleRate, lBuf, rBuf, n);
    for (let i = 0; i < n; i++) {
      left[done + i] = lBuf[i];
      right[done + i] = rBuf[i];
    }
    done += n;
  }

  return { left, right, sampleRate, state };
}

/** Frames in `seconds` at `sampleRate`, rounded to the nearest whole sample. */
export function secondsToFrames(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate);
}

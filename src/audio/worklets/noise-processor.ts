/**
 * AudioWorkletProcessor for the procedural soundscape bed.
 *
 * Independent left/right generators, so the bed is decorrelated and reads as
 * a wide ambience rather than a centred mono block.
 */

import { createNoise, type NoiseColor, type NoiseGenerator } from '../dsp/noise.ts';

export interface NoiseMessage {
  type: 'color' | 'stop';
  color?: NoiseColor;
}

/** Seeded at construction, for the same reason as the entrainment processor. */
export interface NoiseProcessorOptions {
  processorOptions?: { color?: NoiseColor };
}

class NoiseProcessor extends AudioWorkletProcessor {
  private left: NoiseGenerator = createNoise('pink', 1);
  private right: NoiseGenerator = createNoise('pink', 2);
  private color: NoiseColor = 'pink';
  private running = true;

  constructor(options?: NoiseProcessorOptions) {
    super();

    const initial = options?.processorOptions?.color;
    if (initial) this.setColor(initial);

    this.port.onmessage = (event: MessageEvent<NoiseMessage>) => {
      const msg = event.data;
      if (msg.type === 'stop') {
        this.running = false;
        return;
      }
      if (msg.color) this.setColor(msg.color);
    };
  }

  private setColor(color: NoiseColor): void {
    // Idempotent, and that is not a nicety.
    //
    // The generators are seeded from fixed constants, so rebuilding them
    // restarts the noise from its first sample. Anything that re-sends the
    // current colour therefore makes the bed stutter — and the graph sends it
    // on every configuration change, including ones that touch nothing here.
    // Dragging an entrainment slider replayed the same opening samples about
    // thirty times a second, which is audible as a bouncing or fluttering bed.
    if (color === this.color) return;
    this.color = color;
    // Distinct seeds keep the two channels decorrelated.
    this.left = createNoise(color, 1);
    this.right = createNoise(color, 2);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length < 2) return this.running;
    this.left.fill(output[0]);
    this.right.fill(output[1]);
    return this.running;
  }
}

registerProcessor('noise-processor', NoiseProcessor);

/** Ambient declarations for the AudioWorkletGlobalScope. */

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

// `...args: never[]` so processors may declare their own processorOptions
// shape without the constructor becoming unassignable here.
declare function registerProcessor(
  name: string,
  ctor: new (...args: never[]) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;
declare const currentTime: number;
declare const currentFrame: number;

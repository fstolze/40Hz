/**
 * Minimal expect(...) shim over node:test.
 *
 * The DSP core has no runtime dependencies, and its verification harness has
 * none either — Node 24 runs TypeScript directly and ships a test runner, so
 * `npm install` is not a prerequisite for proving the engine correct. The
 * matcher subset mirrors vitest's semantics, so swapping this import for
 * 'vitest' once a full toolchain is in place requires no other change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

export { describe, it };

export interface Matchers {
  toBe(expected: unknown): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
}

function fail(message: string): never {
  assert.fail(message);
}

export function expect(actual: unknown): Matchers {
  return {
    toBe(expected: unknown): void {
      if (!Object.is(actual, expected)) {
        fail(`expected ${String(actual)} to be ${String(expected)}`);
      }
    },

    toBeCloseTo(expected: number, digits = 2): void {
      const a = actual as number;
      // vitest semantics: pass when |actual - expected| < 10^-digits / 2
      const tolerance = Math.pow(10, -digits) / 2;
      const diff = Math.abs(a - expected);
      if (!(diff < tolerance)) {
        fail(
          `expected ${a} to be close to ${expected} ` +
            `(difference ${diff.toExponential(3)}, tolerance ${tolerance.toExponential(3)})`,
        );
      }
    },

    toBeGreaterThan(expected: number): void {
      const a = actual as number;
      if (!(a > expected)) fail(`expected ${a} to be greater than ${expected}`);
    },

    toBeGreaterThanOrEqual(expected: number): void {
      const a = actual as number;
      if (!(a >= expected)) fail(`expected ${a} to be >= ${expected}`);
    },

    toBeLessThan(expected: number): void {
      const a = actual as number;
      if (!(a < expected)) fail(`expected ${a} to be less than ${expected}`);
    },

    toBeLessThanOrEqual(expected: number): void {
      const a = actual as number;
      if (!(a <= expected)) fail(`expected ${a} to be <= ${expected}`);
    },
  };
}

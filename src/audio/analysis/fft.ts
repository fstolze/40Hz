/**
 * Minimal radix-2 FFT and exact-frequency DFT probes.
 *
 * Used by the verification harness (Layer 1 of the signal integrity
 * subsystem) to prove that the synthesised waveform carries a 40 Hz amplitude
 * envelope at the commanded depth, independent of any audio hardware.
 */

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function prevPowerOfTwo(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/** In-place iterative Cooley-Tukey FFT. `re` and `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (!isPowerOfTwo(n)) throw new Error(`fft: length ${n} is not a power of two`);
  if (im.length !== n) throw new Error('fft: re and im must be the same length');

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** In-place inverse FFT, via conjugation. */
export function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

/** Hann window of length n, applied to a copy of `signal`. */
export function hann(signal: Float64Array): Float64Array {
  const n = signal.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = signal[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return out;
}

/**
 * Amplitude of `signal` at exactly `freq`, by direct correlation.
 *
 * Exact and leakage-free when `freq * signal.length / sampleRate` is an
 * integer, i.e. when the analysis window holds a whole number of cycles.
 * Preferred over a windowed FFT peak when comparing sideband amplitude
 * ratios, because it has no scalloping loss.
 */
export function amplitudeAt(signal: Float64Array, sampleRate: number, freq: number): number {
  const n = signal.length;
  const w = (2 * Math.PI * freq) / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    re += signal[i] * Math.cos(w * i);
    im -= signal[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(re, im)) / n;
}

/**
 * Dominant frequency of `signal`, in Hz.
 *
 * Mean-removed, Hann-windowed, with quadratic interpolation of the log
 * magnitude around the peak bin for sub-bin resolution.
 */
export function dominantFrequency(signal: Float64Array, sampleRate: number, minHz = 1): number {
  const n = prevPowerOfTwo(signal.length);
  const slice = signal.subarray(0, n);

  let mean = 0;
  for (let i = 0; i < n; i++) mean += slice[i];
  mean /= n;

  const centred = new Float64Array(n);
  for (let i = 0; i < n; i++) centred[i] = slice[i] - mean;

  const re = hann(centred);
  const im = new Float64Array(n);
  fft(re, im);

  const minBin = Math.max(1, Math.ceil((minHz * n) / sampleRate));
  let peak = minBin;
  let peakMag = -Infinity;
  for (let k = minBin; k < n / 2; k++) {
    const mag = re[k] * re[k] + im[k] * im[k];
    if (mag > peakMag) {
      peakMag = mag;
      peak = k;
    }
  }

  const db = (k: number) => 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-300);
  let delta = 0;
  if (peak > 0 && peak < n / 2 - 1) {
    const a = db(peak - 1);
    const b = db(peak);
    const c = db(peak + 1);
    const denom = a - 2 * b + c;
    if (denom !== 0) delta = (0.5 * (a - c)) / denom;
    if (!Number.isFinite(delta) || Math.abs(delta) > 1) delta = 0;
  }

  return ((peak + delta) * sampleRate) / n;
}

/**
 * Power spectral slope of `signal` in dB per decade, fitted over [loHz, hiHz].
 *
 * Pink noise should return about -10 dB/decade (-3 dB/octave); brown noise
 * about -20 dB/decade (-6 dB/octave).
 */
export function spectralSlope(
  signal: Float64Array,
  sampleRate: number,
  loHz: number,
  hiHz: number,
): number {
  const n = prevPowerOfTwo(signal.length);
  const re = hann(signal.subarray(0, n));
  const im = new Float64Array(n);
  fft(re, im);

  const loBin = Math.max(1, Math.floor((loHz * n) / sampleRate));
  const hiBin = Math.min(n / 2 - 1, Math.ceil((hiHz * n) / sampleRate));

  // Average power into log-spaced buckets so the fit is not dominated by the
  // high-frequency bins, which vastly outnumber the low ones.
  const buckets = 40;
  const logLo = Math.log10(loBin);
  const logHi = Math.log10(hiBin);
  const sum = new Float64Array(buckets);
  const count = new Int32Array(buckets);

  for (let k = loBin; k <= hiBin; k++) {
    const idx = Math.min(
      buckets - 1,
      Math.floor(((Math.log10(k) - logLo) / (logHi - logLo)) * buckets),
    );
    sum[idx] += re[k] * re[k] + im[k] * im[k];
    count[idx]++;
  }

  const xs: number[] = [];
  const ys: number[] = [];
  for (let b = 0; b < buckets; b++) {
    if (count[b] === 0) continue;
    const centreBin = Math.pow(10, logLo + ((b + 0.5) / buckets) * (logHi - logLo));
    xs.push(Math.log10((centreBin * sampleRate) / n));
    ys.push(10 * Math.log10(sum[b] / count[b]));
  }

  // Least-squares fit of dB against log10(Hz).
  const m = xs.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < m; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  return (m * sxy - sx * sy) / (m * sxx - sx * sx);
}

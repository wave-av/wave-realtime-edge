/**
 * fft.ts — a small radix-2 FFT + magnitude spectrum for the audio signal plane's LIVE tap
 * (wave-audio-signal-plane E1). Pure, dependency-free (no external DSP lib on the edge).
 * Grounded in: Fourier (1822, the transform) + Cooley–Tukey (1965, the FFT algorithm).
 */

/**
 * In-place radix-2 Cooley–Tukey FFT. `re`/`im` must be the same power-of-2 length. Reorders + transforms
 * in place. This is the O(n log n) workhorse — no allocations in the hot path beyond the caller's arrays.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]!;
        const uIm = im[i + j]!;
        const x = i + j + half;
        const vRe = re[x]! * curRe - im[x]! * curIm;
        const vIm = re[x]! * curIm + im[x]! * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[x] = uRe - vRe;
        im[x] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

/**
 * Compute the LOG-magnitude spectrum of a 16-bit-LE PCM buffer (48 kHz stereo), downmixed to mono.
 * Returns `bins` log-magnitude values (the first bins/2 FFT bins) in dB-ish scale for display. This is the
 * Fourier truth the audio.wave.online dashboard renders — the same tap that makes the echo a visible band.
 */
export function spectrumLogMagnitude(pcm: Uint8Array, bins = 64): number[] {
  const n = bins * 2; // power-of-two FFT length
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const samples = Math.floor(pcm.length / 4); // 4 bytes per stereo sample frame (2ch × 2 bytes)
  const stride = Math.max(1, Math.floor(samples / n));
  for (let i = 0; i < n; i++) {
    const off = Math.min(i * stride, samples - 1) * 4; // first channel (L), 16-bit LE
    const lo = pcm[off]!;
    const hi = pcm[off + 1]!;
    const s = (hi << 8) | lo; // signed 16-bit
    const v = (s >= 0x8000 ? s - 0x10000 : s) / 32768;
    re[i] = v;
    im[i] = 0;
  }
  fft(re, im);
  const out = new Array<number>(bins);
  for (let k = 0; k < bins; k++) {
    const mag = Math.hypot(re[k]!, im[k]!);
    out[k] = Math.round(20 * Math.log10(mag + 1e-12) + 96); // shift into a positive display range
  }
  return out;
}

/** In-place inverse FFT (conjugate → FFT → conjugate → scale). `re`/`im` same power-of-2 length. */
export function inverseFft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i]!;
  fft(re, im);
  for (let i = 0; i < n; i++) {
    im[i] = -im[i]! / n;
    re[i] = re[i]! / n;
  }
}

/**
 * Hilbert transform of a real signal (the imaginary part of the analytic signal): zero the negative-frequency
 * half of the spectrum, then inverse-FFT. Grounded in Hilbert — the analytic signal / instantaneous phase.
 * Returns the same-length imaginary part (the Hilbert transform), the real part unchanged in `re`.
 */
export function hilbert(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  fft(re, im);
  const half = n >> 1;
  for (let k = 1; k < half; k++) im[k] = 0; // zero the negative half (the analytic signal keeps the positive)
  for (let k = half + 1; k < n; k++) im[k] = 0;
  inverseFft(re, im);
}

/**
 * Fundamental-frequency (pitch) estimate via the real cepstrum: IFFT of the log-magnitude spectrum; the pitch
 * is the quefrency of the peak in the plausible pitch band (50–1000 Hz). Grounded in Bogert–Healy–Tukey 1963.
 * Returns 0 when no confident peak (unvoiced / silence).
 */
export function cepstrumPitch(pcm: Uint8Array, sampleRate = 48000): number {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const samples = Math.floor(pcm.length / 4);
  const stride = Math.max(1, Math.floor(samples / n));
  for (let i = 0; i < n; i++) {
    const off = Math.min(i * stride, samples - 1) * 4;
    const lo = pcm[off]!;
    const hi = pcm[off + 1]!;
    const s = (hi << 8) | lo;
    re[i] = (s >= 0x8000 ? s - 0x10000 : s) / 32768;
    im[i] = 0;
  }
  fft(re, im);
  // real cepstrum = IFFT(log |X|)
  for (let k = 0; k < n; k++) re[k] = Math.log(Math.hypot(re[k]!, im[k]!) + 1e-12);
  im.fill(0);
  inverseFft(re, im);
  // scan the quefrency band for 50–1000 Hz
  const loQ = Math.floor(sampleRate / 1000); // 1000 Hz → quefrency loQ
  const hiQ = Math.floor(sampleRate / 50);   // 50 Hz  → quefrency hiQ
  let bestQ = -1;
  let bestV = -Infinity;
  for (let q = loQ; q < hiQ && q < n; q++) {
    if (re[q]! > bestV) {
      bestV = re[q]!;
      bestQ = q;
    }
  }
  if (bestQ <= 0 || bestV < 0.3) return 0; // no confident peak
  return Math.round(sampleRate / bestQ);
}

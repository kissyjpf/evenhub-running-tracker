// Signal processing: bandpass IIR filter + autocorrelation cadence estimation

export interface BiquadCoeffs {
  b0: number; b1: number; b2: number
  a1: number; a2: number  // a0 normalized to 1
}

export interface BiquadState {
  w1: number; w2: number
}

export function newBiquadState(): BiquadState { return { w1: 0, w2: 0 } }

// Butterworth 2nd-order low-pass (bilinear transform with pre-warping)
export function butterLP2(fc: number, fs: number): BiquadCoeffs {
  const k = Math.tan(Math.PI * fc / fs)
  const k2 = k * k
  const norm = 1 / (1 + k * Math.SQRT2 + k2)
  return {
    b0: k2 * norm,
    b1: 2 * k2 * norm,
    b2: k2 * norm,
    a1: 2 * (k2 - 1) * norm,
    a2: (1 - k * Math.SQRT2 + k2) * norm,
  }
}

// Butterworth 2nd-order high-pass (bilinear transform with pre-warping)
export function butterHP2(fc: number, fs: number): BiquadCoeffs {
  const k = Math.tan(Math.PI * fc / fs)
  const k2 = k * k
  const norm = 1 / (1 + k * Math.SQRT2 + k2)
  return {
    b0: norm,
    b1: -2 * norm,
    b2: norm,
    a1: 2 * (k2 - 1) * norm,
    a2: (1 - k * Math.SQRT2 + k2) * norm,
  }
}

// Transposed direct form II biquad — numerically stable
export function processBiquad(x: number, c: BiquadCoeffs, s: BiquadState): number {
  const y = c.b0 * x + s.w1
  s.w1 = c.b1 * x - c.a1 * y + s.w2
  s.w2 = c.b2 * x - c.a2 * y
  return y
}

export interface BandpassFilter {
  hp: BiquadCoeffs; hpState: BiquadState
  lp: BiquadCoeffs; lpState: BiquadState
}

export function createBandpass(fLow: number, fHigh: number, fs: number): BandpassFilter {
  return {
    hp: butterHP2(fLow, fs), hpState: newBiquadState(),
    lp: butterLP2(fHigh, fs), lpState: newBiquadState(),
  }
}

export function processBandpass(x: number, f: BandpassFilter): number {
  return processBiquad(processBiquad(x, f.hp, f.hpState), f.lp, f.lpState)
}

// Autocorrelation-based cadence estimation.
// Returns spm in [50, 200], or null if signal is too weak or not periodic.
// Optimized: O(n * lagRange) where lagRange is typically small.
export function estimateCadence(samples: number[], fs: number): number | null {
  const n = samples.length
  const minSamples = Math.ceil(fs * 2)
  if (n < minSamples) return null

  // Compute mean and variance for normalization
  let mean = 0
  for (let i = 0; i < n; i++) mean += samples[i] ?? 0
  mean /= n

  const x = new Float64Array(n)
  let variance = 0
  for (let i = 0; i < n; i++) {
    x[i] = (samples[i] ?? 0) - mean
    variance += x[i] ** 2
  }
  variance /= n

  // Require meaningful signal amplitude (~0.22 m/s² RMS minimum)
  if (variance < 0.05) return null

  // Lag range: 50–200 spm (covers walking and running)
  const lagMin = Math.max(1, Math.floor((fs * 60) / 200))
  const lagMax = Math.min(n - 1, Math.floor((fs * 60) / 50))
  if (lagMin >= lagMax) return null

  let bestLag = lagMin
  let bestAcf = -Infinity

  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acf = 0
    const count = n - lag
    for (let i = 0; i < count; i++) {
      acf += (x[i] ?? 0) * (x[i + lag] ?? 0)
    }
    acf /= count
    if (acf > bestAcf) { bestAcf = acf; bestLag = lag }
  }

  // Require at least 15% normalized correlation — rejects aperiodic noise
  if (bestAcf / variance < 0.15) return null

  const cadence = (fs * 60) / bestLag
  return Math.max(50, Math.min(200, cadence))
}

// RMS amplitude of a buffer
export function rmsAmplitude(buf: number[]): number {
  if (buf.length === 0) return 0
  return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)
}

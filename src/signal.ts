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

  // Require meaningful signal amplitude (~0.03 G RMS minimum for walking)
  if (variance < 0.001) return null

  // Lag range: 50–200 spm (covers walking and running)
  const lagMin = Math.max(1, Math.floor((fs * 60) / 200))
  const lagMax = Math.min(n - 1, Math.floor((fs * 60) / 50))
  if (lagMin >= lagMax) return null

  const acf = new Float64Array(lagMax + 1)
  let bestLag = lagMin
  let bestAcf = -Infinity

  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0
    const count = n - lag
    for (let i = 0; i < count; i++) {
      sum += (x[i] ?? 0) * (x[i + lag] ?? 0)
    }
    sum /= count
    acf[lag] = sum
    if (sum > bestAcf) { bestAcf = sum; bestLag = lag }
  }

  // Check for half-lag peak (to avoid halving cadence due to asymmetric walking)
  const halfLag = Math.round(bestLag / 2)
  if (halfLag >= lagMin) {
    let localMaxLag = halfLag
    let localMaxAcf = -Infinity
    const searchRange = Math.max(1, Math.floor(halfLag * 0.2)) // ±20%
    for (let lag = halfLag - searchRange; lag <= halfLag + searchRange; lag++) {
      if (lag >= lagMin && lag <= lagMax) {
        if (acf[lag] > localMaxAcf) {
          localMaxAcf = acf[lag]
          localMaxLag = lag
        }
      }
    }
    // If half-lag peak is prominent, use it (step freq instead of stride freq)
    if (localMaxAcf > bestAcf * 0.35) {
      const isLocalPeak = localMaxLag === lagMin || localMaxLag === lagMax || 
                          (acf[localMaxLag] >= acf[localMaxLag - 1] && acf[localMaxLag] >= acf[localMaxLag + 1])
      if (isLocalPeak) {
        bestLag = localMaxLag
        bestAcf = localMaxAcf
      }
    }
  }

  // Require at least 8% normalized correlation — rejects aperiodic noise
  if (bestAcf / variance < 0.08) return null

  // Parabolic interpolation around the peak for sub-sample lag resolution.
  // Without this, integer-lag quantisation makes cadence jump ~8–11 spm at a
  // time (worse at high spm / low sample rate), giving a jittery reading.
  let refinedLag = bestLag
  if (bestLag > lagMin && bestLag < lagMax) {
    const ym1 = acf[bestLag - 1] ?? 0
    const y0  = acf[bestLag] ?? 0
    const yp1 = acf[bestLag + 1] ?? 0
    const denom = ym1 - 2 * y0 + yp1
    if (denom !== 0) {
      const delta = 0.5 * (ym1 - yp1) / denom
      if (delta > -1 && delta < 1) refinedLag = bestLag + delta
    }
  }

  const cadence = (fs * 60) / refinedLag
  return Math.max(50, Math.min(200, cadence))
}

// RMS amplitude of a buffer
export function rmsAmplitude(buf: number[]): number {
  if (buf.length === 0) return 0
  return Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length)
}

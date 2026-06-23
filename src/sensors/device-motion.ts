// DeviceMotion sensor (priority A: iPhone 腰装着想定).
// Uses acceleration (gravity-removed) when available;
// falls back to gravity-projected z from accelerationIncludingGravity.
// Requires user-tap-initiated permission call on iOS 13+.

import { createBandpass, processBandpass, estimateCadence, rmsAmplitude, BandpassFilter } from '../signal'

const F_LOW      = 0.5        // bandpass low cutoff (Hz)
const F_HIGH     = 4.5        // bandpass high cutoff (Hz)
const FS_INIT    = 60         // initial sample-rate guess (iOS default ≈60Hz)
const FS_MIN     = 10         // clamp for measured sample rate
const FS_MAX     = 120
const WINDOW_S   = 5          // sliding window for autocorrelation (seconds)
const UPDATE_MS  = 1000       // cadence update interval

export type CadenceCallback = (spm: number | null, vertAmp: number) => void

// Gravity EMA for fallback projection from accelerationIncludingGravity
const GRAVITY_ALPHA = 0.98

export class DeviceMotionSensor {
  private filter: BandpassFilter
  private filterFs = FS_INIT
  private buf: number[] = []
  private lastUpdateMs = 0
  private lastSampleMs = 0      // perf timestamp of previous motion event
  private fsEma = FS_INIT       // measured sample rate (EMA)
  private fsInit = false
  private gravEma = { x: 0, y: 0, z: -9.81 }  // earth gravity estimate
  private gravInit = false
  private callback: CadenceCallback | null = null

  public cadenceSpm: number | null = null
  public verticalAmp = 0
  public available = false

  constructor() {
    this.filter = createBandpass(F_LOW, F_HIGH, FS_INIT)
  }

  /** Must be called from a user gesture on iOS 13+. Returns true if granted. */
  async requestPermission(): Promise<boolean> {
    if (!window.DeviceMotionEvent) return false
    const Ev = window.DeviceMotionEvent as typeof DeviceMotionEvent & {
      requestPermission?: () => Promise<PermissionState>
    }
    if (typeof Ev.requestPermission === 'function') {
      try {
        const state = await Ev.requestPermission()
        return state === 'granted'
      } catch {
        return false
      }
    }
    return true  // Non-iOS: permission not required
  }

  start(cb: CadenceCallback): void {
    this.callback = cb
    window.addEventListener('devicemotion', this.onMotion, { passive: true })
    this.available = true
  }

  private onMotion = (e: DeviceMotionEvent): void => {
    let vertical: number | null = null

    const a = e.acceleration
    const ag = e.accelerationIncludingGravity

    if (a && a.z !== null) {
      // Gravity already removed by OS
      vertical = a.z
    } else if (ag && ag.z !== null && ag.x !== null && ag.y !== null) {
      // Estimate gravity via slow EMA, then subtract
      if (!this.gravInit) {
        this.gravEma = { x: ag.x, y: ag.y, z: ag.z }
        this.gravInit = true
      } else {
        this.gravEma.x = GRAVITY_ALPHA * this.gravEma.x + (1 - GRAVITY_ALPHA) * ag.x
        this.gravEma.y = GRAVITY_ALPHA * this.gravEma.y + (1 - GRAVITY_ALPHA) * ag.y
        this.gravEma.z = GRAVITY_ALPHA * this.gravEma.z + (1 - GRAVITY_ALPHA) * ag.z
      }
      vertical = ag.z - this.gravEma.z
    }

    if (vertical === null) return

    // Measure the real sample rate — iOS does not guarantee 60Hz, and a wrong
    // fs scales the cadence directly (e.g. half-rate reads as double cadence).
    const tNow = performance.now()
    if (this.lastSampleMs > 0) {
      const dt = tNow - this.lastSampleMs
      if (dt > 0 && dt < 200) {  // ignore startup gaps / backgrounding
        const inst = 1000 / dt
        this.fsEma = this.fsInit ? 0.95 * this.fsEma + 0.05 * inst : inst
        this.fsInit = true
      }
    }
    this.lastSampleMs = tNow
    const fs = Math.max(FS_MIN, Math.min(FS_MAX, this.fsEma))

    // Re-tune the bandpass if the measured rate drifts >10% from what it was
    // built for (its cutoffs are fs-dependent). Converges within a second.
    if (Math.abs(fs - this.filterFs) / this.filterFs > 0.1) {
      this.filter = createBandpass(F_LOW, F_HIGH, fs)
      this.filterFs = fs
    }

    // Gyroscope fusion: rotation rate (deg/s) norm scaled to roughly match accel magnitude
    const r = e.rotationRate
    let gyroNorm = 0
    if (r && r.alpha !== null && r.beta !== null && r.gamma !== null) {
      const mag = Math.sqrt(r.alpha * r.alpha + r.beta * r.beta + r.gamma * r.gamma)
      gyroNorm = mag * 0.02
    }

    const compositeRaw = vertical + gyroNorm
    const filtered = processBandpass(compositeRaw, this.filter)
    this.buf.push(filtered)

    const maxBuf = Math.ceil(fs * WINDOW_S)
    if (this.buf.length > maxBuf) this.buf.splice(0, this.buf.length - maxBuf)

    const now = Date.now()
    if (now - this.lastUpdateMs >= UPDATE_MS && this.buf.length >= fs * 2) {
      this.lastUpdateMs = now
      const spm = estimateCadence(this.buf, fs)
      const amp = rmsAmplitude(this.buf)
      this.cadenceSpm = spm
      this.verticalAmp = amp
      this.callback?.(spm, amp)
    }
  }

  stop(): void {
    window.removeEventListener('devicemotion', this.onMotion)
    this.available = false
  }
}

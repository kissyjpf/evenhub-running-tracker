// DeviceMotion sensor (priority A: iPhone 腰装着想定).
// Uses acceleration (gravity-removed) when available;
// falls back to gravity-projected z from accelerationIncludingGravity.
// Requires user-tap-initiated permission call on iOS 13+.

import { createBandpass, processBandpass, estimateCadence, rmsAmplitude, BandpassFilter } from '../signal'

const FS_NOMINAL = 60         // nominal sample rate (actual varies, iOS ≤60Hz)
const WINDOW_S   = 5          // sliding window for autocorrelation
const UPDATE_MS  = 1000       // cadence update interval

export type CadenceCallback = (spm: number | null, vertAmp: number) => void

// Gravity EMA for fallback projection from accelerationIncludingGravity
const GRAVITY_ALPHA = 0.98

export class DeviceMotionSensor {
  private filter: BandpassFilter
  private buf: number[] = []
  private lastUpdateMs = 0
  private gravEma = { x: 0, y: 0, z: -9.81 }  // earth gravity estimate
  private gravInit = false
  private callback: CadenceCallback | null = null

  public cadenceSpm: number | null = null
  public verticalAmp = 0
  public available = false

  constructor() {
    this.filter = createBandpass(1.0, 4.5, FS_NOMINAL)
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

    const filtered = processBandpass(vertical, this.filter)
    this.buf.push(filtered)

    const maxBuf = Math.ceil(FS_NOMINAL * WINDOW_S)
    if (this.buf.length > maxBuf) this.buf.splice(0, this.buf.length - maxBuf)

    const now = Date.now()
    if (now - this.lastUpdateMs >= UPDATE_MS && this.buf.length >= FS_NOMINAL * 2) {
      this.lastUpdateMs = now
      const spm = estimateCadence(this.buf, FS_NOMINAL)
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

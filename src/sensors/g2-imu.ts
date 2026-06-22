// G2 IMU sensor (priority B: 100ms period = 10Hz).
// At 10Hz, waveform-based step detection is unreliable;
// cadence is estimated via autocorrelation on an 8-9s window.
// Moving-average subtraction serves as DC-removal high-pass.

import { estimateCadence, rmsAmplitude } from '../signal'

const FS = 10            // G2 IMU fixed at 10 Hz (100ms)
const WINDOW_S = 9       // 9s window → 90 samples (adequate ACF resolution)
const UPDATE_MS = 1000
const MA_LEN = 5         // ~0.5s moving average for DC removal

export type ImuRaw = { x: number; y: number; z: number }
export type CadenceCallback = (spm: number | null, vertAmp: number) => void

export class G2ImuSensor {
  private buf: number[] = []        // HP-filtered acceleration norm
  private maRing: number[] = []     // ring for moving-average DC removal
  private gravEma = { x: 0, y: 0, z: 9.81 }
  private gravCount = 0
  private readonly GRAV_INIT = 30   // 3s of slow init
  private lastUpdateMs = 0
  private callback: CadenceCallback | null = null

  public cadenceSpm: number | null = null
  public verticalAmp = 0
  public available = false

  start(cb: CadenceCallback): void {
    this.callback = cb
    this.available = true
  }

  /** Called by main.ts for each IMU_DATA_REPORT event. */
  feed(raw: ImuRaw): void {
    const { x, y, z } = raw

    // Slow EMA for gravity estimation
    if (this.gravCount < this.GRAV_INIT) {
      const α = 0.15
      this.gravEma.x = (1 - α) * this.gravEma.x + α * x
      this.gravEma.y = (1 - α) * this.gravEma.y + α * y
      this.gravEma.z = (1 - α) * this.gravEma.z + α * z
      this.gravCount++
    }

    // Linear acceleration (gravity-removed)
    const lx = x - this.gravEma.x
    const ly = y - this.gravEma.y
    const lz = z - this.gravEma.z
    const norm = Math.sqrt(lx * lx + ly * ly + lz * lz)

    // DC removal via moving-average subtraction
    this.maRing.push(norm)
    if (this.maRing.length > MA_LEN) this.maRing.shift()
    const dc = this.maRing.reduce((a, b) => a + b, 0) / this.maRing.length
    const hpVal = norm - dc

    this.buf.push(hpVal)
    const maxBuf = FS * WINDOW_S
    if (this.buf.length > maxBuf) this.buf.splice(0, this.buf.length - maxBuf)

    const now = Date.now()
    if (now - this.lastUpdateMs >= UPDATE_MS && this.buf.length >= FS * 3) {
      this.lastUpdateMs = now
      const spm = estimateCadence(this.buf, FS)
      const amp = rmsAmplitude(this.buf)
      this.cadenceSpm = spm
      this.verticalAmp = amp
      this.callback?.(spm, amp)
    }
  }

  stop(): void { this.available = false }
}

// G2 IMU sensor (priority B: 100ms period = 10Hz).
// At 10Hz, waveform-based step detection is unreliable;
// cadence is estimated via autocorrelation on an 8-9s window.
// Moving-average subtraction serves as DC-removal high-pass.

import { estimateCadence, rmsAmplitude } from '../signal'

const FS_INIT = 10       // initial guess; actual rate is measured from feeds
const FS_MIN = 2
const FS_MAX = 50
const WINDOW_S = 9       // 9s window (adequate ACF resolution at ~10Hz)
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
  private lastFeedMs = 0            // wall-clock of previous feed
  private fsEma = FS_INIT           // measured sample rate (EMA)
  private fsInit = false
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

    // Measure the real report rate rather than trusting a fixed 10Hz —
    // a wrong fs scales cadence directly.
    const tNow = Date.now()
    if (this.lastFeedMs > 0) {
      const dt = tNow - this.lastFeedMs
      if (dt > 0 && dt < 1000) {
        const inst = 1000 / dt
        this.fsEma = this.fsInit ? 0.9 * this.fsEma + 0.1 * inst : inst
        this.fsInit = true
      }
    }
    this.lastFeedMs = tNow
    const fs = Math.max(FS_MIN, Math.min(FS_MAX, this.fsEma))

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
    const maxBuf = Math.ceil(fs * WINDOW_S)
    if (this.buf.length > maxBuf) this.buf.splice(0, this.buf.length - maxBuf)

    const now = tNow
    if (now - this.lastUpdateMs >= UPDATE_MS && this.buf.length >= fs * 3) {
      this.lastUpdateMs = now
      const spm = estimateCadence(this.buf, fs)
      const amp = rmsAmplitude(this.buf)
      this.cadenceSpm = spm
      this.verticalAmp = amp
      this.callback?.(spm, amp)
    }
  }

  stop(): void { this.available = false }
}

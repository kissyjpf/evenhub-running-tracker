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
const FS_WINDOW_N = 64   // timestamps kept for the sample-rate estimate

export type ImuRaw = { x: number; y: number; z: number }
export type CadenceCallback = (spm: number | null, vertAmp: number) => void

export class G2ImuSensor {
  private buf: number[] = []        // HP-filtered acceleration norm
  private maRing: number[] = []     // ring for moving-average DC removal
  // Seeded from the first sample rather than a hard-coded 9.81: the G2 reports
  // acceleration in g (|a| ≈ 1.0), so an m/s² seed is 10x off and decays over
  // seconds — a transient that sits in the 9 s window and pegged cadence at the
  // 200 spm clamp for the first ~10 s of every run.
  private gravEma: { x: number, y: number, z: number } | null = null
  private gravCount = 0
  private readonly GRAV_WARMUP = 20   // samples dropped while gravity settles
  private lastUpdateMs = 0
  private lastFeedMs = 0            // wall-clock of previous feed
  private tsRing: number[] = []     // recent feed timestamps, for rate measurement
  private fsLogged = 0
  private prevRaw: number | null = null   // previous raw estimate, for the agreement check
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

    // Measure the real report rate rather than trusting a fixed 10Hz — a wrong
    // fs scales cadence directly.
    //
    // Derive it from samples-per-elapsed-time over a window, NOT from an EMA of
    // instantaneous 1/dt rates: the glasses deliver IMU events in bursts, and a
    // single 1 ms gap reads as 1000 Hz. Averaging rates lets those spikes
    // dominate (mean of 1/dt >> 1/mean dt), inflating fs and with it cadence.
    const tNow = Date.now()
    this.tsRing.push(tNow)
    if (this.tsRing.length > FS_WINDOW_N) this.tsRing.shift()
    if (this.tsRing.length >= 8) {
      const span = this.tsRing[this.tsRing.length - 1]! - this.tsRing[0]!
      if (span > 0) {
        this.fsEma = ((this.tsRing.length - 1) * 1000) / span
        this.fsInit = true
      }
    }
    this.lastFeedMs = tNow
    const fs = Math.max(FS_MIN, Math.min(FS_MAX, this.fsEma))

    if (this.fsInit && Math.abs(fs - this.fsLogged) > 1) {
      this.fsLogged = fs
      console.log(`[IMU] measured report rate ${fs.toFixed(1)} Hz`)
    }

    // Gravity: seed from the first sample, then keep tracking it slowly. Freezing
    // it after a fixed warm-up let head tilt leak into the "linear" signal for
    // the rest of the run.
    if (this.gravEma === null) this.gravEma = { x, y, z }
    const g = this.gravEma
    const α = this.gravCount < this.GRAV_WARMUP ? 0.25 : 0.01
    g.x = (1 - α) * g.x + α * x
    g.y = (1 - α) * g.y + α * y
    g.z = (1 - α) * g.z + α * z
    this.gravCount++

    // Drop the settling samples entirely — they are a decaying step, not gait,
    // and the autocorrelation window would carry them for seconds.
    if (this.gravCount <= this.GRAV_WARMUP) return

    // Signed vertical acceleration = linear acceleration projected onto gravity.
    // The magnitude |a| would rectify the waveform and double its fundamental,
    // which reads as double cadence (or half, once it aliases past Nyquist).
    const lx = x - g.x
    const ly = y - g.y
    const lz = z - g.z
    const gMag = Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z) || 1
    const vert = (lx * g.x + ly * g.y + lz * g.z) / gMag

    // DC removal via moving-average subtraction
    this.maRing.push(vert)
    if (this.maRing.length > MA_LEN) this.maRing.shift()
    const dc = this.maRing.reduce((a, b) => a + b, 0) / this.maRing.length
    const hpVal = vert - dc

    this.buf.push(hpVal)
    const maxBuf = Math.ceil(fs * WINDOW_S)
    if (this.buf.length > maxBuf) this.buf.splice(0, this.buf.length - maxBuf)

    const now = tNow
    if (now - this.lastUpdateMs >= UPDATE_MS && this.buf.length >= fs * 3) {
      this.lastUpdateMs = now
      const raw = estimateCadence(this.buf, fs)
      const amp = rmsAmplitude(this.buf)

      // Require two consecutive estimates to agree before reporting. The window
      // straddles the moment you start running, mixing stationary and gait data,
      // and that one blended reading lands at the 200 spm clamp — which then
      // leads the display EMA for several seconds. Waiting a beat costs ~1 s of
      // latency at the start and removes the spike.
      const agrees = raw !== null && this.prevRaw !== null &&
        Math.abs(raw - this.prevRaw) <= 0.25 * Math.max(raw, this.prevRaw)
      const spm = agrees ? raw : null
      this.prevRaw = raw

      this.cadenceSpm = spm
      this.verticalAmp = amp
      this.callback?.(spm, amp)
    }
  }

  stop(): void { this.available = false }
}

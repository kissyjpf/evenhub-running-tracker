// k scalar: second layer of the two-layer model.
// Single EMA parameter handling global drift only.
// Updated at ~1 Hz when GPS conditions are good; frozen otherwise.

const LAMBDA = 0.995               // time constant ≈ 200 s at 1 Hz
const K_MIN  = 0.85
const K_MAX  = 1.15
const BOUNDARY_THRESHOLD_MS = 120_000  // 2 min at boundary → recalibration warning

export class KScalar {
  private _k = 1.0
  private _boundaryStart: number | null = null
  public  kAtBoundaryMs = 0

  get value(): number { return this._k }

  /**
   * Update k with GPS observation.
   * Only runs when GPS accuracy < 15m, speed > 1.5 m/s, and speed_cov < 0.08.
   */
  update(params: {
    gpsSpeedMs: number
    gpsAccuracyM: number
    speedCov: number
    cadenceSpm: number | null
    lBase: number
  }): void {
    const { gpsSpeedMs, gpsAccuracyM, speedCov, cadenceSpm, lBase } = params
    if (gpsAccuracyM >= 15 || gpsSpeedMs < 1.5 || speedCov >= 0.08) return
    if (cadenceSpm === null || cadenceSpm <= 0 || lBase <= 0) return

    const lObs = (gpsSpeedMs * 60) / cadenceSpm   // m/step observed by GPS
    const ratio = lObs / lBase
    this._k = Math.max(K_MIN, Math.min(K_MAX, LAMBDA * this._k + (1 - LAMBDA) * ratio))

    const atBoundary = this._k <= K_MIN || this._k >= K_MAX
    if (atBoundary) {
      this._boundaryStart ??= Date.now()
      this.kAtBoundaryMs = Date.now() - this._boundaryStart
    } else {
      this._boundaryStart = null
      this.kAtBoundaryMs = 0
    }
  }

  get recalibNeeded(): boolean {
    return this.kAtBoundaryMs >= BOUNDARY_THRESHOLD_MS
  }

  reset(): void {
    this._k = 1.0
    this._boundaryStart = null
    this.kAtBoundaryMs = 0
  }

  serialize(): number { return this._k }

  deserialize(k: number): void {
    this._k = isFinite(k) ? Math.max(K_MIN, Math.min(K_MAX, k)) : 1.0
    this._boundaryStart = null
    this.kAtBoundaryMs = 0
  }
}

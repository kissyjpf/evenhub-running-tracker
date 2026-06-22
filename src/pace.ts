// Pace estimator: complementary filter (GPS + dead reckoning).
// v_fused = α·v_gps + (1-α)·v_acc   (α=0.7 when GPS valid, α=0 when GPS absent)

import type { CalibRecord, Settings } from './types'
import { computeLBase } from './model/l-base'
import { KScalar } from './model/k-scalar'

const ALPHA_GPS = 0.7         // GPS weight when valid
const EMA_TC_S  = 4           // smoothing time constant (seconds)
const EMA_ALPHA = 1 - 1 / EMA_TC_S  // ≈0.75 at 1Hz update

export interface PaceResult {
  paceSPerKm: number | null
  cadenceSpm: number | null
  lBase: number
  speedMs: number
}

export class PaceEstimator {
  public readonly k = new KScalar()
  private _paceEma: number | null = null
  private _cadEma:  number | null = null

  /** Call at ~1 Hz. */
  update(p: {
    gpsSpeedMs: number | null
    gpsAccuracyM: number
    cadenceSpm: number | null
    verticalAmp: number
    speedCov: number
    records: CalibRecord[]
    settings: Settings
  }): PaceResult {
    const { gpsSpeedMs, gpsAccuracyM, cadenceSpm, verticalAmp, speedCov, records, settings } = p
    const gpsOk = gpsSpeedMs !== null && gpsAccuracyM < 15

    // L_base uses cadence + vertical_amp (NOT speed → no circular reference)
    const cadForModel = cadenceSpm ?? 160
    const lBase = computeLBase(records, cadForModel, verticalAmp, settings)

    // Update k when GPS is reliable
    if (gpsOk && gpsSpeedMs !== null) {
      this.k.update({ gpsSpeedMs, gpsAccuracyM, speedCov, cadenceSpm, lBase })
    }

    const L = Math.max(0.3, Math.min(3.0, this.k.value * lBase))

    // Accelerometer-based speed
    const vAcc = cadenceSpm !== null ? (cadenceSpm / 60) * L : null

    // Complementary fusion
    let vFused: number | null
    if (gpsOk && gpsSpeedMs !== null && vAcc !== null) {
      vFused = ALPHA_GPS * gpsSpeedMs + (1 - ALPHA_GPS) * vAcc
    } else if (gpsOk && gpsSpeedMs !== null) {
      vFused = gpsSpeedMs
    } else {
      vFused = vAcc  // dead reckoning (k frozen automatically — no update called above)
    }

    const rawPace = vFused !== null && vFused > 0.3 ? 1000 / vFused : null

    // EMA smoothing
    this._paceEma = rawPace === null ? this._paceEma
      : this._paceEma === null ? rawPace
      : EMA_ALPHA * this._paceEma + (1 - EMA_ALPHA) * rawPace

    this._cadEma = cadenceSpm === null ? this._cadEma
      : this._cadEma === null ? cadenceSpm
      : EMA_ALPHA * this._cadEma + (1 - EMA_ALPHA) * cadenceSpm

    return {
      paceSPerKm: this._paceEma,
      cadenceSpm: this._cadEma,
      lBase,
      speedMs: vFused ?? 0,
    }
  }

  resetEma(): void {
    this._paceEma = null
    this._cadEma  = null
  }
}

// L_base: first layer of the two-layer step-length model.
// Key: (cadence, vertical_amp) — NOT speed (avoids circular reference).
//
// Priority chain:
//   1. ≥2 records within ±8 spm → local WLS (β0 + β1*cad + β2*amp)
//   2. Exactly 1 record within window → use its step_length_m directly
//   3. No records in window → nearest-cadence record
//   4. No records at all → height prior: (height_cm / 100) * 0.68

import type { CalibRecord, Settings } from '../types'

const CADENCE_WIN  = 8     // ±spm matching window
const HALF_LIFE_MS = 90 * 86400 * 1000  // 90-day freshness half-life

function freshness(ts: number): number {
  return Math.exp(-Math.LN2 * (Date.now() - ts) / HALF_LIFE_MS)
}

function quality(r: CalibRecord): number {
  const sq = r.source === 'manual' ? 1.2 : r.source === 'known' ? 1.1 : 1.0
  const aq = r.source === 'gps' ? Math.max(0.3, 1 - r.gps_accuracy_m / 30) : 1.0
  return sq * aq
}

// 3×3 determinant via expansion
function det3(m: readonly [readonly number[], readonly number[], readonly number[]]): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

// Local weighted least squares: L = β0 + β1·cadence + β2·vertAmp
// Returns null if system is singular or result is out of physical range.
function localWLS(
  records: CalibRecord[],
  cadence: number,
  vertAmp: number,
): number | null {
  if (records.length < 2) return null

  const ws = records.map(r => {
    const diff = (r.cadence_spm - cadence) / CADENCE_WIN
    const gaussW = Math.exp(-(diff * diff))
    return gaussW * freshness(r.ts) * quality(r)
  })

  // Weighted normal equations: (X'WX)β = X'Wy
  // X columns: [1, cadence, vertAmp]
  let S = Array.from({ length: 3 }, () => Array(3).fill(0) as number[])
  let T = [0, 0, 0] as [number, number, number]

  records.forEach((r, i) => {
    const w = ws[i] ?? 0
    const x = [1, r.cadence_spm, r.vertical_amp]
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++)
        S[j]![k] = (S[j]![k] ?? 0) + w * (x[j] ?? 0) * (x[k] ?? 0)
    for (let j = 0; j < 3; j++)
      T[j] = (T[j] ?? 0) + w * r.step_length_m * (x[j] ?? 0)
  })

  const Sm = S as unknown as readonly [readonly number[], readonly number[], readonly number[]]
  const d = det3(Sm)
  if (Math.abs(d) < 1e-15) return null

  // Cramer's rule for β0, β1, β2
  const replaceCol = (col: number, rhs: readonly number[]): readonly [readonly number[], readonly number[], readonly number[]] =>
    Sm.map((row, i) => row.map((v, j) => (j === col ? (rhs[i] ?? 0) : v))) as unknown as readonly [readonly number[], readonly number[], readonly number[]]

  const β0 = det3(replaceCol(0, T)) / d
  const β1 = det3(replaceCol(1, T)) / d
  const β2 = det3(replaceCol(2, T)) / d

  const result = β0 + β1 * cadence + β2 * vertAmp
  return result > 0.3 && result < 3.0 ? result : null
}

export function computeLBase(
  records: CalibRecord[],
  cadence: number,
  vertAmp: number,
  settings: Settings,
): number {
  const near = records.filter(r => Math.abs(r.cadence_spm - cadence) <= CADENCE_WIN)

  if (near.length >= 2) {
    const wls = localWLS(near, cadence, vertAmp)
    if (wls !== null) return wls
  }

  if (near.length === 1) return near[0]!.step_length_m

  if (records.length > 0) {
    const sorted = [...records].sort(
      (a, b) => Math.abs(a.cadence_spm - cadence) - Math.abs(b.cadence_spm - cadence),
    )
    return sorted[0]!.step_length_m
  }

  // Height prior
  return (settings.height_cm / 100) * 0.68
}

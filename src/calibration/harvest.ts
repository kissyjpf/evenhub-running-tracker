// Auto-harvest: find the longest steady-state segment (speed_cov < 0.08)
// in a completed run and emit at most one CalibRecord per run.

import type { CalibRecord, Settings } from '../types'
import { acceptanceGate } from './gate'

export interface RunSample {
  ts: number
  distM: number          // cumulative GPS distance
  speedMs: number        // instantaneous GPS speed
  gpsAccuracyM: number
  steps: number          // cumulative step count
  cadenceSpm: number | null
  verticalAmp: number
}

function segSpeedStats(seg: RunSample[]): { mean: number; cov: number } {
  if (seg.length < 2) return { mean: 0, cov: 999 }
  const speeds = seg.map(s => s.speedMs)
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length
  if (mean < 0.01) return { mean, cov: 999 }
  const variance = speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length
  return { mean, cov: Math.sqrt(variance) / mean }
}

// Find the longest contiguous window where all rolling 10-sample CoVs stay below 0.08.
function longestSteadySegment(samples: RunSample[]): [number, number] {
  const ROLL = 10        // rolling window for local CoV
  const COV_LIMIT = 0.08
  const MIN_WIN = 20     // minimum segment length

  let bestStart = 0, bestEnd = 0
  let winStart = 0

  for (let i = ROLL; i < samples.length; i++) {
    const local = samples.slice(i - ROLL, i)
    const { cov } = segSpeedStats(local)
    if (cov >= COV_LIMIT) {
      if (i - 1 - winStart >= MIN_WIN && i - 1 - winStart > bestEnd - bestStart) {
        bestStart = winStart; bestEnd = i - 1
      }
      winStart = i
    }
  }
  const tail = samples.length - 1 - winStart
  if (tail >= MIN_WIN && tail > bestEnd - bestStart) {
    bestStart = winStart; bestEnd = samples.length - 1
  }

  return [bestStart, bestEnd]
}

export function harvestCalibRecord(
  allSamples: RunSample[],
  settings: Settings,
  source: 'gps' | 'known',
  knownDistanceM?: number,
): CalibRecord | null {
  if (allSamples.length < 2) return null

  const fallbackRecord = (): CalibRecord => {
    const first = allSamples[0]!
    const last = allSamples[allSamples.length - 1]!
    const distM = last.distM - first.distM
    const steps = last.steps - first.steps
    const durationMs = last.ts - first.ts
    const speedMs = durationMs > 0 ? distM / (durationMs / 1000) : 0
    const stepLenM = steps > 0 ? distM / steps : 0
    const cadences = allSamples.map(s => s.cadenceSpm).filter((c): c is number => c !== null)
    const avgCadence = cadences.length > 0 ? cadences.reduce((a, b) => a + b, 0) / cadences.length : 0
    const avgAmp = allSamples.reduce((s, v) => s + v.verticalAmp, 0) / allSamples.length
    const avgAcc = allSamples.reduce((s, v) => s + v.gpsAccuracyM, 0) / allSamples.length
    const { cov: speedCov } = segSpeedStats(allSamples)

    return {
      ts: Date.now(),
      distance_m: distM,
      duration_ms: durationMs,
      source: 'manual',
      gps_accuracy_m: avgAcc,
      steps,
      step_length_m: stepLenM,
      cadence_spm: avgCadence,
      vertical_amp: avgAmp,
      speed_ms: speedMs,
      speed_cov: speedCov,
      edited: false,
    }
  }

  if (allSamples.length < 30) return fallbackRecord()

  const [s0, s1] = longestSteadySegment(allSamples)
  if (s1 - s0 < 20) return fallbackRecord()

  const seg = allSamples.slice(s0, s1 + 1)
  const first = seg[0]!
  const last = seg[seg.length - 1]!

  const distM = (source === 'known' && knownDistanceM !== undefined)
    ? knownDistanceM
    : (last.distM - first.distM)
  const steps = last.steps - first.steps
  const durationMs = last.ts - first.ts

  if (steps <= 0 || durationMs <= 0 || distM <= 0) return fallbackRecord()

  const stepLenM = distM / steps
  const speedMs = distM / (durationMs / 1000)
  const { cov: speedCov } = segSpeedStats(seg)
  const avgAcc = seg.reduce((s, v) => s + v.gpsAccuracyM, 0) / seg.length

  const cadences = seg.map(s => s.cadenceSpm).filter((c): c is number => c !== null)
  const avgCadence = cadences.length > 0
    ? cadences.reduce((a, b) => a + b, 0) / cadences.length : 0
  const cadenceMean = avgCadence
  const cadenceSD = cadences.length > 1
    ? Math.sqrt(cadences.reduce((s, v) => s + (v - cadenceMean) ** 2, 0) / cadences.length)
    : 0
  const avgAmp = seg.reduce((s, v) => s + v.verticalAmp, 0) / seg.length

  const gateResult = acceptanceGate({
    distance_m: distM,
    source,
    gps_accuracy_m: avgAcc,
    speed_cov: speedCov,
    cadence_sd: cadenceSD,
    step_length_m: stepLenM,
  }, settings)

  if (!gateResult.pass) {
    console.log('[harvest] rejected:', gateResult.reason, '-> falling back to manual')
    return fallbackRecord()
  }

  return {
    ts: Date.now(),
    distance_m: distM,
    duration_ms: durationMs,
    source,
    gps_accuracy_m: avgAcc,
    steps,
    step_length_m: stepLenM,
    cadence_spm: avgCadence,
    vertical_amp: avgAmp,
    speed_ms: speedMs,
    speed_cov: speedCov,
    edited: false,
  }
}

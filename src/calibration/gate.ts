import type { Settings } from '../types'

export interface GateInput {
  distance_m: number
  source: 'gps' | 'known' | 'manual'
  gps_accuracy_m: number
  speed_cov: number
  cadence_sd: number
  step_length_m: number
}

export interface GateResult {
  pass: boolean
  reason: string
}

export function acceptanceGate(input: GateInput, settings: Settings): GateResult {
  const minDist = input.source === 'gps'
    ? settings.min_distance_gps
    : settings.min_distance_known

  if (input.distance_m < minDist)
    return { pass: false, reason: `distance ${input.distance_m.toFixed(0)}m < ${minDist}m` }

  if (input.source === 'gps' && input.gps_accuracy_m >= 15)
    return { pass: false, reason: `GPS accuracy ${input.gps_accuracy_m.toFixed(1)}m ≥ 15m` }

  if (input.speed_cov >= 0.08)
    return { pass: false, reason: `speed CoV ${input.speed_cov.toFixed(3)} ≥ 0.08` }

  if (input.cadence_sd >= 5)
    return { pass: false, reason: `cadence SD ${input.cadence_sd.toFixed(1)} ≥ 5 spm` }

  if (input.step_length_m < 0.5 || input.step_length_m > 2.2)
    return { pass: false, reason: `step_length ${input.step_length_m.toFixed(3)}m outside [0.5, 2.2]` }

  return { pass: true, reason: 'ok' }
}

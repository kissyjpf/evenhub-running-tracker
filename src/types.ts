// Speed bands (m/s): <3.0 | 3.0-3.5 | 3.5-4.0 | 4.0-4.5 | >4.5
export const BAND_EDGES = [3.0, 3.5, 4.0, 4.5] as const
export type Band = 0 | 1 | 2 | 3 | 4
export const BAND_LABELS = ['<3.0', '3.0-3.5', '3.5-4.0', '4.0-4.5', '>4.5'] as const

export function speedToBand(ms: number): Band {
  if (ms < BAND_EDGES[0]) return 0
  if (ms < BAND_EDGES[1]) return 1
  if (ms < BAND_EDGES[2]) return 2
  if (ms < BAND_EDGES[3]) return 3
  return 4
}

export interface CalibRecord {
  ts: number
  distance_m: number
  duration_ms: number
  source: 'gps' | 'known' | 'manual'
  gps_accuracy_m: number
  steps: number
  step_length_m: number
  cadence_spm: number
  vertical_amp: number
  speed_ms: number
  speed_cov: number
  edited: boolean
}

export interface Settings {
  height_cm: number
  weight_kg: number | null
  min_distance_gps: number
  min_distance_known: number
}

export const DEFAULT_SETTINGS: Settings = {
  height_cm: 170,
  weight_kg: null,
  min_distance_gps: 800,
  min_distance_known: 400,
}

export type SensorPath = 'devicemotion' | 'g2imu' | 'gps-only'

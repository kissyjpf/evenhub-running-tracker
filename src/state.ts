import type { CalibRecord, Settings } from './types'
import { DEFAULT_SETTINGS } from './types'
import type { RunSample } from './calibration/harvest'
import type { PaceResult } from './pace'

export type RunStatus = 'idle' | 'running' | 'paused'

export interface LapRecord {
  number: number
  distanceM: number
  elapsedMs: number
}

export interface AppState {
  status: RunStatus

  startTime: number | null
  pausedElapsed: number
  pauseStart: number | null

  totalDistanceM: number
  lapStartDistanceM: number
  lapStartElapsedMs: number
  laps: LapRecord[]

  lastPace: PaceResult | null
  segmentPaceSPerKm: number | null

  runSamples: RunSample[]

  calibRecords: CalibRecord[]
  settings: Settings
}

export function makeInitialState(): AppState {
  return {
    status: 'idle',
    startTime: null,
    pausedElapsed: 0,
    pauseStart: null,
    totalDistanceM: 0,
    lapStartDistanceM: 0,
    lapStartElapsedMs: 0,
    laps: [],
    lastPace: null,
    segmentPaceSPerKm: null,
    runSamples: [],
    calibRecords: [],
    settings: { ...DEFAULT_SETTINGS },
  }
}

export function activeElapsedMs(s: AppState): number {
  if (s.startTime === null) return 0
  const paused = s.pausedElapsed + (s.pauseStart !== null ? Date.now() - s.pauseStart : 0)
  return Date.now() - s.startTime - paused
}

export function lapElapsedMs(s: AppState): number {
  return activeElapsedMs(s) - s.lapStartElapsedMs
}

export function lapDistanceM(s: AppState): number {
  return s.totalDistanceM - s.lapStartDistanceM
}

export function recordLap(s: AppState): void {
  const elapsed = activeElapsedMs(s)
  s.laps.push({
    number: s.laps.length + 1,
    distanceM: lapDistanceM(s),
    elapsedMs: lapElapsedMs(s),
  })
  s.lapStartDistanceM = s.totalDistanceM
  s.lapStartElapsedMs = elapsed
}

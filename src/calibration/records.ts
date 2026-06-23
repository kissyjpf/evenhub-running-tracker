// Calibration record storage: max 10 records, 2 per speed band, coverage-first policy.

import type { CalibRecord, Settings } from '../types'
import { speedToBand } from '../types'

export const MAX_RECORDS = 10
export const MAX_PER_BAND = 2

export async function loadRecords(
  get: (key: string) => Promise<string | null>,
): Promise<CalibRecord[]> {
  try {
    const raw = await get('calib_records_v2')
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as CalibRecord[]) : []
  } catch {
    return []
  }
}

export async function saveRecords(
  set: (key: string, value: string) => Promise<void>,
  records: CalibRecord[],
): Promise<void> {
  await set('calib_records_v2', JSON.stringify(records))
}

// Insert with coverage-first policy: prefer filling empty bands,
// then replace oldest within the same band, then cap total at 10.
export function insertRecord(records: CalibRecord[], rec: CalibRecord): CalibRecord[] {
  const band = speedToBand(rec.speed_ms)
  const inBand = records.filter(r => speedToBand(r.speed_ms) === band)

  let next: CalibRecord[]
  if (inBand.length < MAX_PER_BAND) {
    next = [...records, rec]
  } else {
    // Replace oldest in band
    const oldest = [...inBand].sort((a, b) => a.ts - b.ts)[0]!
    next = records.filter(r => r !== oldest).concat(rec)
  }

  if (next.length > MAX_RECORDS) {
    next = [...next].sort((a, b) => a.ts - b.ts).slice(next.length - MAX_RECORDS)
  }

  return next
}

// Edit distance and steps of a record (settings UI). Re-derives step_length, speed, cadence, source.
// Returns { records, error } — error is non-null on validation failure.
export function editRecordManual(
  records: CalibRecord[],
  idx: number,
  newDistanceM: number,
  newSteps: number,
): { records: CalibRecord[]; error: string | null } {
  const rec = records[idx]
  if (!rec) return { records, error: 'Record not found' }

  if (newSteps <= 0) return { records, error: 'Steps must be > 0' }

  const newStepLen = newDistanceM / newSteps
  if (newStepLen < 0.3 || newStepLen > 2.5) {
    return {
      records,
      error: `Result step_length ${newStepLen.toFixed(3)} m outside [0.3, 2.5] — check distance and steps`,
    }
  }

  const durationS = rec.duration_ms / 1000
  const newCadence = durationS > 0 ? (newSteps / durationS) * 60 : 0
  const newSpeed = durationS > 0 ? newDistanceM / durationS : 0

  const updated: CalibRecord = {
    ...rec,
    distance_m: newDistanceM,
    steps: newSteps,
    step_length_m: newStepLen,
    speed_ms: newSpeed,
    cadence_spm: newCadence,
    source: 'manual',
    edited: true,
  }
  const next = [...records]
  next[idx] = updated
  return { records: next, error: null }
}

// Delete a record by index
export function deleteRecord(records: CalibRecord[], idx: number): CalibRecord[] {
  return records.filter((_, i) => i !== idx)
}

// Returns a map of band → count for the settings UI coverage display
export function bandCoverage(records: CalibRecord[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const r of records) {
    const b = speedToBand(r.speed_ms)
    m.set(b, (m.get(b) ?? 0) + 1)
  }
  return m
}

// Invalidate all records and reset k (called when height_cm changes)
export async function invalidateAllRecords(
  set: (key: string, value: string) => Promise<void>,
): Promise<void> {
  await saveRecords(set, [])
  await set('k_scalar', '1.0')
}

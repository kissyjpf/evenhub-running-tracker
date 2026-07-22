// Calibration record storage: max 10 records, 2 per speed band, coverage-first policy.

import type { CalibRecord, Settings } from '../types'
import { speedToBand, BAND_EDGES } from '../types'

export const MAX_RECORDS = 10
export const MAX_PER_BAND = 2

// A record teaches a step length, so one with no steps or no cadence teaches
// nothing — and worse, computeLBase will happily return its 0 m/step, collapsing
// the modelled speed and dragging the fused pace far below GPS. Older builds
// stored these, so filter on load as well as on harvest.
export function isUsableCalibRecord(r: CalibRecord): boolean {
  return (
    r !== null && typeof r === 'object' &&
    isFinite(r.step_length_m) && r.step_length_m >= 0.3 && r.step_length_m <= 2.5 &&
    isFinite(r.cadence_spm) && r.cadence_spm > 0 &&
    isFinite(r.distance_m) && r.distance_m > 0 &&
    isFinite(r.steps) && r.steps > 0
  )
}

export async function loadRecords(
  get: (key: string) => Promise<string | null>,
): Promise<CalibRecord[]> {
  try {
    const raw = await get('calib_records_v2')
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const all = parsed as CalibRecord[]
    const good = all.filter(isUsableCalibRecord)
    if (good.length !== all.length) {
      console.warn(`[calib] dropped ${all.length - good.length} unusable record(s) on load`)
    }
    return good
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

// Representative speed for each band, used when the user types a step length in
// directly: the band is what they are choosing, so anchor the record at its
// midpoint (the open-ended outer bands sit just outside the edge).
export function bandCentreSpeedMs(band: number): number {
  const [e0, e1, e2, e3] = BAND_EDGES
  switch (band) {
    case 0:  return e0 - 0.25
    case 1:  return (e0 + e1) / 2
    case 2:  return (e1 + e2) / 2
    case 3:  return (e2 + e3) / 2
    default: return e3 + 0.25
  }
}

// Build a record from a hand-entered step length for a speed band. Cadence is
// derived from the band speed so the (cadence -> step length) model stays
// consistent with harvested records.
export function makeManualRecord(band: number, stepLengthM: number): CalibRecord {
  const speed = bandCentreSpeedMs(band)
  return {
    ts: Date.now(),
    distance_m: 1000,
    duration_ms: Math.round((1000 / speed) * 1000),
    source: 'manual',
    gps_accuracy_m: 0,
    steps: Math.round(1000 / stepLengthM),
    step_length_m: stepLengthM,
    cadence_spm: (speed / stepLengthM) * 60,
    vertical_amp: 0,
    speed_ms: speed,
    speed_cov: 0,
    edited: true,
  }
}

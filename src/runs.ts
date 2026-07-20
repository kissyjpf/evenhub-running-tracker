// Completed-run history. Stored separately from calibration records: those are
// a curated sample set for the pace model, these are the user's actual runs.

import type { RunRecord } from './types'

const KEY = 'runs_v1'
export const MAX_RUNS = 50   // keeps device storage bounded

export async function loadRuns(
  get: (key: string) => Promise<string | null>,
): Promise<RunRecord[]> {
  try {
    const raw = await get(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return (parsed as RunRecord[]).filter(r => typeof r?.ts === 'number')
  } catch {
    return []
  }
}

export async function saveRuns(
  set: (key: string, value: string) => Promise<void>,
  runs: RunRecord[],
): Promise<void> {
  await set(KEY, JSON.stringify(runs))
}

// Newest first, capped.
export function insertRun(runs: RunRecord[], rec: RunRecord): RunRecord[] {
  return [rec, ...runs].slice(0, MAX_RUNS)
}

export function deleteRun(runs: RunRecord[], ts: number): RunRecord[] {
  return runs.filter(r => r.ts !== ts)
}

export function avgPaceSPerKm(r: RunRecord): number | null {
  if (r.distance_m < 1 || r.duration_ms < 1000) return null
  return (r.duration_ms / 1000) / (r.distance_m / 1000)
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p2(m)}:${p2(sec)}` : `${m}:${p2(sec)}`
}

export function fmtPace(sPerKm: number | null): string {
  if (sPerKm === null || !isFinite(sPerKm) || sPerKm <= 0) return '-:--'
  const m = Math.floor(sPerKm / 60)
  const s = Math.round(sPerKm % 60)
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`
}

// CSV — one row per run, laps flattened into a trailing field. Chosen over JSON
// so it can be pasted straight into a spreadsheet.
export function runsToCsv(runs: RunRecord[]): string {
  const head = 'date,start,duration,distance_km,avg_pace_per_km,steps,calories,laps'
  const rows = runs.map(r => {
    const d = new Date(r.ts)
    const laps = r.laps
      .map(l => `L${l.number} ${(l.distanceM / 1000).toFixed(2)}km ${fmtDuration(l.elapsedMs)}`)
      .join(' | ')
    return [
      d.toLocaleDateString(),
      d.toLocaleTimeString(),
      fmtDuration(r.duration_ms),
      (r.distance_m / 1000).toFixed(2),
      fmtPace(avgPaceSPerKm(r)),
      Math.round(r.steps),
      Math.round(r.calories),
      `"${laps}"`,
    ].join(',')
  })
  return [head, ...rows].join('\n')
}

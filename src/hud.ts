// HUD renderer for Even G2 (576×288 mono green Micro-LED).
// Three data lines: current pace | cadence | segment pace.

export type RunStatus = 'idle' | 'running' | 'paused'

export interface HudInput {
  status: RunStatus
  elapsedMs: number
  totalDistanceM: number
  lapNumber: number
  lapDistanceM: number
  lapElapsedMs: number
  paceSPerKm: number | null
  cadenceSpm: number | null
  segmentPaceSPerKm: number | null
  kValue: number
  calibRecordCount: number
}

export interface HUDCells {
  tl: string  // elapsed time
  tc: string  // current pace — main focus
  tr: string  // total distance
  ca: string  // cadence + segment pace (full width)
  bl: string  // current lap: dist + elapsed
  bc: string  // status icon + lap number
  br: string  // debug: k + calib count
}

export const CELL_KEYS: Array<keyof HUDCells> = ['tl', 'tc', 'tr', 'ca', 'bl', 'bc', 'br']

function p2(n: number): string {
  return String(Math.floor(Math.abs(n))).padStart(2, '0')
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`
}

function fmtPace(sPerKm: number | null): string {
  if (sPerKm === null || sPerKm <= 0 || sPerKm > 99 * 60) return '-:--'
  const m = Math.floor(sPerKm / 60)
  const s = Math.round(sPerKm % 60)
  return s === 60 ? `${m + 1}:00` : `${m}:${p2(s)}`
}

export function renderHUD(h: HudInput): HUDCells {
  const distKm = (h.totalDistanceM / 1000).toFixed(2)

  if (h.status === 'idle') {
    const calStr = h.calibRecordCount > 0
      ? `${h.calibRecordCount} records  k=${h.kValue.toFixed(2)}`
      : 'no calibration — run to auto-calibrate'
    return {
      tl: '00:00',
      tc: 'READY',
      tr: '0.00km',
      ca: calStr,
      bl: '',
      bc: '○ dbl=start',
      br: '',
    }
  }

  const paceStr = fmtPace(h.paceSPerKm)
  const cadStr  = h.cadenceSpm !== null ? `${Math.round(h.cadenceSpm)}spm` : '--spm'
  const segStr  = fmtPace(h.segmentPaceSPerKm)
  const lapDistKm = (h.lapDistanceM / 1000).toFixed(2)
  const icon    = h.status === 'running' ? '●' : '◐'

  return {
    tl: fmtElapsed(h.elapsedMs),
    tc: `${paceStr}/km`,
    tr: `${distKm}km`,
    ca: `CAD ${cadStr}  •  SEG ${segStr}/km`,
    bl: `L${h.lapNumber}: ${lapDistKm}km ${fmtElapsed(h.lapElapsedMs)}`,
    bc: `${icon} lap${h.lapNumber}`,
    br: `k=${h.kValue.toFixed(2)} c${h.calibRecordCount}`,
  }
}

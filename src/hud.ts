// HUD renderer for Even G2 (576×288 mono green Micro-LED).
// Three data lines: current pace | cadence | segment pace.

export type RunStatus = 'idle' | 'running' | 'paused'

export type HudModal =
  | { type: 'none' }
  | { type: 'exit', sel: number }   // sel 0=exit, 1=cancel
  | { type: 'stop', sel: number }   // sel 0=save+exit, 1=discard, 2=continue

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
  totalSteps: number
  calories: number
  showSteps: boolean
  showCalories: boolean
  modal: HudModal
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

function renderModalCells(m: HudModal): HUDCells {
  const blank: HUDCells = { tl: '', tc: '', tr: '', ca: '', bl: '', bc: '', br: '' }

  if (m.type === 'exit') {
    return {
      ...blank,
      tl: m.sel === 0 ? '[Exit]' : 'Exit',
      tc: 'Exit?',
      bl: m.sel === 1 ? '[Cancel]' : 'Cancel',
      bc: 'tap=ok  ↑↓=pick',
    }
  }

  if (m.type === 'stop') {
    return {
      ...blank,
      tl: m.sel === 0 ? '[Save+exit]' : 'Save+exit',
      tc: 'Save run?',
      ca: m.sel === 1 ? '[Discard]' : 'Discard',
      bl: m.sel === 2 ? '[Continue]' : 'Continue',
      bc: 'tap=ok  ↑↓=pick',
    }
  }

  return blank
}

export function renderHUD(h: HudInput): HUDCells {
  if (h.modal.type !== 'none') return renderModalCells(h.modal)

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
      bc: '○ tap=start  dbl=exit',
      br: '',
    }
  }

  const paceStr = fmtPace(h.paceSPerKm)
  const cadStr  = h.cadenceSpm !== null ? `${Math.round(h.cadenceSpm)}spm` : '--spm'
  const segStr  = fmtPace(h.segmentPaceSPerKm)
  const lapDistKm = (h.lapDistanceM / 1000).toFixed(2)
  const icon    = h.status === 'running' ? '●' : '◐'

  let cadPart = `CAD ${cadStr}`
  if (h.showSteps) cadPart += `  ${h.totalSteps}stp`
  let segPart = `SEG ${segStr}/km`
  if (h.showCalories && h.calories > 0) segPart += `  ${Math.round(h.calories)}kcal`

  const cells: HUDCells = {
    tl: fmtElapsed(h.elapsedMs),
    tc: `${paceStr}/km`,
    tr: `${distKm}km`,
    ca: `${cadPart}  •  ${segPart}`,
    bl: `L${h.lapNumber}: ${lapDistKm}km ${fmtElapsed(h.lapElapsedMs)}`,
    bc: `${icon} lap${h.lapNumber}`,
    br: `k=${h.kValue.toFixed(2)} c${h.calibRecordCount}`,
  }

  return cells
}

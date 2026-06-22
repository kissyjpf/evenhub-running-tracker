// HUD renderer for Even G2 (576×288 mono green Micro-LED).
// Three data lines: current pace | cadence | segment pace.

export type RunStatus = 'idle' | 'running' | 'paused'

export type HudModal =
  | { type: 'none' }
  | { type: 'stop', sel: number }   // sel 0=save+exit, 1=discard, 2=continue

export interface HudInput {
  status: RunStatus
  elapsedMs: number
  totalDistanceM: number
  laps: { number: number, distanceM: number, elapsedMs: number }[]
  lapScrollOffset: number
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
  ca: string  // cadence + segment pace (full width, row 2)
  mo1: string // modal option 1
  mo2: string // modal option 2
  mo3: string // modal option 3
  bot: string // bottom row (lap + status + debug)
}

export const CELL_KEYS: Array<keyof HUDCells> = ['tl', 'tc', 'tr', 'ca', 'mo1', 'mo2', 'mo3', 'bot']

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

function renderBaseCells(h: HudInput): HUDCells {
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
      mo1: ' ', mo2: ' ', mo3: ' ',
      bot: '○ tap=start  dbl=exit',
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

  let allLines: string[] = []

  for (const l of h.laps) {
    const lDist = (l.distanceM / 1000).toFixed(2)
    allLines.push(`L${l.number}: ${lDist}km ${fmtElapsed(l.elapsedMs)}`)
  }
  allLines.push(`L${h.lapNumber}: ${lapDistKm}km ${fmtElapsed(h.lapElapsedMs)}  ${icon}  k=${h.kValue.toFixed(2)} c${h.calibRecordCount}`)

  const MAX_LINES = 6
  let offset = h.lapScrollOffset
  const maxOffset = Math.max(0, allLines.length - MAX_LINES)
  if (offset > maxOffset) offset = maxOffset
  if (offset < 0) offset = 0

  let visibleLines = allLines
  if (allLines.length > MAX_LINES) {
    const startIdx = allLines.length - MAX_LINES - offset
    const endIdx = allLines.length - offset
    visibleLines = allLines.slice(startIdx, endIdx)
  }

  return {
    tl: fmtElapsed(h.elapsedMs),
    tc: `${paceStr}/km`,
    tr: `${distKm}km`,
    ca: `${cadPart}  •  ${segPart}`,
    mo1: ' ', mo2: ' ', mo3: ' ',
    bot: visibleLines.join('\n'),
  }
}

export function renderHUD(h: HudInput): HUDCells {
  const cells = renderBaseCells(h)

  const m = h.modal
  if (m.type === 'stop') {
    // Hide all normal HUD elements to show a "separate screen"
    cells.tl = ' '
    cells.tc = ' '
    cells.tr = ' '
    cells.ca = ' '
    cells.bot = ' '

    const opts = ['Save + exit', 'Discard', 'Continue']
    cells.mo1 = m.sel === 0 ? `> ${opts[0]} <` : `  ${opts[0]}  `
    cells.mo2 = m.sel === 1 ? `> ${opts[1]} <` : `  ${opts[1]}  `
    cells.mo3 = m.sel === 2 ? `> ${opts[2]} <` : `  ${opts[2]}  `
  }

  return cells
}

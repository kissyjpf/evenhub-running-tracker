// HUD renderer for Even G2 (576×288 mono green Micro-LED).
// Layout:
//   left column  — elapsed+distance / cadence+steps / segment+lap+gps
//   top-right    — clock / weather / compass / glasses battery (4 lines)
//   bottom       — large dot-matrix pace (the focal readout)
//   centre       — stop-menu overlay (shown only during a modal)

import type { WeatherInfo } from './weather'

export type RunStatus = 'idle' | 'running' | 'paused'

export type HudModal =
  | { type: 'none' }
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
  gpsAccuracyM?: number
  clock: string                        // "12:34"
  weather: WeatherInfo | null
  headingDeg: number | null
  glassesBatteryPct: number | null
  modal: HudModal
}

export interface HUDCells {
  l1: string    // top-left row 1: elapsed + distance
  l2: string    // top-left row 2: cadence + steps
  l3: string    // top-left row 3: segment + lap + gps
  info: string  // top-right 4-line block: clock / weather / compass / battery
  pb: string    // bottom big dot-matrix pace (multi-line)
  pu: string    // bottom pace unit "/km"
  mo: string    // centre modal overlay (blank unless a modal is active)
}

export const CELL_KEYS: Array<keyof HUDCells> = ['l1', 'l2', 'l3', 'info', 'pb', 'pu', 'mo']

const BLANK = ' '

// ── formatting helpers ────────────────────────────────────────────────────────
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

// ── 16-point compass ──────────────────────────────────────────────────────────
const DIRS16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
function compass16(deg: number | null): string {
  if (deg === null || !isFinite(deg)) return '--'
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16
  return DIRS16[idx]!
}

// ── dot-matrix big font (5 rows) for pace digits ──────────────────────────────
// '█' = lit dot. Change DOT here if the G2 font renders a different glyph better.
const GLYPHS: Record<string, string[]> = {
  '0': ['███', '█ █', '█ █', '█ █', '███'],
  '1': [' █ ', '██ ', ' █ ', ' █ ', '███'],
  '2': ['███', '  █', '███', '█  ', '███'],
  '3': ['███', '  █', '███', '  █', '███'],
  '4': ['█ █', '█ █', '███', '  █', '  █'],
  '5': ['███', '█  ', '███', '  █', '███'],
  '6': ['███', '█  ', '███', '█ █', '███'],
  '7': ['███', '  █', '  █', '  █', '  █'],
  '8': ['███', '█ █', '███', '█ █', '███'],
  '9': ['███', '█ █', '███', '  █', '███'],
  ':': [' ', '█', ' ', '█', ' '],
  '-': ['   ', '   ', '███', '   ', '   '],
  ' ': ['  ', '  ', '  ', '  ', '  '],
}

// Render a short string (pace like "5:30") as a 5-line dot-matrix block.
function bigText(s: string): string {
  const rows: string[] = []
  for (let r = 0; r < 5; r++) {
    rows.push([...s].map(ch => (GLYPHS[ch] ?? GLYPHS[' ']!)[r]).join(' '))
  }
  return rows.join('\n')
}

// ── top-right info block ──────────────────────────────────────────────────────
function infoBlock(h: HudInput): string {
  const w = h.weather
  const wStr = w ? `${w.tempC}°C ${w.cond} ${w.humidity}%` : 'weather --'
  const batt = h.glassesBatteryPct !== null ? `${h.glassesBatteryPct}` : '--'
  return [
    h.clock,
    wStr,
    compass16(h.headingDeg),
    `G:${batt}%`,
  ].join('\n')
}

// ── base HUD (no modal) ───────────────────────────────────────────────────────
function renderBaseCells(h: HudInput): HUDCells {
  const info = infoBlock(h)
  const paceStr = fmtPace(h.paceSPerKm)
  const gpsStr = (h.gpsAccuracyM ?? 999) < 30 ? 'GPS:OK' : 'GPS:--'

  if (h.status === 'idle') {
    const calStr = h.calibRecordCount > 0
      ? `${h.calibRecordCount} recs k=${h.kValue.toFixed(2)}`
      : 'no calib — run to learn'
    return {
      l1: 'READY',
      l2: calStr,
      l3: `${gpsStr}  tap=start  dbl=exit`,
      info,
      pb: bigText(paceStr),
      pu: '/km',
      mo: BLANK,
    }
  }

  const distKm = (h.totalDistanceM / 1000).toFixed(2)
  const cadStr = h.cadenceSpm !== null ? `${Math.round(h.cadenceSpm)}spm` : '--spm'
  const segStr = fmtPace(h.segmentPaceSPerKm)

  let l2 = `CAD ${cadStr}`
  if (h.showSteps) l2 += `  ${h.totalSteps}stp`
  let l3 = `SEG ${segStr}/km  L${h.lapNumber}  ${gpsStr}`

  return {
    l1: `${fmtElapsed(h.elapsedMs)}   ${distKm}km`,
    l2,
    l3,
    info,
    pb: bigText(paceStr),
    pu: '/km',
    mo: BLANK,
  }
}

export function renderHUD(h: HudInput): HUDCells {
  const cells = renderBaseCells(h)

  const m = h.modal
  if (m.type === 'stop') {
    // Full-screen takeover: blank everything, show the 3 options centred.
    cells.l1 = BLANK
    cells.l2 = BLANK
    cells.l3 = BLANK
    cells.info = BLANK
    cells.pb = BLANK
    cells.pu = BLANK

    const opts = ['Save + exit', 'Discard', 'Continue']
    cells.mo = opts.map((o, i) => (i === m.sel ? `> ${o} <` : `  ${o}  `)).join('\n')
  }

  return cells
}

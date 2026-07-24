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
  laps: { number: number, distanceM: number, elapsedMs: number }[]
  lapNumber: number
  lapDistanceM: number
  lapElapsedMs: number
  lapView: boolean
  lapScrollOffset: number
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
  altitudeM: number | null
  glassesBatteryPct: number | null
  modal: HudModal
}

export interface HUDCells {
  l1: string    // top-left row 1: elapsed + distance
  l2: string    // top-left row 2: cadence + steps
  l3: string    // top-left row 3: segment + lap + gps
  info: string  // top-right 4-line block: clock / weather / compass / battery
  pb: string    // plain pace string ("5:30"); drawn as a dot-matrix image, not text
  pu: string    // bottom pace unit "/km"
  mo: string    // centre modal overlay (blank unless a modal is active)
  lap: string   // full-screen lap list (blank unless the lap view is open)
}

export const CELL_KEYS: Array<keyof HUDCells> = ['l1', 'l2', 'l3', 'info', 'pb', 'pu', 'mo', 'lap']

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

// The large pace readout is no longer tiled from text — the fixed base font is
// too coarse. `cells.pb` now carries the plain pace string (e.g. "5:30"); main.ts
// rasterises it into a fine dot-matrix bitmap and pushes it to an image
// container. See paceImage.ts. A blank string clears the image.
export { fmtPace }

// ── top-right info block ──────────────────────────────────────────────────────
function infoBlock(h: HudInput): string {
  const w = h.weather
  const wStr = w ? `${w.tempC}°C ${w.cond} ${w.humidity}%` : 'weather --'
  const batt = h.glassesBatteryPct !== null ? `${h.glassesBatteryPct}` : '--'
  const altStr = h.altitudeM !== null ? `ALT ${Math.round(h.altitudeM)}m` : 'ALT --'
  return [
    h.clock,
    wStr,
    altStr,
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
      pb: paceStr,
      pu: '/km',
      mo: BLANK,
      lap: BLANK,
    }
  }

  const distKm = (h.totalDistanceM / 1000).toFixed(2)
  const cadStr = h.cadenceSpm !== null ? `${Math.round(h.cadenceSpm)}spm` : '--spm'
  const segStr = fmtPace(h.segmentPaceSPerKm)

  let l2 = `CAD ${cadStr}`
  if (h.showSteps) l2 += `  ${h.totalSteps}stp`
  let l3 = `SEG ${segStr}/km  L${h.lapNumber}  ${gpsStr}  ↑laps`

  return {
    l1: `${fmtElapsed(h.elapsedMs)}   ${distKm}km`,
    l2,
    l3,
    info,
    pb: paceStr,
    pu: '/km',
    mo: BLANK,
    lap: BLANK,
  }
}

// Full-screen lap list. Newest at the bottom; offset scrolls towards older laps.
const LAP_MAX_LINES = 8
function lapScreen(h: HudInput): string {
  const lines: string[] = []
  for (const l of h.laps) {
    const km = (l.distanceM / 1000).toFixed(2)
    const pace = l.distanceM > 0
      ? fmtPace((l.elapsedMs / 1000) / (l.distanceM / 1000))
      : '-:--'
    lines.push(`L${l.number}  ${km}km  ${fmtElapsed(l.elapsedMs)}  ${pace}/km`)
  }
  // in-progress current lap
  const ckm = (h.lapDistanceM / 1000).toFixed(2)
  lines.push(`L${h.lapNumber}* ${ckm}km  ${fmtElapsed(h.lapElapsedMs)}`)

  const maxOffset = Math.max(0, lines.length - LAP_MAX_LINES)
  const offset = Math.min(Math.max(0, h.lapScrollOffset), maxOffset)
  const end = lines.length - offset
  const start = Math.max(0, end - LAP_MAX_LINES)
  const visible = lines.slice(start, end)

  const header = lines.length > LAP_MAX_LINES
    ? `LAPS  ${start + 1}-${end}/${lines.length}  ↑↓scroll tap=close`
    : `LAPS  swipe=scroll  tap=close`
  return [header, ...visible].join('\n')
}

function blankAll(cells: HUDCells): void {
  cells.l1 = BLANK; cells.l2 = BLANK; cells.l3 = BLANK
  cells.info = BLANK; cells.pb = BLANK; cells.pu = BLANK
}

export function renderHUD(h: HudInput): HUDCells {
  const cells = renderBaseCells(h)

  // Stop menu takes priority over the lap view.
  const m = h.modal
  if (m.type === 'stop') {
    blankAll(cells)
    cells.lap = BLANK
    const opts = ['Save + exit', 'Discard', 'Continue']
    cells.mo = opts.map((o, i) => (i === m.sel ? `> ${o} <` : `  ${o}  `)).join('\n')
    return cells
  }

  if (h.lapView) {
    blankAll(cells)
    cells.mo = BLANK
    cells.lap = lapScreen(h)
  }

  return cells
}

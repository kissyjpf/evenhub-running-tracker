// HUD renderer for Even G1/G2 (576×288 mono-green Micro-LED).
//
// Three full-width text containers stacked vertically:
//
//   y=  0  info    12:34  21°C Clear 40%  ALT 850m  G85%
//   y= 28  header  FACING NNE 23°  8/24  r50 ≥1000m  tap=mode
//   y= 56  list    up to 8 peak rows
//
// Text containers render at a fixed font size, so the design is a character
// grid: roughly 40 columns across the panel. Every row below is built from
// fixed-width columns so the list reads as a table rather than ragged text.

import { compass16 } from './geo'
import type { PeakView, ViewMode } from './view'
import type { WeatherInfo } from './weather'
import type { Settings } from './types'

export interface HudInput {
  clock: string
  weather: WeatherInfo | null
  altitudeM: number | null
  headingDeg: number | null
  headingKind: 'compass' | 'gps' | null
  glassesBatteryPct: number | null
  settings: Settings
  mode: ViewMode
  views: PeakView[]
  /** How many peaks are in range in total, before the mode's own filtering. */
  totalInRange: number
  scrollOffset: number
  /** Shown instead of the list while loading, or when there is nothing to show. */
  status: string | null
}

export interface HudCells {
  info: string
  hdr: string
  list: string
}

export const CELL_KEYS: Array<keyof HudCells> = ['info', 'hdr', 'list']

export const LIST_MAX_LINES = 8

const MODE_LABELS: Record<ViewMode, string> = {
  facing: 'FACING',
  near: 'NEAR',
  high: 'HIGH',
}

// ── formatting helpers ───────────────────────────────────────────────────────

/** Distances are a column, so they get a fixed width: "4.2km", "42km", "150km". */
export function fmtDist(m: number): string {
  const km = m / 1000
  if (km < 10) return `${km.toFixed(1)}km`
  return `${Math.round(km)}km`
}

export function fmtEle(eleM: number | null): string {
  return eleM === null ? '--' : `${Math.round(eleM)}m`
}

/**
 * Offset from where you're facing: an arrow plus degrees, or "↑" for anything
 * within 5° of dead ahead. Blank when there's no heading to compare against.
 */
export function fmtRel(rel: number | null): string {
  if (rel === null) return '    '
  const a = Math.round(Math.abs(rel))
  if (a <= 5) return ' ↑  '
  return `${rel > 0 ? '→' : '←'}${String(a).padStart(3, ' ')}`
}

function fmtHeading(deg: number | null, kind: 'compass' | 'gps' | null): string {
  if (deg === null) return 'DIR --'
  const tag = kind === 'gps' ? '~' : ''
  return `${compass16(deg)} ${Math.round(deg)}°${tag}`
}

// ── rows ─────────────────────────────────────────────────────────────────────

function infoRow(h: HudInput): string {
  const w = h.weather
  const wStr = w ? `${w.tempC}°C ${w.cond} ${w.humidity}%` : 'weather --'
  const alt = h.altitudeM !== null ? `ALT ${Math.round(h.altitudeM)}m` : 'ALT --'
  const batt = h.glassesBatteryPct !== null ? `G${h.glassesBatteryPct}%` : 'G--'
  return `${h.clock}  ${wStr}  ${alt}  ${batt}`
}

function headerRow(h: HudInput): string {
  const shown = h.views.length
  const range = shown > LIST_MAX_LINES
    ? `${h.scrollOffset + 1}-${Math.min(shown, h.scrollOffset + LIST_MAX_LINES)}/${shown}`
    : `${shown}/${h.totalInRange}`
  return `${MODE_LABELS[h.mode]} ${fmtHeading(h.headingDeg, h.headingKind)}  ${range}  ` +
    `r${h.settings.radiusKm} ≥${h.settings.minEleM}m  tap=mode`
}

/** One peak row: marker, compass point, offset, distance, height, name. */
export function peakRow(v: PeakView): string {
  const ahead = v.rel !== null && Math.abs(v.rel) <= 5
  const mark = ahead ? '> ' : '  '
  const dir = compass16(v.bearing).padEnd(3, ' ')
  const dist = fmtDist(v.distM).padStart(6, ' ')
  const ele = fmtEle(v.peak.eleM).padStart(5, ' ')
  const name = v.peak.volcano ? `${v.peak.name} ▲` : v.peak.name
  return `${mark}${dir} ${fmtRel(v.rel)}  ${dist}  ${ele}  ${name}`
}

function listBlock(h: HudInput): string {
  if (h.status !== null) return h.status
  if (h.views.length === 0) {
    return h.mode === 'facing'
      ? 'Nothing in front of you.\nTurn around, or tap to switch to NEAR.'
      : `No peaks within ${h.settings.radiusKm}km above ${h.settings.minEleM}m.\n` +
        'Widen the radius or lower the minimum height on the phone.'
  }
  const offset = clampOffset(h.scrollOffset, h.views.length)
  return h.views
    .slice(offset, offset + LIST_MAX_LINES)
    .map(peakRow)
    .join('\n')
}

/** Keeps the scroll offset inside the list, so a shrinking list can't strand it. */
export function clampOffset(offset: number, count: number): number {
  const max = Math.max(0, count - LIST_MAX_LINES)
  return Math.min(Math.max(0, offset), max)
}

export function renderHud(h: HudInput): HudCells {
  return {
    info: infoRow(h),
    hdr: headerRow(h),
    list: listBlock(h),
  }
}

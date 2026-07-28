// Turns the raw peak set into what the glasses actually show: distance, true
// bearing, offset from where you're facing, and apparent elevation angle.

import { bearingDeg, elevationAngleDeg, haversineM, relativeBearing, type LatLon } from './geo'
import type { Peak } from './peaks'
import type { Settings } from './types'

export type ViewMode = 'facing' | 'near' | 'high'
export const VIEW_MODES: ViewMode[] = ['facing', 'near', 'high']

export interface PeakView {
  peak: Peak
  distM: number
  bearing: number            // true bearing to the summit, 0-360
  rel: number | null         // offset from your heading, -180..180 (null if unknown)
  elevAngle: number | null   // apparent angle above horizontal, degrees
}

export interface ViewerState {
  pos: LatLon
  altitudeM: number | null
  headingDeg: number | null
}

/**
 * Build the display list for one mode.
 *
 * 'facing' keeps only what is inside the field-of-view cone and orders it by
 * how close it is to dead ahead, so the first row is the summit you are looking
 * at. Without a heading there is no cone to speak of, so it degrades to 'near'
 * rather than showing an empty screen.
 */
export function buildViews(
  peaks: Peak[],
  viewer: ViewerState,
  settings: Settings,
  mode: ViewMode,
): PeakView[] {
  const maxDistM = settings.radiusKm * 1000
  const views: PeakView[] = []

  for (const p of peaks) {
    // A summit of unknown height can't be held to a height filter; excluding it
    // is the honest call once the user has asked for "at least N metres".
    if (settings.minEleM > 0 && (p.eleM === null || p.eleM < settings.minEleM)) continue

    const distM = haversineM(viewer.pos, p)
    if (distM > maxDistM) continue

    const bearing = bearingDeg(viewer.pos, p)
    const rel = viewer.headingDeg === null ? null : relativeBearing(bearing, viewer.headingDeg)
    const elevAngle = (p.eleM !== null && viewer.altitudeM !== null)
      ? elevationAngleDeg(distM, viewer.altitudeM, p.eleM)
      : null

    views.push({ peak: p, distM, bearing, rel, elevAngle })
  }

  const effective: ViewMode = (mode === 'facing' && viewer.headingDeg === null) ? 'near' : mode

  if (effective === 'facing') {
    const halfFov = settings.fovDeg / 2
    const inView = views.filter(v => v.rel !== null && Math.abs(v.rel) <= halfFov)
    inView.sort((a, b) => Math.abs(a.rel!) - Math.abs(b.rel!))
    return inView
  }

  if (effective === 'high') {
    views.sort((a, b) => (b.peak.eleM ?? -1) - (a.peak.eleM ?? -1))
    return views
  }

  views.sort((a, b) => a.distM - b.distM)
  return views
}

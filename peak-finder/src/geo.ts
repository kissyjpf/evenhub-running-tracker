// Spherical geometry for peak bearings and distances.
// Everything here is pure — no I/O — so the maths stays testable in isolation.

export interface LatLon {
  lat: number
  lon: number
}

const EARTH_R = 6371000

const toRad = (d: number) => (d * Math.PI) / 180
const toDeg = (r: number) => (r * 180) / Math.PI

/** Great-circle distance in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const chord = sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon
  return EARTH_R * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord))
}

/**
 * Initial great-circle bearing from `a` to `b`, 0-360° clockwise from true north.
 * At the distances this app deals with (tens of km) the initial bearing is the
 * direction you actually point in, so no midpoint correction is needed.
 */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat)
  const φ2 = toRad(b.lat)
  const Δλ = toRad(b.lon - a.lon)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return norm360(toDeg(Math.atan2(y, x)))
}

/** Wrap any angle into [0, 360). */
export function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * Signed offset of `bearing` from `heading`, in (-180, 180].
 * Negative = to your left, positive = to your right.
 */
export function relativeBearing(bearing: number, heading: number): number {
  const d = norm360(bearing - heading)
  return d > 180 ? d - 360 : d
}

const DIRS16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]

/** 16-point compass label ("--" when the heading is unknown). */
export function compass16(deg: number | null): string {
  if (deg === null || !isFinite(deg)) return '--'
  return DIRS16[Math.round(norm360(deg) / 22.5) % 16]!
}

/**
 * Apparent elevation angle of a summit, in degrees above the horizontal.
 * Includes the standard 0.13 refraction/curvature correction, which is worth
 * ~30 m of apparent drop at 40 km — enough to matter for a distant peak.
 */
export function elevationAngleDeg(distM: number, viewerEleM: number, peakEleM: number): number | null {
  if (distM <= 0) return null
  const drop = (0.87 * distM * distM) / (2 * EARTH_R)
  return toDeg(Math.atan2(peakEleM - viewerEleM - drop, distM))
}

/**
 * Circular exponential moving average — averaging headings numerically would
 * put the mean of 359° and 1° at 180°, so the smoothing happens on the unit
 * circle instead.
 */
export function circularEma(prev: number | null, next: number, alpha: number): number {
  if (prev === null) return norm360(next)
  const p = toRad(prev)
  const n = toRad(next)
  const x = alpha * Math.cos(p) + (1 - alpha) * Math.cos(n)
  const y = alpha * Math.sin(p) + (1 - alpha) * Math.sin(n)
  if (x === 0 && y === 0) return norm360(next)
  return norm360(toDeg(Math.atan2(y, x)))
}

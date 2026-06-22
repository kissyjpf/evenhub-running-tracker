// GPS sensor: primary pace and distance source.
// Uses coords.speed when available; falls back to Haversine/Δt.

export interface GpsFix {
  lat: number
  lon: number
  speedMs: number | null
  accuracyM: number
  ts: number
}

export function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const cosA = Math.cos(toRad(a.lat))
  const cosB = Math.cos(toRad(b.lat))
  const chord = sinLat * sinLat + cosA * cosB * sinLon * sinLon
  return R * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord))
}

export class GpsSensor {
  private watchId: number | null = null
  private lastFix: GpsFix | null = null
  private onFix: ((fix: GpsFix) => void) | null = null

  public available = false
  public lastSpeedMs: number | null = null
  public lastAccuracyM = 999

  /** Returns false if geolocation API is unavailable. */
  start(onFix: (fix: GpsFix) => void): boolean {
    if (!navigator.geolocation) return false
    this.onFix = onFix
    this.watchId = navigator.geolocation.watchPosition(
      pos => this.handlePosition(pos),
      err => console.warn('[GPS]', err.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    )
    return true
  }

  private handlePosition(pos: GeolocationPosition): void {
    const c = pos.coords
    const fix: GpsFix = {
      lat: c.latitude,
      lon: c.longitude,
      accuracyM: c.accuracy,
      ts: pos.timestamp,
      speedMs: null,
    }

    if (c.speed !== null && c.speed >= 0) {
      fix.speedMs = c.speed
    } else if (this.lastFix !== null) {
      const dt = (fix.ts - this.lastFix.ts) / 1000
      if (dt > 0.3 && dt < 15) {
        const dm = haversineM(this.lastFix, fix)
        fix.speedMs = dm / dt
      }
    }

    this.available = c.accuracy < 30
    this.lastSpeedMs = fix.speedMs
    this.lastAccuracyM = c.accuracy
    this.lastFix = fix
    this.onFix?.(fix)
  }

  getFix(): GpsFix | null { return this.lastFix }

  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId)
      this.watchId = null
      this.available = false
    }
  }
}

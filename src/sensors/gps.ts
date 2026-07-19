// GPS sensor: primary pace and distance source.
// Prefers the native EvenHub App Location API (bridge), which is purpose-built
// for the Even App WebView and avoids the browser-geolocation restrictions of
// the embedded WebView. Falls back to navigator.geolocation automatically when
// the native path is unavailable (e.g. the Vite simulator or an older host).
// Uses reported speed when available; otherwise Haversine/Δt.

import { AppLocationAccuracy } from '@evenrealities/even_hub_sdk'
import type { AppLocation, AppLocationOptions } from '@evenrealities/even_hub_sdk'

// Minimal structural view of the bridge methods this sensor needs — keeps the
// sensor decoupled from the full EvenAppBridge type. The real bridge satisfies it.
export interface LocationBridge {
  startAppLocationUpdates(options?: AppLocationOptions): Promise<boolean>
  stopAppLocationUpdates(): Promise<boolean>
  onAppLocationChanged(cb: (loc: AppLocation) => void): () => void
}

// Assumed accuracy when the host reports a fix without an accuracy value.
// Kept under the 30 m dead-reckoning / calibration threshold so native fixes
// stay usable, but not treated as pristine.
const DEFAULT_ACCURACY_M = 20

export interface GpsFix {
  lat: number
  lon: number
  speedMs: number | null
  accuracyM: number
  headingDeg: number | null   // course over ground (0-360); null when stationary/unknown
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
  private lastFix: GpsFix | null = null
  private onFix: ((fix: GpsFix) => void) | null = null

  // Native path
  private bridge: LocationBridge | null = null
  private unsub: (() => void) | null = null
  private usingNative = false

  // Browser-geolocation fallback path
  private watchId: number | null = null

  public available = false
  public lastSpeedMs: number | null = null
  public lastAccuracyM = 999

  /**
   * Start location updates. Prefers the native App Location API when a bridge
   * is supplied; otherwise (or on failure) falls back to navigator.geolocation.
   * Returns false only if no location source is available at all.
   */
  async start(bridge: LocationBridge | null, onFix: (fix: GpsFix) => void): Promise<boolean> {
    this.onFix = onFix
    this.bridge = bridge

    if (bridge) {
      try {
        this.unsub = bridge.onAppLocationChanged(loc => this.handleAppLocation(loc))
        const ok = await bridge.startAppLocationUpdates({
          accuracy: AppLocationAccuracy.High,
          intervalMs: 1000,
          distanceFilter: 0,   // time-based updates so speed CoV has regular samples
        })
        if (ok) {
          this.usingNative = true
          console.log('[GPS] using native App Location API')
          return true
        }
        // Host declined — clean up and fall back to the browser API.
        this.unsub?.()
        this.unsub = null
      } catch (e) {
        console.warn('[GPS] native location failed, falling back to browser:', e)
        this.unsub?.()
        this.unsub = null
      }
    }

    return this.startBrowser()
  }

  private startBrowser(): boolean {
    if (!navigator.geolocation) return false
    console.log('[GPS] using browser geolocation')
    this.watchId = navigator.geolocation.watchPosition(
      pos => this.handlePosition(pos),
      err => console.warn('[GPS]', err.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    )
    return true
  }

  private handleAppLocation(loc: AppLocation): void {
    const ts = typeof loc.timestamp === 'number' && loc.timestamp > 0 ? loc.timestamp : Date.now()
    const accuracyM = typeof loc.accuracy === 'number' && loc.accuracy >= 0
      ? loc.accuracy
      : DEFAULT_ACCURACY_M

    const fix: GpsFix = {
      lat: loc.latitude,
      lon: loc.longitude,
      accuracyM,
      headingDeg: typeof loc.heading === 'number' && loc.heading >= 0 ? loc.heading : null,
      ts,
      speedMs: null,
    }

    if (typeof loc.speed === 'number' && loc.speed >= 0) {
      fix.speedMs = loc.speed
    } else if (this.lastFix !== null) {
      const dt = (fix.ts - this.lastFix.ts) / 1000
      if (dt > 0.3 && dt < 15) {
        fix.speedMs = haversineM(this.lastFix, fix) / dt
      }
    }

    this.commit(fix)
  }

  private handlePosition(pos: GeolocationPosition): void {
    const c = pos.coords
    const fix: GpsFix = {
      lat: c.latitude,
      lon: c.longitude,
      accuracyM: c.accuracy,
      headingDeg: c.heading !== null && !isNaN(c.heading) ? c.heading : null,
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

    this.commit(fix)
  }

  private commit(fix: GpsFix): void {
    this.available = fix.accuracyM < 30
    this.lastSpeedMs = fix.speedMs
    this.lastAccuracyM = fix.accuracyM
    this.lastFix = fix
    this.onFix?.(fix)
  }

  getFix(): GpsFix | null { return this.lastFix }

  stop(): void {
    if (this.unsub) {
      this.unsub()
      this.unsub = null
    }
    if (this.usingNative && this.bridge) {
      this.bridge.stopAppLocationUpdates().catch(() => {})
    }
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId)
      this.watchId = null
    }
    this.usingNative = false
    this.available = false
  }
}

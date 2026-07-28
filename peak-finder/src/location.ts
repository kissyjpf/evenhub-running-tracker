// Location: native EvenHub App Location API with a browser-geolocation fallback.
//
// Same two-path arrangement the running tracker uses — the embedded WebView
// restricts navigator.geolocation, but the simulator has no bridge — with the
// update rate relaxed, because someone standing still looking at a mountain
// does not need 1 Hz fixes.

import { AppLocationAccuracy } from '@evenrealities/even_hub_sdk'
import type { AppLocation, AppLocationOptions } from '@evenrealities/even_hub_sdk'

export interface LocationBridge {
  startAppLocationUpdates(options?: AppLocationOptions): Promise<boolean>
  stopAppLocationUpdates(): Promise<boolean>
  onAppLocationChanged(cb: (loc: AppLocation) => void): () => void
}

export interface Fix {
  lat: number
  lon: number
  accuracyM: number
  /** Course over ground; only meaningful while moving, null otherwise. */
  courseDeg: number | null
  altitudeM: number | null
  ts: number
}

const DEFAULT_ACCURACY_M = 20
const UPDATE_INTERVAL_MS = 3000

export class LocationSource {
  public lastFix: Fix | null = null
  /** GPS altitude, lightly smoothed — a raw fix wanders by several metres. */
  public altitudeM: number | null = null
  public source: 'native' | 'browser' | null = null

  private onFix: ((fix: Fix) => void) | null = null
  private bridge: LocationBridge | null = null
  private unsub: (() => void) | null = null
  private watchId: number | null = null

  async start(bridge: LocationBridge | null, onFix: (fix: Fix) => void): Promise<boolean> {
    this.onFix = onFix
    this.bridge = bridge

    if (bridge) {
      try {
        this.unsub = bridge.onAppLocationChanged(loc => this.handleApp(loc))
        const ok = await bridge.startAppLocationUpdates({
          accuracy: AppLocationAccuracy.High,
          intervalMs: UPDATE_INTERVAL_MS,
          distanceFilter: 0,
        })
        if (ok) {
          this.source = 'native'
          console.log('[loc] using native App Location API')
          return true
        }
        this.unsub?.()
        this.unsub = null
      } catch (e) {
        console.warn('[loc] native location failed, falling back to browser:', e)
        this.unsub?.()
        this.unsub = null
      }
    }
    return this.startBrowser()
  }

  private startBrowser(): boolean {
    if (!navigator.geolocation) {
      console.warn('[loc] no location source available')
      return false
    }
    console.log('[loc] using browser geolocation')
    this.source = 'browser'
    this.watchId = navigator.geolocation.watchPosition(
      pos => {
        const c = pos.coords
        this.commit({
          lat: c.latitude,
          lon: c.longitude,
          accuracyM: c.accuracy,
          courseDeg: c.heading !== null && !isNaN(c.heading) ? c.heading : null,
          altitudeM: typeof c.altitude === 'number' && !isNaN(c.altitude) ? c.altitude : null,
          ts: pos.timestamp,
        })
      },
      err => console.warn('[loc]', err.message),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    )
    return true
  }

  private handleApp(loc: AppLocation): void {
    this.commit({
      lat: loc.latitude,
      lon: loc.longitude,
      accuracyM: typeof loc.accuracy === 'number' && loc.accuracy >= 0
        ? loc.accuracy
        : DEFAULT_ACCURACY_M,
      courseDeg: typeof loc.heading === 'number' && loc.heading >= 0 ? loc.heading : null,
      altitudeM: typeof loc.altitude === 'number' ? loc.altitude : null,
      ts: typeof loc.timestamp === 'number' && loc.timestamp > 0 ? loc.timestamp : Date.now(),
    })
  }

  private commit(fix: Fix): void {
    if (fix.altitudeM !== null) {
      this.altitudeM = this.altitudeM === null
        ? fix.altitudeM
        : 0.8 * this.altitudeM + 0.2 * fix.altitudeM
    }
    this.lastFix = fix
    this.onFix?.(fix)
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
    if (this.source === 'native' && this.bridge) {
      this.bridge.stopAppLocationUpdates().catch(() => {})
    }
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId)
      this.watchId = null
    }
    this.source = null
  }
}

// Which way you're facing.
//
// The glasses expose accelerometer samples but no magnetometer, so the compass
// has to come from the phone: hold it (or pocket it) facing the same way you
// are. Two browser paths exist and neither is universal:
//
//   iOS      'deviceorientation' + webkitCompassHeading — a true-north heading,
//            but only after DeviceOrientationEvent.requestPermission() has been
//            granted from a real user gesture (hence the button in the panel).
//   Android  'deviceorientationabsolute' + alpha, counter-clockwise from north.
//
// GPS course over ground is the fallback: it's only valid while you're actually
// moving, so it can't replace the compass for someone standing and looking up.

import { circularEma, norm360 } from './geo'

export type HeadingKind = 'compass' | 'gps' | null

const COMPASS_STALE_MS = 5000
const COURSE_STALE_MS = 15000
const EMA_ALPHA = 0.6

interface IosDeviceOrientationCtor {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>
}

export class HeadingSource {
  /** Smoothed heading in degrees clockwise from north, or null if unknown. */
  public deg: number | null = null
  public kind: HeadingKind = null
  /** Raw (unsmoothed) last compass reading, for the diagnostics panel. */
  public rawCompassDeg: number | null = null
  public permission: 'unknown' | 'granted' | 'denied' | 'unsupported' = 'unknown'
  public sampleCount = 0

  private compassDeg: number | null = null
  private compassAt = 0
  private courseDeg: number | null = null
  private courseAt = 0
  private listening = false
  private handler: ((e: DeviceOrientationEvent) => void) | null = null
  private eventName: 'deviceorientationabsolute' | 'deviceorientation' = 'deviceorientation'

  /**
   * Start listening, asking for permission first where that's required.
   * Must be called from a user gesture on iOS; returns false if it was refused
   * or the platform has no orientation events at all.
   */
  async enable(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
      this.permission = 'unsupported'
      console.warn('[heading] DeviceOrientationEvent unavailable')
      return false
    }

    const ctor = DeviceOrientationEvent as unknown as IosDeviceOrientationCtor
    if (typeof ctor.requestPermission === 'function') {
      try {
        const res = await ctor.requestPermission()
        this.permission = res === 'granted' ? 'granted' : 'denied'
        if (res !== 'granted') {
          console.warn(`[heading] permission ${res}`)
          return false
        }
      } catch (e) {
        // Thrown when the call didn't come from a user gesture.
        this.permission = 'denied'
        console.warn('[heading] requestPermission threw:', e)
        return false
      }
    } else {
      this.permission = 'granted'
    }

    this.listen()
    return true
  }

  private listen(): void {
    if (this.listening) return
    this.listening = true

    // 'deviceorientationabsolute' is the Android path; iOS only fires the plain
    // event, and carries the heading on webkitCompassHeading instead.
    this.eventName = 'ondeviceorientationabsolute' in window
      ? 'deviceorientationabsolute'
      : 'deviceorientation'

    this.handler = (e: DeviceOrientationEvent) => this.onOrientation(e)
    window.addEventListener(this.eventName, this.handler, true)
    console.info(`[heading] listening on ${this.eventName}`)
  }

  private onOrientation(e: DeviceOrientationEvent): void {
    const webkit = (e as DeviceOrientationEvent & { webkitCompassHeading?: number })
      .webkitCompassHeading

    let heading: number | null = null
    if (typeof webkit === 'number' && isFinite(webkit) && webkit >= 0) {
      // Already a compass heading (iOS applies declination, so this is true north).
      heading = webkit
    } else if (typeof e.alpha === 'number' && isFinite(e.alpha) && (e.absolute || this.eventName === 'deviceorientationabsolute')) {
      // alpha counts counter-clockwise from north, so a heading is its mirror.
      heading = 360 - e.alpha
    }
    if (heading === null) return

    // A landscape phone reports orientation in the screen's frame, not the
    // device's — without this the heading is 90° out whenever the user rotates.
    heading = norm360(heading + screenAngle())

    this.sampleCount++
    this.rawCompassDeg = heading
    this.compassDeg = circularEma(this.compassDeg, heading, EMA_ALPHA)
    this.compassAt = Date.now()
    this.resolve()
  }

  /** Feed course over ground from a GPS fix (null when standing still). */
  setCourse(deg: number | null): void {
    if (deg === null || !isFinite(deg)) return
    this.courseDeg = norm360(deg)
    this.courseAt = Date.now()
    this.resolve()
  }

  private resolve(): void {
    const now = Date.now()
    if (this.compassDeg !== null && now - this.compassAt < COMPASS_STALE_MS) {
      this.deg = this.compassDeg
      this.kind = 'compass'
      return
    }
    if (this.courseDeg !== null && now - this.courseAt < COURSE_STALE_MS) {
      this.deg = this.courseDeg
      this.kind = 'gps'
      return
    }
    this.deg = null
    this.kind = null
  }

  /** Re-evaluates freshness; call on the display tick, not just on events. */
  refresh(): void {
    this.resolve()
  }

  stop(): void {
    if (this.handler) window.removeEventListener(this.eventName, this.handler, true)
    this.handler = null
    this.listening = false
  }
}

function screenAngle(): number {
  const a = screen.orientation?.angle
  if (typeof a === 'number') return a
  const legacy = (window as unknown as { orientation?: number }).orientation
  return typeof legacy === 'number' ? legacy : 0
}

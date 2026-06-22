// Sensor manager: DeviceMotion (A) → G2 IMU (B) → GPS-only (C) fallback chain.

import { GpsSensor, GpsFix } from './gps'
import { DeviceMotionSensor } from './device-motion'
import { G2ImuSensor, ImuRaw } from './g2-imu'
import type { SensorPath } from '../types'

export interface CadenceUpdate {
  spm: number | null
  vertAmp: number
  path: SensorPath
}

export class SensorManager {
  public readonly gps = new GpsSensor()
  public readonly dm  = new DeviceMotionSensor()
  public readonly imu = new G2ImuSensor()
  public path: SensorPath = 'gps-only'

  private _cadenceCb: ((u: CadenceUpdate) => void) | null = null
  private _gpsCb: ((fix: GpsFix) => void) | null = null

  // Last known cadence (from whichever active path)
  public lastCadenceSpm: number | null = null
  public lastVertAmp = 0

  onCadence(cb: (u: CadenceUpdate) => void): void { this._cadenceCb = cb }
  onGps(cb: (fix: GpsFix) => void): void { this._gpsCb = cb }

  initGps(): boolean {
    return this.gps.start(fix => this._gpsCb?.(fix))
  }

  /** Call from a user-gesture handler so iOS permission prompt can fire. */
  async tryDeviceMotion(): Promise<boolean> {
    const granted = await this.dm.requestPermission()
    if (!granted) return false
    this.dm.start((spm, amp) => {
      this.path = 'devicemotion'
      this.lastCadenceSpm = spm
      this.lastVertAmp = amp
      this._cadenceCb?.({ spm, vertAmp: amp, path: 'devicemotion' })
    })
    return true
  }

  /** Start G2 IMU path (used as fallback when DeviceMotion is unavailable). */
  startG2Imu(): void {
    if (this.path === 'devicemotion') return
    this.path = 'g2imu'
    this.imu.start((spm, amp) => {
      if (this.path !== 'devicemotion') {
        this.lastCadenceSpm = spm
        this.lastVertAmp = amp
        this._cadenceCb?.({ spm, vertAmp: amp, path: 'g2imu' })
      }
    })
  }

  /** Route raw G2 IMU data to the appropriate sensor. */
  feedImu(raw: ImuRaw): void {
    // Always feed IMU regardless of active path; G2ImuSensor ignores if not started
    this.imu.feed(raw)
  }

  stop(): void {
    this.gps.stop()
    this.dm.stop()
    this.imu.stop()
  }
}

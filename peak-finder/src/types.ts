// Shared types and defaults.

export interface Settings {
  /** Search radius around you, in kilometres. */
  radiusKm: number
  /** Only show summits at or above this elevation, in metres. */
  minEleM: number
  /**
   * Width of the "in front of you" cone, in degrees. A peak counts as being in
   * view when its bearing is within ±fovDeg/2 of where you're facing.
   */
  fovDeg: number
  /**
   * Which OSM name tag to prefer. 'local' uses the country's own name (Japanese
   * in Japan); 'en' prefers name:en / romaji, for when the glasses render Latin
   * text more legibly than the local script.
   */
  nameLang: 'local' | 'en'
  /** Keep the phone screen awake so the app keeps updating in the background. */
  useWakeLock: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  radiusKm: 50,
  minEleM: 1000,
  fovDeg: 90,
  nameLang: 'local',
  useWakeLock: true,
}

export const RADIUS_MIN_KM = 1
export const RADIUS_MAX_KM = 200
export const ELE_MIN_M = 0
export const ELE_MAX_M = 5000

export function clampSettings(s: Settings): Settings {
  return {
    ...s,
    radiusKm: Math.min(RADIUS_MAX_KM, Math.max(RADIUS_MIN_KM, Math.round(s.radiusKm))),
    minEleM: Math.min(ELE_MAX_M, Math.max(ELE_MIN_M, Math.round(s.minEleM))),
    fovDeg: Math.min(360, Math.max(10, Math.round(s.fovDeg))),
  }
}

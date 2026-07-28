// Peak data from OpenStreetMap via the Overpass API.
//
// Overpass is free and needs no API key, but it is a shared community service:
// it rate-limits, it goes down, and a 200 km query is not something to issue on
// a timer. So a fetch happens only when the cached set no longer covers where
// you are, and the result is persisted on-device — once an area is cached the
// app keeps working with no network at all.

import { haversineM, type LatLon } from './geo'

export interface Peak {
  id: number
  name: string
  lat: number
  lon: number
  eleM: number | null   // null when OSM has no ele tag for the summit
  volcano: boolean
}

export interface PeakSet {
  /** Centre the set was fetched around. */
  lat: number
  lon: number
  /** Radius the set was fetched with, in km. */
  radiusKm: number
  /** Fetch time (epoch ms). */
  ts: number
  peaks: Peak[]
}

// Public mirrors, tried in order. The main instance is the most complete but
// also the most likely to be throttled, so a mirror behind it is not optional.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
]

// Only named summits are useful here — an unnamed spot height tells you nothing
// when you're looking at it through the glasses.
function buildQuery(lat: number, lon: number, radiusKm: number): string {
  const r = Math.round(radiusKm * 1000)
  const ll = `${lat.toFixed(5)},${lon.toFixed(5)}`
  return `[out:json][timeout:60];` +
    `(node["natural"="peak"]["name"](around:${r},${ll});` +
    `node["natural"="volcano"]["name"](around:${r},${ll}););` +
    `out body;`
}

// OSM ele tags are free text: "3776", "3776 m", "3,776", "1234.5", "ca. 800".
export function parseEle(raw: unknown): number | null {
  if (typeof raw === 'number') return isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const m = raw.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!m) return null
  const v = parseFloat(m[0])
  return isFinite(v) ? v : null
}

function pickName(tags: Record<string, string>, lang: 'local' | 'en'): string | null {
  if (lang === 'en') {
    const en = tags['name:en'] ?? tags['name:ja_rm'] ?? tags['int_name']
    if (en) return en
  }
  return tags['name'] ?? tags['name:ja'] ?? tags['name:en'] ?? null
}

export interface OverpassNode {
  type?: string
  id?: number
  lat?: number
  lon?: number
  tags?: Record<string, string>
}

/**
 * Fetch every named summit within `radiusKm`. Elevation is NOT filtered here —
 * the whole set is cached and the minimum-height setting is applied at display
 * time, so moving that slider never costs a round trip.
 */
export async function fetchPeaks(
  lat: number,
  lon: number,
  radiusKm: number,
  nameLang: 'local' | 'en',
): Promise<PeakSet> {
  const body = 'data=' + encodeURIComponent(buildQuery(lat, lon, radiusKm))
  let lastErr: unknown = null

  for (const url of ENDPOINTS) {
    try {
      const t0 = Date.now()
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      if (!res.ok) {
        lastErr = new Error(`${res.status} ${res.statusText}`)
        console.warn(`[peaks] ${url} -> ${res.status}`)
        continue
      }
      const json = await res.json() as { elements?: OverpassNode[] }
      const peaks = parseElements(json.elements ?? [], nameLang)
      console.info(`[peaks] ${peaks.length} peaks from ${new URL(url).host} ` +
        `in ${Date.now() - t0}ms (r=${radiusKm}km)`)
      return { lat, lon, radiusKm, ts: Date.now(), peaks }
    } catch (e) {
      lastErr = e
      console.warn(`[peaks] ${url} failed:`, e)
    }
  }
  throw lastErr ?? new Error('no Overpass endpoint reachable')
}

// Cap on what we keep, tallest first. A 200 km radius over a mountainous region
// can return several thousand summits; anything past this is noise that would
// only bloat the on-device store.
const MAX_PEAKS = 800

export function parseElements(elements: OverpassNode[], nameLang: 'local' | 'en'): Peak[] {
  const out: Peak[] = []
  for (const el of elements) {
    if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue
    const tags = el.tags ?? {}
    const name = pickName(tags, nameLang)
    if (name === null) continue
    out.push({
      id: el.id ?? out.length,
      name,
      lat: el.lat,
      lon: el.lon,
      eleM: parseEle(tags['ele']),
      volcano: tags['natural'] === 'volcano',
    })
  }
  // Unknown elevation sorts last: it can't be judged, so it shouldn't displace
  // a summit we do know the height of.
  out.sort((a, b) => (b.eleM ?? -1) - (a.eleM ?? -1))
  return out.slice(0, MAX_PEAKS)
}

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_KEY = 'peaks_cache_v1'
// OSM summits don't move. A month is only about picking up new/corrected data.
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * True when `set` still covers a viewer at `at`. The cached disc has to contain
 * the disc you now want, so the usable slack is (cached radius − wanted radius);
 * moving further than that would silently cut off peaks on the far side.
 */
export function cacheCovers(set: PeakSet | null, at: LatLon, radiusKm: number): boolean {
  if (set === null) return false
  if (Date.now() - set.ts > CACHE_MAX_AGE_MS) return false
  if (set.radiusKm < radiusKm) return false
  const movedKm = haversineM(set, at) / 1000
  return movedKm <= set.radiusKm - radiusKm
}

export async function loadPeakCache(
  get: (k: string) => Promise<string | null>,
): Promise<PeakSet | null> {
  try {
    const raw = await get(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PeakSet
    if (!Array.isArray(parsed.peaks) || typeof parsed.lat !== 'number') return null
    return parsed
  } catch (e) {
    console.warn('[peaks] cache load failed:', e)
    return null
  }
}

export async function savePeakCache(
  set: (k: string, v: string) => Promise<void>,
  value: PeakSet,
): Promise<void> {
  try {
    await set(CACHE_KEY, JSON.stringify(value))
  } catch (e) {
    console.warn('[peaks] cache save failed:', e)
  }
}

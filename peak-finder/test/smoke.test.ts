// Smoke tests for the pure logic: geometry, peak parsing, view building and the
// HUD renderer. Everything here runs without the bridge, the network or a GPS.
//
//   npm test
//
// Reference values are Tokyo Station → Mt Fuji, which is a case with a
// well-known answer: ~100 km, WSW, and a summit sitting under 2° above the
// horizon.

import assert from 'node:assert/strict'

import {
  bearingDeg, circularEma, compass16, elevationAngleDeg, haversineM, norm360, relativeBearing,
} from '../src/geo'
import { parseEle, parseElements, cacheCovers, type Peak, type PeakSet } from '../src/peaks'
import { buildViews } from '../src/view'
import { clampOffset, fmtDist, fmtRel, peakRow, renderHud, LIST_MAX_LINES } from '../src/hud'
import { DEFAULT_SETTINGS, clampSettings, type Settings } from '../src/types'

let failures = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures++
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : String(e)}`)
  }
}

const TOKYO = { lat: 35.6812, lon: 139.7671 }
const FUJI = { lat: 35.3606, lon: 138.7274 }

// ── geo ──────────────────────────────────────────────────────────────────────
test('haversine: Tokyo → Fuji is ~100 km', () => {
  const km = haversineM(TOKYO, FUJI) / 1000
  assert.ok(km > 99 && km < 102, `got ${km.toFixed(2)} km`)
})

test('bearing: Tokyo → Fuji points WSW', () => {
  const b = bearingDeg(TOKYO, FUJI)
  assert.ok(Math.abs(b - 249.6) < 1, `got ${b.toFixed(1)}°`)
  assert.equal(compass16(b), 'WSW')
})

test('bearing is antisymmetric within a degree', () => {
  const there = bearingDeg(TOKYO, FUJI)
  const back = bearingDeg(FUJI, TOKYO)
  assert.ok(Math.abs(norm360(back - there) - 180) < 1)
})

test('relativeBearing wraps the short way round north', () => {
  assert.equal(relativeBearing(10, 350), 20)     // 20° to the right
  assert.equal(relativeBearing(350, 10), -20)    // 20° to the left
  assert.equal(relativeBearing(180, 0), 180)     // dead behind
})

test('compass16 covers the cardinals and rejects nulls', () => {
  assert.equal(compass16(0), 'N')
  assert.equal(compass16(90), 'E')
  assert.equal(compass16(180), 'S')
  assert.equal(compass16(270), 'W')
  assert.equal(compass16(359), 'N')
  assert.equal(compass16(null), '--')
})

test('circularEma averages across the 0° seam', () => {
  const m = circularEma(359, 1, 0.5)
  assert.ok(m > 359.5 || m < 0.5, `got ${m}`)
})

test('elevation angle: Fuji from Tokyo sits under 2° up', () => {
  const a = elevationAngleDeg(haversineM(TOKYO, FUJI), 40, 3776)
  assert.ok(a !== null && a > 1.5 && a < 2.0, `got ${a}`)
})

test('elevation angle goes negative for a summit below you', () => {
  const a = elevationAngleDeg(10000, 3000, 500)
  assert.ok(a !== null && a < 0)
})

// ── peaks ────────────────────────────────────────────────────────────────────
test('parseEle handles the shapes OSM actually contains', () => {
  assert.equal(parseEle('3776'), 3776)
  assert.equal(parseEle('3776 m'), 3776)
  assert.equal(parseEle('3,776'), 3776)
  assert.equal(parseEle('1234.5'), 1234.5)
  assert.equal(parseEle(2057), 2057)
  assert.equal(parseEle(undefined), null)
  assert.equal(parseEle('unknown'), null)
})

test('parseElements keeps named summits, sorted tallest first', () => {
  const peaks = parseElements([
    { id: 1, lat: 35.36, lon: 138.72, tags: { natural: 'volcano', name: '富士山', 'name:en': 'Mount Fuji', ele: '3776' } },
    { id: 2, lat: 35.7, lon: 138.8, tags: { natural: 'peak', name: '大菩薩嶺', ele: '2057' } },
    { id: 3, lat: 35.7, lon: 138.9, tags: { natural: 'peak', ele: '1500' } },      // unnamed → dropped
    { id: 4, lat: 35.7, lon: 139.0, tags: { natural: 'peak', name: 'No ele' } },   // kept, ele unknown
  ], 'local')

  assert.deepEqual(peaks.map(p => p.name), ['富士山', '大菩薩嶺', 'No ele'])
  assert.equal(peaks[0]!.volcano, true)
  assert.equal(peaks[1]!.volcano, false)
  assert.equal(peaks[2]!.eleM, null)
})

test('parseElements honours the English name preference', () => {
  const [p] = parseElements([
    { id: 1, lat: 35.36, lon: 138.72, tags: { natural: 'volcano', name: '富士山', 'name:en': 'Mount Fuji', ele: '3776' } },
  ], 'en')
  assert.equal(p!.name, 'Mount Fuji')
})

test('cacheCovers: the cached disc has to contain the wanted disc', () => {
  const set: PeakSet = { ...TOKYO, radiusKm: 50, ts: Date.now(), peaks: [] }
  assert.equal(cacheCovers(set, TOKYO, 50), true)          // same spot, same radius
  assert.equal(cacheCovers(set, TOKYO, 60), false)         // wants more than was fetched
  assert.equal(cacheCovers(null, TOKYO, 10), false)
  // 30 km away with a 20 km request still fits inside the cached 50 km disc.
  assert.equal(cacheCovers(set, { lat: 35.95, lon: 139.7671 }, 20), true)
  assert.equal(cacheCovers(set, { lat: 35.95, lon: 139.7671 }, 40), false)
  const stale: PeakSet = { ...set, ts: Date.now() - 60 * 86400000 }
  assert.equal(cacheCovers(stale, TOKYO, 50), false)
})

// ── views ────────────────────────────────────────────────────────────────────
const PEAKS: Peak[] = [
  { id: 1, name: 'Fuji', lat: FUJI.lat, lon: FUJI.lon, eleM: 3776, volcano: true },
  { id: 2, name: 'North', lat: TOKYO.lat + 0.09, lon: TOKYO.lon, eleM: 1200, volcano: false },  // ~10 km N
  { id: 3, name: 'Low', lat: TOKYO.lat + 0.18, lon: TOKYO.lon, eleM: 400, volcano: false },     // ~20 km N
  { id: 4, name: 'NoEle', lat: TOKYO.lat + 0.27, lon: TOKYO.lon, eleM: null, volcano: false },
]

function viewer(headingDeg: number | null) {
  return { pos: TOKYO, altitudeM: 40, headingDeg }
}

function withSettings(patch: Partial<Settings>): Settings {
  return clampSettings({ ...DEFAULT_SETTINGS, ...patch })
}

test('radius filter drops anything further out', () => {
  // North ~10 km, Low ~20 km, NoEle ~30 km, Fuji ~100 km.
  const near = buildViews(PEAKS, viewer(null), withSettings({ radiusKm: 25, minEleM: 0 }), 'near')
  assert.deepEqual(near.map(v => v.peak.name), ['North', 'Low'])
})

test('height filter drops low and unknown-height summits', () => {
  const near = buildViews(PEAKS, viewer(null), withSettings({ radiusKm: 200, minEleM: 1000 }), 'near')
  assert.deepEqual(near.map(v => v.peak.name), ['North', 'Fuji'])
})

test('minEle 0 keeps summits with no height tag', () => {
  const near = buildViews(PEAKS, viewer(null), withSettings({ radiusKm: 200, minEleM: 0 }), 'near')
  assert.ok(near.some(v => v.peak.name === 'NoEle'))
})

test('FACING keeps only the cone ahead, nearest-to-centre first', () => {
  // Facing WSW: Fuji is dead ahead, the northern peaks are behind you.
  const facing = buildViews(PEAKS, viewer(249.6),
    withSettings({ radiusKm: 200, minEleM: 0, fovDeg: 90 }), 'facing')
  assert.deepEqual(facing.map(v => v.peak.name), ['Fuji'])
  assert.ok(Math.abs(facing[0]!.rel!) < 1)
})

test('FACING with a 360° field of view still orders by offset', () => {
  const all = buildViews(PEAKS, viewer(0),
    withSettings({ radiusKm: 200, minEleM: 0, fovDeg: 360 }), 'facing')
  assert.equal(all[0]!.peak.name, 'North')            // due north = 0° off
  assert.equal(all[all.length - 1]!.peak.name, 'Fuji') // ~110° off
})

test('FACING degrades to NEAR when there is no heading', () => {
  const s = withSettings({ radiusKm: 200, minEleM: 0 })
  const noHeading = buildViews(PEAKS, viewer(null), s, 'facing')
  assert.deepEqual(noHeading.map(v => v.peak.name),
    buildViews(PEAKS, viewer(null), s, 'near').map(v => v.peak.name))
})

test('HIGH sorts by elevation, unknown last', () => {
  const high = buildViews(PEAKS, viewer(null), withSettings({ radiusKm: 200, minEleM: 0 }), 'high')
  assert.deepEqual(high.map(v => v.peak.name), ['Fuji', 'North', 'Low', 'NoEle'])
})

// ── HUD ──────────────────────────────────────────────────────────────────────
test('distances stay in one column width', () => {
  assert.equal(fmtDist(4200), '4.2km')
  assert.equal(fmtDist(42300), '42km')
  assert.equal(fmtDist(150000), '150km')
  assert.equal(fmtDist(900), '0.9km')
})

test('offset column is fixed width and picks the right arrow', () => {
  assert.equal(fmtRel(null).length, 4)
  assert.equal(fmtRel(0), ' ↑  ')
  assert.equal(fmtRel(12), '→ 12')
  assert.equal(fmtRel(-45), '← 45')
  assert.equal(fmtRel(-145).length, 4)
})

test('a peak row is columnar and marks what is dead ahead', () => {
  const [view] = buildViews([PEAKS[0]!], viewer(249.6),
    withSettings({ radiusKm: 200, minEleM: 0 }), 'near')
  const row = peakRow(view!)
  assert.match(row, /^> WSW  ↑ {3} {2}101km {2}3776m {2}Fuji ▲$/)
})

test('rows fit the panel: no more than 44 columns', () => {
  const views = buildViews(PEAKS, viewer(0), withSettings({ radiusKm: 200, minEleM: 0 }), 'near')
  for (const v of views) {
    assert.ok(peakRow(v).length <= 44, `${peakRow(v).length}: ${peakRow(v)}`)
  }
})

function hudInput(overrides: Record<string, unknown> = {}) {
  const settings = withSettings({ radiusKm: 50, minEleM: 1000 })
  const views = buildViews(PEAKS, viewer(0), settings, 'near')
  return {
    clock: '14:23',
    weather: { tempC: 21, humidity: 40, cond: 'Clear', siteEleM: 40, ts: Date.now() },
    altitudeM: 40,
    headingDeg: 23,
    headingKind: 'compass' as const,
    glassesBatteryPct: 85,
    settings,
    mode: 'near' as const,
    views,
    totalInRange: views.length,
    scrollOffset: 0,
    status: null as string | null,
    ...overrides,
  }
}

test('info row carries clock, weather, altitude and battery within 44 columns', () => {
  const { info } = renderHud(hudInput())
  assert.equal(info, '14:23  21°C Clear 40%  ALT 40m  G85%')
  assert.ok(info.length <= 44, `${info.length} columns`)
})

test('info row degrades gracefully with nothing to show', () => {
  const { info } = renderHud(hudInput({ weather: null, altitudeM: null, glassesBatteryPct: null }))
  assert.equal(info, '14:23  weather --  ALT --  G--')
})

test('header row shows mode, heading and the active filters', () => {
  const { hdr } = renderHud(hudInput())
  assert.equal(hdr, 'NEAR NNE 23°  1/1  r50 ≥1000m  tap=mode')
  assert.ok(hdr.length <= 44, `${hdr.length} columns`)
})

test('header marks a GPS-derived heading and copes without one', () => {
  assert.match(renderHud(hudInput({ headingKind: 'gps' })).hdr, /NNE 23°~/)
  assert.match(renderHud(hudInput({ headingDeg: null, headingKind: null })).hdr, /DIR --/)
})

test('status text replaces the list entirely', () => {
  const { list } = renderHud(hudInput({ status: 'Waiting for a GPS fix…' }))
  assert.equal(list, 'Waiting for a GPS fix…')
})

test('an empty list explains itself instead of going blank', () => {
  assert.match(renderHud(hudInput({ views: [], mode: 'facing' })).list, /Turn around/)
  assert.match(renderHud(hudInput({ views: [] })).list, /No peaks within 50km above 1000m/)
})

test('the list never renders more rows than fit', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: i, name: `P${i}`, lat: TOKYO.lat + 0.01 * (i + 1), lon: TOKYO.lon, eleM: 1500, volcano: false,
  }))
  const views = buildViews(many, viewer(0), withSettings({ radiusKm: 100, minEleM: 0 }), 'near')
  const { list } = renderHud(hudInput({ views, totalInRange: views.length, scrollOffset: 10 }))
  const lines = list.split('\n')
  assert.equal(lines.length, LIST_MAX_LINES)
  assert.match(lines[0]!, /P10$/)
})

test('scroll offset is clamped to the list', () => {
  assert.equal(clampOffset(-5, 30), 0)
  assert.equal(clampOffset(99, 30), 30 - LIST_MAX_LINES)
  assert.equal(clampOffset(5, 3), 0)          // fewer rows than a screen: no scroll
})

test('settings are clamped to the ranges the UI offers', () => {
  const s = clampSettings({ ...DEFAULT_SETTINGS, radiusKm: 9999, minEleM: -100, fovDeg: 1 })
  assert.equal(s.radiusKm, 200)
  assert.equal(s.minEleM, 0)
  assert.equal(s.fovDeg, 10)
})

console.log(failures === 0 ? '\nall tests passed' : `\n${failures} test(s) failed`)
process.exit(failures === 0 ? 0 : 1)

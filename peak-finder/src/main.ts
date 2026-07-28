import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

import { installDebugLog } from './debugLog'
import { LocationSource, type Fix } from './location'
import { HeadingSource } from './heading'
import { fetchWeather, type WeatherInfo } from './weather'
import {
  fetchPeaks, loadPeakCache, savePeakCache, cacheCovers, type PeakSet,
} from './peaks'
import { buildViews, VIEW_MODES, type PeakView, type ViewMode } from './view'
import { renderHud, CELL_KEYS, clampOffset, LIST_MAX_LINES, type HudCells } from './hud'
import { DEFAULT_SETTINGS, clampSettings, type Settings } from './types'
import { renderPanel, refreshPanelLive, type PanelState } from './ui/panel'

// ── Canvas geometry ──────────────────────────────────────────────────────────
const CANVAS_W = 576
const CANVAS_H = 288
const ROW_H = 28

const INFO_Y = 0
const HDR_Y = ROW_H              // 28
const LIST_Y = ROW_H * 2         // 56
const LIST_H = CANVAS_H - LIST_Y // 232 → 8 rows

// ── State ────────────────────────────────────────────────────────────────────
type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

const location = new LocationSource()
const heading = new HeadingSource()

let bridge: Bridge | null = null
let settings: Settings = { ...DEFAULT_SETTINGS }
let peakSet: PeakSet | null = null
let views: PeakView[] = []
let totalInRange = 0
let mode: ViewMode = 'facing'
let scrollOffset = 0
let weather: WeatherInfo | null = null
let glassesBatteryPct: number | null = null
let glassesSn: string | null = null
let glassesConnected = true

// Heading actually used for display and ordering. Updated only once the smoothed
// compass has moved a couple of degrees — otherwise every row in FACING mode
// re-sorts on sensor noise while you stand perfectly still.
const HEADING_HYSTERESIS_DEG = 2
let displayHeading: number | null = null

type PeakStatus = 'idle' | 'loading' | 'error'
let peakStatus: PeakStatus = 'idle'
let peakError: string | null = null

// ── Peak fetching ────────────────────────────────────────────────────────────
// Overpass is a shared public service, so a failed fetch backs off instead of
// retrying on the next tick, and a successful one is cached until you walk out
// of the area it covers.
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 10 * 60 * 1000
let retryCount = 0
let nextFetchAllowedAt = 0

async function refreshPeaks(force: boolean): Promise<void> {
  const fix = location.lastFix
  if (fix === null || peakStatus === 'loading') return
  if (!force && cacheCovers(peakSet, fix, settings.radiusKm)) return
  if (!force && Date.now() < nextFetchAllowedAt) return

  peakStatus = 'loading'
  peakError = null
  void flushHud()
  renderPhonePanel()

  try {
    const set = await fetchPeaks(fix.lat, fix.lon, settings.radiusKm, settings.nameLang)
    peakSet = set
    peakStatus = 'idle'
    retryCount = 0
    nextFetchAllowedAt = 0
    if (bridge) {
      const b = bridge
      await savePeakCache(async (k, v) => { await b.setLocalStorage(k, v) }, set)
    }
  } catch (e) {
    peakStatus = 'error'
    peakError = e instanceof Error ? e.message : String(e)
    retryCount++
    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (retryCount - 1))
    nextFetchAllowedAt = Date.now() + wait
    console.error(`[peaks] fetch failed (${peakError}) — next attempt in ${Math.round(wait / 1000)}s`)
  }

  recomputeViews()
  void flushHud()
  renderPhonePanel()
}

// ── View computation ─────────────────────────────────────────────────────────
function viewerAltitude(): number | null {
  // A GPS fix knows if you're on a rooftop; the weather model's DEM elevation
  // only knows the ground. Prefer GPS, fall back to the DEM.
  return location.altitudeM ?? weather?.siteEleM ?? null
}

function recomputeViews(): void {
  const fix = location.lastFix
  if (fix === null || peakSet === null) {
    views = []
    totalInRange = 0
    return
  }
  const viewer = {
    pos: { lat: fix.lat, lon: fix.lon },
    altitudeM: viewerAltitude(),
    headingDeg: displayHeading,
  }
  views = buildViews(peakSet.peaks, viewer, settings, mode)
  // "In range" is mode-independent: it's what NEAR would show, i.e. everything
  // that passes the radius and height filters.
  totalInRange = mode === 'near'
    ? views.length
    : buildViews(peakSet.peaks, viewer, settings, 'near').length
  scrollOffset = clampOffset(scrollOffset, views.length)
}

function statusText(): string | null {
  if (location.lastFix === null) return 'Waiting for a GPS fix…'
  if (peakStatus === 'loading') return 'Loading peaks from OpenStreetMap…'
  if (peakSet === null && peakStatus === 'error') {
    return `Peak data unavailable\n${peakError ?? ''}\nRetrying automatically — check the phone panel.`
  }
  if (peakSet === null) return 'No peak data yet.'
  return null
}

// ── HUD plumbing ─────────────────────────────────────────────────────────────
let cachedCells: HudCells = { info: '', hdr: '', list: '' }
let pageReady = false
let pageBuiltOnce = false
let pageFailLogged = false
let textFails = 0
const TEXT_FAILS_BEFORE_REBUILD = 3
const PAGE_RETRY_MS = 5000

const PAGE_RESULT_NAMES: Record<number, string> = {
  0: 'success', 1: 'invalid', 2: 'oversize', 3: 'outOfMemory',
}

function buildHudInput() {
  const now = new Date()
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return {
    clock,
    weather,
    altitudeM: viewerAltitude(),
    headingDeg: displayHeading,
    headingKind: heading.kind,
    glassesBatteryPct,
    settings,
    mode,
    views,
    totalInRange,
    scrollOffset,
    status: statusText(),
  }
}

function makeContainer(
  id: number, name: keyof HudCells,
  x: number, y: number, w: number, h: number,
  content: string, isEventCapture: 0 | 1,
): TextContainerProperty {
  return new TextContainerProperty({
    containerID: id,
    containerName: name,
    xPosition: x, yPosition: y,
    width: w, height: h,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0,
    content,
    isEventCapture,
  })
}

async function ensurePage(b: Bridge): Promise<void> {
  if (pageReady) return

  const initial = renderHud(buildHudInput())
  const result = await b.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [
      makeContainer(1, 'info', 0, INFO_Y, CANVAS_W, ROW_H, initial.info, 1),
      makeContainer(2, 'hdr', 0, HDR_Y, CANVAS_W, ROW_H, initial.hdr, 0),
      makeContainer(3, 'list', 0, LIST_Y, CANVAS_W, LIST_H, initial.list, 0),
    ],
    imageObject: [],
  })).catch(e => { console.error('[page] create threw:', e); return null })

  if (result !== StartUpPageCreateResult.success) {
    const name = typeof result === 'number' ? PAGE_RESULT_NAMES[result] ?? String(result) : result
    if (!pageFailLogged) {
      pageFailLogged = true
      console.error(`[page] create failed: ${name} — retrying every ${PAGE_RETRY_MS / 1000}s ` +
        `(usually means the glasses aren't connected yet)`)
    }
    return
  }

  // A rebuild means the link dropped and came back; the location subscription
  // can go with it, so re-arm it rather than showing a frozen screen.
  if (pageBuiltOnce) void rearmLocation(b)
  pageBuiltOnce = true

  pageReady = true
  pageFailLogged = false
  cachedCells = { info: '', hdr: '', list: '' }   // fresh page = empty containers
  console.info('[page] HUD containers created')
  await flushHud()
}

async function rearmLocation(b: Bridge): Promise<void> {
  try {
    location.stop()
    await location.start(b, onFix)
    console.info('[loc] re-armed after reconnect')
  } catch (e) {
    console.warn('[loc] re-arm failed:', e)
  }
}

// Gestures, the tick, weather and peak fetches all want to push the screen, and
// a text upgrade is a BLE round trip. Overlapping flushes would queue frames on
// a slow link, so a flush in flight just marks the screen dirty and the running
// one picks the change up when it finishes.
let flushing = false
let flushDirty = false

async function flushHud(): Promise<void> {
  if (flushing) { flushDirty = true; return }
  flushing = true
  try {
    do {
      flushDirty = false
      await flushOnce()
    } while (flushDirty)
  } finally {
    flushing = false
  }
}

async function flushOnce(): Promise<void> {
  if (!bridge || !pageReady) return
  const cells = renderHud(buildHudInput())

  for (let i = 0; i < CELL_KEYS.length; i++) {
    const key = CELL_KEYS[i]!
    if (cells[key] === cachedCells[key]) continue
    cachedCells[key] = cells[key]
    const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: i + 1,
      containerName: key,
      contentOffset: 0,
      contentLength: 0,
      content: cells[key],
    })).catch(e => { console.error(e); return false })

    if (ok) {
      textFails = 0
    } else if (++textFails >= TEXT_FAILS_BEFORE_REBUILD) {
      // The glasses no longer have the page we're addressing. Rebuild it instead
      // of pushing updates at containers that aren't there.
      textFails = 0
      pageReady = false
      console.warn('[page] text upgrades failing — will rebuild the page')
      return
    }
  }
}

// ── Sensors ──────────────────────────────────────────────────────────────────
function onFix(fix: Fix): void {
  heading.setCourse(fix.courseDeg)
  // Peaks and weather were both waiting on a position. refreshPeaks is a no-op
  // while the cached set still covers where you are.
  void refreshPeaks(false)
  if (weather === null) void refreshWeather()
}

function updateDisplayHeading(): void {
  heading.refresh()
  const h = heading.deg
  if (h === null) {
    displayHeading = null
    return
  }
  if (displayHeading === null) {
    displayHeading = h
    return
  }
  const diff = Math.abs(((h - displayHeading + 540) % 360) - 180)
  if (diff >= HEADING_HYSTERESIS_DEG) displayHeading = h
}

let weatherBusy = false
async function refreshWeather(): Promise<void> {
  const fix = location.lastFix
  if (weatherBusy || fix === null) return
  weatherBusy = true
  try {
    const w = await fetchWeather(fix.lat, fix.lon)
    if (w !== null) {
      weather = w
      void flushHud()
      renderPhonePanel()
    }
  } finally {
    weatherBusy = false
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────────
function tick(): void {
  updateDisplayHeading()
  recomputeViews()
  void flushHud()
  refreshPanelLive(panelState())
}

// ── Persistence ──────────────────────────────────────────────────────────────
async function loadAll(b: Bridge): Promise<void> {
  const raw = await b.getLocalStorage('settings_v1').catch(() => null)
  if (raw) {
    try {
      settings = clampSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) as Partial<Settings> })
    } catch { /* keep defaults */ }
  }
  peakSet = await loadPeakCache(k => b.getLocalStorage(k).catch(() => null))
  if (peakSet !== null) {
    console.info(`[peaks] ${peakSet.peaks.length} peaks from cache ` +
      `(r=${peakSet.radiusKm}km, ${Math.round((Date.now() - peakSet.ts) / 86400000)}d old)`)
  }
}

async function saveSettings(b: Bridge): Promise<void> {
  await b.setLocalStorage('settings_v1', JSON.stringify(settings)).catch(console.error)
}

// ── Wake lock ────────────────────────────────────────────────────────────────
let wakeLock: { release: () => Promise<void> } | null = null

async function requestWakeLock(): Promise<void> {
  if (wakeLock !== null || !('wakeLock' in navigator)) return
  try {
    wakeLock = await (navigator as unknown as {
      wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> }
    }).wakeLock.request('screen')
    console.log('[wakelock] active')
  } catch (e) {
    console.warn('[wakelock] failed:', e)
  }
}

function releaseWakeLock(): void {
  wakeLock?.release().catch(() => {})
  wakeLock = null
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && settings.useWakeLock) void requestWakeLock()
})

// ── Phone panel ──────────────────────────────────────────────────────────────
function panelState(): PanelState {
  return {
    settings,
    views,
    totalInRange,
    peakSet,
    peakStatus,
    peakError,
    fix: location.lastFix,
    locationSource: location.source,
    altitudeM: viewerAltitude(),
    heading,
    weather,
    mode,
  }
}

function renderPhonePanel(): void {
  const root = document.getElementById('panel-root')
  if (!root || !bridge) return
  const b = bridge
  renderPanel(root, panelState(), {
    onSettingsChange(next) {
      const prev = settings
      settings = clampSettings(next)
      void saveSettings(b)
      if (settings.useWakeLock && !prev.useWakeLock) void requestWakeLock()
      if (!settings.useWakeLock && prev.useWakeLock) releaseWakeLock()
      // A wider radius, or a different name language, needs data we don't have.
      if (settings.radiusKm > prev.radiusKm || settings.nameLang !== prev.nameLang) {
        void refreshPeaks(settings.nameLang !== prev.nameLang)
      }
      recomputeViews()
      void flushHud()
      renderPhonePanel()
    },
    onRefreshPeaks() {
      void refreshPeaks(true)
    },
    async onEnableCompass() {
      const ok = await heading.enable()
      console.info(`[heading] enable -> ${ok ? 'ok' : 'refused'}`)
      renderPhonePanel()
    },
    onModeChange(next) {
      mode = next
      scrollOffset = 0
      recomputeViews()
      void flushHud()
      renderPhonePanel()
    },
  })
}

function setStatus(html: string): void {
  const el = document.getElementById('app-status')
  if (el) el.innerHTML = html
}

// ── Gestures ─────────────────────────────────────────────────────────────────
function cycleMode(): void {
  const i = VIEW_MODES.indexOf(mode)
  mode = VIEW_MODES[(i + 1) % VIEW_MODES.length]!
  scrollOffset = 0
  recomputeViews()
  renderPhonePanel()
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  installDebugLog()
  try {
    const b = await waitForEvenAppBridge()
    bridge = b

    await loadAll(b)

    // Android delivers absolute orientation without a permission prompt; iOS
    // refuses outside a user gesture, which is what the panel button is for.
    void heading.enable().then(ok => {
      if (!ok) console.info('[heading] compass needs the "Enable compass" button on the phone')
      renderPhonePanel()
    })

    await location.start(b, onFix)

    b.getDeviceInfo().then(di => {
      console.info(`[link] device: isGlasses=${di?.isGlasses()} sn="${di?.sn ?? ''}" ` +
        `connectType=${di?.status?.connectType} battery=${di?.status?.batteryLevel}`)
      if (di?.isGlasses()) {
        glassesSn = di.sn
        if (typeof di.status.batteryLevel === 'number') glassesBatteryPct = di.status.batteryLevel
      }
    }).catch(e => console.warn('[link] getDeviceInfo failed:', e))

    b.onDeviceStatusChanged(st => {
      // The host also emits empty placeholder events (sn "", battery 0,
      // connectType "none"); only events that identify the glasses mean anything.
      const sn = st.sn ?? ''
      if (sn !== '' && (glassesSn === null || sn === glassesSn)) {
        const connected = !!st.connectType && st.connectType !== 'none'
        if (connected !== glassesConnected) {
          glassesConnected = connected
          console.info(`[link] glasses ${connected ? 'connected' : 'DISCONNECTED'}`)
        }
      }
      if ((glassesSn === null || st.sn === glassesSn) && typeof st.batteryLevel === 'number') {
        glassesBatteryPct = st.batteryLevel
      }
    })

    await ensurePage(b)
    setInterval(() => { void ensurePage(b) }, PAGE_RETRY_MS)

    setInterval(tick, 1000)
    setInterval(() => { void refreshWeather() }, 10 * 60 * 1000)
    // Cheap: only actually fetches when you've walked out of the cached area.
    setInterval(() => { void refreshPeaks(false) }, 60 * 1000)

    if (settings.useWakeLock) void requestWakeLock()

    const unsub = b.onEvenHubEvent(async event => {
      const type = event.sysEvent?.eventType
        ?? event.textEvent?.eventType
        ?? event.listEvent?.eventType
        ?? OsEventTypeList.CLICK_EVENT

      switch (type) {
        // Single tap cycles FACING → NEAR → HIGH.
        case OsEventTypeList.CLICK_EVENT:
          cycleMode()
          await flushHud()
          break

        // Double tap closes the app.
        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          await b.shutDownPageContainer(1)
          break

        // Swipes scroll the list.
        case OsEventTypeList.SCROLL_TOP_EVENT:
          scrollOffset = clampOffset(scrollOffset + LIST_MAX_LINES, views.length)
          await flushHud()
          break

        case OsEventTypeList.SCROLL_BOTTOM_EVENT:
          scrollOffset = clampOffset(scrollOffset - LIST_MAX_LINES, views.length)
          await flushHud()
          break
      }
    })

    window.addEventListener('beforeunload', () => {
      location.stop()
      heading.stop()
      releaseWakeLock()
      unsub()
    })

    setStatus('<span style="color:#4a4">Peak Finder ready.</span>')
    renderPhonePanel()
    await flushHud()

  } catch (err: unknown) {
    setStatus(`<span style="color:#f44">Fatal: ${String(err)}</span>`)
    console.error(err)
  }
}

main().catch(console.error)

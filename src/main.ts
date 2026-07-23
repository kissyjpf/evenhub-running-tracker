import {
  waitForEvenAppBridge,
  TextContainerProperty,
  OsEventTypeList,
  ImuReportPace,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
} from '@evenrealities/even_hub_sdk'
import {
  renderPacePng, renderPaceGray, renderPaceText,
  PACE_IMG_W, PACE_IMG_H, PACE_IMG_GRAY4_BYTES,
} from './paceImage'

// Set false to fall back to a tiled-text pace readout over the text channel.
// (Image frames were suspected of wedging the link, but text fails at the same
// point with images disabled entirely — the link itself drops.)
const USE_PACE_IMAGE = true
import { installDebugLog } from './debugLog'

import { makeInitialState, activeElapsedMs, lapElapsedMs, lapDistanceM, recordLap } from './state'
import type { AppState } from './state'
import { SensorManager } from './sensors/manager'
import { haversineM } from './sensors/gps'
import type { GpsFix } from './sensors/gps'
import { PaceEstimator } from './pace'
import { loadRecords, saveRecords, insertRecord } from './calibration/records'
import { loadRuns, saveRuns, insertRun } from './runs'
import { harvestCalibRecord } from './calibration/harvest'
import type { RunSample } from './calibration/harvest'
import { renderHUD, HUDCells, CELL_KEYS, type HudModal } from './hud'
import { renderSettingsUI } from './settings/ui'
import { fetchWeather, type WeatherInfo } from './weather'
import { DEFAULT_SETTINGS } from './types'
import type { CalibRecord } from './types'

// ── Canvas geometry ──────────────────────────────────────────────────────────
const CANVAS_W  = 576
const CANVAS_H  = 288
const ROW_H     = 28

// Left column (elapsed+dist / cadence / segment+lap+gps)
const LEFT_W    = 360
const L1_Y      = 0
const L2_Y      = ROW_H          // 28
const L3_Y      = ROW_H * 2      // 56

// Top-right info block (clock / weather / compass / battery)
const INFO_X    = 372
const INFO_W    = CANVAS_W - INFO_X   // 204
const INFO_Y    = 0
const INFO_H    = ROW_H * 4      // 112

// Bottom large pace readout — a dot-matrix bitmap in an image container (the
// fixed base font is too coarse to tile a big number). Size must match the
// PNG produced by paceImage.ts; SDK limits are width ≤288, height ≤144.
const IMG_W     = PACE_IMG_W
const IMG_H     = PACE_IMG_H
const IMG_X     = Math.floor((CANVAS_W - IMG_W) / 2)   // centred horizontally
const IMG_Y     = 140
// Text-fallback geometry for the same readout (7 tiled rows).
const PACE_TEXT_Y = 116
const PACE_TEXT_H = CANVAS_H - PACE_TEXT_Y
const UNIT_X    = 470
const UNIT_Y    = 252
const UNIT_W    = CANVAS_W - UNIT_X

// Centre modal overlay
const MODAL_X   = 130
const MODAL_Y   = 116
const MODAL_W   = 320
const MODAL_H   = ROW_H * 3      // 84

// ── Module-level singletons ──────────────────────────────────────────────────
const state   = makeInitialState()
const sensors = new SensorManager()
const pace    = new PaceEstimator()

// Rolling GPS speed buffer for computing speed CoV (last 10 values)
const gpsSpeedBuf: number[] = []
// Plausibility limits for integrating GPS fixes into distance.
const GPS_MAX_SPEED_MS    = 7.0    // ~2:23/km — above any running pace, so a jump
const GPS_MIN_SPEED_MS    = 0.7    // below this it's jitter, not travel
const GPS_MAX_GAP_S       = 10     // never bridge a dropout; that's where jumps land
const GPS_MAX_ACCURACY_M  = 30
// Dead reckoning is for bridging short GPS gaps, not for standing still. Without
// a deadline it invents distance for as long as the sensor reports a cadence.
const DEAD_RECKON_MAX_MS  = 30_000
// Auto-pause after this long without movement.
const AUTO_PAUSE_AFTER_MS = 5_000
// Resume only on a fresh GPS fix (not the long dead-reckoning grace).
const AUTO_RESUME_MS      = 3_000

// Displayed pace is averaged over this trailing window of distance vs time.
// 8 s is responsive; the light EMA below tames the extra jitter that comes with
// a shorter window.
const PACE_WINDOW_MS = 8_000
// EMA on the window *speed* (m/s, not pace) so smoothing stays harmonic-correct
// and doesn't reintroduce the pace-space slow bias. ~0.7 ≈ 3 s time constant.
const PACE_EMA_ALPHA = 0.7
let paceSpeedEma: number | null = null
// Show "-:--" once almost no ground has been covered for this long. Judged on a
// short recent slice so a stop registers quickly, independent of the longer
// averaging window.
const PACE_STOP_MS = 5_000
const paceWindow: { ms: number, distM: number }[] = []

let pendingDistM  = 0       // GPS distance accumulated between 1Hz ticks
let lastMovingMs  = 0       // last time GPS confirmed real movement
let lastProgressMs= 0       // last tick distance actually advanced (incl. dead reckoning)
let autoPaused    = false   // true only while auto-pause owns the paused state
const gpsSkipped = { gap: 0, accuracy: 0, jump: 0, still: 0 }
let lastGpsFix: GpsFix | null = null
let totalStepEst  = 0       // cumulative step count estimate (from cadence × dt)

// ── Bridge helpers ────────────────────────────────────────────────────────────
type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>

function makeContainer(
  id: number,
  name: keyof HUDCells,
  x: number, y: number,
  w: number, h: number,
  content: string,
  isEventCapture: 0 | 1,
): TextContainerProperty {
  return new TextContainerProperty({
    containerID:   id,
    containerName: name,
    xPosition: x, yPosition: y,
    width: w, height: h,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0,
    content,
    isEventCapture,
  })
}

let cachedCells: HUDCells = { l1:'', l2:'', l3:'', info:'', pb:'', pu:'', mo:'', lap:'' }
let bridge: Bridge | null = null
let hudModal: HudModal = { type: 'none' }

// Lap list (separate scrollable screen opened with a swipe)
let lapView = false
let lapScrollOffset = 0

// Top-right info block sources
let weather: WeatherInfo | null = null
let glassesBatteryPct: number | null = null
let glassesSn: string | null = null
let glassesConnected = true    // assumed until a status update says otherwise
let textUpgradeLogged: boolean | null = null
let linkHealthy = true
let textFails = 0
const TEXT_FAILS_BEFORE_REBUILD = 3
let lastHeadingDeg: number | null = null

async function flushHUD(): Promise<void> {
  if (!bridge || !pageReady) return
  const h = buildHudInput()
  const cells = renderHUD(h)

  for (let i = 0; i < CELL_KEYS.length; i++) {
    const key = CELL_KEYS[i]!
    if (key === 'pb' && USE_PACE_IMAGE) continue   // container 5 is an image
    if (cells[key] === cachedCells[key]) continue
    cachedCells[key] = cells[key]
    // cells.pb carries the plain pace string; expand it to the block font here.
    const content = key === 'pb' ? renderPaceText(cells[key]) : cells[key]
    const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID:   i + 1,
      containerName: key,
      contentOffset: 0,
      contentLength: 0,
      content,
    })).catch(e => { console.error(e); return false })
    // Text upgrades also report failure by return value. Logging the first
    // outcome distinguishes "the image API is broken" from "nothing reaches the
    // glasses at all".
    if (textUpgradeLogged !== ok) {
      textUpgradeLogged = ok
      console.info(`[link] textContainerUpgrade -> ${ok ? 'ok' : 'FAILED'} (${key})`)
    }
    // Text upgrades are the cheapest probe we have, so let them drive link
    // health: pushing image frames into a dropped link is what piles up and
    // takes the app down.
    linkHealthy = ok
    if (ok) {
      textFails = 0
      paceImgFails = 0
      paceImgDisabled = false
    } else if (++textFails >= TEXT_FAILS_BEFORE_REBUILD) {
      // The link came back but the page went with it. Rebuild it rather than
      // pushing updates at containers the glasses no longer have.
      textFails = 0
      pageReady = false
      console.warn('[page] text upgrades failing — will rebuild the page')
      return
    }
  }

  if (USE_PACE_IMAGE) await updatePaceImage(cells.pb)
}

// Push the big pace readout as a block dot-matrix bitmap. Image frames are slow
// over BLE, so: never overlap two sends, and leave a gap between them so text
// upgrades still get through. A deferred value is picked up by the next flush.
const PACE_IMG_MIN_INTERVAL_MS = 5000
let lastPaceImg = ''
let paceImgSending = false
let lastPaceImgAt = 0
let paceImgLogged = false   // log the first successful frame only, not every 5 s
let paceImgFails = 0
let paceImgLinkWarned = false
let paceImgDisabled = false

// The docs say imageData may be a base64 PNG or raw greyscale bytes, but this
// host only accepts raw greyscale — PNG comes back sendFailed. Probe greyscale
// first so a rejected PNG doesn't burn a send every cycle, and keep whichever
// format the glasses take.
type PaceImgFormat = 'png' | 'gray'
let paceImgFormat: PaceImgFormat | null = null

async function sendPaceFrame(text: string, fmt: PaceImgFormat): Promise<unknown> {
  const data = fmt === 'png' ? renderPacePng(text) : renderPaceGray(text)
  if (data === null) return null
  return bridge!.updateImageRawData(new ImageRawDataUpdate({
    containerID: 5, containerName: 'pb', imageData: data,
  }))
}

// Failed frames appear to pile up host-side (the app dies after enough of them),
// so stop issuing them rather than retrying forever.
const PACE_IMG_MAX_FAILS = 5

async function updatePaceImage(text: string): Promise<void> {
  if (!bridge || paceImgSending || text === lastPaceImg) return
  if (paceImgDisabled) return
  // Clearing the number (lap list / stop menu opened) and restoring it must not
  // wait out the throttle — otherwise the big pace bitmap shows through the lap
  // list for up to 5 s. Only steady pace updates are rate-limited.
  const isViewToggle = text.trim() === '' || lastPaceImg.trim() === ''
  if (!isViewToggle && Date.now() - lastPaceImgAt < PACE_IMG_MIN_INTERVAL_MS) return
  if (!glassesConnected || !linkHealthy) {
    if (!paceImgLinkWarned) {
      paceImgLinkWarned = true
      console.warn('[paceImage] skipped — link down (text upgrades failing)')
    }
    return
  }
  paceImgLinkWarned = false

  paceImgSending = true
  const prev = lastPaceImg
  lastPaceImg = text
  try {
    const order: PaceImgFormat[] = paceImgFormat ? [paceImgFormat] : ['gray', 'png']
    let ok = false
    for (const fmt of order) {
      const res = await sendPaceFrame(text, fmt)
      if (res === null) continue
      // updateImageRawData reports failure via its return value, not by throwing
      // — without checking it the image silently never appears.
      if (ImageRawDataUpdateResult.isSuccess(res as never)) {
        ok = true
        if (paceImgFormat !== fmt) {
          paceImgFormat = fmt
          console.info(`[paceImage] format=${fmt} accepted`)
        }
        break
      }
      console.error(
        `[paceImage] ${fmt} rejected: ${res} (${PACE_IMG_W}x${PACE_IMG_H}, ` +
        `~${PACE_IMG_GRAY4_BYTES}B gray4 over BLE)`)
    }

    if (ok) {
      paceImgFails = 0
      if (!paceImgLogged) {
        paceImgLogged = true
        console.info(`[paceImage] ok "${text}" ${PACE_IMG_W}x${PACE_IMG_H}`)
      }
    } else {
      lastPaceImg = prev   // retry this value later
      paceImgFails++
      console.error(`[paceImage] all formats failed (attempt ${paceImgFails})`)
      if (paceImgFails >= PACE_IMG_MAX_FAILS) {
        paceImgDisabled = true
        console.error(
          `[paceImage] giving up after ${paceImgFails} failures — no more frames ` +
          `will be sent (queued transfers are what take the app down)`)
      }
    }
  } catch (e) {
    lastPaceImg = ''   // force a retry on the next flush
    console.error('[paceImage] send threw:', e)
  } finally {
    // Back off after repeated failures so a dead link isn't hammered every 5 s.
    lastPaceImgAt = Date.now() +
      Math.min(paceImgFails, 6) * PACE_IMG_MIN_INTERVAL_MS
    paceImgSending = false
  }
}

// ── HUD page creation ─────────────────────────────────────────────────────────
// createStartUpPageContainer returns invalid(1) when there is no link yet, so
// creation is retried until it succeeds instead of leaving a blank display.
const PAGE_RETRY_MS = 5000
let pageReady = false
let pageBuiltOnce = false

// Re-subscribe the sensors after the glasses reconnect.
async function rearmSensors(b: Bridge): Promise<void> {
  try {
    await sensors.initGps(b)
    if (sensors.path === 'g2imu') {
      await b.imuControl(true, ImuReportPace.P200)
    }
    console.info(`[sensors] re-armed after reconnect (path=${sensors.path})`)
  } catch (e) {
    console.warn('[sensors] re-arm failed:', e)
  }
}

const PAGE_RESULT_NAMES: Record<number, string> = {
  0: 'success', 1: 'invalid', 2: 'oversize', 3: 'outOfMemory',
}

async function ensurePage(b: Bridge): Promise<void> {
  if (pageReady) return

  const initial = renderHUD(buildHudInput())
  cachedCells = { ...initial }

  const result = await b.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 8,
    textObject: [
      makeContainer(1, 'l1',   0,      L1_Y,   LEFT_W,   ROW_H,  initial.l1,   1),
      makeContainer(2, 'l2',   0,      L2_Y,   LEFT_W,   ROW_H,  initial.l2,   0),
      makeContainer(3, 'l3',   0,      L3_Y,   LEFT_W,   ROW_H,  initial.l3,   0),
      makeContainer(4, 'info', INFO_X, INFO_Y, INFO_W,   INFO_H, initial.info, 0),
      makeContainer(6, 'pu',   UNIT_X, UNIT_Y, UNIT_W,   ROW_H,  initial.pu,   0),
      makeContainer(7, 'mo',   MODAL_X, MODAL_Y, MODAL_W, MODAL_H, initial.mo, 0),
      makeContainer(8, 'lap',  0,      0,      CANVAS_W, CANVAS_H, initial.lap, 0),
      ...(USE_PACE_IMAGE ? [] : [
        makeContainer(5, 'pb', 0, PACE_TEXT_Y, CANVAS_W, PACE_TEXT_H,
          renderPaceText(initial.pb), 0),
      ]),
    ],
    // Image data can't be sent during startup — declare an empty placeholder
    // here and fill it with updatePaceImage() once the page exists.
    imageObject: USE_PACE_IMAGE ? [
      new ImageContainerProperty({
        containerID: 5, containerName: 'pb',
        xPosition: IMG_X, yPosition: IMG_Y,
        width: IMG_W, height: IMG_H,
      }),
    ] : [],
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

  // A rebuild means the link dropped and came back. The glasses stop streaming
  // IMU across a disconnect and never resume on their own, and the location
  // subscription can go with it — which showed up as the clock still running
  // while cadence, steps and speed sat frozen. Re-arm both.
  if (pageBuiltOnce) void rearmSensors(b)
  pageBuiltOnce = true

  pageReady = true
  pageFailLogged = false
  // A fresh page has empty containers, so force a full resend.
  cachedCells = { l1:'', l2:'', l3:'', info:'', pb:'', pu:'', mo:'', lap:'' }
  linkHealthy = true
  paceImgDisabled = false
  paceImgFails = 0
  lastPaceImg = ''
  console.info(`HUD containers created (5 = pace ${USE_PACE_IMAGE ? 'image' : 'text'})`)

  await flushHUD()
}
let pageFailLogged = false

// Immediately push a single cell to the glasses (bypasses cache).
// Resets the cache entry so flushHUD always re-syncs that cell afterward.
async function flashCell(key: keyof HUDCells, content: string): Promise<void> {
  if (!bridge) return
  const idx = CELL_KEYS.indexOf(key)
  if (idx < 0) return
  cachedCells[key] = ''  // force flushHUD to re-send this cell next call
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   idx + 1,
    containerName: key,
    contentOffset: 0,
    contentLength: 0,
    content,
  })).catch(console.error)
}

function buildHudInput() {
  const lp = state.lastPace
  const weightKg = state.settings.weight_kg ?? 65
  const calories = (state.totalDistanceM / 1000) * weightKg * 1.036
  const now = new Date()
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return {
    status:              state.status,
    elapsedMs:           activeElapsedMs(state),
    totalDistanceM:      state.totalDistanceM,
    laps:                state.laps,
    lapNumber:           state.laps.length + 1,
    lapDistanceM:        lapDistanceM(state),
    lapElapsedMs:        lapElapsedMs(state),
    lapView,
    lapScrollOffset,
    paceSPerKm:          lp?.paceSPerKm ?? null,
    cadenceSpm:          lp?.cadenceSpm ?? null,
    segmentPaceSPerKm:   state.segmentPaceSPerKm,
    kValue:              pace.k.value,
    calibRecordCount:    state.calibRecords.length,
    totalSteps:          Math.round(totalStepEst),
    calories,
    showSteps:           state.settings.showSteps,
    showCalories:        state.settings.showCalories,
    gpsAccuracyM:        sensors.gps.lastAccuracyM,
    clock,
    weather,
    headingDeg:          lastHeadingDeg,
    glassesBatteryPct,
    modal:               hudModal,
  }
}

// ── Speed CoV from buffer ────────────────────────────────────────────────────
function speedCov(): number {
  if (gpsSpeedBuf.length < 3) return 999
  const mean = gpsSpeedBuf.reduce((a, b) => a + b, 0) / gpsSpeedBuf.length
  if (mean < 0.1) return 999
  const variance = gpsSpeedBuf.reduce((s, v) => s + (v - mean) ** 2, 0) / gpsSpeedBuf.length
  return Math.sqrt(variance) / mean
}

// ── 1 Hz tick ────────────────────────────────────────────────────────────────
function tick(): void {
  const now = Date.now()

  // Consume accumulated GPS distance or fallback to dead reckoning
  const gpsOk = sensors.gps.lastAccuracyM < 30 && sensors.gps.lastSpeedMs !== null

  // Only dead-reckon while GPS recently confirmed movement. Standing at a light
  // with a poor fix used to keep banking distance (and steps) indefinitely,
  // because a stationary sensor still reports a plausible-looking cadence.
  const movingRecently = now - lastMovingMs < DEAD_RECKON_MAX_MS

  // Auto-pause: stop the clock when movement stops, resume when it returns.
  // Only ever undoes a pause it applied itself, so a manual pause still sticks.
  // Pausing keys off distance progress (which includes dead reckoning), not
  // GPS fixes alone — otherwise a 5 s GPS gap while still running would pause.
  // Resuming keys off a real GPS fix so a stationary jitter can't un-pause.
  if (state.settings.autoPause) {
    if (state.status === 'running' && now - lastProgressMs > AUTO_PAUSE_AFTER_MS) {
      state.status = 'paused'
      state.pauseStart = now - AUTO_PAUSE_AFTER_MS   // don't count the idle wait
      autoPaused = true
      console.log('[autopause] paused — no movement')
    } else if (state.status === 'paused' && autoPaused &&
               now - lastMovingMs < AUTO_RESUME_MS) {
      // Resume on a *fresh* GPS fix, not the 30 s dead-reckoning grace — that
      // stays true long after a stop and would immediately un-pause.
      if (state.pauseStart !== null) {
        state.pausedElapsed += now - state.pauseStart
        state.pauseStart = null
      }
      state.status = 'running'
      autoPaused = false
      lastProgressMs = now
      console.log('[autopause] resumed — moving again')
    }
  }

  if (state.status === 'running') {
    const before = state.totalDistanceM
    if (gpsOk) {
      state.totalDistanceM += pendingDistM
    } else if (state.lastPace && movingRecently) {
      // Dead reckoning: speedMs * dt (dt = 1s), capped at a runnable speed
      state.totalDistanceM += Math.min(state.lastPace.speedMs, GPS_MAX_SPEED_MS) * 1.0
    }
    // Real forward progress this tick → resets the auto-pause timer.
    if (state.totalDistanceM - before > 0.3) lastProgressMs = now
  }
  pendingDistM = 0

  // Estimate cadence step count — only count fresh, non-stale cadence so
  // steps stop accumulating the moment motion stops or the sensor stalls.
  const cadNow = sensors.freshCadence()
  if (state.status === 'running' && cadNow !== null && movingRecently) {
    totalStepEst += cadNow / 60   // 1s tick → cadence/60 steps
  }

  // Update pace estimator
  const result = pace.update({
    gpsSpeedMs:   sensors.gps.lastSpeedMs,
    gpsAccuracyM: sensors.gps.lastAccuracyM,
    cadenceSpm:   cadNow,
    verticalAmp:  sensors.lastVertAmp,
    speedCov:     speedCov(),
    records:      state.calibRecords,
    settings:     state.settings,
  })
  state.lastPace = result

  // Displayed "current pace" from a trailing distance/time window — the same
  // quantity as lap pace, so the two agree. The estimator smoothed 1000/v in
  // pace-space, which by Jensen's inequality reads slower than distance/time
  // whenever speed varies (badly so at walking speed, where the mean is small),
  // and it used Doppler speed while laps use accumulated distance. This removes
  // both mismatches. The estimator still drives dead reckoning and the k-scalar.
  if (state.status === 'running') {
    paceWindow.push({ ms: activeElapsedMs(state), distM: state.totalDistanceM })
    while (paceWindow.length > 2 &&
           paceWindow[paceWindow.length - 1]!.ms - paceWindow[0]!.ms > PACE_WINDOW_MS) {
      paceWindow.shift()
    }
    const b = paceWindow[paceWindow.length - 1]!

    // Stop detection over the last PACE_STOP_MS: distance barely moved → stopped.
    // Uses accumulated distance, so dead reckoning through a GPS gap still counts
    // as moving; only a genuine standstill trips it.
    let si = paceWindow.length - 1
    while (si > 0 && paceWindow[si - 1]!.ms >= b.ms - PACE_STOP_MS) si--
    const stopSpan = (b.ms - paceWindow[si]!.ms) / 1000
    const stopDist = b.distM - paceWindow[si]!.distM
    const stopped = stopSpan >= 4 && stopDist < 1.0

    if (stopped) {
      result.paceSPerKm = null
      paceSpeedEma = null            // re-seed cleanly on the next move
    } else {
      const a = paceWindow[0]!
      const dDist = b.distM - a.distM
      const dSec = (b.ms - a.ms) / 1000
      // Wait for a few seconds of data before showing anything — the first 1-3 s
      // of a run or lap is where the wild fast/slow swings came from.
      if (dSec >= 4 && dDist > 2) {
        const vWin = dDist / dSec    // m/s over the window
        paceSpeedEma = paceSpeedEma === null ? vWin
          : PACE_EMA_ALPHA * paceSpeedEma + (1 - PACE_EMA_ALPHA) * vWin
        result.paceSPerKm = 1000 / paceSpeedEma
      } else {
        result.paceSPerKm = null
      }
    }
  }

  // Collect run sample
  if (state.status === 'running') {
    const sample: RunSample = {
      ts:           now,
      distM:        state.totalDistanceM,
      speedMs:      result.speedMs,
      gpsAccuracyM: sensors.gps.lastAccuracyM,
      steps:        Math.round(totalStepEst),
      cadenceSpm:   cadNow,
      verticalAmp:  sensors.lastVertAmp,
    }
    state.runSamples.push(sample)
  }

  // Segment (current lap) pace: cumulative lap distance / elapsed time. Hold it
  // blank until the lap has enough distance to be stable — at 20 m the ±GPS
  // jitter made it swing fast/slow, which is the fluctuation seen on the HUD.
  const segMs = lapElapsedMs(state)
  const segDm = lapDistanceM(state)
  if (state.status === 'running') {
    state.segmentPaceSPerKm = (segDm > 60 && segMs > 15000)
      ? (segMs / 1000) / (segDm / 1000)
      : null
  }

  flushHUD().catch(console.error)
}

// ── Persistence helpers ───────────────────────────────────────────────────────
async function persistAll(b: Bridge): Promise<void> {
  await saveRecords(async (k, v) => { await b.setLocalStorage(k, v) }, state.calibRecords).catch(console.error)
  await saveRuns(async (k, v) => { await b.setLocalStorage(k, v) }, state.runs).catch(console.error)
  await b.setLocalStorage('pending_calib_v1',
    state.pendingCalib ? JSON.stringify(state.pendingCalib) : '').catch(console.error)
  await b.setLocalStorage('k_scalar', String(pace.k.serialize())).catch(console.error)
  await b.setLocalStorage('settings_v1', JSON.stringify(state.settings)).catch(console.error)
}

async function loadAll(b: Bridge): Promise<void> {
  state.calibRecords = await loadRecords(k => b.getLocalStorage(k).catch(() => null))
  state.runs = await loadRuns(k => b.getLocalStorage(k).catch(() => null))

  const pendRaw = await b.getLocalStorage('pending_calib_v1').catch(() => null)
  if (pendRaw) {
    try { state.pendingCalib = JSON.parse(pendRaw) as CalibRecord } catch { /* ignore */ }
  }

  const kRaw = await b.getLocalStorage('k_scalar').catch(() => null)
  if (kRaw) {
    const kv = parseFloat(kRaw)
    if (isFinite(kv)) pace.k.deserialize(kv)
  }

  const settingsRaw = await b.getLocalStorage('settings_v1').catch(() => null)
  if (settingsRaw) {
    try {
      const parsed = JSON.parse(settingsRaw) as Partial<typeof DEFAULT_SETTINGS>
      state.settings = { ...DEFAULT_SETTINGS, ...parsed }
    } catch { /* use defaults */ }
  }
}

// ── WakeLock ─────────────────────────────────────────────────────────────────
let wakeLock: any = null

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await (navigator as any).wakeLock.request('screen')
      console.log('[WakeLock] Active')
    } catch (err: any) {
      console.warn('[WakeLock] Failed:', err.message)
    }
  }
}

function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().catch(() => {})
    wakeLock = null
    console.log('[WakeLock] Released')
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.status !== 'idle' && state.settings.useWakeLock) {
    requestWakeLock()
  }
})

// ── Run lifecycle ─────────────────────────────────────────────────────────────
function startRun(): void {
  state.status             = 'running'
  state.startTime          = Date.now()
  state.pausedElapsed      = 0
  state.pauseStart         = null
  state.totalDistanceM     = 0
  state.lapStartDistanceM  = 0
  state.lapStartElapsedMs  = 0
  state.laps               = []
  state.lastPace           = null
  state.segmentPaceSPerKm  = null
  state.runSamples         = []
  pendingDistM             = 0
  lastMovingMs             = Date.now()
  lastProgressMs           = Date.now()
  autoPaused               = false
  paceWindow.length        = 0
  paceSpeedEma             = null
  gpsSkipped.gap = gpsSkipped.accuracy = gpsSkipped.jump = gpsSkipped.still = 0
  totalStepEst             = 0
  lapView                  = false
  lapScrollOffset          = 0
  pace.resetEma()

  if (state.settings.useWakeLock) {
    requestWakeLock()
  }
}

async function stopRun(b: Bridge): Promise<void> {
  const elapsed = activeElapsedMs(state)
  state.status = 'idle'

  // Keep the run itself — until now only the calibration sample survived a save,
  // and the run was thrown away.
  if (elapsed > 5000 && state.totalDistanceM > 10) {
    const weightKg = state.settings.weight_kg ?? 65
    state.runs = insertRun(state.runs, {
      ts: state.startTime ?? Date.now(),
      duration_ms: elapsed,
      distance_m: state.totalDistanceM,
      steps: Math.round(totalStepEst),
      calories: (state.totalDistanceM / 1000) * weightKg * 1.036,
      laps: state.laps.map(l => ({ ...l })),
    })
    console.log(`[runs] saved: ${(state.totalDistanceM / 1000).toFixed(2)}km in ${Math.round(elapsed / 1000)}s`)
    console.log(`[gps] fixes not counted — jump:${gpsSkipped.jump} still:${gpsSkipped.still} ` +
      `gap:${gpsSkipped.gap} accuracy:${gpsSkipped.accuracy}`)
  } else {
    console.log('[runs] not saved — run too short')
  }

  // Harvest a calibration candidate, but do NOT apply it. A bad record silently
  // skews every later pace estimate, so adopting one is an explicit opt-in on
  // the phone panel after each run.
  if (state.runSamples.length >= 2) {
    const rec = harvestCalibRecord(state.runSamples, state.settings, 'gps')
    if (rec !== null) {
      state.pendingCalib = rec
      console.log('[harvest] candidate (not applied):', rec.cadence_spm.toFixed(0), 'spm',
        rec.step_length_m.toFixed(3), 'm/step — approve it in Settings to use it')
    } else {
      console.log('[harvest] no record')
    }
  } else {
    console.log('[harvest] too few samples:', state.runSamples.length, '(need ≥2)')
  }

  await persistAll(b)
  state.runSamples = []
  
  releaseWakeLock()
}

// ── Discard run (no save) ─────────────────────────────────────────────────────
function discardRun(): void {
  state.status            = 'idle'
  state.startTime         = null
  state.pausedElapsed     = 0
  state.pauseStart        = null
  state.totalDistanceM    = 0
  state.lapStartDistanceM = 0
  state.lapStartElapsedMs = 0
  state.laps              = []
  state.lastPace          = null
  state.segmentPaceSPerKm = null
  state.runSamples        = []
  pendingDistM            = 0
  lastMovingMs            = 0
  lastProgressMs          = 0
  autoPaused              = false
  paceWindow.length       = 0
  paceSpeedEma            = null
  totalStepEst            = 0
  lapView                 = false
  lapScrollOffset         = 0
  pace.resetEma()

  releaseWakeLock()
}

// ── HUD modal ─────────────────────────────────────────────────────────────────
async function handleModalGesture(type: number, b: Bridge): Promise<void> {
  const m = hudModal
  if (m.type === 'none') return

  if (m.type === 'stop') {
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) {
      hudModal = { type: 'stop', sel: (m.sel + 1) % 3 }
    } else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      hudModal = { type: 'stop', sel: (m.sel + 2) % 3 }
    } else if (type === OsEventTypeList.CLICK_EVENT) {
      hudModal = { type: 'none' }
      if (m.sel === 0) { await stopRun(b); renderSettings(b) }
      else if (m.sel === 1) discardRun()
      // sel === 2: continue — no state change
    } else {
      hudModal = { type: 'none' }  // double-tap = continue
    }
  }

  await flushHUD()
}

// ── Settings panel (always visible on phone) ──────────────────────────────────
function renderSettings(b: Bridge): void {
  const root = document.getElementById('settings-root')
  if (!root) return
  renderSettingsUI(root, state.settings, state.calibRecords, state.runs, state.pendingCalib, {
    onSettingsChange(s) {
      state.settings = s
      persistAll(b).catch(console.error)
      renderSettings(b)
    },
    onRecordsChange(r) {
      state.calibRecords = r
      persistAll(b).catch(console.error)
      renderSettings(b)
    },
    onRunsChange(r) {
      state.runs = r
      persistAll(b).catch(console.error)
      renderSettings(b)
    },
    onPendingCalibChange(r) {
      state.pendingCalib = r
      persistAll(b).catch(console.error)
      renderSettings(b)
    },
  })
}

// ── Weather ────────────────────────────────────────────────────────────────────
let weatherBusy = false
async function refreshWeather(): Promise<void> {
  if (weatherBusy || lastGpsFix === null) return
  weatherBusy = true
  try {
    const w = await fetchWeather(lastGpsFix.lat, lastGpsFix.lon)
    if (w !== null) {
      weather = w
      flushHUD().catch(console.error)
    }
  } finally {
    weatherBusy = false
  }
}

// ── Phone screen helpers ──────────────────────────────────────────────────────
function setStatus(html: string): void {
  const el = document.getElementById('app-status')
  if (el) el.innerHTML = html
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Installed first so bridge/HUD startup logs land in the on-screen console.
  installDebugLog()
  try {
    const b = await waitForEvenAppBridge()
    bridge = b

    await loadAll(b)

    // GPS: accumulate distance between ticks + capture heading for the compass
    sensors.onGps(fix => {
      const spd = fix.speedMs
      if (spd !== null && spd >= 0) {
        gpsSpeedBuf.push(spd)
        if (gpsSpeedBuf.length > 10) gpsSpeedBuf.shift()
      }
      if (fix.headingDeg !== null) lastHeadingDeg = fix.headingDeg
      if (lastGpsFix !== null) {
        // Every fix-to-fix hop used to be credited unconditionally, which is how
        // a 1:28 run logged 16.3 km against Garmin's ~13: one lap ran at 8.4 m/s
        // (a reacquisition jump), and standing at lights still banked metres per
        // second of pure jitter. Only integrate hops that a runner could produce.
        const dtS = (fix.ts - lastGpsFix.ts) / 1000
        const d = haversineM(lastGpsFix, fix)
        const impliedMs = dtS > 0 ? d / dtS : Infinity
        const running = state.status === 'running'

        if (dtS <= 0 || dtS > GPS_MAX_GAP_S) {
          if (running) gpsSkipped.gap++      // dropout: re-anchor, don't credit
        } else if (fix.accuracyM > GPS_MAX_ACCURACY_M) {
          if (running) gpsSkipped.accuracy++
        } else if (impliedMs > GPS_MAX_SPEED_MS) {
          if (running) gpsSkipped.jump++
        } else if (impliedMs < GPS_MIN_SPEED_MS) {
          if (running) gpsSkipped.still++    // standing still: jitter, not travel
        } else {
          // Genuine movement. Record it even while auto-paused — this is what
          // lets the run resume; it lived inside the running-only branch before,
          // so a pause never saw movement again and never came back. Distance is
          // still credited only while actually running.
          lastMovingMs = Date.now()
          if (running) pendingDistM += d
        }
      }
      const firstFix = lastGpsFix === null
      lastGpsFix = fix
      if (firstFix) refreshWeather()   // kick off weather once we have a location
    })
    await sensors.initGps(b)

    // Glasses battery: initial read + subscribe to status updates
    b.getDeviceInfo().then(di => {
      // Authoritative read of the link, unlike the empty status events the host
      // broadcasts. If this says no glasses, nothing we push can land.
      console.info(
        `[link] device: isGlasses=${di?.isGlasses()} sn="${di?.sn ?? ''}" ` +
        `connectType=${di?.status?.connectType} battery=${di?.status?.batteryLevel} ` +
        `isWearing=${di?.status?.isWearing} inCase=${di?.status?.isInCase}`)
      if (di?.isGlasses()) {
        glassesSn = di.sn
        if (typeof di.status.batteryLevel === 'number') glassesBatteryPct = di.status.batteryLevel
      }
    }).catch(e => console.warn('[link] getDeviceInfo failed:', e))
    b.onDeviceStatusChanged(st => {
      // Only status events that actually identify the glasses say anything about
      // the link. The host also emits empty placeholders (sn "", battery 0,
      // connectType "none"); treating those as a disconnect blocks image sends
      // even though the link is fine.
      const sn = st.sn ?? ''
      if (sn !== '' && (glassesSn === null || sn === glassesSn)) {
        const connected = !!st.connectType && st.connectType !== 'none'
        if (connected !== glassesConnected) {
          glassesConnected = connected
          console.info(`[link] glasses ${connected ? 'connected' : 'DISCONNECTED'} (connectType=${st.connectType})`)
        }
      }
      if ((glassesSn === null || st.sn === glassesSn) && typeof st.batteryLevel === 'number') {
        glassesBatteryPct = st.batteryLevel
      }
    })

    // Weather refresh every 10 min (also fired on first GPS fix above)
    setInterval(refreshWeather, 10 * 60 * 1000)

    // Build the HUD page. Retries until it lands: creation fails outright when
    // the glasses aren't connected yet (connectType=connectionFailed), and
    // without a retry the app would show nothing until it was restarted.
    await ensurePage(b)
    setInterval(() => { void ensurePage(b) }, PAGE_RETRY_MS)

    // Try DeviceMotion; fall back to G2 IMU path
    const dmGranted = await sensors.tryDeviceMotion()
    if (!dmGranted) {
      sensors.startG2Imu()
    }

    // The glasses IMU stream (~5 samples/s) saturates the BLE link and starves
    // the pace image transfer, so it stays off.
    //
    // Cost: when DeviceMotion is unavailable this is the only cadence source, so
    // cadence reads "--spm" and pace falls back to GPS alone. Set this to true to
    // trade the big pace readout back for cadence.
    //
    // ImuReportPace.Pxxx values are protocol pacing codes, NOT literal Hz — the
    // real delivery rate is device-defined, so g2-imu.ts measures the actual rate
    // from event timestamps rather than trusting this number.
    // Turning this off did not change the image behaviour, so BLE contention was
    // not the cause — the stream stays on and cadence keeps working.
    const USE_GLASSES_IMU = true
    try {
      if (USE_GLASSES_IMU && !dmGranted) {
        await b.imuControl(true, ImuReportPace.P200)
        console.info('[IMU] glasses stream on — DeviceMotion unavailable')
      } else {
        await b.imuControl(false)
        console.info(dmGranted
          ? '[IMU] glasses stream off — cadence from phone DeviceMotion'
          : '[IMU] glasses stream off — no cadence source (pace is GPS-only)')
      }
    } catch (e) {
      console.warn('[IMU] control failed (simulator mode):', e)
    }

    // 1 Hz tick
    setInterval(tick, 1000)

    // Recalibration warning check
    setInterval(() => {
      if (pace.k.recalibNeeded) {
        console.warn('[k-scalar] at boundary for >2 min — recommend new calibration run')
      }
    }, 30_000)

    // Gesture + IMU event handler
    const unsub = b.onEvenHubEvent(async event => {
      const sys = event.sysEvent
      if (sys?.imuData && sys.eventType === OsEventTypeList.IMU_DATA_REPORT) {
        sensors.feedImu({ x: sys.imuData.x ?? 0, y: sys.imuData.y ?? 0, z: sys.imuData.z ?? 0 })
        return
      }

      const type = event.sysEvent?.eventType
        ?? event.textEvent?.eventType
        ?? event.listEvent?.eventType
        ?? OsEventTypeList.CLICK_EVENT

      // HUD modal intercepts all gestures
      if (hudModal.type !== 'none') {
        await handleModalGesture(type, b)
        return
      }

      // Lap-list screen intercepts all gestures while open
      if (lapView) {
        const maxOffset = Math.max(0, (state.laps.length + 1) - 8)
        if (type === OsEventTypeList.SCROLL_TOP_EVENT) {
          lapScrollOffset = Math.min(maxOffset, lapScrollOffset + 1)   // scroll to older
        } else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
          if (lapScrollOffset <= 0) lapView = false                    // at newest → close
          else lapScrollOffset -= 1                                    // scroll to newer
        } else {
          lapView = false                                             // tap / double-tap closes
        }
        await flushHUD()
        return
      }

      switch (type) {

        // Single tap: start (idle) | lap (running) | resume (paused)
        case OsEventTypeList.CLICK_EVENT: {
          if (state.status === 'idle') {
            await flashCell('l1', '⋯ starting')
            // First run: request DeviceMotion permission from user gesture
            if (sensors.path === 'g2imu') {
              const granted = await sensors.tryDeviceMotion()
              if (granted) {
                console.log('[sensors] upgraded to DeviceMotion')
                // Free the BLE link now that the glasses IMU is redundant.
                await b.imuControl(false).catch(() => {})
              }
            }
            startRun()
          } else if (state.status === 'running') {
            recordLap(state)
          } else if (state.status === 'paused') {
            if (state.pauseStart !== null) {
              state.pausedElapsed += Date.now() - state.pauseStart
              state.pauseStart = null
            }
            state.status = 'running'
          }
          await flushHUD()
          break
        }

        // Double tap: system exit dialog (idle) | stop modal (running/paused)
        case OsEventTypeList.DOUBLE_CLICK_EVENT: {
          if (state.status === 'idle') {
            await b.shutDownPageContainer(1)
          } else {
            hudModal = { type: 'stop', sel: 0 }
            await flushHUD()
          }
          break
        }

        // Swipe up: open the scrollable lap-list screen (while a run is active)
        case OsEventTypeList.SCROLL_TOP_EVENT: {
          if (state.status !== 'idle') {
            lapView = true
            lapScrollOffset = 0
            await flushHUD()
          }
          break
        }
      }
    })

    window.addEventListener('beforeunload', () => {
      b.imuControl(false)
      sensors.stop()
      unsub()
    })

    setStatus('<span style="color:#4a4">Running tracker ready.</span>')
    renderSettings(b)
    await flushHUD()

  } catch (err: unknown) {
    setStatus(`<span style="color:#f44">Fatal: ${String(err)}</span>`)
    console.error(err)
  }
}

main().catch(console.error)

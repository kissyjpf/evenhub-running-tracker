import {
  waitForEvenAppBridge,
  TextContainerProperty,
  OsEventTypeList,
  ImuReportPace,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
} from '@evenrealities/even_hub_sdk'

import { makeInitialState, activeElapsedMs, lapElapsedMs, lapDistanceM, recordLap } from './state'
import type { AppState } from './state'
import { SensorManager } from './sensors/manager'
import { haversineM } from './sensors/gps'
import type { GpsFix } from './sensors/gps'
import { PaceEstimator } from './pace'
import { loadRecords, saveRecords, insertRecord } from './calibration/records'
import { harvestCalibRecord } from './calibration/harvest'
import type { RunSample } from './calibration/harvest'
import { renderHUD, HUDCells, CELL_KEYS, type HudModal } from './hud'
import { renderSettingsUI } from './settings/ui'
import { fetchWeather, type WeatherInfo } from './weather'
import { DEFAULT_SETTINGS } from './types'

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

// Bottom large dot-matrix pace + unit
const PACE_Y    = 140
const PACE_H    = CANVAS_H - PACE_Y   // 148 (fits 5 dot rows)
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
let pendingDistM  = 0       // GPS distance accumulated between 1Hz ticks
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

let cachedCells: HUDCells = { l1:'', l2:'', l3:'', info:'', pb:'', pu:'', mo:'' }
let bridge: Bridge | null = null
let hudModal: HudModal = { type: 'none' }

// Top-right info block sources
let weather: WeatherInfo | null = null
let glassesBatteryPct: number | null = null
let glassesSn: string | null = null
let lastHeadingDeg: number | null = null

async function flushHUD(): Promise<void> {
  if (!bridge) return
  const h = buildHudInput()
  const cells = renderHUD(h)

  for (let i = 0; i < CELL_KEYS.length; i++) {
    const key = CELL_KEYS[i]!
    if (cells[key] === cachedCells[key]) continue
    cachedCells[key] = cells[key]
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID:   i + 1,
      containerName: key,
      contentOffset: 0,
      contentLength: 0,
      content: cells[key],
    })).catch(console.error)
  }
}

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
    lapNumber:           state.laps.length + 1,
    lapDistanceM:        lapDistanceM(state),
    lapElapsedMs:        lapElapsedMs(state),
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
  if (state.status === 'running') {
    if (gpsOk) {
      state.totalDistanceM += pendingDistM
    } else if (state.lastPace) {
      // Dead reckoning: speedMs * dt (dt = 1s)
      state.totalDistanceM += state.lastPace.speedMs * 1.0
    }
  }
  pendingDistM = 0

  // Estimate cadence step count — only count fresh, non-stale cadence so
  // steps stop accumulating the moment motion stops or the sensor stalls.
  const cadNow = sensors.freshCadence()
  if (state.status === 'running' && cadNow !== null) {
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

  // Segment pace: direct from lap accumulated distance / elapsed time
  const segMs = lapElapsedMs(state)
  const segDm = lapDistanceM(state)
  if (state.status === 'running' && segDm > 20 && segMs > 5000) {
    state.segmentPaceSPerKm = (segMs / 1000) / (segDm / 1000)
  }

  flushHUD().catch(console.error)
}

// ── Persistence helpers ───────────────────────────────────────────────────────
async function persistAll(b: Bridge): Promise<void> {
  await saveRecords(async (k, v) => { await b.setLocalStorage(k, v) }, state.calibRecords).catch(console.error)
  await b.setLocalStorage('k_scalar', String(pace.k.serialize())).catch(console.error)
  await b.setLocalStorage('settings_v1', JSON.stringify(state.settings)).catch(console.error)
}

async function loadAll(b: Bridge): Promise<void> {
  state.calibRecords = await loadRecords(k => b.getLocalStorage(k).catch(() => null))

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
  totalStepEst             = 0
  pace.resetEma()

  if (state.settings.useWakeLock) {
    requestWakeLock()
  }
}

async function stopRun(b: Bridge): Promise<void> {
  state.status = 'idle'

  // Auto-harvest calibration record from this run
  if (state.runSamples.length >= 2) {
    const rec = harvestCalibRecord(state.runSamples, state.settings, 'gps')
    if (rec !== null) {
      state.calibRecords = insertRecord(state.calibRecords, rec)
      console.log('[harvest] new record:', rec.cadence_spm.toFixed(0), 'spm',
        rec.step_length_m.toFixed(3), 'm/step')
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
  totalStepEst            = 0
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
  renderSettingsUI(root, state.settings, state.calibRecords, {
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
      if (state.status === 'running' && lastGpsFix !== null) {
        pendingDistM += haversineM(lastGpsFix, fix)
      }
      const firstFix = lastGpsFix === null
      lastGpsFix = fix
      if (firstFix) refreshWeather()   // kick off weather once we have a location
    })
    await sensors.initGps(b)

    // Glasses battery: initial read + subscribe to status updates
    b.getDeviceInfo().then(di => {
      if (di?.isGlasses()) {
        glassesSn = di.sn
        if (typeof di.status.batteryLevel === 'number') glassesBatteryPct = di.status.batteryLevel
      }
    }).catch(() => {})
    b.onDeviceStatusChanged(st => {
      if ((glassesSn === null || st.sn === glassesSn) && typeof st.batteryLevel === 'number') {
        glassesBatteryPct = st.batteryLevel
      }
    })

    // Weather refresh every 10 min (also fired on first GPS fix above)
    setInterval(refreshWeather, 10 * 60 * 1000)

    // Build initial HUD
    const initial = renderHUD(buildHudInput())
    cachedCells = { ...initial }

    const result = await b.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 7,
      textObject: [
        makeContainer(1, 'l1',   0,      L1_Y,   LEFT_W,   ROW_H,  initial.l1,   1),
        makeContainer(2, 'l2',   0,      L2_Y,   LEFT_W,   ROW_H,  initial.l2,   0),
        makeContainer(3, 'l3',   0,      L3_Y,   LEFT_W,   ROW_H,  initial.l3,   0),
        makeContainer(4, 'info', INFO_X, INFO_Y, INFO_W,   INFO_H, initial.info, 0),
        makeContainer(5, 'pb',   0,      PACE_Y, CANVAS_W, PACE_H, initial.pb,   0),
        makeContainer(6, 'pu',   UNIT_X, UNIT_Y, UNIT_W,   ROW_H,  initial.pu,   0),
        makeContainer(7, 'mo',   MODAL_X, MODAL_Y, MODAL_W, MODAL_H, initial.mo, 0),
      ],
    }))

    if (result !== StartUpPageCreateResult.success) {
      console.error('HUD init failed:', result)
    }

    // Try DeviceMotion; fall back to G2 IMU path
    const dmGranted = await sensors.tryDeviceMotion()
    if (!dmGranted) {
      sensors.startG2Imu()
    }

    // Start G2 IMU via SDK. ImuReportPace.Pxxx values are protocol pacing
    // codes, NOT literal Hz — the real delivery rate is device-defined, so
    // g2-imu.ts measures the actual rate from event timestamps rather than
    // trusting this number. The pace code only nudges the host faster/slower.
    try {
      await b.imuControl(true, ImuReportPace.P200)
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

      switch (type) {

        // Single tap: start (idle) | lap (running) | resume (paused)
        case OsEventTypeList.CLICK_EVENT: {
          if (state.status === 'idle') {
            await flashCell('l1', '⋯ starting')
            // First run: request DeviceMotion permission from user gesture
            if (sensors.path === 'g2imu') {
              const granted = await sensors.tryDeviceMotion()
              if (granted) console.log('[sensors] upgraded to DeviceMotion')
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

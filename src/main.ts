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
import { renderHUD, HUDCells, CELL_KEYS } from './hud'
import { renderSettingsUI } from './settings/ui'
import { DEFAULT_SETTINGS } from './types'

// ── Canvas geometry ──────────────────────────────────────────────────────────
const CANVAS_W  = 576
const CANVAS_H  = 288
const ROW_H     = 28
const SIDE_W    = 130
const CENTER_W  = CANVAS_W - SIDE_W * 2   // 316
const TOP_Y     = 0
const MID_Y     = ROW_H                   // 28
const BOT_Y     = CANVAS_H - ROW_H        // 260

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

let cachedCells: HUDCells = { tl:'', tc:'', tr:'', ca:'', bl:'', bc:'', br:'' }
let bridge: Bridge | null = null

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

function buildHudInput() {
  const lp = state.lastPace
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

  // Consume accumulated GPS distance
  if (state.status === 'running') {
    state.totalDistanceM += pendingDistM
  }
  pendingDistM = 0

  // Estimate cadence step count
  const cadNow = sensors.lastCadenceSpm
  if (state.status === 'running' && cadNow !== null) {
    totalStepEst += cadNow / 60   // 1s tick → cadence/60 steps
  }

  // Update pace estimator
  const gpsFix = sensors.gps.getFix()
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
}

async function stopRun(b: Bridge): Promise<void> {
  state.status = 'idle'

  // Auto-harvest calibration record from this run
  if (state.runSamples.length >= 30) {
    const rec = harvestCalibRecord(state.runSamples, state.settings, 'gps')
    if (rec !== null) {
      state.calibRecords = insertRecord(state.calibRecords, rec)
      console.log('[harvest] new record:', rec.cadence_spm.toFixed(0), 'spm',
        rec.step_length_m.toFixed(3), 'm/step')
    }
  }

  await persistAll(b)
  state.runSamples = []
}

// ── Settings WebView ──────────────────────────────────────────────────────────
let settingsOpen = false

function openSettings(b: Bridge): void {
  if (settingsOpen) return
  settingsOpen = true
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;background:#111;overflow:auto;z-index:10'
  document.body.appendChild(overlay)

  const draw = () => renderSettingsUI(overlay, state.settings, state.calibRecords, {
    onSettingsChange(s) {
      state.settings = s
      persistAll(b).catch(console.error)
      draw()
    },
    onRecordsChange(r) {
      state.calibRecords = r
      persistAll(b).catch(console.error)
      draw()
    },
    onClose() {
      document.body.removeChild(overlay)
      settingsOpen = false
      flushHUD().catch(console.error)
    },
  })
  draw()
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  document.body.style.cssText = 'background:#1a1a1a;color:#ccc;font-family:monospace;padding:8px'
  document.body.innerHTML = '<p>Initializing…</p>'

  try {
    const b = await waitForEvenAppBridge()
    bridge = b

    await loadAll(b)

    // GPS: accumulate distance between ticks
    sensors.onGps(fix => {
      const spd = fix.speedMs
      if (spd !== null && spd >= 0) {
        gpsSpeedBuf.push(spd)
        if (gpsSpeedBuf.length > 10) gpsSpeedBuf.shift()
      }
      if (state.status === 'running' && lastGpsFix !== null) {
        pendingDistM += haversineM(lastGpsFix, fix)
      }
      lastGpsFix = fix
    })
    sensors.initGps()

    // Build initial HUD
    const initial = renderHUD(buildHudInput())
    cachedCells = { ...initial }

    const result = await b.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 7,
      textObject: [
        makeContainer(1, 'tl', 0,                 TOP_Y, SIDE_W,   ROW_H, initial.tl, 1),
        makeContainer(2, 'tc', SIDE_W,             TOP_Y, CENTER_W, ROW_H, initial.tc, 0),
        makeContainer(3, 'tr', CANVAS_W - SIDE_W, TOP_Y, SIDE_W,   ROW_H, initial.tr, 0),
        makeContainer(4, 'ca', 0,                 MID_Y, CANVAS_W, ROW_H, initial.ca, 0),
        makeContainer(5, 'bl', 0,                 BOT_Y, SIDE_W,   ROW_H, initial.bl, 0),
        makeContainer(6, 'bc', SIDE_W,             BOT_Y, CENTER_W, ROW_H, initial.bc, 0),
        makeContainer(7, 'br', CANVAS_W - SIDE_W, BOT_Y, SIDE_W,   ROW_H, initial.br, 0),
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

    // Start G2 IMU via SDK
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

      switch (type) {

        // Single tap: lap (running) | resume (paused)
        case OsEventTypeList.CLICK_EVENT: {
          if (state.status === 'running') {
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

        // Double tap: start (idle) | stop+save (running/paused)
        case OsEventTypeList.DOUBLE_CLICK_EVENT: {
          if (state.status === 'idle') {
            // First run: request DeviceMotion permission from user gesture
            if (sensors.path === 'g2imu') {
              const granted = await sensors.tryDeviceMotion()
              if (granted) console.log('[sensors] upgraded to DeviceMotion')
            }
            startRun()
          } else {
            await stopRun(b)
          }
          await flushHUD()
          break
        }

        // Swipe up: pause (running) | open settings (idle)
        case OsEventTypeList.SCROLL_TOP_EVENT: {
          if (state.status === 'running') {
            state.status     = 'paused'
            state.pauseStart = Date.now()
          } else if (state.status === 'idle') {
            openSettings(b)
          }
          await flushHUD()
          break
        }

        // Swipe down: resume if paused
        case OsEventTypeList.SCROLL_BOTTOM_EVENT: {
          if (state.status === 'paused') {
            if (state.pauseStart !== null) {
              state.pausedElapsed += Date.now() - state.pauseStart
              state.pauseStart = null
            }
            state.status = 'running'
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

    document.body.innerHTML = '<p style="color:#4a4">Running tracker ready.</p>'
    await flushHUD()

  } catch (err: unknown) {
    document.body.innerHTML += `<p style="color:#f44">Fatal: ${String(err)}</p>`
    console.error(err)
  }
}

main().catch(console.error)

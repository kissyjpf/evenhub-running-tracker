# Even G2 Running Tracker

**A GPS + motion-sensor running tracker for Even Realities G1/G2 smart glasses, built on the EvenHub SDK.**

Real-time pace, cadence, distance and a scrollable lap history are rendered directly on
the glasses' 576×288 mono-green Micro-LED display — no phone glances needed during a run.
The paired phone WebView is used only as a static settings panel (profile + calibration
history).

Supports both **running and walking** (cadence detection down to ~50 spm).

---

## Features

- **Real-time pace on the HUD** — complementary filter fusing GPS speed with
  accelerometer dead reckoning. When GPS accuracy drops (≥30 m), distance keeps
  advancing from the estimated speed so the run doesn't stall in tunnels/under cover.
- **Native location** — GPS comes from the EvenHub **App Location API** (bridge),
  purpose-built for the Even App WebView; it falls back to browser geolocation
  automatically when the native path isn't available (e.g. the simulator).
- **Cadence & step count** — steps per minute from the DeviceMotion API (phone,
  accelerometer + gyroscope fusion) or the G2 IMU, via autocorrelation with an
  adaptively-measured sample rate and half-lag harmonic correction.
- **Auto-calibration** — learns your step length per speed band from GPS during a run,
  auto-harvested at the end and persisted on-device across sessions.
- **Scrollable lap history** — laps stack on the HUD; swipe to scroll through them.
- **On-glasses stop menu** — Save / Discard / Continue is confirmed on the HUD itself,
  so you never need the phone mid-run.
- **Keep-screen-on (Wake Lock)** — optional; holds the screen awake so the run keeps
  running in the background, re-acquired automatically when the app returns to foreground.
- **GPS status indicator** — `GPS:OK` / `GPS:--` on the HUD at a glance.
- **Always-on settings panel** — height, weight, wake-lock toggle and calibration-record
  management, shown on the phone WebView at all times.

## HUD Layout (576×288)

```
y= 28   [ elapsed ]      [ pace /km ]        [ distance ]        ← top data row
y= 56   [ GPS:OK  •  CAD ###spm ###stp  •  SEG #:##/km ###kcal ] ← row 2
y=112   L1: 0.42km 2:31                                          ┐
        L2: 0.40km 2:28                                          │ scrollable
        …                                                        │ lap history
        L4: 0.18km 1:05  ●  k=1.00 c3   (current lap)            ┘ (up to 6 lines)
```

### Stop menu (running/paused, full-screen)

When you open the stop menu the normal HUD is hidden and three options are stacked in
the centre; the selected one is marked with arrows:

```
        > Save + exit <
          Discard
          Continue
```

## Gesture Controls

| Gesture     | Idle                    | Running / Paused          |
|-------------|-------------------------|---------------------------|
| Single tap  | Start run               | Record lap (running) / Resume (paused) |
| Double tap  | System exit dialog      | Open stop menu            |
| Swipe up    | —                       | Scroll lap history (newer) |
| Swipe down  | —                       | Scroll lap history (older) |

### While the stop menu is open

| Gesture      | Action                                    |
|--------------|-------------------------------------------|
| Swipe ↑ / ↓  | Move the selection                        |
| Single tap   | Confirm the highlighted option            |
| Double tap   | Dismiss (= Continue)                      |

- **Save + exit** — ends the run, auto-harvests a calibration record, then exits.
- **Discard** — ends the run without saving.
- **Continue** — dismiss and keep running.

## Settings Panel (phone WebView)

Always visible; no gesture required. Provides:

- **Profile** — height (cm), optional weight (kg) for calorie estimation, and a
  **Keep Screen On (Wake Lock)** toggle.
- **Speed band coverage** — how many calibration records fall in each pace band.
- **Calibration records** — the last 10 harvested records, each showing date, duration,
  step length and source, with editable distance/steps and delete. New records appear
  here immediately after a Save + exit.

## Sensor Paths

The app selects the best available sensor automatically:

1. **DeviceMotion** (phone browser API) — preferred; gravity-removed vertical
   acceleration fused with gyroscope rotation rate.
2. **G2 IMU** (SDK `imuControl`) — fallback via EvenHub `IMU_DATA_REPORT` events.
3. **GPS only** — pace from GPS speed alone when no motion data is available.

> **Note on `ImuReportPace`:** the SDK's `Pxxx` values are *protocol pacing codes, not
> literal Hz*. Both sensor paths therefore **measure the real sample rate at runtime**
> from event timestamps and feed that into the bandpass filter and the cadence math, so
> the reading is correct regardless of the device's actual delivery rate.

## Cadence / Step Detection

Vertical acceleration (+ gyroscope) → band-pass filter (0.5–4.5 Hz) → autocorrelation
over a sliding window. Key robustness measures:

- **Adaptive sample rate** — the real event rate is measured per-event (EMA) and used for
  both the filter cutoffs and the lag→spm conversion (a wrong rate would scale cadence
  directly, e.g. reading a half-rate stream as double).
- **Parabolic peak interpolation** — sub-sample lag resolution removes the ~8–11 spm
  quantisation jitter you'd otherwise get at integer lags.
- **Half-lag harmonic correction** — detects when the true step frequency is at half the
  dominant lag (asymmetric gait) and uses it, so cadence isn't reported at half value.
- **Noise gating & freshness** — a minimum-amplitude threshold plus a normalised-
  correlation floor return `null` (not a garbage value) when you're standing still, and a
  3-second freshness guard stops the step counter the moment motion stops.

Reported cadence range: **50–200 spm** (covers walking through fast running).

## Pace Algorithm

```
L_base  = calibrated step length  (cadence + vertical amplitude → lookup)
k       = adaptive scalar, updated from GPS when accuracy < 15 m
v_acc   = (cadence / 60) × k × L_base
v_fused = 0.7 × v_gps + 0.3 × v_acc   (GPS valid)
        = v_acc                          (GPS absent / inaccurate)
pace    = EMA(1000 / v_fused, τ = 4 s)
```

Distance accumulates from GPS haversine when accuracy < 30 m, otherwise from the fused
speed (dead reckoning). Location fixes are sourced from the native EvenHub App Location
API (`startAppLocationUpdates` / `onAppLocationChanged`, High accuracy, 1 s interval),
with browser `navigator.geolocation` as an automatic fallback.

### Calibration acceptance gate

A record is harvested from a run's longest steady segment only when it passes all of:

| Check              | Threshold                          |
|--------------------|------------------------------------|
| Distance (GPS)     | ≥ 50 m *(low testing value)*       |
| GPS accuracy       | < 30 m                             |
| Speed CoV          | < 0.15                             |
| Cadence SD         | < 5 spm                            |
| Step length        | 0.3 – 2.2 m                        |

If a run doesn't produce a record, the browser console logs the reason (`[harvest] …`).

## Requirements

- Even Realities G1 or G2 smart glasses
- EvenHub host app (`min_app_version` 2.0.0, `min_sdk_version` 0.0.10)
- Node.js 18+

## Setup

```bash
npm install
npm run dev      # Vite dev server (simulator)
npm run build    # bump version, tsc, vite build, and pack running-tracker.ehpk
```

`npm run build` auto-increments the patch version in `app.json`, compiles, and produces
`running-tracker.ehpk` ready to install in EvenHub.

## Project Structure

```
src/
  main.ts              # entry point: bridge init, HUD containers, gesture routing, run lifecycle, wake lock
  hud.ts               # HUD cell renderer (data rows, scrollable lap history, stop menu)
  pace.ts              # complementary-filter pace estimator
  signal.ts            # band-pass IIR filter + autocorrelation cadence estimation
  state.ts             # app state (run lifecycle, laps)
  types.ts             # shared types and defaults
  sensors/
    manager.ts         # sensor orchestration + cadence freshness
    device-motion.ts   # DeviceMotion cadence (adaptive rate, accel + gyro fusion)
    g2-imu.ts          # G2 IMU cadence (adaptive sample rate)
    gps.ts             # native App Location (bridge) + browser-geolocation fallback
  model/
    l-base.ts          # step-length lookup from calibration records
    k-scalar.ts        # adaptive GPS correction scalar
  calibration/
    harvest.ts         # auto-harvest a calibration record from a run
    records.ts         # persistence (load/save to on-device storage)
    gate.ts            # quality gate for calibration acceptance
  settings/
    ui.ts              # always-on phone settings panel renderer
```

## License

MIT

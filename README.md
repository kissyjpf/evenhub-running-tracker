# Even G2 Running Tracker

**A GPS + motion-sensor running tracker for Even Realities G1/G2 smart glasses, built on the EvenHub SDK.**

Real-time pace, cadence, distance and a scrollable lap history are rendered directly on
the glasses' 576×288 mono-green Micro-LED display — no phone glances needed during a run.
The paired phone WebView carries the settings panel, a saved-run history and an on-screen
console for hardware debugging.

Supports both **running and walking** (cadence detection down to ~50 spm).

> **Also in this repo:** [`peak-finder/`](peak-finder/) — a second EvenHub app that names
> the mountains around you, with the bearing and distance to each summit, plus your
> heading, altitude, weather and the time.

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
- **Large dot-matrix pace readout** — the focal number is drawn as a bitmap and pushed to
  an image container, because text containers have a fixed font size and can't be scaled up.
- **Scrollable lap history** — laps stack on the HUD; swipe to scroll through them.
- **Saved run history** — completed runs are stored on-device (up to 50) and browsable on
  the phone, with CSV export and delete.
- **Link recovery** — the HUD page is rebuilt automatically when the glasses reconnect,
  and updates stop while the link is down instead of piling up.
- **On-glasses stop menu** — Save / Discard / Continue is confirmed on the HUD itself,
  so you never need the phone mid-run.
- **Keep-screen-on (Wake Lock)** — optional; holds the screen awake so the run keeps
  running in the background, re-acquired automatically when the app returns to foreground.
- **GPS status indicator** — `GPS:OK` / `GPS:--` on the HUD at a glance.
- **Always-on phone panel** — three tabs: Settings, Runs and Console.

## HUD Layout (576×288)

```
        ┌───────────────────────────────────┬──────────────┐
y=  0   │ 12:34   2.00km                    │ 12:34        │ ← clock
y= 28   │ CAD 180spm  2431stp               │ 21°C Sun 40% │ ← weather
y= 56   │ SEG 5:12/km  L3  GPS:OK  ↑laps    │ NNE          │ ← compass
y= 84   │                                   │ G:85%        │ ← glasses battery
        │                                   └──────────────┤
y=140   │            ██  ██ ███  ██                        │ ┐ dot-matrix pace,
        │            ██ ███ ███ ███                        │ ┘ drawn as a bitmap
y=252   │                                            /km   │
        └──────────────────────────────────────────────────┘
```

The pace readout is an **image container** (160×72, centred), not text: text containers
render at a fixed font size, so a big number can only be produced as a bitmap. Falling
back to tiled text is a one-line switch (`USE_PACE_IMAGE` in `main.ts`).

### Lap history (full-screen, swipe to open)

```
LAPS  3-10/10  ↑↓scroll tap=close
L3  1.00km  5:12  5:12/km
L4  0.42km  2:31  5:59/km
…
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

## Phone Panel (WebView)

Always visible; no gesture required. Three tabs:

### Settings
- **Profile** — height (cm), optional weight (kg) for calorie estimation, and a
  **Keep Screen On (Wake Lock)** toggle.
- **Speed band coverage** — how many calibration records fall in each pace band.
- **Calibration records** — the last 10 harvested records, each showing date, duration,
  step length and source, with editable distance/steps and delete. New records appear
  here immediately after a Save + exit.

### Runs
Saved runs (newest first, max 50), each card showing distance, duration, average pace,
date, steps, calories and the full lap breakdown.

- **Copy all (CSV)** — one row per run, laps flattened into a trailing field, ready to
  paste into a spreadsheet. Clipboard access is unreliable in a WebView, so the CSV is
  also placed in a selectable textarea.
- **Delete** — per run, or all at once. Both confirm first.

Runs shorter than 5 s or 10 m are not saved.

### Console
Mirrors `console.*` plus uncaught errors and promise rejections — there are no devtools
on the phone, and this is how the link/image/cadence issues above are diagnosed.

- Colour-coded by level, timestamped, repeats collapsed (`x12`), 300-line buffer
- `copy` (selectable textarea), `imu` (unhide the high-rate IMU log spam, hidden by
  default), `pause`, `clear`
- Capture starts before the bridge connects, so startup logs are never lost

## Sensor Paths

The app selects the best available sensor automatically:

1. **DeviceMotion** (phone browser API) — preferred; gravity-removed vertical
   acceleration fused with gyroscope rotation rate.
2. **G2 IMU** (SDK `imuControl`) — fallback via EvenHub `IMU_DATA_REPORT` events. Only
   enabled when DeviceMotion is unavailable: while DeviceMotion runs the G2 samples are
   discarded anyway, and the stream occupies the BLE link continuously (~5/s).
3. **GPS only** — pace from GPS speed alone when no motion data is available.

> **Note on `ImuReportPace`:** the SDK's `Pxxx` values are *protocol pacing codes, not
> literal Hz*. Both sensor paths therefore **measure the real sample rate at runtime**
> from event timestamps and feed that into the bandpass filter and the cadence math, so
> the reading is correct regardless of the device's actual delivery rate.

## Cadence / Step Detection

Vertical acceleration (+ gyroscope) → band-pass filter (0.5–4.5 Hz) → autocorrelation
over a sliding window. Key robustness measures:

- **Adaptive sample rate** — the real event rate is measured and used for both the filter
  cutoffs and the lag→spm conversion, since a wrong rate scales cadence directly. It is
  derived as *samples ÷ elapsed time* over a 64-sample window, **not** as an average of
  instantaneous `1/dt` rates: the glasses deliver IMU events in bursts, and because
  `mean(1/dt) ≫ 1/mean(dt)` a single 1 ms gap reads as 1000 Hz and drags the estimate up.
  The measured rate is logged (`[IMU] measured report rate … Hz`).
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

Records that would carry no information are discarded outright rather than stored — zero
distance, duration, steps or cadence, or a step length outside 0.3–2.5 m. A calibration
record exists to teach a step length, so a zero-step record would only drag the k-scalar
down. The reason is logged (`[harvest] discarded: …`), as is a non-harvest (`[harvest] …`).

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
  main.ts              # entry point: bridge init, HUD page build/retry, gesture routing, run lifecycle, wake lock
  hud.ts               # HUD cell renderer (data rows, scrollable lap history, stop menu)
  paceImage.ts         # big pace readout as a dot-matrix bitmap (+ tiled-text fallback)
  runs.ts              # saved-run storage, CSV export
  debugLog.ts          # on-screen console (console.* capture + mountable panel)
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
    ui.ts              # phone panel shell: tab switching + settings screen
    runsUi.ts          # run history screen (cards, CSV copy, delete)
```

## Notes on the Glasses Link

Hard-won details that are easy to trip over:

- **`updateImageRawData` reports failure by return value, not by throwing.** An unchecked
  call fails silently and the image simply never appears.
- **`textContainerUpgrade` likewise returns a boolean.** It doubles as the cheapest link
  health probe, and drives both the image gating and the page rebuild.
- **Image payload is not the PNG size.** The phone decodes the image and pushes
  `width × height ÷ 2` bytes of 4-bit greyscale over BLE, so dimensions drive the cost:
  288×132 is ~19 KB, 160×72 is ~5.8 KB.
- **This host accepts raw greyscale (1 byte/px), not base64 PNG** — PNG comes back
  `sendFailed`, despite the docs listing both. The app probes greyscale first and keeps
  whichever format is accepted.
- **`createStartUpPageContainer` returns `invalid` when the glasses aren't connected**, so
  page creation is retried every 5 s rather than leaving a blank display forever.
- **The host emits placeholder status events** (`sn: ""`, `battery: 0`,
  `connectType: "none"`) that must not be mistaken for a disconnect.

## License

MIT

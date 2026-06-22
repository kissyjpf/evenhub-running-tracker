# Even G2 Running Tracker

**A running tracker app for Even Realities G1/G2 smart glasses, built on the EvenHub SDK.**

Displays real-time pace, cadence, distance, and lap data on the glasses' 576×288 mono green Micro-LED display — no phone screen required during a run.

---

## Features

- **Real-time pace display** — complementary filter fusing GPS + accelerometer (dead reckoning when GPS is unreliable)
- **Cadence tracking** — steps per minute via DeviceMotion API or G2 IMU
- **Auto-calibration** — learns your step length per cadence band from GPS data, persisted across sessions
- **Lap recording** — per-lap distance and elapsed time
- **Segment pace** — rolling average pace for the current lap
- **Settings UI** — height, weight, calibration records management (swipe up from idle)

## HUD Layout (576×288)

```
[elapsed]   [pace /km]   [distance]
     [cadence spm  •  segment pace]
[lap dist]  [status]   [k / calib]
```

## Gesture Controls

| Gesture     | Idle           | Running        | Paused         |
|-------------|----------------|----------------|----------------|
| Double tap  | Start run      | Stop & save    | Stop & save    |
| Single tap  | —              | Record lap     | Resume         |
| Swipe up    | Open settings  | Pause          | —              |
| Swipe down  | —              | —              | Resume         |

## Sensor Paths

The app selects the best available sensor automatically:

1. **DeviceMotion** (browser API) — preferred; provides cadence + vertical amplitude
2. **G2 IMU** (SDK `imuControl`) — fallback via EvenHub SDK events
3. **GPS only** — pace from GPS speed alone when no IMU data is available

## Pace Algorithm

```
L_base  = calibrated step length (cadence × vertical amplitude → lookup table)
k       = adaptive scalar updated from GPS when accuracy < 15m
v_acc   = (cadence / 60) × k × L_base
v_fused = 0.7 × v_gps + 0.3 × v_acc   (GPS valid)
        = v_acc                          (GPS absent / inaccurate)
pace    = EMA(1000 / v_fused, τ=4s)
```

Calibration records are auto-harvested at the end of each run and persisted to local storage on the glasses.

## Requirements

- Even Realities G1 or G2 smart glasses
- [EvenHub](https://github.com/evenrealities) desktop app
- Node.js 18+

## Setup

```bash
npm install
npm run dev      # development server
npm run build    # production build
```

Deploy the built `dist/` folder as an EvenHub plugin.

## Project Structure

```
src/
  main.ts              # entry point, bridge init, gesture handling
  hud.ts               # HUD renderer
  pace.ts              # complementary filter pace estimator
  state.ts             # app state (run lifecycle, laps)
  types.ts             # shared types and defaults
  sensors/
    manager.ts         # sensor orchestration
    device-motion.ts   # DeviceMotion API cadence extraction
    g2-imu.ts          # G2 IMU cadence extraction
    gps.ts             # GPS haversine distance, speed
  model/
    l-base.ts          # step-length lookup from calibration records
    k-scalar.ts        # adaptive GPS correction scalar
  calibration/
    harvest.ts         # auto-harvest calibration record from run
    records.ts         # persistence (load/save to local storage)
    gate.ts            # quality gate for calibration acceptance
  settings/
    ui.ts              # settings overlay renderer
```

## License

MIT

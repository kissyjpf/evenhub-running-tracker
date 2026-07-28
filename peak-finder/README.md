# Peak Finder

**Nearby mountain summits on Even Realities G1/G2 smart glasses, built on the EvenHub SDK.**

Look at a skyline and the glasses tell you what you're looking at: the name of each
summit in front of you, which way it lies, how far away it is and how high it is —
plus the direction you're facing, your altitude, the weather, temperature, humidity
and the time, all on one 576×288 mono-green screen.

Peak data comes from OpenStreetMap (Overpass API); weather from Open-Meteo. Neither
needs an API key.

---

## HUD Layout (576×288)

```
┌──────────────────────────────────────────────────────────┐
│ 14:23  21°C Clear 40%  ALT 850m  G85%                    │ ← clock / weather / altitude / battery
│ FACING NNE 23°  8/24  r50 ≥1000m  tap=mode               │ ← mode, heading, counts, active filters
├──────────────────────────────────────────────────────────┤
│ > NNE  ↑     42km  3776m  富士山 ▲                        │
│   NNE →12    28km  2057m  大菩薩嶺                        │
│   NE  →37    15km  1729m  雲取山                          │
│   ENE →61    31km  1201m  …                              │
└──────────────────────────────────────────────────────────┘
```

Each row is `marker · compass point · offset from your heading · distance · height · name`:

| Column | Meaning |
|--------|---------|
| `>`    | the summit is within 5° of dead ahead |
| `NNE`  | true bearing to the summit, 16-point compass |
| `→12`  | 12° to your right; `←` is to your left, `↑` is straight ahead |
| `42km` | great-circle distance to the summit |
| `3776m`| summit elevation (`--` when OSM has no `ele` tag) |
| `▲`    | the peak is tagged as a volcano |

Everything is a fixed-width column so the list reads as a table on a display with
one font size.

## View Modes

A single tap cycles through three orderings:

| Mode     | Shows |
|----------|-------|
| `FACING` | only what's inside the field-of-view cone, closest to dead ahead first |
| `NEAR`   | everything in range, nearest first |
| `HIGH`   | everything in range, tallest first |

Without a compass there is no cone to speak of, so `FACING` falls back to `NEAR`
rather than showing an empty screen.

## Gesture Controls

| Gesture     | Action                          |
|-------------|---------------------------------|
| Single tap  | Cycle FACING → NEAR → HIGH      |
| Double tap  | Exit                            |
| Swipe up    | Scroll down one page (8 rows)   |
| Swipe down  | Scroll up one page              |

## Settings (phone panel)

| Setting | Default | Notes |
|---------|---------|-------|
| **Radius / 半径** | 50 km | 1–200 km. Widening it refetches; narrowing it doesn't. |
| **Minimum summit height / 対象の山の高さ** | 1000 m | 0–5000 m. Applied locally, so moving it never costs a fetch. |
| Field of view | 90° (±45°) | How wide "in front of you" is in FACING mode. |
| Peak names | Local | Local script (Japanese in Japan) or English/romaji, for when Latin text reads better on the glasses. |
| Keep screen on | on | Wake Lock, so the app keeps updating in the background. |

The panel also has a **Peaks** tab (the full list with apparent elevation angles) and
a **Console** tab mirroring `console.*` — there are no devtools on the phone.

## Which Way You're Facing

The glasses expose accelerometer samples but **no magnetometer**, so the heading comes
from the phone. Two paths, neither universal:

- **iOS** — `deviceorientation` + `webkitCompassHeading` (already true north). Only
  after `DeviceOrientationEvent.requestPermission()` has been granted **from a user
  gesture**, which is what the *Enable compass / コンパスを有効化* button is for.
- **Android** — `deviceorientationabsolute` + `alpha`, counted counter-clockwise from
  north, so the heading is its mirror. This is magnetic north; in Japan that's about
  7° west of true, which is under half a compass point and left uncorrected.

Both are compensated for screen rotation, otherwise a landscape phone reads 90° out.

**GPS course over ground is the fallback**, marked `~` on the HUD. It only knows which
way you're *travelling*, so it can't help someone standing still looking up — treat it
as a rough hint, not a bearing.

The heading is smoothed on the unit circle (a plain average would put the mean of 359°
and 1° at 180°) and applied with 2° of hysteresis, so the list doesn't re-sort on
sensor noise while you stand still.

## Peak Data

```
[out:json][timeout:60];
(node["natural"="peak"]["name"](around:R,LAT,LON);
 node["natural"="volcano"]["name"](around:R,LAT,LON););
out body;
```

- **Named summits only** — an unnamed spot height tells you nothing when you're
  looking at it.
- **No height filter in the query.** The whole set is fetched and cached, and the
  minimum-height setting is applied at display time, so moving that slider is instant.
- **`ele` is free text** in OSM (`3776`, `3776 m`, `3,776`, `1234.5`) and is parsed
  accordingly. Summits with no `ele` are kept, but they can't satisfy a "at least N
  metres" filter, so they drop out as soon as one is set.
- **Cached on-device** and reused until you walk out of the area it covers — the
  cached disc has to contain the disc you're now asking for, so the usable slack is
  (cached radius − current radius). Once an area is cached the app works offline.
- Overpass is a shared community service: fetches are rate-limited by that coverage
  check, three mirrors are tried in order, and a failure backs off (30 s, doubling, up
  to 10 min) instead of retrying on the next tick. Stale cached data keeps being shown
  throughout.
- At most 800 summits are kept, tallest first — a 200 km radius over a mountainous
  region returns thousands.

## Altitude

GPS altitude when it's available (lightly smoothed — a raw fix wanders several metres),
otherwise the terrain elevation Open-Meteo returns for your position. GPS wins because
it's the one that knows you climbed a tower.

It's also what the apparent **elevation angle** in the phone's peak list is computed
from, with the standard 0.13 refraction/curvature correction — worth about 30 m of
apparent drop at 40 km, which matters for a distant summit.

## Requirements

- Even Realities G1 or G2 smart glasses
- EvenHub host app (`min_app_version` 2.0.0, `min_sdk_version` 0.0.10)
- Node.js 18+
- Network access to `overpass-api.de` (or a mirror) and `api.open-meteo.com`

## Setup

```bash
npm install
npm run dev      # Vite dev server (simulator)
npm test         # geometry / parsing / view / HUD smoke tests, no hardware needed
npm run build    # bump version, tsc, vite build, and pack peak-finder.ehpk
```

## Project Structure

```
src/
  main.ts        # entry point: bridge init, HUD page build/retry, tick, gestures, fetch scheduling
  hud.ts         # HUD renderer — the three text containers and their column layout
  view.ts        # peak set → what's on screen (distance, bearing, offset, elevation angle)
  peaks.ts       # Overpass query, tag parsing, on-device cache and its coverage rule
  geo.ts         # haversine, bearing, compass points, circular EMA, elevation angle
  heading.ts     # compass (DeviceOrientation, both platforms) + GPS-course fallback
  location.ts    # native App Location API with a browser-geolocation fallback
  weather.ts     # Open-Meteo current conditions + terrain elevation
  types.ts       # settings and their ranges
  debugLog.ts    # on-screen console (console.* capture + mountable panel)
  ui/panel.ts    # phone panel: settings, peak list, console
test/
  smoke.test.ts  # pure-logic tests (Tokyo → Fuji is the reference case)
```

## Notes on the Glasses Link

Inherited from the running tracker in this repo, and still true here:

- **`textContainerUpgrade` reports failure by return value, not by throwing.** Three
  consecutive failures mean the glasses no longer have the page, so it's rebuilt rather
  than pushing updates at containers that aren't there.
- **`createStartUpPageContainer` returns `invalid` when the glasses aren't connected**,
  so page creation is retried every 5 s instead of leaving a blank display.
- **A rebuild means the link dropped and came back**, which can take the location
  subscription with it — so location is re-armed whenever the page is rebuilt.
- **The host emits placeholder status events** (`sn: ""`, `battery: 0`,
  `connectType: "none"`) that must not be mistaken for a disconnect.

## License

MIT

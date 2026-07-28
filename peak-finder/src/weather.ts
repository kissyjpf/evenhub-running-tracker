// Current weather via Open-Meteo (no API key, CORS-enabled).
//
// The response also carries the DEM elevation of the queried point, which is a
// better viewer altitude than a GPS fix: GPS vertical error is routinely ±10 m
// and the app needs the altitude only to work out how far above you a summit
// sits. GPS altitude still wins when present — it's the one that knows you
// climbed a tower.

export interface WeatherInfo {
  tempC: number
  humidity: number
  cond: string
  /** Terrain elevation of the queried point, metres. */
  siteEleM: number | null
  ts: number
}

// WMO weather interpretation codes → a label short enough for the HUD row.
function condFromCode(code: number): string {
  if (code === 0) return 'Clear'
  if (code <= 2) return 'Clouds'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Showers'
  if (code === 85 || code === 86) return 'Snow'
  if (code >= 95) return 'Storm'
  return '--'
}

export async function fetchWeather(lat: number, lon: number): Promise<WeatherInfo | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}` +
      `&longitude=${lon.toFixed(4)}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code`
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[weather] ${res.status} ${res.statusText}`)
      return null
    }
    const j = await res.json() as {
      elevation?: number
      current?: { temperature_2m?: number, relative_humidity_2m?: number, weather_code?: number }
    }
    const c = j.current
    if (!c || typeof c.temperature_2m !== 'number') return null
    return {
      tempC: Math.round(c.temperature_2m),
      humidity: Math.round(c.relative_humidity_2m ?? 0),
      cond: condFromCode(c.weather_code ?? -1),
      siteEleM: typeof j.elevation === 'number' ? Math.round(j.elevation) : null,
      ts: Date.now(),
    }
  } catch (e) {
    console.warn('[weather] fetch failed:', e)
    return null
  }
}

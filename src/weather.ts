// Current weather via Open-Meteo (no API key, CORS-enabled).
// Used to show temperature / condition / humidity on the HUD.

export interface WeatherInfo {
  tempC: number
  humidity: number
  cond: string
}

// WMO weather interpretation codes → short label that fits the HUD.
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
    if (!res.ok) return null
    const j = await res.json() as {
      current?: { temperature_2m?: number, relative_humidity_2m?: number, weather_code?: number }
    }
    const c = j.current
    if (!c || typeof c.temperature_2m !== 'number') return null
    return {
      tempC: Math.round(c.temperature_2m),
      humidity: Math.round(c.relative_humidity_2m ?? 0),
      cond: condFromCode(c.weather_code ?? -1),
    }
  } catch {
    return null
  }
}

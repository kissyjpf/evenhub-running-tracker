// Phone panel (WebView): settings, the full peak list, and the console.
//
// Labels are bilingual — the app is written for Japanese mountains but the HUD
// itself stays ASCII, so the phone is where the Japanese lives.

import { compass16 } from '../geo'
import type { HeadingSource } from '../heading'
import type { Fix } from '../location'
import type { PeakSet } from '../peaks'
import type { PeakView, ViewMode } from '../view'
import type { WeatherInfo } from '../weather'
import {
  ELE_MAX_M, ELE_MIN_M, RADIUS_MAX_KM, RADIUS_MIN_KM, type Settings,
} from '../types'
import { mountDebugLog, unmountDebugLog } from '../debugLog'

export interface PanelState {
  settings: Settings
  views: PeakView[]
  totalInRange: number
  peakSet: PeakSet | null
  peakStatus: 'idle' | 'loading' | 'error'
  peakError: string | null
  fix: Fix | null
  locationSource: 'native' | 'browser' | null
  altitudeM: number | null
  heading: HeadingSource
  weather: WeatherInfo | null
  mode: ViewMode
}

export interface PanelCallbacks {
  onSettingsChange(s: Settings): void
  onRefreshPeaks(): void
  onEnableCompass(): void
  onModeChange(m: ViewMode): void
}

type Screen = 'settings' | 'peaks' | 'console'
let screen: Screen = 'settings'

// Live regions are updated in place on the tick; re-rendering the whole panel
// once a second would fight the user for focus in every number input.
let liveEl: HTMLElement | null = null
let peaksBodyEl: HTMLElement | null = null

const CSS = `
  #panel-root * { box-sizing: border-box; }
  .tabs { display:flex; gap:8px; max-width:520px; margin:0 auto; padding:12px 16px 0; }
  .tabs button { flex:1; background:#1c1c1c; color:#999; border:1px solid #333;
    border-radius:6px; padding:9px 0; font-size:14px; font-family:inherit; }
  .tabs button.on { background:#123; color:#8cf; border-color:#468; }
  .pw { max-width:520px; margin:0 auto; padding:16px;
    font-family:-apple-system, sans-serif; color:#ddd; }
  .pw h2 { font-size:14px; color:#8cf; margin:20px 0 8px; letter-spacing:.05em; }
  .pw h2:first-child { margin-top:4px; }
  .pw .row { display:flex; align-items:center; gap:10px; margin:10px 0; font-size:15px; }
  .pw .row label { flex:1; }
  .pw .sub { display:block; font-size:12px; color:#777; }
  .pw input[type=number] { background:#222; color:#eee; border:1px solid #444;
    border-radius:4px; padding:6px 10px; width:92px; font-size:15px; text-align:right; }
  .pw input[type=range] { width:100%; margin:2px 0 10px; }
  .pw select { background:#222; color:#eee; border:1px solid #444; border-radius:4px;
    padding:6px 8px; font-size:14px; }
  .pw .btn { background:#222; color:#ddd; border:1px solid #444; border-radius:4px;
    padding:8px 16px; font-size:14px; font-family:inherit; }
  .pw .btn.primary { border-color:#468; color:#8cf; }
  .pw .btn:disabled { opacity:.5; }
  .pw .kv { display:flex; justify-content:space-between; gap:12px; font-size:13px;
    padding:5px 0; border-bottom:1px solid #1e1e1e; }
  .pw .kv span:first-child { color:#777; }
  .pw .warn { color:#fd6; font-size:13px; margin:8px 0; }
  .pw .err { color:#f88; font-size:13px; margin:8px 0; }
  .pw table { width:100%; border-collapse:collapse; font-size:13px; }
  .pw th { color:#777; font-weight:normal; text-align:left; padding:6px 4px;
    border-bottom:1px solid #222; }
  .pw td { padding:7px 4px; border-bottom:1px solid #1a1a1a; }
  .pw td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .pw .modes { display:flex; gap:6px; margin-bottom:10px; }
  .pw .modes button { flex:1; background:#1c1c1c; color:#999; border:1px solid #333;
    border-radius:6px; padding:7px 0; font-size:13px; font-family:inherit; }
  .pw .modes button.on { background:#123; color:#8cf; border-color:#468; }
`

export function renderPanel(root: HTMLElement, st: PanelState, cb: PanelCallbacks): void {
  liveEl = null
  peaksBodyEl = null

  root.innerHTML = `
<style>${CSS}</style>
<div class="tabs">
  <button id="tab-settings" class="${screen === 'settings' ? 'on' : ''}">Settings</button>
  <button id="tab-peaks" class="${screen === 'peaks' ? 'on' : ''}">Peaks (${st.views.length})</button>
  <button id="tab-console" class="${screen === 'console' ? 'on' : ''}">Console</button>
</div>
<div id="screen-root"></div>`

  const host = root.querySelector<HTMLElement>('#screen-root')!
  const go = (s: Screen) => { screen = s; renderPanel(root, st, cb) }
  root.querySelector('#tab-settings')!.addEventListener('click', () => go('settings'))
  root.querySelector('#tab-peaks')!.addEventListener('click', () => go('peaks'))
  root.querySelector('#tab-console')!.addEventListener('click', () => go('console'))

  // The console owns its own DOM and has to be detached when we leave it.
  if (screen !== 'console') unmountDebugLog()

  if (screen === 'console') {
    host.style.padding = '16px'
    mountDebugLog(host)
    return
  }
  if (screen === 'peaks') {
    renderPeaksScreen(host, st, cb)
    return
  }
  renderSettingsScreen(host, st, cb)
}

// ── Settings ─────────────────────────────────────────────────────────────────
function renderSettingsScreen(host: HTMLElement, st: PanelState, cb: PanelCallbacks): void {
  const s = st.settings
  host.innerHTML = `
<div class="pw">

  <h2>SEARCH / 検索範囲</h2>

  <div class="row">
    <label>Radius <span class="sub">半径</span></label>
    <input type="number" id="radius-num" min="${RADIUS_MIN_KM}" max="${RADIUS_MAX_KM}" value="${s.radiusKm}" />
    <span style="font-size:13px;color:#666">km</span>
  </div>
  <input type="range" id="radius-range" min="${RADIUS_MIN_KM}" max="${RADIUS_MAX_KM}" step="1" value="${s.radiusKm}" />

  <div class="row">
    <label>Minimum summit height <span class="sub">対象の山の高さ（以上）</span></label>
    <input type="number" id="ele-num" min="${ELE_MIN_M}" max="${ELE_MAX_M}" step="50" value="${s.minEleM}" />
    <span style="font-size:13px;color:#666">m</span>
  </div>
  <input type="range" id="ele-range" min="${ELE_MIN_M}" max="${ELE_MAX_M}" step="50" value="${s.minEleM}" />

  <div class="row">
    <label>Field of view <span class="sub">前方とみなす角度（FACING表示）</span></label>
    <select id="fov">
      ${[60, 90, 120, 180, 360].map(v =>
        `<option value="${v}" ${s.fovDeg === v ? 'selected' : ''}>±${v / 2}° (${v}°)</option>`).join('')}
    </select>
  </div>

  <div class="row">
    <label>Peak names <span class="sub">山名の表記</span></label>
    <select id="name-lang">
      <option value="local" ${s.nameLang === 'local' ? 'selected' : ''}>Local / 現地表記</option>
      <option value="en" ${s.nameLang === 'en' ? 'selected' : ''}>English / ローマ字</option>
    </select>
  </div>

  <div class="row">
    <label>Keep screen on <span class="sub">画面をスリープさせない</span></label>
    <input type="checkbox" id="wakelock" ${s.useWakeLock ? 'checked' : ''} style="width:22px;height:22px" />
  </div>

  <h2>COMPASS / 方位</h2>
  <div id="compass-box"></div>

  <h2>PEAK DATA / 山データ (OpenStreetMap)</h2>
  <div id="data-box"></div>
  <div class="row" style="margin-top:12px">
    <button class="btn primary" id="refresh">Refresh peaks / 再取得</button>
  </div>

  <h2>STATUS / 現在値</h2>
  <div id="live"></div>

</div>`

  liveEl = host.querySelector<HTMLElement>('#live')
  renderCompassBox(host.querySelector<HTMLElement>('#compass-box')!, st, cb)
  renderDataBox(host.querySelector<HTMLElement>('#data-box')!, st)
  renderLive(st)

  // Number field and slider drive the same value; committing on 'change' (not
  // 'input') keeps a drag from firing an Overpass fetch on every pixel.
  const radiusNum = host.querySelector<HTMLInputElement>('#radius-num')!
  const radiusRange = host.querySelector<HTMLInputElement>('#radius-range')!
  const eleNum = host.querySelector<HTMLInputElement>('#ele-num')!
  const eleRange = host.querySelector<HTMLInputElement>('#ele-range')!

  radiusRange.addEventListener('input', () => { radiusNum.value = radiusRange.value })
  eleRange.addEventListener('input', () => { eleNum.value = eleRange.value })

  const commit = (patch: Partial<Settings>) => cb.onSettingsChange({ ...s, ...patch })

  radiusNum.addEventListener('change', () => commit({ radiusKm: Number(radiusNum.value) }))
  radiusRange.addEventListener('change', () => commit({ radiusKm: Number(radiusRange.value) }))
  eleNum.addEventListener('change', () => commit({ minEleM: Number(eleNum.value) }))
  eleRange.addEventListener('change', () => commit({ minEleM: Number(eleRange.value) }))

  host.querySelector<HTMLSelectElement>('#fov')!
    .addEventListener('change', e => commit({ fovDeg: Number((e.target as HTMLSelectElement).value) }))
  host.querySelector<HTMLSelectElement>('#name-lang')!
    .addEventListener('change', e =>
      commit({ nameLang: (e.target as HTMLSelectElement).value as Settings['nameLang'] }))
  host.querySelector<HTMLInputElement>('#wakelock')!
    .addEventListener('change', e => commit({ useWakeLock: (e.target as HTMLInputElement).checked }))
  host.querySelector<HTMLButtonElement>('#refresh')!
    .addEventListener('click', () => cb.onRefreshPeaks())
}

function renderCompassBox(el: HTMLElement, st: PanelState, cb: PanelCallbacks): void {
  const h = st.heading
  const state = h.kind === 'compass'
    ? `OK — ${h.sampleCount} samples`
    : h.kind === 'gps'
      ? 'GPS course only (compass unavailable — bearings are only right while moving)'
      : 'not available'

  el.innerHTML = `
    <div class="kv"><span>Source</span><span>${state}</span></div>
    <div class="kv"><span>Permission</span><span>${h.permission}</span></div>
    ${h.kind !== 'compass' ? `
      <div class="warn">iOS asks for motion &amp; orientation access from a tap.
        iOSでは下のボタンから許可してください。</div>
      <div class="row"><button class="btn primary" id="enable-compass">Enable compass / コンパスを有効化</button></div>` : ''}
    <div class="kv"><span>Note</span><span style="text-align:right">The compass reads the phone,
      not the glasses — keep it facing the same way you do.</span></div>`

  el.querySelector<HTMLButtonElement>('#enable-compass')
    ?.addEventListener('click', () => cb.onEnableCompass())
}

function renderDataBox(el: HTMLElement, st: PanelState): void {
  const set = st.peakSet
  const ageDays = set ? (Date.now() - set.ts) / 86400000 : null
  el.innerHTML = `
    <div class="kv"><span>Cached peaks</span><span>${set ? set.peaks.length : '—'}</span></div>
    <div class="kv"><span>Cached radius</span><span>${set ? `${set.radiusKm} km` : '—'}</span></div>
    <div class="kv"><span>Fetched</span><span>${
      ageDays === null ? '—' : ageDays < 1 ? 'today' : `${Math.round(ageDays)} d ago`}</span></div>
    <div class="kv"><span>In range now</span><span>${st.totalInRange}</span></div>
    ${st.peakStatus === 'loading' ? '<div class="warn">Loading… / 取得中…</div>' : ''}
    ${st.peakStatus === 'error' ? `<div class="err">Fetch failed: ${escapeHtml(st.peakError ?? '')}<br>
      Cached data is still in use. Retrying automatically.</div>` : ''}`
}

function renderLive(st: PanelState): void {
  if (!liveEl) return
  const f = st.fix
  const h = st.heading
  const w = st.weather
  const now = new Date()
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` +
    `:${String(now.getSeconds()).padStart(2, '0')}`

  liveEl.innerHTML = `
    <div class="kv"><span>Time / 時刻</span><span>${clock}</span></div>
    <div class="kv"><span>Facing / 方向</span><span>${
      h.deg === null ? '—' : `${compass16(h.deg)} ${Math.round(h.deg)}°${h.kind === 'gps' ? ' (GPS)' : ''}`}</span></div>
    <div class="kv"><span>Altitude / 高度</span><span>${
      st.altitudeM === null ? '—' : `${Math.round(st.altitudeM)} m`}</span></div>
    <div class="kv"><span>Weather / 天気</span><span>${w ? w.cond : '—'}</span></div>
    <div class="kv"><span>Temp / 気温</span><span>${w ? `${w.tempC} °C` : '—'}</span></div>
    <div class="kv"><span>Humidity / 湿度</span><span>${w ? `${w.humidity} %` : '—'}</span></div>
    <div class="kv"><span>Position</span><span>${
      f ? `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}` : 'waiting for a fix'}</span></div>
    <div class="kv"><span>GPS accuracy</span><span>${
      f ? `±${Math.round(f.accuracyM)} m (${st.locationSource ?? '—'})` : '—'}</span></div>`
}

// ── Peaks list ───────────────────────────────────────────────────────────────
const MODES: { id: ViewMode, label: string }[] = [
  { id: 'facing', label: 'FACING / 正面' },
  { id: 'near', label: 'NEAR / 近い順' },
  { id: 'high', label: 'HIGH / 高い順' },
]

function renderPeaksScreen(host: HTMLElement, st: PanelState, cb: PanelCallbacks): void {
  host.innerHTML = `
<div class="pw">
  <div class="modes">
    ${MODES.map(m => `<button data-mode="${m.id}" class="${st.mode === m.id ? 'on' : ''}">${m.label}</button>`).join('')}
  </div>
  <table>
    <thead><tr>
      <th>Dir</th><th class="num">Off</th><th class="num">Dist</th>
      <th class="num">Ele</th><th class="num">Up</th><th>Name</th>
    </tr></thead>
    <tbody id="peaks-body"></tbody>
  </table>
</div>`

  for (const btn of Array.from(host.querySelectorAll<HTMLButtonElement>('.modes button'))) {
    btn.addEventListener('click', () => cb.onModeChange(btn.dataset['mode'] as ViewMode))
  }
  peaksBodyEl = host.querySelector<HTMLElement>('#peaks-body')
  renderPeaksBody(st)
}

function renderPeaksBody(st: PanelState): void {
  if (!peaksBodyEl) return
  if (st.views.length === 0) {
    peaksBodyEl.innerHTML =
      `<tr><td colspan="6" style="color:#777;padding:16px 4px">
        No peaks to show. / 表示できる山がありません。</td></tr>`
    return
  }
  peaksBodyEl.innerHTML = st.views.slice(0, 100).map(v => {
    const off = v.rel === null ? '—'
      : Math.abs(v.rel) <= 5 ? '↑'
        : `${v.rel > 0 ? 'R' : 'L'}${Math.round(Math.abs(v.rel))}°`
    const km = v.distM / 1000
    return `<tr>
      <td>${compass16(v.bearing)}</td>
      <td class="num">${off}</td>
      <td class="num">${km < 10 ? km.toFixed(1) : Math.round(km)} km</td>
      <td class="num">${v.peak.eleM === null ? '—' : `${Math.round(v.peak.eleM)} m`}</td>
      <td class="num">${v.elevAngle === null ? '—' : `${v.elevAngle.toFixed(1)}°`}</td>
      <td>${escapeHtml(v.peak.name)}${v.peak.volcano ? ' <span style="color:#f88">▲</span>' : ''}</td>
    </tr>`
  }).join('')
}

/** Called on the app tick: refreshes only the parts with no user input in them. */
export function refreshPanelLive(st: PanelState): void {
  if (screen === 'settings') renderLive(st)
  else if (screen === 'peaks') renderPeaksBody(st)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

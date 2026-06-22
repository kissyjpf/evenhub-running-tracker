// Settings UI: rendered in the phone WebView.
// Lets the user edit height/weight and calibration records.

import type { CalibRecord, Settings } from '../types'
import { bandCoverage, editRecordDistance, deleteRecord } from '../calibration/records'
import type { HUDCells } from '../hud'

export interface SettingsCallbacks {
  onSettingsChange(s: Settings): void
  onRecordsChange(r: CalibRecord[]): void
  onClose(): void
}

const BAND_LABELS = ['<3.0 m/s', '3.0–3.5', '3.5–4.0', '4.0–4.5', '>4.5 m/s']

export function renderSettingsUI(
  root: HTMLElement,
  settings: Settings,
  records: CalibRecord[],
  hudCells: HUDCells,
  cb: SettingsCallbacks,
): void {
  root.innerHTML = `
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; padding: 16px;
    background: #111; color: #ddd; margin: 0; }
  h2 { font-size: 14px; color: #8cf; margin: 16px 0 6px; letter-spacing: .05em; }
  label { display: flex; align-items: center; gap: 8px;
    margin: 6px 0; font-size: 13px; }
  input[type=number] { background: #222; color: #eee; border: 1px solid #444;
    border-radius: 4px; padding: 4px 8px; width: 90px; font-size: 13px; }
  .btn { background: #222; color: #ddd; border: 1px solid #444;
    border-radius: 4px; padding: 5px 12px; cursor: pointer; font-size: 12px; }
  .btn:active { background: #333; }
  .btn.danger { border-color: #933; color: #f88; }
  .btn.primary { border-color: #468; color: #8cf; }
  .coverage { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .band { padding: 4px 10px; border-radius: 12px; font-size: 11px; }
  .band-empty  { background: #222; color: #555; border: 1px solid #333; }
  .band-half   { background: #133; color: #7cf; border: 1px solid #468; }
  .band-full   { background: #134; color: #afa; border: 1px solid #474; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
  th { color: #666; font-weight: normal; text-align: left;
    padding: 4px 4px; border-bottom: 1px solid #222; }
  td { padding: 5px 4px; border-bottom: 1px solid #1a1a1a; vertical-align: middle; }
  .dist-in { width: 64px; background: #222; color: #eee; border: 1px solid #333;
    border-radius: 3px; padding: 2px 4px; font-size: 11px; }
  .src-tag { font-size: 10px; color: #666; }
  .src-tag.manual { color: #8cf; }
  .back-row { margin-top: 20px; }
  /* Glasses HUD preview */
  .hud-preview {
    background: #050505; border: 1px solid #2a2a2a; border-radius: 10px;
    padding: 0 6px; margin: 4px 0 12px; position: relative;
    aspect-ratio: 2 / 1; overflow: hidden;
    font-family: monospace; color: #00cc55; font-size: 9px; }
  .hud-row-top, .hud-row-mid {
    display: flex; align-items: center; height: 9.72%; }
  .hud-row-bot {
    position: absolute; bottom: 0; left: 6px; right: 6px;
    display: flex; align-items: center; height: 9.72%; }
  .hud-l  { flex: 130; overflow: hidden; white-space: nowrap; }
  .hud-c  { flex: 316; text-align: center; overflow: hidden; white-space: nowrap; font-size: 11px; }
  .hud-r  { flex: 130; text-align: right; overflow: hidden; white-space: nowrap; }
  .hud-f  { flex: 1; text-align: center; overflow: hidden; white-space: nowrap; }
</style>
<h2>GLASSES PREVIEW</h2>
<div class="hud-preview">
  <div class="hud-row-top">
    <span class="hud-l" id="prev-tl">${hudCells.tl}</span>
    <span class="hud-c" id="prev-tc">${hudCells.tc}</span>
    <span class="hud-r" id="prev-tr">${hudCells.tr}</span>
  </div>
  <div class="hud-row-mid">
    <span class="hud-f" id="prev-ca">${hudCells.ca}</span>
  </div>
  <div class="hud-row-bot">
    <span class="hud-l" id="prev-bl">${hudCells.bl}</span>
    <span class="hud-c" id="prev-bc">${hudCells.bc}</span>
    <span class="hud-r" id="prev-br">${hudCells.br}</span>
  </div>
</div>

<h2>PROFILE</h2>
<label>Height
  <input type="number" id="height" min="100" max="250" value="${settings.height_cm}" />
  <span style="font-size:12px;color:#666">cm</span>
</label>
<label>Weight (optional)
  <input type="number" id="weight" min="30" max="200"
    value="${settings.weight_kg !== null ? settings.weight_kg : ''}" />
  <span style="font-size:12px;color:#666">kg</span>
</label>
<button class="btn primary" id="save-profile">Save profile</button>
<div id="profile-msg" style="font-size:11px;color:#4a4;margin:4px 0;min-height:14px"></div>

<h2>SPEED BAND COVERAGE</h2>
<div class="coverage" id="coverage"></div>

<h2>CALIBRATION RECORDS (${records.length}/10)</h2>
<table>
  <thead>
    <tr><th>#</th><th>Date</th><th>v m/s</th><th>Cad</th><th>Step m</th><th>Src</th>
      <th>Dist m</th><th></th></tr>
  </thead>
  <tbody id="rec-body"></tbody>
</table>

<div class="back-row">
  <button class="btn" id="close-btn">← Back</button>
</div>
`

  // Band coverage
  const coverage = bandCoverage(records)
  const covEl = root.querySelector('#coverage')!
  BAND_LABELS.forEach((label, i) => {
    const count = coverage.get(i) ?? 0
    const cls = count === 0 ? 'band-empty' : count >= 2 ? 'band-full' : 'band-half'
    const span = document.createElement('span')
    span.className = `band ${cls}`
    span.textContent = `${label} ${count}/2`
    covEl.appendChild(span)
  })

  // Records table
  const tbody = root.querySelector('#rec-body')!
  records.forEach((r, idx) => {
    const date = new Date(r.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const srcCls = r.edited ? 'manual' : ''
    const srcLabel = r.edited ? 'manual' : r.source
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${date}</td>
      <td>${r.speed_ms.toFixed(2)}</td>
      <td>${Math.round(r.cadence_spm)}</td>
      <td>${r.step_length_m.toFixed(3)}</td>
      <td><span class="src-tag ${srcCls}">${srcLabel}</span></td>
      <td><input class="dist-in" type="number" min="100" max="50000"
          value="${Math.round(r.distance_m)}" data-idx="${idx}" /></td>
      <td>
        <button class="btn edit-btn" data-idx="${idx}" style="padding:2px 6px">✓</button>
        <button class="btn danger del-btn" data-idx="${idx}" style="padding:2px 6px">✕</button>
      </td>`
    tbody.appendChild(tr)
  })

  // Save profile
  root.querySelector('#save-profile')!.addEventListener('click', () => {
    const h = parseInt((root.querySelector('#height') as HTMLInputElement).value)
    const wRaw = parseFloat((root.querySelector('#weight') as HTMLInputElement).value)
    const msg = root.querySelector('#profile-msg')!
    if (!isFinite(h) || h < 100 || h > 250) {
      msg.textContent = 'Invalid height'
      return
    }
    cb.onSettingsChange({
      ...settings,
      height_cm: h,
      weight_kg: isFinite(wRaw) && wRaw > 0 ? wRaw : null,
    })
    msg.textContent = 'Saved'
    setTimeout(() => { msg.textContent = '' }, 2000)
  })

  // Edit distance
  root.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt((e.currentTarget as HTMLElement).dataset['idx'] ?? '0')
      const input = root.querySelector<HTMLInputElement>(`.dist-in[data-idx="${idx}"]`)!
      const newDist = parseFloat(input.value)
      if (!isFinite(newDist) || newDist <= 0) return
      const { records: updated, error } = editRecordDistance(records, idx, newDist)
      if (error) { alert(error); return }
      cb.onRecordsChange(updated)
    })
  })

  // Delete record
  root.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt((e.currentTarget as HTMLElement).dataset['idx'] ?? '0')
      if (!confirm('Delete this calibration record?')) return
      cb.onRecordsChange(deleteRecord(records, idx))
    })
  })

  root.querySelector('#close-btn')!.addEventListener('click', cb.onClose)
}

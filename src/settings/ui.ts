// Settings UI: rendered in the phone WebView.
// Lets the user edit height/weight and calibration records.

import type { CalibRecord, Settings } from '../types'
import { bandCoverage, editRecordDistance, deleteRecord } from '../calibration/records'

export interface SettingsCallbacks {
  onSettingsChange(s: Settings): void
  onRecordsChange(r: CalibRecord[]): void
}

const BAND_LABELS = ['<3.0 m/s', '3.0–3.5', '3.5–4.0', '4.0–4.5', '>4.5 m/s']

export function renderSettingsUI(
  root: HTMLElement,
  settings: Settings,
  records: CalibRecord[],
  cb: SettingsCallbacks,
): void {
  root.innerHTML = `
<style>
  #settings-root * { box-sizing: border-box; }
  .sw { max-width: 480px; margin: 0 auto; padding: 16px;
    font-family: -apple-system, sans-serif; color: #ddd; }
  .sw h2 { font-size: 16px; color: #8cf; margin: 18px 0 8px; letter-spacing: .05em; }
  .sw label { display: flex; align-items: center; gap: 8px;
    margin: 8px 0; font-size: 15px; }
  .sw input[type=number] { background: #222; color: #eee; border: 1px solid #444;
    border-radius: 4px; padding: 6px 10px; width: 100px; font-size: 15px; }
  .sw .btn { background: #222; color: #ddd; border: 1px solid #444;
    border-radius: 4px; padding: 7px 16px; cursor: pointer; font-size: 14px; }
  .sw .btn:active { background: #333; }
  .sw .btn.danger { border-color: #933; color: #f88; }
  .sw .btn.primary { border-color: #468; color: #8cf; }
  .sw .coverage { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .sw .band { padding: 5px 12px; border-radius: 12px; font-size: 13px; }
  .sw .band-empty  { background: #222; color: #555; border: 1px solid #333; }
  .sw .band-half   { background: #133; color: #7cf; border: 1px solid #468; }
  .sw .band-full   { background: #134; color: #afa; border: 1px solid #474; }
  .sw table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  .sw th { color: #777; font-weight: normal; text-align: left;
    padding: 5px 4px; border-bottom: 1px solid #222; }
  .sw td { padding: 7px 4px; border-bottom: 1px solid #1a1a1a; vertical-align: middle; }
  .sw .dist-in { width: 72px; background: #222; color: #eee; border: 1px solid #333;
    border-radius: 3px; padding: 4px 6px; font-size: 13px; }
  .sw .src-tag { font-size: 12px; color: #666; }
  .sw .src-tag.manual { color: #8cf; }
</style>
<div class="sw">

<h2>PROFILE</h2>
<label>Height
  <input type="number" id="height" min="100" max="250" value="${settings.height_cm}" />
  <span style="font-size:13px;color:#666">cm</span>
</label>
<label>Weight (optional)
  <input type="number" id="weight" min="30" max="200"
    value="${settings.weight_kg !== null ? settings.weight_kg : ''}" />
  <span style="font-size:13px;color:#666">kg</span>
</label>
<button class="btn primary" id="save-profile">Save profile</button>
<div id="profile-msg" style="font-size:13px;color:#4a4;margin:6px 0;min-height:16px"></div>

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

}

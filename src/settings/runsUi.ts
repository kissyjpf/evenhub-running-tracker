// Run history screen, rendered in the phone WebView next to the settings screen.
// Lists completed runs with their laps, and supports copy (CSV) and delete.

import type { RunRecord } from '../types'
import { avgPaceSPerKm, deleteRun, fmtDuration, fmtPace, runsToCsv } from '../runs'

export interface RunsCallbacks {
  onRunsChange(runs: RunRecord[]): void
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;')
}

export function renderRunsUI(
  root: HTMLElement,
  runs: RunRecord[],
  cb: RunsCallbacks,
): void {
  const totalKm = runs.reduce((n, r) => n + r.distance_m, 0) / 1000

  root.innerHTML = `
<div class="sw">
  <h2>RUN HISTORY (${runs.length})</h2>
  <div style="font-size:13px;color:#777;margin-bottom:10px">
    ${runs.length === 0 ? 'No runs saved yet.' : `${totalKm.toFixed(2)} km total`}
  </div>

  <div class="rw-btns" style="display:flex;gap:8px;margin-bottom:12px">
    <button class="btn primary" id="runs-copy" ${runs.length ? '' : 'disabled'}>Copy all (CSV)</button>
    <button class="btn danger" id="runs-clear" ${runs.length ? '' : 'disabled'}>Delete all</button>
  </div>
  <textarea id="runs-text" readonly style="display:none;width:100%;height:150px;
    background:#000;color:#ddd;border:1px solid #444;border-radius:4px;
    font-family:monospace;font-size:11px;margin-bottom:12px"></textarea>

  <div id="runs-list"></div>
</div>`

  const list = root.querySelector('#runs-list')!
  runs.forEach(r => {
    const d = new Date(r.ts)
    const card = document.createElement('div')
    card.style.cssText =
      'border:1px solid #333;border-radius:6px;padding:10px 12px;margin-bottom:10px;background:#161616'
    const lapRows = r.laps.length === 0 ? '' : `
      <table style="margin-top:8px">
        <thead><tr><th>Lap</th><th>Dist</th><th>Time</th><th>Pace</th></tr></thead>
        <tbody>${r.laps.map(l => {
          const p = l.distanceM > 0 ? (l.elapsedMs / 1000) / (l.distanceM / 1000) : null
          return `<tr><td>${l.number}</td><td>${(l.distanceM / 1000).toFixed(2)} km</td>` +
                 `<td>${fmtDuration(l.elapsedMs)}</td><td>${fmtPace(p)} /km</td></tr>`
        }).join('')}</tbody>
      </table>`

    card.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px">
        <strong style="color:#8cf;font-size:15px">${(r.distance_m / 1000).toFixed(2)} km</strong>
        <span style="color:#ddd">${fmtDuration(r.duration_ms)}</span>
        <span style="color:#ddd">${fmtPace(avgPaceSPerKm(r))} /km</span>
        <span style="flex:1"></span>
        <button class="btn danger run-del" data-ts="${r.ts}" style="padding:2px 8px">✕</button>
      </div>
      <div style="font-size:12px;color:#777;margin-top:4px">
        ${esc(d.toLocaleDateString())} ${esc(d.toLocaleTimeString())}
        · ${Math.round(r.steps)} steps · ${Math.round(r.calories)} kcal
      </div>
      ${lapRows}`
    list.appendChild(card)
  })

  // Clipboard is unreliable in a WebView, so also expose the CSV in a selectable
  // textarea the user can long-press to copy.
  const textEl = root.querySelector<HTMLTextAreaElement>('#runs-text')!
  root.querySelector('#runs-copy')?.addEventListener('click', () => {
    const csv = runsToCsv(runs)
    navigator.clipboard?.writeText(csv).catch(() => {})
    textEl.value = csv
    textEl.style.display = 'block'
    textEl.select()
  })

  root.querySelector('#runs-clear')?.addEventListener('click', () => {
    if (!confirm(`Delete all ${runs.length} runs? This cannot be undone.`)) return
    cb.onRunsChange([])
  })

  root.querySelectorAll('.run-del').forEach(btn => {
    btn.addEventListener('click', e => {
      const ts = Number((e.currentTarget as HTMLElement).dataset['ts'])
      if (!confirm('Delete this run?')) return
      cb.onRunsChange(deleteRun(runs, ts))
    })
  })
}

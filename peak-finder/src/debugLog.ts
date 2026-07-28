// On-screen console for hardware testing.
//
// There are no devtools when the plugin runs on the phone/glasses, so mirror
// console output into a panel in the WebView.
//
// Split in two: installDebugLog() hooks console.* at startup and buffers lines
// with no DOM at all, so nothing is lost before the UI exists; mountDebugLog()
// renders that buffer into whichever element the Console tab hands it.

const MAX_LINES = 300

type Level = 'log' | 'info' | 'warn' | 'error'

interface Line { t: string, level: Level, msg: string, n?: number }

const lines: Line[] = []
let bodyEl: HTMLElement | null = null
let countEl: HTMLElement | null = null
let installed = false
let paused = false

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return `${a.name}: ${a.message}`
  if (a === null) return 'null'
  if (a === undefined) return 'undefined'
  try { return JSON.stringify(a) } catch { return String(a) }
}

function asText(): string {
  return lines.map(l => `${l.t} [${l.level}] ${l.msg}${l.n && l.n > 1 ? ` x${l.n}` : ''}`).join('\n')
}

// The SDK logs every IMU sample (~5/s), which buries everything else and makes
// the panel impossible to read or paste. Drop that one line pattern; toggled by
// the "noise" button if it's ever needed.
const NOISE = /EvenHub event|iMUData/
let showNoise = false

function push(level: Level, args: unknown[]): void {
  // Test the format string before serialising: the SDK logs an IMU object many
  // times a second, and stringifying those just to discard them burns CPU.
  const head = typeof args[0] === 'string' ? args[0] : ''
  if (!showNoise && NOISE.test(head)) return

  const msg = args.map(fmtArg).join(' ')
  if (!showNoise && NOISE.test(msg)) return

  // Collapse repeats (device-status events repeat many times a second).
  const last = lines[lines.length - 1]
  if (last && last.msg === msg && last.level === level) {
    last.n = (last.n ?? 1) + 1
    last.t = stamp()
  } else {
    lines.push({ t: stamp(), level, msg })
    if (lines.length > MAX_LINES) lines.shift()
  }
  if (!paused) scheduleRender()
}

// Coalesce renders to one per frame — rebuilding the list on every log line
// makes the panel the most expensive thing in the app.
let renderQueued = false
function scheduleRender(): void {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => { renderQueued = false; render() })
}

const COLORS: Record<Level, string> = {
  log: '#cfcfcf', info: '#8cf', warn: '#fd6', error: '#f88',
}

function render(): void {
  if (!bodyEl || !countEl) return
  countEl.textContent = String(lines.length)
  bodyEl.innerHTML = lines.map(l =>
    `<div style="color:${COLORS[l.level]};white-space:pre-wrap;word-break:break-all">` +
    `<span style="color:#666">${l.t}</span> ${escapeHtml(l.msg)}` +
    (l.n && l.n > 1 ? ` <span style="color:#666">x${l.n}</span>` : '') +
    `</div>`
  ).join('')
  bodyEl.scrollTop = bodyEl.scrollHeight   // follow the tail
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

// Starts capturing console.* and uncaught errors. No DOM. Safe to call twice.
export function installDebugLog(): void {
  if (installed || typeof document === 'undefined') return
  installed = true

  const orig = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  }
  const hook = (level: Level) => (...args: unknown[]) => {
    orig[level](...args)
    try { push(level, args) } catch { /* never let logging break the app */ }
  }
  console.log = hook('log')
  console.info = hook('info')
  console.warn = hook('warn')
  console.error = hook('error')

  window.addEventListener('error', ev => {
    push('error', [`uncaught: ${ev.message} @${ev.filename}:${ev.lineno}`])
  })
  window.addEventListener('unhandledrejection', ev => {
    push('error', [`unhandled rejection: ${fmtArg(ev.reason)}`])
  })
}

// Detach from the DOM (called when the user leaves the Console tab) so renders
// stop targeting a discarded element. The buffer keeps filling regardless.
export function unmountDebugLog(): void {
  bodyEl = null
  countEl = null
}

// Renders the console into `host`. Re-mountable; the buffer survives.
export function mountDebugLog(host: HTMLElement): void {
  const wrap = document.createElement('div')
  wrap.id = 'debug-root'
  wrap.style.cssText =
    'max-width:480px;margin:0 auto;border:1px solid #444;border-radius:6px;' +
    'background:#111;font-family:monospace;font-size:12px;overflow:hidden'
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:#1e1e1e;border-bottom:1px solid #444">
      <strong style="color:#8cf;font-size:13px">console</strong>
      <span id="dbg-count" style="color:#666">0</span>
      <span style="flex:1"></span>
      <button id="dbg-copy"   style="background:#222;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 10px">copy</button>
      <button id="dbg-noise"  style="background:#222;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 10px">imu</button>
      <button id="dbg-pause"  style="background:#222;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 10px">pause</button>
      <button id="dbg-clear"  style="background:#222;color:#ddd;border:1px solid #444;border-radius:4px;padding:4px 10px">clear</button>
    </div>
    <div id="dbg-body" style="height:420px;overflow:auto;padding:6px 8px;line-height:1.45"></div>
    <textarea id="dbg-text" readonly style="display:none;width:100%;height:140px;background:#000;color:#ddd;border:0;border-top:1px solid #444;font-family:monospace;font-size:11px"></textarea>`
  host.appendChild(wrap)

  bodyEl = wrap.querySelector('#dbg-body')
  countEl = wrap.querySelector('#dbg-count')
  const textEl = wrap.querySelector<HTMLTextAreaElement>('#dbg-text')!
  const pauseBtn = wrap.querySelector<HTMLButtonElement>('#dbg-pause')!

  wrap.querySelector('#dbg-clear')!.addEventListener('click', () => {
    lines.length = 0
    textEl.style.display = 'none'
    render()
  })

  // Clipboard access is unreliable in a WebView — fall back to a selectable
  // textarea the user can long-press to copy.
  wrap.querySelector('#dbg-copy')!.addEventListener('click', () => {
    const text = asText()
    navigator.clipboard?.writeText(text).catch(() => {})
    textEl.value = text
    textEl.style.display = 'block'
    textEl.select()
  })

  const noiseBtn = wrap.querySelector<HTMLButtonElement>('#dbg-noise')!
  noiseBtn.addEventListener('click', () => {
    showNoise = !showNoise
    noiseBtn.style.color = showNoise ? '#8cf' : '#ddd'
  })

  pauseBtn.addEventListener('click', () => {
    paused = !paused
    pauseBtn.textContent = paused ? 'resume' : 'pause'
    if (!paused) render()
  })

  render()
}

// Big pace readout as a block dot-matrix bitmap for the G2 image container.
//
// Text containers can't be resized (the base font is fixed), so tiling block
// characters can never line up or get large enough. We rasterise the pace into
// an image container instead.
//
// The dots are drawn as large solid squares on a 5x7 grid per digit. Big flat
// squares matter for more than looks: a finely screened image is high-entropy
// and produces a PNG several times larger, and the glasses' BLE link is slow
// enough that oversized frames back up and never land. Solid blocks compress to
// a fraction of that.
//
// Format per the EvenHub docs: imageData may be raw greyscale (1 byte/px) OR a
// PNG (base64, no data: prefix). We use base64 PNG — dimensions are intrinsic
// and the payload is far smaller than raw bytes.

// Must match the image container width/height declared in main.ts.
// Bounds enforced by the SDK: width 20–288, height 20–144.
//
// Size drives the BLE cost, and not via the PNG: the phone decodes our PNG and
// pushes width*height/2 bytes of gray4 to the glasses. 288x132 is ~19 KB, which
// the link rejects with sendFailed. 192x88 is ~8.4 KB. Raise these again only if
// the link proves it can take it — the digits scale to fit automatically.
export const PACE_IMG_W = 160
export const PACE_IMG_H = 72

// Bytes actually transmitted to the glasses (4-bit greyscale = 2 px per byte).
export const PACE_IMG_GRAY4_BYTES = (PACE_IMG_W * PACE_IMG_H) / 2

const ROWS = 7          // glyph height in blocks
const GRID_GAP = 1      // blank grid columns between glyphs
const BLOCK_INSET = 2   // px shaved off each block, so squares read separately

// 5x7 LED digits ('#' = lit). Colon is a single column.
const SRC: Record<string, string[]> = {
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
  '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
  '3': ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
  '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
  '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
  '9': [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  ':': [' ', ' ', '#', ' ', '#', ' ', ' '],
  '-': ['     ', '     ', '     ', '#####', '     ', '     ', '     '],
}

// Text fallback: the same 5x7 grid tiled from '#'. Coarse, but it goes over the
// text channel, which stays up when image transfers wedge the link.
export function renderPaceText(text: string): string {
  const chars = [...text.trim()].map(c => SRC[c]).filter((g): g is string[] => !!g)
  if (chars.length === 0) return ' '
  const rows: string[] = []
  for (let r = 0; r < ROWS; r++) rows.push(chars.map(g => g[r]!).join(' '))
  return rows.join('\n')
}

let canvas: HTMLCanvasElement | null = null
let warned = false

function getCanvas(): HTMLCanvasElement | null {
  try {
    if (typeof document === 'undefined') return null
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.width = PACE_IMG_W
      canvas.height = PACE_IMG_H
    }
    return canvas
  } catch {
    return null
  }
}

function glyphFor(ch: string): string[] | null {
  return SRC[ch] ?? null
}

// Draws the pace onto the shared canvas. Returns false if no canvas is available.
function draw(text: string): boolean {
  const cv = getCanvas()
  if (!cv) {
    if (!warned) { console.warn('[paceImage] no canvas — big pace image disabled'); warned = true }
    return false
  }
  const ctx = cv.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false

  const W = PACE_IMG_W, H = PACE_IMG_H
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)

  const chars = [...text.trim()].map(glyphFor).filter((g): g is string[] => g !== null)
  if (chars.length > 0) {
    // Lay the glyphs out on a shared block grid and size blocks to fit.
    const cols = chars.reduce((n, g) => n + g[0]!.length, 0) + GRID_GAP * (chars.length - 1)
    const block = Math.max(2, Math.floor(Math.min(W / cols, H / ROWS)))
    const originX = Math.floor((W - cols * block) / 2)
    const originY = Math.floor((H - ROWS * block) / 2)

    ctx.fillStyle = '#fff'
    let cx = 0
    for (const g of chars) {
      for (let r = 0; r < ROWS; r++) {
        const row = g[r]!
        for (let c = 0; c < row.length; c++) {
          if (row[c] !== '#') continue
          ctx.fillRect(
            originX + (cx + c) * block,
            originY + r * block,
            block - BLOCK_INSET,
            block - BLOCK_INSET,
          )
        }
      }
      cx += g[0]!.length + GRID_GAP
    }
  }
  return true
}

// base64 PNG (no data: prefix), or null if unavailable.
export function renderPacePng(text: string): string | null {
  if (!draw(text)) return null
  try {
    return canvas!.toDataURL('image/png').split(',')[1] ?? null
  } catch {
    return null
  }
}

// Raw greyscale, one byte per pixel, row-major — the format the docs list first.
// Used as a fallback when the host refuses PNG payloads.
export function renderPaceGray(text: string): number[] | null {
  if (!draw(text)) return null
  try {
    const ctx = canvas!.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const d = ctx.getImageData(0, 0, PACE_IMG_W, PACE_IMG_H).data
    const out = new Array<number>(PACE_IMG_W * PACE_IMG_H)
    for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = d[i]!
    return out
  } catch {
    return null
  }
}

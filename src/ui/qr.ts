/**
 * Turning a session code into something a camera can read.
 *
 * Ported from the Phase 0 spike, whose one real finding is preserved below: the
 * module size must be a whole number of *device* pixels. A fractional module
 * size puts a seam of half-lit pixels down the edge of every module, and scan
 * reliability falls off a cliff -- which is the measurement the whole spike
 * existed to make.
 */
import qrcode from 'qrcode-generator'
import type { SessionCode } from '../session/types.ts'

/** Quiet zone in modules. Four is the spec minimum and what the camera expects. */
const QUIET_ZONE = 4

export interface DrawnQr {
  canvas: HTMLCanvasElement
  /** QR version 1..40. Above v20 the code gets slow enough to threaten the ICE window. */
  version: number
}

export function drawQr(container: HTMLElement, code: SessionCode): DrawnQr | null {
  container.replaceChildren()

  // typeNumber 0 = pick the smallest version that fits; `L` because a
  // screen-to-camera read at close range has error correction to spare, and
  // every step up in ECL is a step up in QR version and scan time.
  const qr = qrcode(0, 'L')
  qr.addData(code, 'Byte')
  try {
    qr.make()
  } catch {
    // Too much data for any version. Nothing to draw -- the caller shows the
    // failure rather than an empty box.
    return null
  }

  const moduleCount = qr.getModuleCount()
  const total = moduleCount + QUIET_ZONE * 2
  const dpr = window.devicePixelRatio || 1
  const targetCss = Math.min(320, window.innerWidth - 64)
  const cell = Math.max(1, Math.floor((targetCss * dpr) / total))
  const px = total * cell

  const canvas = document.createElement('canvas')
  canvas.width = px
  canvas.height = px
  canvas.style.width = `${px / dpr}px`
  canvas.style.height = `${px / dpr}px`

  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, px, px)
  ctx.fillStyle = '#000000'
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      // isDark takes row first -- the spike's own codec comment flags this, and
      // swapping them produces a transposed QR that never scans.
      if (qr.isDark(row, col)) {
        ctx.fillRect((col + QUIET_ZONE) * cell, (row + QUIET_ZONE) * cell, cell, cell)
      }
    }
  }

  container.append(canvas)
  return { canvas, version: (moduleCount - 17) / 4 }
}

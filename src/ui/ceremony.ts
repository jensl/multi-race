/**
 * The QR handshake as a screen element: a code to show, a camera to read one.
 *
 * This is the `CodeChannel` the session layer asks for, so nothing about the
 * handshake itself is reimplemented here -- `showCode` draws, `readCode` reads,
 * and the session's own signaler drives the sequence.
 *
 * Two things it does that the Phase 0 spike's scanner did not, both of which
 * only matter once failure is survivable rather than terminal:
 *
 * **A read is validated before it is accepted.** `signaler.deliver()` rejects
 * the whole wait on a code it cannot decode, so a stray product barcode or a
 * half-read frame would otherwise abort the handshake outright. Here the scan
 * keeps running and just says so. `readCode` is told which kind it expects for
 * exactly this reason, and it is also how pointing a camera at the wrong one of
 * the pair turns into a hint rather than a failure.
 *
 * **The camera stops on every exit path.** Resolved, rejected, timed out,
 * cancelled, or the page hidden -- Android suspends the camera anyway, and a
 * dead stream that still looks live is worse than an honest error.
 */
import { decodeSignal } from '../session/codec.ts'
import type { CodeChannel } from '../session/signaler.ts'
import type { SessionCode } from '../session/types.ts'
import { el, setText } from './dom.ts'
import { drawQr } from './qr.ts'
import { canScan, startScan, type ScanHandle } from './qr-scanner.ts'

export interface CeremonyChannel extends CodeChannel {
  /** The element to place on the screen. */
  readonly el: HTMLElement
  /** Replaces the hint under the code, for the screen's own progress copy. */
  status(text: string): void
  readonly canScan: boolean
  dispose(): void
}

export function createCeremony(): CeremonyChannel {
  const qrSlot = el('div', 'qr')
  const video = el('video', 'camera')
  video.playsInline = true
  video.muted = true
  video.autoplay = true
  video.hidden = true

  const statusLine = el('p', 'status')
  const flashLine = el('p', 'flash')
  flashLine.hidden = true
  const expiryLine = el('p', 'expiry')
  expiryLine.hidden = true

  const root = el('div', 'ceremony', qrSlot, video, flashLine, statusLine, expiryLine)

  let expiryTimer: ReturnType<typeof setInterval> | null = null
  let flashTimer: ReturnType<typeof setTimeout> | null = null

  function stopExpiry(): void {
    if (expiryTimer !== null) clearInterval(expiryTimer)
    expiryTimer = null
    expiryLine.hidden = true
  }

  function stopCamera(): void {
    const stream = video.srcObject
    if (stream instanceof MediaStream) for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
    video.hidden = true
  }

  function setStatus(text: string): void {
    setText(statusLine, text)
  }

  /** A short-lived message about a scan that was read but not accepted. */
  function flash(text: string, kind: 'info' | 'bad'): void {
    setText(flashLine, text)
    flashLine.className = `flash ${kind}`
    flashLine.hidden = false
    if (flashTimer !== null) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashLine.hidden = true
    }, 1800)
  }

  /**
   * Decides whether a scanned string is usable.
   *
   * Returns null to keep scanning. Anything that does not decode, or decodes to
   * the other half of the pair, is not an error -- it is the camera seeing
   * something that is none of its business.
   */
  function accept(raw: string, expect: 'offer' | 'answer'): SessionCode | null {
    let kind: 'offer' | 'answer'
    try {
      kind = decodeSignal(raw).kind
    } catch {
      flash('That is not a game code — still looking', 'info')
      return null
    }
    if (kind !== expect) {
      flash(
        expect === 'answer'
          ? 'That is their join code — you need their reply'
          : 'That is a reply code — you need their join code',
        'bad',
      )
      return null
    }
    return raw as SessionCode
  }

  function showCode(code: SessionCode, meta: { kind: 'offer' | 'answer'; expiresAt: number }): void {
    stopCamera()
    flashLine.hidden = true
    const drawn = drawQr(qrSlot, code)
    if (!drawn) {
      setStatus('That code is too large to display. Try again.')
      return
    }
    setStatus(meta.kind === 'offer' ? 'Waiting for them to scan…' : 'Waiting for the host to scan…')

    // The invite has a lifetime and the host is the authority on it, so a
    // countdown here is a courtesy to the person holding the phone, not a
    // deadline the client enforces.
    stopExpiry()
    const tick = (): void => {
      const left = Math.max(0, meta.expiresAt - Date.now())
      if (left === 0) {
        stopExpiry()
        setStatus('That code has expired. Show a new one.')
        return
      }
      const seconds = Math.ceil(left / 1000)
      setText(
        expiryLine,
        `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
      )
      expiryLine.hidden = false
    }
    tick()
    expiryTimer = setInterval(tick, 1000)
  }

  function hideCode(): void {
    stopExpiry()
    qrSlot.replaceChildren()
  }

  function dispose(): void {
    stopExpiry()
    stopCamera()
    if (flashTimer !== null) clearTimeout(flashTimer)
    qrSlot.replaceChildren()
  }

  return {
    el: root,
    canScan: canScan(),

    showCode,
    hideCode,
    dispose,

    readCode(opts) {
      hideCode()
      setStatus('Starting the camera…')

      const controller = new AbortController()
      let scan: ScanHandle | null = null
      let timer: ReturnType<typeof setTimeout> | null = null

      return new Promise<SessionCode>((resolve, reject) => {
        let settled = false

        const onHidden = (): void => {
          // Android tears the camera down when the page hides. Report it now
          // rather than waiting on a stream that will never produce a frame.
          if (document.visibilityState === 'hidden') controller.abort()
        }
        const onOuterAbort = (): void => controller.abort()
        const onAborted = (): void => settle(() => reject(new Error('Scanning stopped.')))

        function settle(action: () => void): void {
          if (settled) return
          settled = true
          if (timer !== null) clearTimeout(timer)
          document.removeEventListener('visibilitychange', onHidden)
          opts.signal?.removeEventListener('abort', onOuterAbort)
          controller.signal.removeEventListener('abort', onAborted)
          scan?.stop()
          stopCamera()
          action()
        }

        controller.signal.addEventListener('abort', onAborted, { once: true })
        opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
        document.addEventListener('visibilitychange', onHidden)

        timer = setTimeout(() => {
          settle(() => reject(new Error('No code was scanned in time.')))
        }, opts.timeoutMs)

        void startScan(
          video,
          (raw) => {
            const code = accept(raw, opts.expect)
            if (!code) return false
            settle(() => resolve(code))
            return true
          },
          setStatus,
          controller.signal,
        )
          .then((handle) => {
            // The scan can settle before it finishes starting -- a timeout or a
            // hidden page -- and then the handle has to be stopped by hand.
            scan = handle
            if (settled) handle.stop()
          })
          .catch((err: unknown) => {
            settle(() => reject(err instanceof Error ? err : new Error(String(err))))
          })
      })
    },

    status: setStatus,
  }
}

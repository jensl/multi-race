/**
 * Camera QR reading, for the two phones that have to point at each other.
 *
 * Android Chrome ships a native `BarcodeDetector`, which is why the Android-only
 * scope keeps a ~950KB WASM decoder off the critical path. It is feature-detected
 * rather than user-agent sniffed, so anything else gets a clear message instead
 * of a scanner that silently never finds anything.
 *
 * Three things the Phase 0 spike did not do, all of which matter here:
 *
 *   - The camera is stopped on every exit path, not just left running.
 *   - The scan can be cancelled, so a screen that is torn down mid-scan does not
 *     leave a camera light on.
 *   - A read that the caller rejects keeps scanning. The caller decides what a
 *     usable code is; a stray barcode in the background is not a reason to fail
 *     the whole handshake.
 */

interface DetectedBarcode {
  rawValue: string
}

type BarcodeCtor = new (opts?: { formats?: string[] }) => {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

const detectorCtor = (): BarcodeCtor | undefined =>
  (globalThis as unknown as { BarcodeDetector?: BarcodeCtor }).BarcodeDetector

export const canScan = (): boolean =>
  typeof detectorCtor() === 'function' && typeof navigator.mediaDevices?.getUserMedia === 'function'

export interface ScanHandle {
  stop(): void
}

/**
 * Opens the camera and reports every QR it reads to `onAccept`.
 *
 * `onAccept` returns true once the caller has what it needs, which stops the
 * camera and resolves the scan. Returning false keeps looking.
 */
export async function startScan(
  video: HTMLVideoElement,
  onAccept: (raw: string) => boolean,
  onStatus: (message: string) => void,
  signal: AbortSignal,
): Promise<ScanHandle> {
  const Ctor = detectorCtor()
  if (!Ctor) throw new Error('This browser cannot scan QR codes.')

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      // `ideal`, never `exact`: `exact` throws on devices that ignore it, and
      // leaving the choice to Android beats demanding a camera it may not have.
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  })

  let running = true
  const detector = new Ctor({ formats: ['qr_code'] })

  const stop = (): void => {
    if (!running) return
    running = false
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
    video.hidden = true
  }

  if (signal.aborted) {
    stop()
    throw new Error('cancelled')
  }
  signal.addEventListener('abort', stop, { once: true })

  video.srcObject = stream
  video.hidden = false
  try {
    await video.play()
  } catch (err) {
    stop()
    throw new Error(`The camera would not start: ${String(err)}`)
  }

  const settings = stream.getVideoTracks()[0]?.getSettings()
  onStatus(`Point at the code${settings?.width ? ` (${settings.width}×${settings.height})` : ''}`)

  let busy = false
  let lastAttempt = 0

  const tick = async (): Promise<void> => {
    if (!running) return
    const now = performance.now()
    // ~5 reads a second. Any faster burns battery on a phone, and the code on
    // the other screen is not moving.
    if (!busy && now - lastAttempt > 200 && video.readyState >= 2) {
      lastAttempt = now
      busy = true
      try {
        const codes = await detector.detect(video)
        for (const found of codes) {
          if (!running) break
          if (onAccept(found.rawValue)) {
            stop()
            return
          }
        }
      } catch {
        // Autofocus hunting produces transient failures. Keep looking.
      } finally {
        busy = false
      }
    }
    if (running) requestAnimationFrame(() => void tick())
  }

  void tick()
  return { stop }
}

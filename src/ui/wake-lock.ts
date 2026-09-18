/**
 * Keeps the screen awake while a session is live.
 *
 * Android suspends a hidden page, and a suspended page loses its WebRTC stack --
 * so a phone that dims mid-game does not pause, it drops out of the game
 * entirely, and reconnecting means a fresh QR ceremony. The lock is held for the
 * whole session rather than only while a QR is on screen, because the rest of
 * the game is exactly as vulnerable as the handshake was.
 *
 * A refused lock is a warning, not a failure: the game still works, it is just
 * as vulnerable as any other page to a screen timeout.
 */

interface WakeLockSentinelLike {
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

function api(): WakeLockLike | undefined {
  return (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock
}

/**
 * Takes a wake lock and keeps it. Returns a release function.
 *
 * The browser drops the lock every time the page is hidden, so it is re-taken
 * on the way back rather than assumed to still be held.
 */
export function holdWakeLock(): () => void {
  let sentinel: WakeLockSentinelLike | null = null
  let wanted = true

  async function acquire(): Promise<void> {
    const wakeLock = api()
    if (!wakeLock || !wanted || sentinel) return
    try {
      sentinel = await wakeLock.request('screen')
      sentinel.addEventListener('release', () => {
        sentinel = null
      })
    } catch {
      // Denied: low battery, a background tab, or a browser that says no. The
      // game runs regardless.
      sentinel = null
    }
  }

  function onVisibility(): void {
    if (document.visibilityState === 'visible') void acquire()
  }

  document.addEventListener('visibilitychange', onVisibility)
  void acquire()

  return () => {
    wanted = false
    document.removeEventListener('visibilitychange', onVisibility)
    const held = sentinel
    sentinel = null
    if (held) void held.release().catch(() => {})
  }
}

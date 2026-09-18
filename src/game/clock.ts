/**
 * The game's only source of time, injected rather than reached for directly.
 *
 * This is the same seam `TokenBucket` uses for `Date.now` (`protocol.ts`), and
 * it is deliberate here for the same reason: the round loop is a pile of
 * deadlines, and a test that cannot move the clock can only assert on the first
 * frame of a ten-round game. `vi.useFakeTimers` is not an option -- the session
 * suite's `until()` helper polls on a real `setTimeout`, and `FakePeerConnection`
 * completes ICE gathering on a macrotask, so faking timers deadlocks the
 * handshake before a game ever starts.
 */
export interface GameClock {
  /** Milliseconds from an arbitrary origin. Monotonic; never a wall clock. */
  now(): number
  /** Runs `fn` after `ms`, returning a cancel. Cancelling twice is harmless. */
  after(ms: number, fn: () => void): () => void
}

/**
 * `performance.now()` and not `Date.now()`: the countdown must not be disturbed
 * by the user (or the OS) changing the device clock mid-round.
 */
export const realClock: GameClock = {
  now: () => performance.now(),
  after(ms, fn) {
    const id = setTimeout(fn, ms)
    return () => clearTimeout(id)
  },
}

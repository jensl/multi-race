/**
 * A clock the test drives, so a ten-round game takes no wall-clock time.
 *
 * The alternative -- `vi.useFakeTimers()` -- is not available here: the session
 * suite's `until()` polls on a real `setTimeout` and `FakePeerConnection`
 * completes ICE gathering on a macrotask, so faking global timers deadlocks the
 * handshake before a game can start. Injecting the clock for the game layer
 * only leaves the session's own timers real and untouched.
 */
import type { GameClock } from '../clock.ts'

export interface ManualClock extends GameClock {
  /** Moves time forward, firing every timer that comes due, in order. */
  advance(ms: number): void
  /** Timers still armed. A game that leaks one is a game that never settles. */
  pending(): number
}

export function manualClock(start = 0): ManualClock {
  let now = start
  let nextId = 0
  const timers = new Map<number, { at: number; fn: () => void }>()

  return {
    now: () => now,

    after(ms, fn) {
      const id = ++nextId
      timers.set(id, { at: now + ms, fn })
      return () => {
        timers.delete(id)
      }
    },

    advance(ms) {
      const target = now + ms
      // Timers armed *during* an advance are picked up by the next pass, which is
      // what lets a round deadline roll straight into the next round's countdown
      // within one call. Progress is guaranteed because every armed delay is
      // positive, so `now` strictly increases and the loop runs out of work.
      for (;;) {
        let due: { id: number; at: number; fn: () => void } | null = null
        for (const [id, timer] of timers) {
          if (timer.at > target) continue
          if (due === null || timer.at < due.at || (timer.at === due.at && id < due.id)) {
            due = { id, at: timer.at, fn: timer.fn }
          }
        }
        if (due === null) break
        timers.delete(due.id)
        now = Math.max(now, due.at)
        due.fn()
      }
      now = target
    },

    pending: () => timers.size,
  }
}

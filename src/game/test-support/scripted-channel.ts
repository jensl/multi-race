/**
 * A `CodeChannel` with no camera and no screen, so the QR ceremony is testable.
 *
 * This is deliberately paired with the *real* `createCodeSignaler` rather than
 * the session suite's `RecordingSignaler`, whose `awaitPeer` always throws. That
 * means a test driving this channel exercises the actual `publish` / `awaitPeer`
 * / `deliver` path -- decode included -- and only the glass is replaced.
 */
import type { CodeChannel } from '../../session/signaler.ts'
import type { SessionCode } from '../../session/types.ts'

export interface ShownCode {
  code: SessionCode
  kind: 'offer' | 'answer'
  /** Exposed so a test can assert the invite countdown has something to count. */
  expiresAt: number
}

export interface ScriptedCodeChannel extends CodeChannel {
  /** Every code this side has put on screen, oldest first. */
  readonly shown: ShownCode[]
  /** What each `readCode` was asked to expect. */
  readonly reads: Array<'offer' | 'answer'>
  readonly hides: number
  readonly disposed: boolean
  /** The code currently on screen, or null after `hideCode`. */
  current(): SessionCode | null
  /** Delivers a code to a reader, queueing it if nothing is reading yet. */
  provide(code: SessionCode): void
}

export function scriptedChannel(): ScriptedCodeChannel {
  const shown: ShownCode[] = []
  const reads: Array<'offer' | 'answer'> = []
  const queued: SessionCode[] = []
  const waiting: Array<(code: SessionCode) => void> = []

  let hides = 0
  let disposed = false
  let onScreen: SessionCode | null = null

  return {
    shown,
    reads,

    get hides() {
      return hides
    },
    get disposed() {
      return disposed
    },
    current: () => onScreen,

    showCode(code, meta) {
      shown.push({ code, kind: meta.kind, expiresAt: meta.expiresAt })
      onScreen = code
    },

    hideCode() {
      hides += 1
      onScreen = null
    },

    readCode(opts) {
      reads.push(opts.expect)
      const pending = queued.shift()
      if (pending !== undefined) return Promise.resolve(pending)

      return new Promise<SessionCode>((resolve, reject) => {
        waiting.push(resolve)
        // A scan the UI cancelled must not leave a resolver behind to be fed by a
        // later `provide`, which would resolve the wrong attempt with a stale code.
        opts.signal?.addEventListener(
          'abort',
          () => {
            const at = waiting.indexOf(resolve)
            if (at >= 0) waiting.splice(at, 1)
            reject(new Error('aborted'))
          },
          { once: true },
        )
      })
    },

    provide(code) {
      const reader = waiting.shift()
      if (reader) reader(code)
      else queued.push(code)
    },

    dispose() {
      disposed = true
    },
  }
}

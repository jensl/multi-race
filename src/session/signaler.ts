/**
 * How a signal gets from one device to the other.
 *
 * `Signaler` is an interface specifically so QR is just one implementation. The
 * whole handshake is exercisable in two browser tabs with no camera, no QR
 * density problems and no phones -- which is how most development and all of
 * the automated testing actually happens.
 *
 * The signaler is deliberately stateless about sessions: it publishes one
 * description and awaits one description. All correlation (sid/cid) lives in
 * the SignalDescription, so routing, retry and expiry stay in the session
 * layer where the roster is.
 */
import { decodeSignal, encodeSignal, type SignalDescription } from './codec.ts'
import { CodecError } from './codec.ts'
import { DEFAULT_INVITE_TTL_MS, sessionError, type SessionCode } from './types.ts'

export interface AwaitOptions {
  expect: 'offer' | 'answer'
  timeoutMs?: number
  signal?: AbortSignal
  /** Reject anything that does not match -- used to pin an answer to its invite. */
  match?: (desc: SignalDescription) => boolean
}

export interface Signaler {
  readonly kind: 'code' | 'broadcast-channel'
  publish(desc: SignalDescription): Promise<{ code: SessionCode; expiresAt: number }>
  awaitPeer(opts: AwaitOptions): Promise<SignalDescription>
  /** Feed a code obtained out of band: a paste, or a deep link. */
  inject(code: SessionCode): void
  dispose(): void
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const onAbort = (): void => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

// ------------------------------------------------------------- QR / paste

/**
 * What the UI must provide for a QR flow. Kept separate from `Signaler` so the
 * same session logic drives a camera, a paste box, or a test double.
 */
export interface CodeChannel {
  showCode(code: SessionCode, meta: { kind: 'offer' | 'answer'; expiresAt: number }): void
  hideCode(): void
  readCode(opts: {
    expect: 'offer' | 'answer'
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<SessionCode>
  dispose?(): void
}

export function createCodeSignaler(channel: CodeChannel, ttlMs = DEFAULT_INVITE_TTL_MS): Signaler {
  let pending: {
    expect: 'offer' | 'answer'
    match?: (d: SignalDescription) => boolean
    resolve: (d: SignalDescription) => void
    reject: (e: unknown) => void
  } | null = null

  function deliver(raw: SessionCode): void {
    const p = pending
    if (!p) return
    let desc: SignalDescription
    try {
      desc = decodeSignal(raw)
    } catch (err) {
      p.reject(err)
      pending = null
      return
    }
    if (desc.kind !== p.expect) {
      p.reject(
        sessionError('WRONG_KIND', `Expected an ${p.expect} code but that was an ${desc.kind}.`),
      )
      pending = null
      return
    }
    if (p.match && !p.match(desc)) {
      p.reject(
        sessionError('INVITE_UNKNOWN', 'That code is not for the invitation being scanned.'),
      )
      pending = null
      return
    }
    pending = null
    p.resolve(desc)
  }

  return {
    kind: 'code',

    async publish(desc) {
      const code = encodeSignal(desc)
      const expiresAt = Date.now() + ttlMs
      channel.showCode(code, { kind: desc.kind, expiresAt })
      return { code, expiresAt }
    },

    async awaitPeer(opts) {
      channel.hideCode()
      const timeoutMs = opts.timeoutMs ?? ttlMs

      return raceAbort(
        new Promise<SignalDescription>((resolve, reject) => {
          let settled = false
          /** Every exit path clears the timer and the pending slot exactly once. */
          const finish = (action: () => void): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            pending = null
            action()
          }

          const timer = setTimeout(() => {
            finish(() => reject(sessionError('INVITE_EXPIRED', 'No code was scanned in time.')))
          }, timeoutMs)

          pending = {
            expect: opts.expect,
            ...(opts.match ? { match: opts.match } : {}),
            resolve: (d) => finish(() => resolve(d)),
            reject: (e) => finish(() => reject(e)),
          }

          // The camera may also resolve this via inject(), e.g. a pasted code.
          channel
            .readCode({
              expect: opts.expect,
              timeoutMs,
              ...(opts.signal ? { signal: opts.signal } : {}),
            })
            .then((code) => deliver(code))
            .catch((err: unknown) => finish(() => reject(err)))
        }),
        opts.signal,
      )
    },

    inject(code) {
      deliver(code)
    },

    dispose() {
      channel.dispose?.()
    },
  }
}

// ---------------------------------------------------- two tabs, one machine

interface LoopbackMessage {
  from: string
  desc: SignalDescription
}

/**
 * BroadcastChannel signalling, for developing and testing the whole handshake
 * in two tabs on one machine -- no camera, no phones, no QR density concerns.
 *
 * Both tabs get real RTCPeerConnections over the loopback interface, so ICE,
 * DTLS and the data channels are all genuinely exercised. Only the *carrier* of
 * the handshake is swapped.
 */
export function createBroadcastChannelSignaler(channelName: string): Signaler {
  const me = crypto.randomUUID()
  const channel = new BroadcastChannel(channelName)
  const inbox: SignalDescription[] = []
  const waiters = new Set<() => void>()
  let disposed = false

  channel.onmessage = (event: MessageEvent) => {
    const msg = event.data as LoopbackMessage | undefined
    if (!msg || msg.from === me) return // never consume our own broadcast
    inbox.push(msg.desc)
    for (const wake of [...waiters]) wake()
  }

  function take(expect: 'offer' | 'answer', match?: (d: SignalDescription) => boolean) {
    const idx = inbox.findIndex((d) => d.kind === expect && (!match || match(d)))
    return idx < 0 ? null : (inbox.splice(idx, 1)[0] ?? null)
  }

  return {
    kind: 'broadcast-channel',

    async publish(desc) {
      const code = encodeSignal(desc)
      channel.postMessage({ from: me, desc } satisfies LoopbackMessage)
      return { code, expiresAt: Date.now() + DEFAULT_INVITE_TTL_MS }
    },

    async awaitPeer(opts) {
      const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_INVITE_TTL_MS)
      for (;;) {
        if (disposed) throw new Error('signaler disposed')
        if (opts.signal?.aborted) throw new Error('aborted')

        const hit = take(opts.expect, opts.match)
        if (hit) return hit
        if (Date.now() >= deadline) {
          throw sessionError('INVITE_EXPIRED', 'Timed out waiting for the other tab.')
        }

        // Woken by an inbound message, or by the poll as a safety net.
        await new Promise<void>((resolve) => {
          const wake = (): void => {
            waiters.delete(wake)
            clearTimeout(timer)
            resolve()
          }
          waiters.add(wake)
          const timer = setTimeout(wake, 100)
        })
      }
    },

    inject(code) {
      try {
        inbox.push(decodeSignal(code))
      } catch {
        // Nothing is waiting in a meaningful way here; drop it.
      }
    },

    dispose() {
      disposed = true
      channel.close()
    },
  }
}

export { CodecError }

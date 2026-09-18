/**
 * The guest half of a star topology: exactly one connection, always to the host.
 *
 * The load-bearing rule here is that a guest is joined on `welcome`, never on
 * the data channel opening. `onopen` only proves bytes flow -- the host may
 * still reject (version mismatch, full session, a duplicate identity), and a
 * guest that declared victory on `onopen` would sit showing "connected" to
 * nothing while its peers saw nothing at all.
 */
import { decodeSignal, type SignalDescription } from './codec.ts'
import { createEmitter, type Handler } from './emitter.ts'
import { createPeer, type Peer, type PeerOptions } from './peer.ts'
import { ClockSync, makeEnvelope } from './protocol.ts'
import type { Signaler } from './signaler.ts'
import { CodecError } from './codec.ts'
import {
  ALL_ADDRESS,
  CONTROL,
  HOST_ADDRESS,
  PROTOCOL_VERSION,
  sessionError,
  type ChannelKind,
  type ClientId,
  type CloseReason,
  type ConnectionId,
  type Envelope,
  type PeerId,
  type RosterEntry,
  type SendResult,
  type SessionCode,
  type SessionError,
  type SessionId,
  type WelcomePayload,
} from './types.ts'
import type { SignalPayload } from './sdp.ts'

export type GuestPhase =
  | 'idle'
  | 'joining'
  | 'answering'
  | 'connecting'
  | 'joined'
  | 'failed'
  | 'closed'

export type GuestEvent =
  | { t: 'phase'; phase: GuestPhase; prev: GuestPhase }
  | { t: 'answer-ready'; cid: ConnectionId; code: SessionCode; expiresAt: number }
  | {
      t: 'welcome'
      peerId: PeerId
      sessionId: SessionId
      rev: number
      roster: readonly RosterEntry[]
      hostTime: number
      rttMs: number
      reattached: boolean
    }
  | { t: 'roster'; rev: number; roster: readonly RosterEntry[] }
  | { t: 'peer-joined'; entry: RosterEntry }
  | { t: 'peer-left'; peerId: PeerId; reason: CloseReason }
  | { t: 'message'; from: PeerId; env: Envelope }
  | { t: 'rtt'; rttMs: number; offsetMs: number }
  | { t: 'error'; error: SessionError }
  | { t: 'closed'; reason: CloseReason }

export type GuestEventMap = { [E in GuestEvent as E['t']]: Omit<E, 't'> }

export interface GuestOptions {
  signaler: Signaler
  iceServers: RTCIceServer[]
  name?: string
  gatherTimeoutMs?: number
  connectTimeoutMs?: number
  welcomeTimeoutMs?: number
  liveness?: { intervalMs: number; missThreshold: number }
}

export interface GuestSession {
  readonly phase: GuestPhase
  readonly peerId: PeerId | null
  readonly sessionId: SessionId | null
  readonly roster: readonly RosterEntry[]
  readonly rosterRev: number
  join(opts?: { code?: SessionCode; clientId?: ClientId }): Promise<void>
  /** Re-present the same answer code after a host-side miss. Never rebuilds the peer. */
  republishAnswer(): Promise<SessionCode>
  send(to: PeerId | typeof HOST_ADDRESS | typeof ALL_ADDRESS, t: string, p?: unknown, channel?: ChannelKind): SendResult
  rttMs(): number
  hostTime(): number | null
  leave(reason?: CloseReason): void
  on<K extends keyof GuestEventMap & string>(k: K, fn: Handler<GuestEventMap[K]>): () => void
}

const CLIENT_ID_KEY = 'multirace:client-id'

/**
 * A stable per-tab identity, so a reload reattaches to the same roster entry
 * instead of appearing as a stranger. sessionStorage is deliberate: it survives
 * a reload but not a new tab, which is exactly the scope we want.
 */
export function getClientId(): ClientId {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY)
    if (existing) return existing
    const id = crypto.randomUUID()
    sessionStorage.setItem(CLIENT_ID_KEY, id)
    return id
  } catch {
    // Private mode or storage disabled: fall back to a per-load identity.
    return crypto.randomUUID()
  }
}

export function createGuestSession(options: GuestOptions): GuestSession {
  const emitter = createEmitter<GuestEventMap>()
  const welcomeTimeoutMs = options.welcomeTimeoutMs ?? 8000
  const clock = new ClockSync()

  let phase: GuestPhase = 'idle'
  let peer: Peer | null = null
  let myPeerId: PeerId | null = null
  let sessionId: SessionId | null = null
  let roster: RosterEntry[] = []
  let rev = 0
  let answer: { cid: ConnectionId; code: SessionCode; expiresAt: number; payload: SignalPayload } | null =
    null

  let settleWelcome: {
    resolve: () => void
    reject: (e: unknown) => void
  } | null = null

  const peerOptions: PeerOptions = {
    iceServers: options.iceServers,
    ...(options.gatherTimeoutMs === undefined ? {} : { gatherTimeoutMs: options.gatherTimeoutMs }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.liveness === undefined ? {} : { liveness: options.liveness }),
  }

  function setPhase(next: GuestPhase): void {
    if (phase === next) return
    const prev = phase
    phase = next
    emitter.emit('phase', { phase: next, prev })
  }

  let finished = false

  /**
   * Single exit path. `finished` is set before closing the peer so that the
   * peer's own close handler re-entering here cannot emit `closed` twice.
   */
  /** Unsubscribes the wait for `ready`, while one is outstanding. */
  let stopWaitingForReady: (() => void) | null = null

  /**
   * Sends `hello` if the channel is open, and otherwise the moment it opens.
   *
   * A dropped hello cannot be recovered from -- the host has nothing to wait on
   * but a message that will never arrive -- so there is no result worth
   * ignoring here, which is what a fire-and-forget `send` was doing.
   */
  function sendHelloWhenReady(env: Envelope): void {
    if (peer?.send(env).ok === true) return
    stopWaitingForReady =
      peer?.on('ready', () => {
        stopWaitingForReady = null
        peer?.send(env)
      }) ?? null
  }

  function finish(reason: CloseReason): void {
    if (finished) return
    finished = true
    stopWaitingForReady?.()
    stopWaitingForReady = null
    peer?.close(reason)
    options.signaler.dispose()
    setPhase('closed')
    emitter.emit('closed', { reason })
  }

  function ping(): void {
    if (!peer) return
    const t0 = performance.now()
    peer.send(makeEnvelope(myPeerId ?? HOST_ADDRESS, HOST_ADDRESS, CONTROL.ping, { t0 }))
  }

  function handleMessage(env: Envelope): void {
    switch (env.t) {
      case CONTROL.welcome: {
        const p = env.p as WelcomePayload
        myPeerId = p.peerId
        sessionId = p.sessionId
        roster = [...p.roster]
        rev = p.rev
        clock.anchorTo(performance.now(), p.hostTime)
        setPhase('joined')
        emitter.emit('welcome', {
          peerId: p.peerId,
          sessionId: p.sessionId,
          rev: p.rev,
          roster: roster,
          hostTime: p.hostTime,
          rttMs: clock.rttMs,
          reattached: p.reattached,
        })
        settleWelcome?.resolve()
        settleWelcome = null
        ping() // first RTT sample now that we know who we are
        return
      }
      case CONTROL.roster: {
        const p = env.p as { rev: number; roster: RosterEntry[] }
        // Host-pushed and revisioned, so a duplicate push is harmless rather
        // than a source of flicker.
        if (p.rev <= rev) return
        const known = new Set(roster.map((r) => r.peerId))
        roster = [...p.roster]
        rev = p.rev
        for (const entry of roster) {
          if (!known.has(entry.peerId)) emitter.emit('peer-joined', { entry })
        }
        emitter.emit('roster', { rev, roster })
        return
      }
      case CONTROL.pong: {
        const p = env.p as { t0: number; t1: number }
        clock.addSample(p.t0, p.t1, performance.now())
        emitter.emit('rtt', { rttMs: clock.rttMs, offsetMs: clock.offsetMs })
        return
      }
      case CONTROL.bye: {
        const reason = (env.p as { reason?: string } | undefined)?.reason
        settleWelcome?.reject(
          sessionError(
            reason === 'VERSION_MISMATCH' ? 'VERSION_MISMATCH' : 'INVITE_UNKNOWN',
            reason === 'VERSION_MISMATCH'
              ? 'This app is a different version to the host.'
              : 'The host ended the connection.',
          ),
        )
        settleWelcome = null
        finish('remote')
        return
      }
      default: {
        const from = env.from
        emitter.emit('message', { from, env })
      }
    }
  }

  function wire(p: Peer): void {
    p.on('message', ({ env }) => handleMessage(env))
    p.on('error', ({ error }) => {
      emitter.emit('error', { error })
      settleWelcome?.reject(error)
      settleWelcome = null
    })
    p.on('close', ({ reason }) => finish(reason))
  }

  return {
    get phase() {
      return phase
    },
    get peerId() {
      return myPeerId
    },
    get sessionId() {
      return sessionId
    },
    get roster() {
      return roster
    },
    get rosterRev() {
      return rev
    },
    on: emitter.on,

    async join(opts = {}) {
      if (phase !== 'idle' && phase !== 'failed') throw new Error('already joined')
      setPhase('joining')

      const clientId = opts.clientId ?? getClientId()

      let offer: SignalDescription
      try {
        if (opts.code) {
          offer = decodeSignal(opts.code)
        } else {
          offer = await options.signaler.awaitPeer({ expect: 'offer' })
        }
        if (offer.kind !== 'offer') {
          throw sessionError('WRONG_KIND', 'That is not a join code.')
        }
      } catch (err) {
        // Back to a state `join()` accepts. These three failures all happen
        // before a peer exists, so nothing is left half-built -- but without
        // this the session stays in `joining`, which the guard above refuses to
        // retry from, and one mis-scanned code would end the session for good.
        setPhase('failed')
        throw err
      }

      peer = createPeer('answerer', peerOptions)
      wire(peer)

      const payload = await peer.acceptInvite(offer.payload)
      setPhase('answering')

      // Echo the host's sid and cid back: the cid is what lets the host route
      // this answer to the exact peer connection that produced the offer.
      const cid = offer.cid
      const published = await options.signaler.publish({
        kind: 'answer',
        sid: offer.sid,
        cid,
        clientId,
        payload,
      })
      answer = { cid, code: published.code, expiresAt: published.expiresAt, payload }
      emitter.emit('answer-ready', {
        cid,
        code: published.code,
        expiresAt: published.expiresAt,
      })

      setPhase('connecting')
      const welcomed = new Promise<void>((resolve, reject) => {
        settleWelcome = { resolve, reject }
        setTimeout(() => {
          if (settleWelcome?.reject !== reject) return
          settleWelcome = null
          reject(
            sessionError('HELLO_TIMEOUT', 'The host did not answer. Ask them to show a new code.'),
          )
        }, welcomeTimeoutMs)
      })

      // `hello` goes out only once the channel can carry it. At this point in
      // the ceremony it certainly cannot: the host has not scanned this answer
      // yet, so nothing has been negotiated, and `send` drops rather than queues
      // when nothing is open. That gap is the seconds a person takes to aim a
      // camera -- which is exactly how long the hello used to be discarded for,
      // leaving the host to time out waiting on a message never sent.
      sendHelloWhenReady(
        makeEnvelope(HOST_ADDRESS, HOST_ADDRESS, CONTROL.hello, {
          clientId,
          proto: PROTOCOL_VERSION,
          ...(options.name === undefined ? {} : { name: options.name }),
        }),
      )

      try {
        await welcomed
      } catch (err) {
        setPhase('failed')
        throw err
      }
    },

    async republishAnswer() {
      if (!answer) throw new Error('no answer has been produced yet')
      // The same code, unchanged: the peer connection is still gathering and
      // its credentials have not expired, so rebuilding it would throw away a
      // perfectly good ICE agent for no reason.
      const result = await options.signaler.publish({
        kind: 'answer',
        sid: sessionId ?? '',
        cid: answer.cid,
        payload: answer.payload,
      })
      answer = { ...answer, code: result.code, expiresAt: result.expiresAt }
      emitter.emit('answer-ready', {
        cid: answer.cid,
        code: result.code,
        expiresAt: result.expiresAt,
      })
      return result.code
    },

    send(to, t, p, channel) {
      if (!peer) return { ok: false, reason: 'not-connected' }
      const env = makeEnvelope(myPeerId ?? HOST_ADDRESS, to, t, p)
      return peer.send(env, channel ?? 'control')
    },

    rttMs() {
      return clock.rttMs
    },

    hostTime() {
      return clock.hostTime(performance.now())
    },

    leave(reason: CloseReason = 'local') {
      finish(reason)
    },
  }
}

export { CodecError }

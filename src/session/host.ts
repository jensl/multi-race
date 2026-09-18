/**
 * The host half of a star topology.
 *
 * Host-star rather than mesh is close to mandatory here, not merely preferable:
 * every WebRTC link needs its own physical QR ceremony, so a full mesh at 8
 * players would be 28 scans against the star's 7. It also gives one authority
 * for game state, and sidesteps WebKit's quadratic socket allocation.
 *
 * The host is authoritative about exactly one thing: invite identity. `cid` is
 * the routing key, and the invite table below is the only source of truth about
 * whether a code is usable. An SDP answer is structurally valid against any
 * offer with the same m-line shape, so a misrouted answer would make
 * `setRemoteDescription` *succeed* and then fail at ICE half a minute later with
 * nothing pointing at the cause. Routing by `cid` is what makes that
 * impossible rather than silent.
 */
import { decodeSignal, newConnectionId, newSessionId, type SignalDescription } from './codec.ts'
import { createEmitter, type Handler } from './emitter.ts'
import { createPeer, type Peer, type PeerOptions, type PeerState } from './peer.ts'
import { parseAddress, sanitizeForRelay, makeEnvelope, TokenBucket } from './protocol.ts'
import type { Signaler } from './signaler.ts'
import {
  ALL_ADDRESS,
  CONTROL,
  DEFAULT_INVITE_TTL_MS,
  HOST_ADDRESS,
  HOST_PEER_ID,
  PROTOCOL_VERSION,
  RELAY_RATE,
  sessionError,
  type ChannelKind,
  type ClientId,
  type CloseReason,
  type ConnectionId,
  type Envelope,
  type HelloPayload,
  type PeerId,
  type RosterEntry,
  type SendResult,
  type SessionCode,
  type SessionError,
  type SessionId,
} from './types.ts'

export type HostState = 'idle' | 'open' | 'closed'

export type HostEvent =
  | { t: 'open'; sessionId: SessionId }
  | { t: 'invite'; cid: ConnectionId; code: SessionCode; expiresAt: number }
  | { t: 'invite-rejected'; cid: ConnectionId; error: SessionError }
  | {
      t: 'peer-joined'
      peerId: PeerId
      entry: RosterEntry
      rev: number
      roster: readonly RosterEntry[]
      reattached: boolean
    }
  | { t: 'peer-left'; peerId: PeerId; reason: CloseReason; rev: number; roster: readonly RosterEntry[] }
  | { t: 'peer-state'; peerId: PeerId; state: PeerState; prev: PeerState }
  | { t: 'message'; peerId: PeerId; env: Envelope }
  | { t: 'undeliverable'; peerId: PeerId; id: string; reason: 'unknown-peer' | 'left' | 'backpressure' }
  | { t: 'error'; error: SessionError }

export interface HostOptions {
  signaler: Signaler
  iceServers: RTCIceServer[]
  name?: string
  inviteTtlMs?: number
  maxPeers?: number
  gatherTimeoutMs?: number
  connectTimeoutMs?: number
  helloTimeoutMs?: number
  liveness?: { intervalMs: number; missThreshold: number }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Rejects with `error` if `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, error: SessionError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

interface HostPeer {
  cid: ConnectionId
  peer: Peer
  peerId: PeerId | null
  clientId: ClientId | null
  limiter: TokenBucket
  /**
   * Resolved by the `hello` handler. Created with the peer rather than inside
   * `submitAnswer`, so a hello that arrives before the host scans the answer
   * is held rather than dropped into nothing.
   */
  hello: Deferred<PeerId>
}

type InviteOutcome = { status: 'used' } | { status: 'expired' }

const PEER_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789' // no l/1/o/0

export interface HostSession {
  readonly sessionId: SessionId
  readonly state: HostState
  readonly roster: readonly RosterEntry[]
  readonly rosterRev: number
  readonly peerCount: number
  start(): Promise<void>
  invite(): Promise<{ cid: ConnectionId; code: SessionCode; expiresAt: number }>
  submitAnswer(code: SessionCode): Promise<{ peerId: PeerId }>
  send(to: PeerId | typeof ALL_ADDRESS, t: string, p?: unknown, channel?: ChannelKind): SendResult
  broadcast(t: string, p?: unknown, channel?: ChannelKind): SendResult
  kick(peerId: PeerId, reason?: CloseReason): void
  close(reason?: CloseReason): void
  on<K extends keyof HostEventMap & string>(k: K, fn: Handler<HostEventMap[K]>): () => void
}

/**
 * Keyed by the `t` discriminant, with `t` stripped from the payload -- the
 * event name already carries it, and repeating it at every emit site is noise.
 */
export type HostEventMap = { [E in HostEvent as E['t']]: Omit<E, 't'> }

export function createHostSession(options: HostOptions): HostSession {
  const emitter = createEmitter<HostEventMap>()
  const inviteTtlMs = options.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS
  const maxPeers = options.maxPeers ?? 8
  const helloTimeoutMs = options.helloTimeoutMs ?? 5000

  const pending = new Map<ConnectionId, { member: HostPeer; expiresAt: number }>()
  /** Consumed and expired cids, kept briefly so a re-scan gets a real message. */
  const recent = new Map<ConnectionId, InviteOutcome>()
  const members = new Map<PeerId, HostPeer>()
  const roster = new Map<PeerId, RosterEntry>()

  let sessionId: SessionId = newSessionId()
  let state: HostState = 'idle'
  let rev = 0
  let seq = 0
  let sweepTimer: ReturnType<typeof setInterval> | null = null

  const peerOptions: PeerOptions = {
    iceServers: options.iceServers,
    ...(options.gatherTimeoutMs === undefined ? {} : { gatherTimeoutMs: options.gatherTimeoutMs }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.liveness === undefined ? {} : { liveness: options.liveness }),
  }

  function remember(cid: ConnectionId, outcome: InviteOutcome): void {
    recent.set(cid, outcome)
    // Long enough to survive a rescan, short enough not to grow unbounded.
    setTimeout(() => recent.delete(cid), 5 * 60_000)
  }

  function rosterList(): RosterEntry[] {
    return [...roster.values()]
  }

  function newPeerId(): PeerId {
    for (;;) {
      let id = ''
      for (let i = 0; i < 4; i++) {
        id += PEER_ID_ALPHABET[Math.floor(Math.random() * PEER_ID_ALPHABET.length)]
      }
      if (!roster.has(id) && id !== HOST_PEER_ID) return id
    }
  }

  function pushRoster(): void {
    rev++
    const payload = { rev, roster: rosterList() }
    for (const m of members.values()) {
      if (m.peerId) m.peer.send(makeEnvelope(HOST_PEER_ID, m.peerId, CONTROL.roster, payload))
    }
  }

  function dropPeer(member: HostPeer, reason: CloseReason): void {
    member.peer.close(reason)
    const id = member.peerId
    if (!id) return
    members.delete(id)
    roster.delete(id)
    pushRoster()
    emitter.emit('peer-left', { peerId: id, reason, rev, roster: rosterList() })
  }

  function handleHello(member: HostPeer, env: Envelope): void {
    const payload = env.p as HelloPayload | undefined
    if (!payload || typeof payload.clientId !== 'string') {
      emitter.emit('error', {
        error: sessionError('BAD_CODE', 'A device sent a malformed hello.'),
      })
      dropPeer(member, 'protocol-error')
      return
    }
    if (payload.proto !== undefined && payload.proto !== PROTOCOL_VERSION) {
      member.peer.send(
        makeEnvelope(HOST_PEER_ID, HOST_ADDRESS, CONTROL.bye, {
          reason: 'VERSION_MISMATCH',
        }),
      )
      dropPeer(member, 'rejected')
      return
    }
    // A returning ClientId reattaches rather than adding a ghost entry: a guest
    // that reloaded should not appear twice in the roster.
    let reattached = false
    for (const other of [...members.values()]) {
      if (other !== member && other.clientId === payload.clientId) {
        dropPeer(other, 'remote')
        reattached = true
      }
    }

    const peerId = newPeerId()
    member.peerId = peerId
    member.clientId = payload.clientId
    members.set(peerId, member)

    const entry: RosterEntry = {
      peerId,
      clientId: payload.clientId,
      joinedAt: Date.now(),
      isHost: false,
      ...(payload.name === undefined ? {} : { name: payload.name }),
    }
    roster.set(peerId, entry)

    rev++
    member.peer.send(
      makeEnvelope(HOST_PEER_ID, peerId, CONTROL.welcome, {
        peerId,
        sessionId,
        roster: rosterList(),
        rev,
        hostTime: Date.now(),
        reattached,
      }),
    )
    pushRoster()
    emitter.emit('peer-joined', { peerId, entry, rev, roster: rosterList(), reattached })
    member.hello.resolve(peerId)
  }

  function routeFrom(member: HostPeer, env: Envelope): void {
    const from = member.peerId

    // hello is the one message that legitimately arrives before we know who is
    // speaking, and it is therefore a claim rather than a fact.
    if (env.t === CONTROL.hello) {
      if (from === null) handleHello(member, env)
      return
    }
    if (from === null) return // nothing else is accepted before hello

    if (!member.limiter.tryTake()) {
      emitter.emit('undeliverable', { peerId: from, id: env.id, reason: 'backpressure' })
      return
    }

    const route = parseAddress(env.to)
    if (!route) {
      member.peer.send(
        makeEnvelope(HOST_PEER_ID, from, CONTROL.undeliverable, {
          id: env.id,
          reason: 'unknown-peer',
        }),
      )
      emitter.emit('undeliverable', { peerId: from, id: env.id, reason: 'unknown-peer' })
      return
    }

    // Sanitized here, not at the edge: a guest must not be able to set `ts` or
    // `seq` on a message another guest will treat as host-authoritative.
    const clean = sanitizeForRelay(env, from, ++seq, Date.now())

    if (route.kind === 'host') {
      if (env.t === CONTROL.ping) {
        member.peer.send(
          makeEnvelope(HOST_PEER_ID, from, CONTROL.pong, {
            t0: (env.p as { t0?: number } | undefined)?.t0 ?? 0,
            t1: Date.now(),
          }),
        )
        return
      }
      emitter.emit('message', { peerId: from, env: clean })
      return
    }

    if (route.kind === 'broadcast') {
      // `@all` excludes the sender: echoing state back to its author would
      // force every client to implement idempotence or origin filtering.
      for (const m of members.values()) {
        if (m.peerId && m.peerId !== from) m.peer.send(clean)
      }
      emitter.emit('message', { peerId: from, env: clean })
      return
    }

    const target = members.get(route.peerId)
    if (!target) {
      member.peer.send(
        makeEnvelope(HOST_PEER_ID, from, CONTROL.undeliverable, {
          id: env.id,
          reason: 'unknown-peer',
        }),
      )
      emitter.emit('undeliverable', { peerId: from, id: env.id, reason: 'unknown-peer' })
      return
    }
    target.peer.send(clean)
  }

  function wireMember(member: HostPeer): void {
    member.peer.on('message', ({ env }) => routeFrom(member, env))
    member.peer.on('state', ({ state: s, prev }) => {
      if (member.peerId) emitter.emit('peer-state', { peerId: member.peerId, state: s, prev })
    })
    member.peer.on('error', ({ error }) => {
      emitter.emit('error', { error })
      if (error.fatal) dropPeer(member, 'ice-failed')
    })
    member.peer.on('close', ({ reason }) => {
      // The peer is already closing; just reconcile the roster.
      const id = member.peerId
      if (!id || !members.has(id)) return
      members.delete(id)
      roster.delete(id)
      pushRoster()
      emitter.emit('peer-left', { peerId: id, reason, rev, roster: rosterList() })
    })
  }

  /** Reap invites nobody used, so their gathering peers do not linger. */
  function sweep(): void {
    const now = Date.now()
    for (const [cid, entry] of pending) {
      if (now <= entry.expiresAt) continue
      pending.delete(cid)
      remember(cid, { status: 'expired' })
      entry.member.peer.close('timeout')
    }
  }

  return {
    get sessionId() {
      return sessionId
    },
    get state() {
      return state
    },
    get roster() {
      return rosterList()
    },
    get rosterRev() {
      return rev
    },
    get peerCount() {
      return members.size
    },
    on: emitter.on,

    async start() {
      if (state === 'open') return
      sessionId = newSessionId()
      state = 'open'
      sweepTimer = setInterval(sweep, 5000)
      emitter.emit('open', { sessionId })
    },

    async invite() {
      if (state === 'idle') throw new Error('call start() before invite()')
      if (state === 'closed') throw new Error('session is closed')
      if (members.size >= maxPeers) {
        throw sessionError('SESSION_FULL', `This game is full (${maxPeers} players).`)
      }

      // No pre-generated offers: a warm offer freezes a candidate snapshot at
      // creation time, so if the host changes network before it is scanned the
      // QR carries dead candidates and the guest has no way to tell why.
      const cid = newConnectionId()
      const peer = createPeer('offerer', peerOptions)
      const member: HostPeer = {
        cid,
        peer,
        peerId: null,
        clientId: null,
        limiter: new TokenBucket(RELAY_RATE.capacity, RELAY_RATE.refillPerSecond),
        hello: deferred<PeerId>(),
      }
      wireMember(member)

      const payload = await peer.createInvite()
      const { code } = await options.signaler.publish({
        kind: 'offer',
        sid: sessionId,
        cid,
        payload,
      })

      // The host is the authority on invite lifetime, not the signaler -- the
      // signaler may be a test double with its own ideas about time.
      const expiresAt = Date.now() + inviteTtlMs
      pending.set(cid, { member, expiresAt })
      emitter.emit('invite', { cid, code, expiresAt })
      return { cid, code, expiresAt }
    },

    async submitAnswer(code: SessionCode) {
      let desc: SignalDescription
      try {
        desc = decodeSignal(code)
      } catch (err) {
        const error =
          err instanceof Error && 'code' in err
            ? sessionError((err as { code: SessionError['code'] }).code, err.message)
            : sessionError('BAD_CODE', `That code could not be read: ${String(err)}`)
        emitter.emit('error', { error })
        throw error
      }

      if (desc.kind !== 'answer') {
        const error = sessionError('WRONG_KIND', 'That is an offer code, not an answer.')
        emitter.emit('error', { error })
        throw error
      }
      if (desc.sid !== sessionId) {
        const error = sessionError(
          'WRONG_SESSION',
          'That code is from a different game session.',
        )
        emitter.emit('error', { error })
        throw error
      }

      const entry = pending.get(desc.cid)
      if (!entry) {
        const past = recent.get(desc.cid)
        const error =
          past?.status === 'used'
            ? sessionError('INVITE_USED', 'That invitation has already been used.')
            : past?.status === 'expired'
              ? sessionError('INVITE_EXPIRED', 'That invitation expired. Show a new code.')
              : sessionError('INVITE_UNKNOWN', 'That code is not for this game.')
        emitter.emit('invite-rejected', { cid: desc.cid, error })
        emitter.emit('error', { error })
        throw error
      }
      if (Date.now() > entry.expiresAt) {
        pending.delete(desc.cid)
        remember(desc.cid, { status: 'expired' })
        entry.member.peer.close('timeout')
        const error = sessionError('INVITE_EXPIRED', 'That invitation expired. Show a new code.')
        emitter.emit('invite-rejected', { cid: desc.cid, error })
        emitter.emit('error', { error })
        throw error
      }

      pending.delete(desc.cid)
      remember(desc.cid, { status: 'used' })

      await entry.member.peer.acceptAnswer(desc.payload)
      // The deferred already exists, so a hello that raced ahead of this call
      // has been captured rather than missed.
      const peerId = await withTimeout(
        entry.member.hello.promise,
        helloTimeoutMs,
        sessionError('HELLO_TIMEOUT', 'The device connected but never checked in.'),
      )
      return { peerId }
    },

    send(to, t, p, channel) {
      const env = makeEnvelope(HOST_PEER_ID, to, t, p, ++seq)
      if (to === ALL_ADDRESS) return this.broadcast(t, p, channel)
      const target = members.get(to)
      if (!target) return { ok: false, reason: 'unknown-peer' }
      return target.peer.send(env, channel ?? 'control')
    },

    broadcast(t, p, channel) {
      const env = makeEnvelope(HOST_PEER_ID, ALL_ADDRESS, t, p, ++seq)
      let last: SendResult = { ok: false, reason: 'not-connected' }
      for (const m of members.values()) last = m.peer.send(env, channel ?? 'control')
      return last
    },

    kick(peerId, reason = 'local') {
      const m = members.get(peerId)
      if (m) dropPeer(m, reason)
    },

    close(reason: CloseReason = 'local') {
      if (state === 'closed') return
      state = 'closed'
      if (sweepTimer !== null) clearInterval(sweepTimer)
      sweepTimer = null
      for (const { member } of pending.values()) member.peer.close(reason)
      pending.clear()
      for (const m of [...members.values()]) m.peer.close(reason)
      members.clear()
      roster.clear()
      options.signaler.dispose()
      emitter.clear()
    },
  }
}

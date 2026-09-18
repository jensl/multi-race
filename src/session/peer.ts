/**
 * One RTCPeerConnection, wrapped.
 *
 * Two orderings here are load-bearing and easy to get wrong:
 *
 * 1. Gathering is triggered BY `setLocalDescription`, not by
 *    `createOffer`/`createAnswer`. Awaiting `iceGatheringState === 'complete'`
 *    *before* calling `setLocalDescription` never resolves -- it hangs forever,
 *    with a perfectly good SDP in hand. The correct order is
 *    create -> setLocalDescription -> await gathering -> snapshot.
 *
 * 2. `setLocalDescription` calls are serialized across all peers on this page.
 *    WebKit re-gathers for every open connection on each call, which is
 *    quadratic in sockets and degrades candidate yield; serializing restores
 *    linear behaviour and costs nothing.
 *
 * The answerer never calls `createDataChannel`. With `negotiated: false` a
 * second creator collides on SCTP stream ids.
 */
import { CodecError } from './codec.ts'
import { createEmitter, type Handler } from './emitter.ts'
import {
  ALL_ADDRESS,
  CONTROL,
  DEFAULT_INVITE_TTL_MS,
  HOST_ADDRESS,
  PROTOCOL_VERSION,
  type ChannelKind,
  type CloseReason,
  type Envelope,
  type PeerId,
  type SendResult,
  type SessionError,
} from './types.ts'
import {
  appendEndOfCandidates,
  buildSdp,
  extractSignal,
  stripCandidates,
  type SignalPayload,
} from './sdp.ts'
import { decodeEnvelope, encodeEnvelope, isOversized, makeEnvelope } from './protocol.ts'

/**
 * Measured on two Android phones: gathering did not complete within 1500 ms and
 * the offer was published with a partial candidate set. It still connected, but
 * the wait is a one-time cost per invite, so we trade a little latency for
 * better odds on unfriendly networks.
 */
export const DEFAULT_GATHER_TIMEOUT_MS = 2500
export const DEFAULT_CONNECT_TIMEOUT_MS = 25_000
export const DEFAULT_HELLO_TIMEOUT_MS = 5_000
export const DEFAULT_LIVENESS = { intervalMs: 3000, missThreshold: 3 }

export type PeerState =
  | 'new'
  | 'creating-offer'
  | 'creating-answer'
  | 'gathering'
  | 'awaiting-answer'
  | 'awaiting-host'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'closed'

/**
 * A type alias rather than an interface: interfaces do not get an implicit
 * index signature, so an interface here fails the emitter's `Record<string,
 * unknown>` constraint.
 */
export type PeerEvents = {
  state: { state: PeerState; prev: PeerState }
  ready: Record<string, never>
  message: { channel: ChannelKind; env: Envelope }
  close: { reason: CloseReason }
  error: { error: SessionError }
}

export interface Peer {
  readonly role: 'offerer' | 'answerer'
  readonly state: PeerState
  readonly pc: RTCPeerConnection
  readonly bufferedAmount: number
  createInvite(signal?: AbortSignal): Promise<SignalPayload>
  acceptInvite(offer: SignalPayload, signal?: AbortSignal): Promise<SignalPayload>
  acceptAnswer(answer: SignalPayload): Promise<void>
  send(env: Envelope, channel?: ChannelKind): SendResult
  close(reason: CloseReason): void
  on<K extends keyof PeerEvents & string>(k: K, fn: Handler<PeerEvents[K]>): () => void
}

// ------------------------------------------------------------------- swapping

let setLocalQueue: Promise<unknown> = Promise.resolve()

/**
 * Serialize `setLocalDescription` page-wide. The chain is kept alive on
 * rejection so one failed peer cannot wedge every later one.
 */
function serializedSetLocalDescription(
  pc: RTCPeerConnection,
  desc: RTCSessionDescriptionInit,
): Promise<void> {
  const next = setLocalQueue.then(() => pc.setLocalDescription(desc))
  setLocalQueue = next.catch(() => undefined)
  return next
}

// -------------------------------------------------------------------- helpers

interface GatheringResult {
  timedOut: boolean
  ms: number
}

/**
 * Attach the listeners, call setLocalDescription, then wait for gathering.
 * Ordering is enforced here so callers cannot get it wrong.
 */
async function setLocalAndGather(
  pc: RTCPeerConnection,
  desc: RTCSessionDescriptionInit,
  timeoutMs: number,
): Promise<GatheringResult> {
  const started = performance.now()
  let settled = false
  const gathering = new Promise<GatheringResult>((resolve) => {
    const done = (timedOut: boolean): void => {
      if (settled) return
      settled = true
      pc.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      resolve({ timedOut, ms: performance.now() - started })
    }
    const onChange = (): void => {
      if (pc.iceGatheringState === 'complete') done(false)
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    const timer = setTimeout(() => done(true), timeoutMs)
    // Listeners are attached before setLocalDescription below, which is what
    // starts gathering -- so nothing can be missed in between.
  })

  await serializedSetLocalDescription(pc, desc)
  if (pc.iceGatheringState === 'complete') {
    pc.dispatchEvent(new Event('icegatheringstatechange'))
  }
  return gathering
}

/**
 * Snapshot the local description for transmission, trimmed for size.
 *
 * TCP candidates are dropped: dead weight on a LAN, and a large share of the
 * bytes. This is legal because it happens on the signaling path, not inside
 * `setLocalDescription`.
 */
function snapshot(pc: RTCPeerConnection, timedOut: boolean): SignalPayload {
  const raw = pc.localDescription?.sdp
  if (!raw) throw new CodecError('BAD_CODE', 'no local description after gathering')
  const stripped = stripCandidates(raw, (c) => c.transport === 'tcp')
  return extractSignal(timedOut ? appendEndOfCandidates(stripped) : stripped, 'offer')
}

function waitForConnected(pc: RTCPeerConnection, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (pc.connectionState === 'connected') return resolve(true)
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      pc.removeEventListener('connectionstatechange', onChange)
      clearTimeout(timer)
      resolve(ok)
    }
    const onChange = (): void => {
      if (pc.connectionState === 'connected') done(true)
      else if (pc.connectionState === 'failed') done(false)
    }
    pc.addEventListener('connectionstatechange', onChange)
    const timer = setTimeout(() => done(false), timeoutMs)
  })
}

// ------------------------------------------------------------------- the peer

export interface PeerOptions {
  iceServers: RTCIceServer[]
  gatherTimeoutMs?: number
  connectTimeoutMs?: number
  liveness?: { intervalMs: number; missThreshold: number }
}

export function createPeer(role: 'offerer' | 'answerer', options: PeerOptions): Peer {
  const emitter = createEmitter<PeerEvents>()
  const pc = new RTCPeerConnection({ iceServers: options.iceServers })
  const gatherTimeoutMs = options.gatherTimeoutMs ?? DEFAULT_GATHER_TIMEOUT_MS
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const liveness = options.liveness ?? DEFAULT_LIVENESS

  const channels: Partial<Record<ChannelKind, RTCDataChannel>> = {}
  let state: PeerState = 'new'
  let closed = false
  let livenessTimer: ReturnType<typeof setInterval> | null = null
  let missedPongs = 0

  function setState(next: PeerState): void {
    if (state === next) return
    const prev = state
    state = next
    emitter.emit('state', { state: next, prev })
  }

  function fail(error: SessionError, reason: CloseReason = 'ice-failed'): void {
    emitter.emit('error', { error })
    close(reason)
  }

  function close(reason: CloseReason): void {
    if (closed) return
    closed = true
    stopLiveness()
    // Detach before closing so teardown does not re-enter as a protocol error.
    pc.onconnectionstatechange = null
    pc.oniceconnectionstatechange = null
    pc.ondatachannel = null
    for (const ch of Object.values(channels)) {
      ch.onopen = null
      ch.onmessage = null
      ch.onclose = null
      try {
        ch.close()
      } catch {
        /* already closing */
      }
    }
    try {
      pc.close()
    } catch {
      /* already closed */
    }
    setState('closed')
    emitter.emit('close', { reason })
  }

  function stopLiveness(): void {
    if (livenessTimer !== null) clearInterval(livenessTimer)
    livenessTimer = null
  }

  /**
   * `onclose` is the primary liveness signal -- it fires promptly on clean
   * teardown and beats any ping schedule. Pings exist to catch the *wedged*
   * case where the channel is open but the peer is gone.
   *
   * Counting is suspended while the page is hidden: mobile browsers throttle
   * background tabs, so a naive miss counter false-positives on anyone who
   * switches away mid-game.
   */
  function startLiveness(): void {
    stopLiveness()
    missedPongs = 0
    livenessTimer = setInterval(() => {
      if (closed) return
      if (typeof document !== 'undefined' && document.hidden) return
      const ctl = channels['control']
      if (!ctl || ctl.readyState !== 'open') return
      if (missedPongs >= liveness.missThreshold) {
        fail(
          {
            code: 'ICE_TIMEOUT',
            message: 'Lost contact with the other device.',
            fatal: true,
          },
          'timeout',
        )
        return
      }
      missedPongs++
      sendEnvelope(makeEnvelope(HOST_ADDRESS as PeerId, ALL_ADDRESS, CONTROL.ping, { t0: 0 }))
    }, liveness.intervalMs)
  }

  function wireChannel(kind: ChannelKind, channel: RTCDataChannel): void {
    channels[kind] = channel
    // Never 0: `bufferedamountlow` does not fire at a zero threshold.
    channel.bufferedAmountLowThreshold = 16 * 1024

    channel.onopen = () => {
      if (channels['control']?.readyState === 'open' && channels['state']?.readyState === 'open') {
        setState('connected')
        startLiveness()
        emitter.emit('ready', {})
      }
    }
    channel.onmessage = (event: MessageEvent) => {
      const decoded = decodeEnvelope(event.data)
      if (!decoded.ok || !decoded.envelope) {
        emitter.emit('error', {
          error: {
            code: 'BAD_CODE',
            message: `Discarded a malformed message: ${decoded.reason ?? 'unknown'}`,
            fatal: false,
          },
        })
        return
      }
      const env = decoded.envelope
      if (env.t === CONTROL.ping) {
        const pong = makeEnvelope(HOST_ADDRESS as PeerId, env.from, CONTROL.pong, {
          t0: (env.p as { t0?: number } | undefined)?.t0 ?? 0,
          t1: Date.now(),
        })
        sendEnvelope(pong)
        return
      }
      if (env.t === CONTROL.pong) missedPongs = 0
      emitter.emit('message', { channel: kind, env })
    }
    channel.onclose = () => {
      if (!closed) close('remote')
    }
    channel.onerror = () => {
      emitter.emit('error', {
        error: {
          code: 'ICE_TIMEOUT',
          message: 'The data channel reported an error.',
          fatal: false,
        },
      })
    }
  }

  function sendEnvelope(env: Envelope, kind: ChannelKind = 'control'): SendResult {
    if (closed) return { ok: false, reason: 'not-connected' }
    const channel = channels[kind]
    if (!channel || channel.readyState !== 'open') return { ok: false, reason: 'not-connected' }

    // Reject rather than queue: the browser closes the channel on overflow in
    // some versions instead of throwing, which is a silent hard failure.
    if (channel.bufferedAmount > 64 * 1024) return { ok: false, reason: 'backpressure' }

    const encoded = encodeEnvelope(env)
    if (isOversized(encoded)) return { ok: false, reason: 'too-large' }

    try {
      channel.send(encoded)
    } catch {
      return { ok: false, reason: 'backpressure' }
    }
    return { ok: true, id: env.id }
  }

  // Only the offerer creates channels. The answerer waits for ondatachannel.
  if (role === 'offerer') {
    wireChannel('control', pc.createDataChannel('ctl', { ordered: true, protocol: 'multirace/1' }))
    wireChannel(
      'state',
      pc.createDataChannel('st', { ordered: false, maxRetransmits: 0, protocol: 'multirace/1' }),
    )
  } else {
    pc.ondatachannel = (event) => {
      const label = event.channel.label
      if (label === 'ctl') wireChannel('control', event.channel)
      else if (label === 'st') wireChannel('state', event.channel)
    }
  }

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState
    if (s === 'failed') {
      fail({ code: 'ICE_TIMEOUT', message: 'Could not establish a direct connection.', fatal: true })
    } else if (s === 'disconnected') {
      // Often transient -- a brief Wi-Fi blip. Give ICE a chance to recover
      // before declaring the peer gone; `failed` is the definitive signal.
      setState('connecting')
    }
  }

  return {
    role,
    pc,
    get state() {
      return state
    },
    get bufferedAmount() {
      return channels['control']?.bufferedAmount ?? 0
    },
    on: emitter.on,

    async createInvite(signal?: AbortSignal): Promise<SignalPayload> {
      if (role !== 'offerer') throw new TypeError('createInvite is offerer-only')
      setState('creating-offer')
      const offer = await pc.createOffer()
      setState('gathering')
      const gathered = await setLocalAndGather(pc, offer, gatherTimeoutMs)
      if (signal?.aborted) throw new Error('aborted')
      setState('awaiting-answer')
      return snapshot(pc, gathered.timedOut)
    },

    async acceptInvite(offer: SignalPayload, signal?: AbortSignal): Promise<SignalPayload> {
      if (role !== 'answerer') throw new TypeError('acceptInvite is answerer-only')
      setState('creating-answer')
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: buildSdp(offer) })
      } catch (err) {
        throw new CodecError('SDP_REJECTED', `The offer was rejected: ${String(err)}`)
      }
      const answer = await pc.createAnswer()
      setState('gathering')
      const gathered = await setLocalAndGather(pc, answer, gatherTimeoutMs)
      if (signal?.aborted) throw new Error('aborted')
      setState('awaiting-host')
      return snapshot(pc, gathered.timedOut)
    },

    async acceptAnswer(answer: SignalPayload): Promise<void> {
      if (role !== 'offerer') throw new TypeError('acceptAnswer is offerer-only')
      setState('connecting')
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: buildSdp(answer) })
      } catch (err) {
        throw new CodecError('SDP_REJECTED', `The answer was rejected: ${String(err)}`)
      }
      const ok = await waitForConnected(pc, connectTimeoutMs)
      if (!ok) {
        fail({
          code: 'ICE_TIMEOUT',
          message: 'Connected to the network but the devices could not reach each other.',
          fatal: true,
        })
      }
    },

    send: sendEnvelope,
    close,
  }
}

export { PROTOCOL_VERSION, DEFAULT_INVITE_TTL_MS }

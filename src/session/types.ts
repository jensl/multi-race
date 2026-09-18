/**
 * Shared vocabulary for the session layer.
 *
 * Naming, because the four id types are easy to confuse:
 *   SessionId    one hosted game. Constant for its lifetime.
 *   ConnectionId one invite (one RTCPeerConnection). Minted per guest.
 *   PeerId       a guest's identity *within* a session. Host-assigned.
 *   ClientId     a browser tab. Survives a reload, so a rejoin is not a stranger.
 */

export type SessionId = string
export type ConnectionId = string
export type PeerId = string
export type ClientId = string

/**
 * An encoded signal. Branded so it cannot be confused with any other string --
 * a raw SDP or a session id passing where a code belongs is a mistake worth
 * catching at compile time.
 */
export type SessionCode = string & { readonly __sessionCode: unique symbol }

/** Reserved address for the host. Peer ids are constrained so they cannot collide. */
export const HOST_ADDRESS = '@host'
/** Fan-out to every peer except the sender. */
export const ALL_ADDRESS = '@all'

/**
 * The host's own peer id. A legal peer id on purpose -- the host appears in the
 * roster like anyone else, and `@` is outside the peer-id alphabet so `@host`
 * (the address) can never be confused with this (the identity).
 */
export const HOST_PEER_ID: PeerId = 'host'

export type Address = PeerId | typeof HOST_ADDRESS | typeof ALL_ADDRESS

/** Two channels: reliable for events, unreliable for anything resembling state. */
export type ChannelKind = 'control' | 'state'

// ----------------------------------------------------------------- roster

export interface RosterEntry {
  peerId: PeerId
  clientId: ClientId
  name?: string
  joinedAt: number
  isHost: boolean
}

// --------------------------------------------------------------- envelopes

export interface Envelope<T = unknown> {
  v: 1
  id: string
  /** Message type. Framework types are reserved; anything else is app-defined. */
  t: string
  /**
   * On the wire from a guest this is untrusted. The host overwrites `from`,
   * `ts` and `seq` before relaying, so a guest cannot impersonate another or
   * inject a timestamp into someone else's game state.
   */
  from: PeerId
  to: Address
  /** Host clock, milliseconds. Sanitized on relay. */
  ts: number
  /** Host-assigned monotonic sequence. Sanitized on relay. */
  seq: number
  p?: T
}

/** Framework message types. Reserved -- app messages must not use these. */
export const CONTROL = {
  hello: 'hello',
  welcome: 'welcome',
  roster: 'roster',
  ping: 'ping',
  pong: 'pong',
  bye: 'bye',
  undeliverable: 'undeliverable',
} as const

export type ControlType = (typeof CONTROL)[keyof typeof CONTROL]

export const RESERVED_TYPES: ReadonlySet<string> = new Set(Object.values(CONTROL))

export interface HelloPayload {
  clientId: ClientId
  name?: string
  /** Protocol version, so a mismatch is a clear rejection rather than odd behaviour. */
  proto: number
}

export interface WelcomePayload {
  peerId: PeerId
  sessionId: SessionId
  roster: readonly RosterEntry[]
  rev: number
  /** Host clock at send time. Guests derive an offset; see `ClockSync` in protocol.ts. */
  hostTime: number
  /** If this ClientId was already known, the host reattached rather than re-added. */
  reattached: boolean
}

export interface RosterPayload {
  rev: number
  roster: readonly RosterEntry[]
}

export interface PingPayload {
  /** Echoed back verbatim so the sender can match it to its own send time. */
  t0: number
}

export interface PongPayload {
  t0: number
  /** Host clock when the ping arrived. */
  t1: number
}

export interface UndeliverablePayload {
  /** The id of the message that could not be delivered. */
  id: string
  reason: 'unknown-peer' | 'left' | 'backpressure'
}

// ------------------------------------------------------------------ results

export type SendResult =
  | { ok: true; id: string }
  | {
      ok: false
      reason: 'not-connected' | 'backpressure' | 'too-large' | 'unknown-peer' | 'rate-limited'
    }

export type CloseReason =
  | 'local'
  | 'remote'
  | 'ice-failed'
  | 'timeout'
  | 'protocol-error'
  | 'rejected'
  | 'pagehide'

// ------------------------------------------------------------------- errors

export type ErrorCode =
  | 'WRONG_SESSION'
  | 'INVITE_UNKNOWN'
  | 'INVITE_USED'
  | 'INVITE_EXPIRED'
  | 'WRONG_KIND'
  | 'BAD_CODE'
  | 'SDP_REJECTED'
  | 'ICE_TIMEOUT'
  | 'HELLO_TIMEOUT'
  | 'SESSION_FULL'
  | 'VERSION_MISMATCH'
  | 'NO_CAMERA'
  | 'NO_SECURE_CONTEXT'
  | 'UNSUPPORTED_BROWSER'

export interface SessionError {
  code: ErrorCode
  /** Already human-readable -- this is what a screen shows. */
  message: string
  detail?: unknown
  /** True when the session cannot continue from here. */
  fatal: boolean
}

export function sessionError(code: ErrorCode, message: string, detail?: unknown): SessionError {
  return { code, message, fatal: true, ...(detail === undefined ? {} : { detail }) }
}

/** Protocol version. Bump when the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1

/** Default invite lifetime. The host is the sole authority on this. */
export const DEFAULT_INVITE_TTL_MS = 120_000

/**
 * Conservative because Firefox -> Chromium reassembly caps out here, and Chrome
 * misreports `sctp.maxMessageSize` as Infinity, so the advertised limit is not
 * trustworthy.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024

/** Host-side relay rate limit, per guest. The only DoS guard a no-backend design gets. */
export const RELAY_RATE = { capacity: 60, refillPerSecond: 30 }

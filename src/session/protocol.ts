/**
 * Envelope construction, validation and routing -- as pure functions, so the
 * rules can be tested without a browser, a socket or a peer connection.
 *
 * The trust model, stated once:
 *   Guests are untrusted. A guest's `from` on the wire is a claim, not a fact,
 *   which is why `hello` is the only message accepted before `welcome` and why
 *   the host overwrites `from`, `ts` and `seq` on everything it relays. A guest
 *   that could set `ts` could inject a bogus timestamp into another guest's game
 *   state; one that could set `from` could impersonate.
 */
import {
  ALL_ADDRESS,
  CONTROL,
  HOST_ADDRESS,
  MAX_MESSAGE_BYTES,
  RESERVED_TYPES,
  type Address,
  type Envelope,
  type PeerId,
} from './types.ts'

/** Host-assigned peer ids live in this alphabet, so `@` addresses cannot collide. */
const PEER_ID_RE = /^[a-z0-9]{4,8}$/

export function isValidPeerId(value: unknown): value is PeerId {
  return typeof value === 'string' && PEER_ID_RE.test(value)
}

export function isHostAddress(value: unknown): boolean {
  return value === HOST_ADDRESS
}

export function isAllAddress(value: unknown): boolean {
  return value === ALL_ADDRESS
}

/** 8 hex characters. Unique enough per sender, and 36-char UUIDs would bloat every frame. */
export function newMessageId(): string {
  const b = new Uint8Array(4)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function isReservedType(t: string): boolean {
  return RESERVED_TYPES.has(t)
}

export function makeEnvelope<T>(
  from: PeerId,
  to: Address,
  t: string,
  p?: T,
  seq = 0,
): Envelope<T> {
  return { v: 1, id: newMessageId(), t, from, to, ts: Date.now(), seq, ...(p === undefined ? {} : { p }) }
}

// ------------------------------------------------------------------- routing

export type Route =
  | { kind: 'host' }
  | { kind: 'broadcast' }
  | { kind: 'peer'; peerId: PeerId }

/**
 * Classify a destination. Returns null for anything that is not a legal
 * address -- an unknown `@xyz`, a malformed peer id, or a non-string.
 *
 * Note this does NOT check that the peer still exists; the caller owns the
 * roster. Deliberately so: an unknown target must produce an `undeliverable`
 * reply rather than a silent drop, because a silent drop turns into a game
 * waiting forever on a player who left.
 */
export function parseAddress(to: unknown): Route | null {
  if (isHostAddress(to)) return { kind: 'host' }
  if (isAllAddress(to)) return { kind: 'broadcast' }
  return isValidPeerId(to) ? { kind: 'peer', peerId: to } : null
}

/**
 * Rewrite the fields a sender must not control, before relaying.
 *
 * Preserves `id` (so the sender can correlate an `undeliverable`), and `to`
 * (already validated) and `p` (opaque). Everything else is the host's.
 */
export function sanitizeForRelay(env: Envelope, from: PeerId, seq: number, ts: number): Envelope {
  return { ...env, from, to: env.to, ts, seq }
}

// ------------------------------------------------------------------ envelopes

export interface DecodeResult {
  ok: boolean
  envelope?: Envelope
  reason?: string
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Parse and structurally validate a message off the wire. */
export function decodeEnvelope(data: unknown): DecodeResult {
  if (typeof data !== 'string' || data.length > MAX_MESSAGE_BYTES) {
    return { ok: false, reason: 'not a string, or oversized' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    return { ok: false, reason: 'not JSON' }
  }
  if (!isObject(raw)) return { ok: false, reason: 'not an object' }
  if (raw['v'] !== 1) return { ok: false, reason: `unsupported envelope version ${String(raw['v'])}` }
  if (typeof raw['id'] !== 'string' || raw['id'].length === 0) return { ok: false, reason: 'bad id' }
  if (typeof raw['t'] !== 'string' || raw['t'].length === 0) return { ok: false, reason: 'bad type' }
  if (typeof raw['from'] !== 'string') return { ok: false, reason: 'bad from' }
  if (typeof raw['to'] !== 'string') return { ok: false, reason: 'bad to' }
  if (typeof raw['ts'] !== 'number' || typeof raw['seq'] !== 'number') {
    return { ok: false, reason: 'bad ts/seq' }
  }
  return { ok: true, envelope: raw as unknown as Envelope }
}

export function encodeEnvelope(env: Envelope): string {
  return JSON.stringify(env)
}

/** Reject before `send()`, where the browser would close the channel instead of throwing. */
export function isOversized(encoded: string): boolean {
  return encoded.length > MAX_MESSAGE_BYTES
}

// ----------------------------------------------------------------- rate limit

/**
 * Token bucket, used to cap how much a single guest can make the host relay.
 * Ten lines, and it is the only DoS guard a no-backend design gets.
 */
export class TokenBucket {
  private tokens: number
  private last: number
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly now: () => number

  constructor(capacity: number, refillPerSecond: number, now: () => number = () => Date.now()) {
    this.capacity = capacity
    this.refillPerMs = refillPerSecond / 1000
    this.now = now
    this.tokens = capacity
    this.last = now()
  }

  tryTake(cost = 1): boolean {
    const t = this.now()
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs)
    this.last = t
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}

// ------------------------------------------------------------------ clock sync

export interface ClockSample {
  rttMs: number
  offsetMs: number
}

/**
 * Best-of-N offset estimation from ping/pong.
 *
 * Keeps the sample with the smallest round trip: under the standard symmetric
 * delay assumption, the least-delayed sample has the least error. Uses
 * monotonic send/receive times, so a wall-clock jump cannot corrupt it.
 */
export class ClockSync {
  private best: ClockSample | null = null
  private anchor: { local: number; host: number } | null = null
  private readonly samples: ClockSample[] = []
  // Spelled out rather than a parameter property: Node's strip-only TypeScript
  // mode cannot transform those, and this module is meant to run under `node`.
  private readonly keep: number

  constructor(keep = 5) {
    this.keep = keep
  }

  addSample(t0Local: number, t1Host: number, t2Local: number): void {
    const rttMs = t2Local - t0Local
    const offsetMs = t1Host - (t0Local + t2Local) / 2
    this.samples.push({ rttMs, offsetMs })
    if (this.samples.length > this.keep) this.samples.shift()
    let best: ClockSample | null = null
    for (const s of this.samples) if (!best || s.rttMs < best.rttMs) best = s
    this.best = best
  }

  /**
   * Anchor to a wall-clock reading taken at the same instant as a local one.
   * Needed because samples use monotonic time (immune to clock jumps) while
   * callers want a host *wall clock*.
   */
  anchorTo(localNow: number, hostWallClock: number): void {
    this.anchor = { local: localNow, host: hostWallClock }
  }

  get rttMs(): number {
    return this.best?.rttMs ?? -1
  }

  get offsetMs(): number {
    return this.best?.offsetMs ?? 0
  }

  /** Estimated host wall-clock time, or null before any sample has arrived. */
  hostTime(localNow: number): number | null {
    if (!this.anchor || !this.best) return null
    return this.anchor.host + (localNow - this.anchor.local) + this.best.offsetMs
  }
}

export { CONTROL }

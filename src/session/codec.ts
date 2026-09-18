/**
 * The wire format for a session code: binary, then base64url.
 *
 * Deliberately not compressed. The payload is mostly the 32-byte DTLS
 * fingerprint and packed ICE candidates -- high-entropy data that DEFLATE
 * makes *larger*, not smaller. The wins come from not shipping SDP text at all
 * (fingerprint as 32 raw bytes rather than 95 hex characters, a candidate as
 * ~7 bytes rather than ~85 characters of ASCII), and from skipping base64
 * inside the QR itself.
 *
 * Timestamps are NOT transmitted. The host mints every invite and holds its own
 * expiry table, so it never needs to trust, or compare against, a clock that
 * came off the wire. That removes the only cross-device clock dependency in the
 * protocol -- worth stating plainly so nobody "improves" it back in.
 *
 * No checksum either: QR carries Reed-Solomon ECC, and every variable-length
 * field is length-prefixed, so truncation throws rather than corrupting.
 */
import type { ClientId, ConnectionId, ErrorCode, SessionCode, SessionId } from './types.ts'
import type { CandidateInfo, SignalPayload } from './sdp.ts'

const MAGIC = 0x4d // 'M'
const FORMAT_VERSION = 1
const SETUPS = ['actpass', 'active', 'passive'] as const
const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const
const TCP_TYPES = ['active', 'passive', 'so'] as const

/** Backed by a plain ArrayBuffer so it satisfies BlobPart and the stream APIs. */
export type Bytes = Uint8Array<ArrayBuffer>

export class CodecError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.name = 'CodecError'
    this.code = code
  }
}

// --------------------------------------------------------------------- ids

const hex = (bytes: Bytes): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

function unhex(s: string, byteLength: number): Bytes {
  if (s.length !== byteLength * 2) throw new CodecError('BAD_CODE', 'malformed id')
  const out = new Uint8Array(byteLength)
  for (let i = 0; i < byteLength; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 4 bytes. Only has to be unique among sessions this device can see. */
export function newSessionId(): SessionId {
  const b = new Uint8Array(4)
  crypto.getRandomValues(b)
  return hex(b)
}

/**
 * 6 bytes, minted per invite. This is the routing key: an SDP answer is
 * structurally valid against any offer with a matching m-line shape, so a
 * misrouted answer makes setRemoteDescription *succeed* and then fail at ICE
 * half a minute later with nothing pointing at the cause. The cid is what
 * makes that misroute impossible rather than silent.
 */
export function newConnectionId(): ConnectionId {
  const b = new Uint8Array(6)
  crypto.getRandomValues(b)
  return hex(b)
}

// ------------------------------------------------------------ binary plumbing

class Writer {
  private readonly out: number[] = []
  u8(v: number): void {
    this.out.push(v & 0xff)
  }
  u16(v: number): void {
    this.out.push((v >>> 8) & 0xff, v & 0xff)
  }
  u32(v: number): void {
    this.out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  }
  raw(b: Bytes): void {
    for (const x of b) this.out.push(x)
  }
  str(s: string): void {
    const b = new TextEncoder().encode(s)
    if (b.length > 255) throw new CodecError('BAD_CODE', 'string field too long')
    this.u8(b.length)
    this.raw(b)
  }
  finish(): Bytes {
    return new Uint8Array(this.out)
  }
}

class Reader {
  private pos = 0
  private readonly buf: Bytes
  constructor(buf: Bytes) {
    this.buf = buf
  }
  get remaining(): number {
    return this.buf.length - this.pos
  }
  u8(): number {
    const v = this.buf[this.pos]
    if (v === undefined) throw new CodecError('BAD_CODE', 'truncated code')
    this.pos++
    return v
  }
  u16(): number {
    return (this.u8() << 8) | this.u8()
  }
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0
  }
  raw(n: number): Bytes {
    if (this.remaining < n) throw new CodecError('BAD_CODE', 'truncated code')
    const v = this.buf.subarray(this.pos, this.pos + n) as Bytes
    this.pos += n
    return v
  }
  str(): string {
    return new TextDecoder().decode(this.raw(this.u8()))
  }
}

// ------------------------------------------------------------------ addresses

function ipv4ToBytes(s: string): Bytes | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1])
    if (n > 255) return null
    out[i] = n
  }
  return out
}

function bytesToHex(b: Bytes, sep = ''): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(sep)
}

/** The UUID at the front of an mDNS candidate, as 16 raw bytes rather than 42 characters. */
function mdnsUuid(s: string): Bytes | null {
  const m =
    /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i.exec(s)
  if (!m) return null
  return unhex(m.slice(1).join('').toLowerCase(), 16)
}

function writeAddress(w: Writer, addr: string): void {
  const v4 = ipv4ToBytes(addr)
  if (v4) {
    w.u8(0)
    w.raw(v4)
    return
  }
  const mdns = mdnsUuid(addr)
  if (mdns) {
    w.u8(1)
    w.raw(mdns)
    return
  }
  w.u8(2)
  w.str(addr)
}

function readAddress(r: Reader): string {
  const kind = r.u8()
  if (kind === 0) return [...r.raw(4)].join('.')
  if (kind === 1) {
    // Lowercase: browsers emit these in lowercase, and while RFC 6762 makes
    // mDNS names case-insensitive, matching the original costs nothing.
    const h = bytesToHex(r.raw(16)).toLowerCase()
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`
  }
  if (kind === 2) return r.str()
  throw new CodecError('BAD_CODE', `bad address tag ${kind}`)
}

// ----------------------------------------------------------------- the signal

export interface SignalDescription {
  kind: 'offer' | 'answer'
  sid: SessionId
  cid: ConnectionId
  /** Answers only. Lets the host reattach a returning guest instead of adding a ghost. */
  clientId?: ClientId
  payload: SignalPayload
}

function writeCandidate(w: Writer, c: CandidateInfo): void {
  const transportIdx = c.transport === 'tcp' ? 1 : 0
  const typeIdx = Math.max(0, CANDIDATE_TYPES.indexOf(c.type as (typeof CANDIDATE_TYPES)[number]))
  const tcpTypeIdx = c.tcptype
    ? Math.max(0, TCP_TYPES.indexOf(c.tcptype as (typeof TCP_TYPES)[number]))
    : -1
  w.u8(transportIdx | (typeIdx << 1) | (tcpTypeIdx >= 0 ? 1 << 4 : 0))
  w.str(c.foundation)
  w.u8(Number(c.component) || 1)
  w.u32(Number(c.priority) || 1)
  writeAddress(w, c.address)
  w.u16(c.port)
  // raddr/rport only exist on srflx and relay candidates, so the flag is the type.
  if (typeIdx === 1 || typeIdx === 3) {
    writeAddress(w, c.raddr ?? '0.0.0.0')
    w.u16(c.rport ?? 0)
  }
  if (tcpTypeIdx >= 0) w.u8(tcpTypeIdx)
}

function readCandidate(r: Reader): CandidateInfo {
  const flags = r.u8()
  const transport = (flags & 1) === 1 ? 'tcp' : 'udp'
  const typeIdx = (flags >> 1) & 0x03
  const hasTcpType = ((flags >> 4) & 1) === 1
  const c: CandidateInfo = {
    foundation: r.str(),
    component: String(r.u8()),
    transport,
    priority: String(r.u32()),
    address: '',
    port: 0,
    type: CANDIDATE_TYPES[typeIdx] ?? 'host',
    isMdns: false,
  }
  c.address = readAddress(r)
  c.isMdns = c.address.endsWith('.local')
  c.port = r.u16()
  if (typeIdx === 1 || typeIdx === 3) {
    c.raddr = readAddress(r)
    c.rport = r.u16()
  }
  if (hasTcpType) c.tcptype = TCP_TYPES[r.u8()] ?? 'active'
  return c
}

export function encodeSignal(desc: SignalDescription): SessionCode {
  const w = new Writer()
  w.u8(MAGIC)
  w.u8(FORMAT_VERSION)

  const setupIdx = Math.max(0, SETUPS.indexOf(desc.payload.setup as (typeof SETUPS)[number]))
  const hasClientId = desc.clientId !== undefined
  w.u8(
    (desc.kind === 'offer' ? 0 : 1) |
      (setupIdx << 1) |
      (desc.payload.endOfCandidates ? 1 << 3 : 0) |
      (hasClientId ? 1 << 4 : 0),
  )

  w.raw(unhex(desc.sid, 4))
  w.raw(unhex(desc.cid, 6))
  w.raw(unhex(desc.payload.fingerprint.replace(/:/g, ''), 32))

  w.str(desc.payload.ufrag)
  w.str(desc.payload.pwd)
  w.u16(desc.payload.sctpPort)
  if (desc.clientId !== undefined) w.str(desc.clientId)

  const candidates = desc.payload.candidates
  if (candidates.length > 255) throw new CodecError('BAD_CODE', 'too many candidates')
  w.u8(candidates.length)
  for (const c of candidates) writeCandidate(w, c)

  return toBase64Url(w.finish()) as SessionCode
}

export function decodeSignal(code: string): SignalDescription {
  let bytes: Bytes
  try {
    bytes = fromBase64Url(code.trim())
  } catch (err) {
    throw new CodecError('BAD_CODE', `not a readable code: ${String(err)}`)
  }
  const r = new Reader(bytes)
  if (r.u8() !== MAGIC) {
    throw new CodecError('BAD_CODE', 'that does not look like a MultiRace code')
  }
  const version = r.u8()
  if (version !== FORMAT_VERSION) {
    throw new CodecError('VERSION_MISMATCH', `code format v${version}, this build speaks v${FORMAT_VERSION}`)
  }

  const flags = r.u8()
  const kind: 'offer' | 'answer' = (flags & 1) === 1 ? 'answer' : 'offer'
  const setup = SETUPS[(flags >> 1) & 0x03] ?? 'actpass'
  const endOfCandidates = ((flags >> 3) & 1) === 1
  const hasClientId = ((flags >> 4) & 1) === 1

  const sid = hex(r.raw(4))
  const cid = hex(r.raw(6))
  const fingerprint = bytesToHex(r.raw(32), ':')

  const ufrag = r.str()
  const pwd = r.str()
  const sctpPort = r.u16()
  const clientId = hasClientId ? r.str() : undefined

  const count = r.u8()
  const candidates: CandidateInfo[] = []
  for (let i = 0; i < count; i++) candidates.push(readCandidate(r))

  return {
    kind,
    sid,
    cid,
    ...(clientId === undefined ? {} : { clientId }),
    payload: { kind, fingerprint, setup, ufrag, pwd, sctpPort, endOfCandidates, candidates },
  }
}

// ------------------------------------------------------------------ base64url

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function toBase64Url(bytes: Bytes): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += B64[(triple >> 18) & 63]! + B64[(triple >> 12) & 63]!
    if (b1 !== undefined) out += B64[(triple >> 6) & 63]!
    if (b2 !== undefined) out += B64[triple & 63]!
  }
  return out
}

function fromBase64Url(s: string): Bytes {
  const lookup = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) lookup[B64.charCodeAt(i)] = i

  const out: number[] = []
  let acc = 0
  let bits = 0
  for (let i = 0; i < s.length; i++) {
    const v = lookup[s.charCodeAt(i)] ?? -1
    if (v < 0) throw new CodecError('BAD_CODE', `unexpected character "${s[i]}"`)
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

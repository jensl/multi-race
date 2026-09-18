/**
 * Everything we do to a browser's SDP, and nothing more.
 *
 * The hard rule: the string handed to `setRemoteDescription` must be one a
 * browser generated, or a faithful reassembly of its meaningful fields. We
 * never rewrite credentials -- Chrome M137+ rejects `setLocalDescription`
 * carrying an altered `ice-ufrag`/`ice-pwd` (field trial WebRTC-NoSdpMangleUfrag,
 * and the standard forbids it). Candidates are the only thing we ever remove,
 * and removing them is legal because this is the signaling path: the far side
 * constructs its own remote description from whatever we give it.
 *
 * Measured on real devices: this path produces a QR v10 code that scans in under
 * a second, against v19 for shipping the SDP verbatim.
 */

export interface CandidateInfo {
  foundation: string
  component: string
  transport: string
  priority: string
  address: string
  port: number
  type: string
  raddr?: string
  rport?: number
  tcptype?: string
  /** Chrome obfuscates host candidates as <uuid>.local when media is not granted. */
  isMdns: boolean
}

/** The fields needed to rebuild an SDP on the far side. */
export interface SignalPayload {
  kind: 'offer' | 'answer'
  fingerprint: string
  setup: string
  ufrag: string
  pwd: string
  sctpPort: number
  endOfCandidates: boolean
  candidates: CandidateInfo[]
}

const CANDIDATE_PREFIX = 'a=candidate:'

function toCandidate(line: string): CandidateInfo | null {
  if (!line.startsWith(CANDIDATE_PREFIX)) return null
  const p = line.split(' ')
  const address = p[4] ?? ''
  const c: CandidateInfo = {
    foundation: p[0]?.slice(CANDIDATE_PREFIX.length) ?? '1',
    component: p[1] ?? '1',
    transport: p[2] ?? 'udp',
    priority: p[3] ?? '1',
    address,
    port: Number(p[5] ?? 0),
    type: p[7] ?? 'host',
    isMdns: address.endsWith('.local'),
  }
  for (let i = 8; i < p.length - 1; i += 2) {
    const key = p[i]
    const value = p[i + 1]
    if (value === undefined) continue
    if (key === 'raddr') c.raddr = value
    else if (key === 'rport') c.rport = Number(value)
    else if (key === 'tcptype') c.tcptype = value
  }
  return c
}

export function parseCandidates(sdp: string): CandidateInfo[] {
  const out: CandidateInfo[] = []
  for (const line of sdp.split(/\r?\n/)) {
    const c = toCandidate(line)
    if (c) out.push(c)
  }
  return out
}

export function summarizeCandidates(sdp: string): string {
  const counts = new Map<string, number>()
  for (const c of parseCandidates(sdp)) {
    const key = `${c.type}/${c.transport}${c.isMdns ? ' (mdns)' : ''}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size === 0) return 'none'
  return [...counts].map(([k, n]) => `${k}×${n}`).join(', ')
}

/**
 * Drop candidate lines matching a predicate.
 *
 * TCP is the usual target: on a LAN it is dead weight, and it is a large share
 * of the SDP's bytes. Measured at 272 bytes of a 1151-byte offer.
 */
export function stripCandidates(sdp: string, drop: (c: CandidateInfo) => boolean): string {
  const kept = sdp
    .split(/\r?\n/)
    .filter((line) => {
      const c = toCandidate(line)
      return c === null || !drop(c)
    })
    .join('\r\n')
  return kept.endsWith('\r\n') ? kept : kept + '\r\n'
}

/**
 * Tell the remote ICE agent we are finished, when gathering was cut short by a
 * timeout rather than completing. Without this the far side waits out its own
 * checklist timers before giving up, so a broken connection looks like a 30s
 * hang instead of an error.
 */
export function appendEndOfCandidates(sdp: string): string {
  return sdp.endsWith('\r\n')
    ? sdp + 'a=end-of-candidates\r\n'
    : sdp + '\r\na=end-of-candidates\r\n'
}

function attr(sdp: string, name: string): string | undefined {
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith(`a=${name}:`)) return line.slice(name.length + 3)
  }
  return undefined
}

/**
 * `a=fingerprint:sha-256 AB:CD:...` carries its algorithm in the same
 * attribute, so take the last token rather than the whole value. Getting this
 * wrong packs the wrong number of bytes and produces a payload that fails to
 * decode -- it is exactly the bug the browser-free checks exist to catch.
 */
export function fingerprintHex(value: string | undefined): string {
  if (!value) return ''
  const parts = value.trim().split(/\s+/)
  return parts[parts.length - 1] ?? ''
}

/** Pull exactly the fields needed to rebuild this SDP on the far side. */
export function extractSignal(sdp: string, kind: 'offer' | 'answer'): SignalPayload {
  const candidates: CandidateInfo[] = []
  for (const line of sdp.split(/\r?\n/)) {
    const c = toCandidate(line)
    if (c) candidates.push(c)
  }
  return {
    kind,
    fingerprint: fingerprintHex(attr(sdp, 'fingerprint')),
    setup: attr(sdp, 'setup') ?? 'actpass',
    ufrag: attr(sdp, 'ice-ufrag') ?? '',
    pwd: attr(sdp, 'ice-pwd') ?? '',
    sctpPort: Number(attr(sdp, 'sctp-port') ?? 5000),
    endOfCandidates: sdp.includes('a=end-of-candidates'),
    candidates,
  }
}

export function candidateLine(c: CandidateInfo): string {
  let s =
    `a=candidate:${c.foundation} ${c.component} ${c.transport} ${c.priority} ` +
    `${c.address} ${c.port} typ ${c.type}`
  if (c.raddr !== undefined) s += ` raddr ${c.raddr} rport ${c.rport ?? 0}`
  if (c.tcptype !== undefined) s += ` tcptype ${c.tcptype}`
  return s + ' generation 0'
}

/**
 * Rebuild the SDP the far side hands to `setRemoteDescription`.
 *
 * Only the boilerplate Chrome emits for a data-only connection is synthesized.
 * Every field carrying meaning -- credentials, fingerprint, candidates, setup
 * role, SCTP port -- comes from the peer.
 *
 * Verified on two Android phones: this is accepted by `setRemoteDescription`
 * and completes an ICE handshake.
 */
export function buildSdp(sig: SignalPayload): string {
  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
  ]
  for (const c of sig.candidates) lines.push(candidateLine(c))
  lines.push(
    `a=ice-ufrag:${sig.ufrag}`,
    `a=ice-pwd:${sig.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${sig.fingerprint}`,
    `a=setup:${sig.setup}`,
    'a=mid:0',
    `a=sctp-port:${sig.sctpPort}`,
    'a=max-message-size:262144',
  )
  if (sig.endOfCandidates) lines.push('a=end-of-candidates')
  return lines.join('\r\n') + '\r\n'
}

import { describe, expect, it } from 'vitest'
import { CodecError, decodeSignal, encodeSignal, type SignalDescription } from './codec.ts'
import { candidateLine, extractSignal, type CandidateInfo, type SignalPayload } from './sdp.ts'
import { makeSdp } from './test-support/fakes.ts'

const FP = Array.from({ length: 32 }, (_, i) =>
  ((i * 37 + 11) % 256).toString(16).padStart(2, '0').toUpperCase(),
).join(':')

function payload(overrides: Partial<SignalPayload> = {}): SignalPayload {
  return {
    kind: 'offer',
    fingerprint: FP,
    setup: 'actpass',
    ufrag: '4ZcD',
    pwd: '2/1muCWoOi3uLifh0NuRHlwo',
    sctpPort: 5000,
    endOfCandidates: false,
    candidates: [],
    ...overrides,
  }
}

const candidate = (over: Partial<CandidateInfo> = {}): CandidateInfo => ({
  foundation: '1467250027',
  component: '1',
  transport: 'udp',
  priority: '2122260223',
  address: '192.168.1.42',
  port: 46243,
  type: 'host',
  isMdns: false,
  ...over,
})

function offer(overrides: Partial<SignalDescription> = {}): SignalDescription {
  return { kind: 'offer', sid: 'a1b2c3d4', cid: '010203040506', payload: payload(), ...overrides }
}

const roundTrip = (desc: SignalDescription): SignalDescription => decodeSignal(encodeSignal(desc))

describe('signal round-trip', () => {
  it('preserves identity and correlation fields', () => {
    const out = roundTrip(offer({ kind: 'answer', clientId: 'client-7' }))
    expect(out.kind).toBe('answer')
    expect(out.sid).toBe('a1b2c3d4')
    expect(out.cid).toBe('010203040506')
    expect(out.clientId).toBe('client-7')
  })

  it('omits clientId on an offer rather than sending an empty string', () => {
    expect(roundTrip(offer()).clientId).toBeUndefined()
  })

  it('preserves the credentials and fingerprint verbatim', () => {
    const out = roundTrip(offer())
    expect(out.payload.fingerprint).toBe(FP)
    expect(out.payload.ufrag).toBe('4ZcD')
    expect(out.payload.pwd).toBe('2/1muCWoOi3uLifh0NuRHlwo')
    expect(out.payload.sctpPort).toBe(5000)
    expect(out.payload.setup).toBe('actpass')
  })

  it('preserves endOfCandidates, which is what stops the far side hanging', () => {
    expect(roundTrip(offer({ payload: payload({ endOfCandidates: true }) })).payload.endOfCandidates).toBe(
      true,
    )
    expect(roundTrip(offer()).payload.endOfCandidates).toBe(false)
  })
})

describe('candidate packing', () => {
  it('round-trips an IPv4 host candidate', () => {
    const c = candidate()
    const out = roundTrip(offer({ payload: payload({ candidates: [c] }) }))
    expect(out.payload.candidates[0]).toMatchObject({
      address: '192.168.1.42',
      port: 46243,
      type: 'host',
      transport: 'udp',
      component: '1',
    })
  })

  it('round-trips a server-reflexive candidate with its raddr and rport', () => {
    const c = candidate({
      foundation: '935214411',
      type: 'srflx',
      address: '203.0.113.20',
      port: 46343,
      raddr: '192.168.1.42',
      rport: 46243,
    })
    const out = roundTrip(offer({ payload: payload({ candidates: [c] }) }))
    expect(out.payload.candidates[0]).toMatchObject({
      type: 'srflx',
      address: '203.0.113.20',
      raddr: '192.168.1.42',
      rport: 46243,
    })
  })

  it('round-trips a TCP candidate and its tcptype', () => {
    const c = candidate({ transport: 'tcp', tcptype: 'active', port: 9 })
    const out = roundTrip(offer({ payload: payload({ candidates: [c] }) }))
    expect(out.payload.candidates[0]).toMatchObject({ transport: 'tcp', tcptype: 'active' })
  })

  it('reconstructs an mDNS name exactly, including its lowercase', () => {
    const name = '8f2a1c4e-9b3d-4a17-8c25-6e0f9d4b7a31.local'
    const c = candidate({ address: name, isMdns: true })
    const out = roundTrip(offer({ payload: payload({ candidates: [c] }) }))
    // Case matters: the packed form stores raw bytes, and browsers emit
    // lowercase. Getting this wrong produces a name the far side cannot resolve.
    expect(out.payload.candidates[0]?.address).toBe(name)
  })

  it('keeps candidates in order across a mixed set', () => {
    const list = [
      candidate({ address: '192.168.1.42' }),
      candidate({ type: 'srflx', address: '203.0.113.20', raddr: '192.168.1.42', rport: 46243 }),
      candidate({ transport: 'tcp', tcptype: 'active' }),
    ]
    const out = roundTrip(offer({ payload: payload({ candidates: list }) }))
    expect(out.payload.candidates.map((c) => c.address)).toEqual([
      '192.168.1.42',
      '203.0.113.20',
      '192.168.1.42',
    ])
  })

  it('round-trips a full realistic SDP through extract -> pack -> unpack', () => {
    const original = extractSignal(makeSdp(), 'offer')
    const out = roundTrip(offer({ payload: original }))
    expect(out.payload.candidates.map((c) => `${c.type}/${c.transport}/${c.address}:${c.port}`)).toEqual(
      original.candidates.map((c) => `${c.type}/${c.transport}/${c.address}:${c.port}`),
    )
    expect(out.payload.fingerprint).toBe(original.fingerprint)
    expect(out.payload.ufrag).toBe(original.ufrag)
  })
})

describe('malformed input', () => {
  const expectCode = (code: string, expected: string): void => {
    try {
      decodeSignal(code)
      throw new Error('expected decodeSignal to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CodecError)
      expect((err as CodecError).code).toBe(expected)
    }
  }

  it('rejects a truncated code', () => {
    const full = encodeSignal(offer({ payload: payload({ candidates: [candidate()] }) }))
    expectCode(full.slice(0, Math.floor(full.length / 2)), 'BAD_CODE')
  })

  it('rejects characters outside the alphabet', () => {
    expectCode('!!not base64url!!', 'BAD_CODE')
  })

  it('rejects a payload that is valid base64url but not one of ours', () => {
    expectCode('aGVsbG8gd29ybGQ', 'BAD_CODE')
  })

  it('reports a version mismatch distinctly, so the message can be actionable', () => {
    const bytes = new Uint8Array(8)
    bytes[0] = 0x4d // correct magic
    bytes[1] = 99 // a format this build does not speak
    const b64 = Buffer.from(bytes).toString('base64url')
    expectCode(b64, 'VERSION_MISMATCH')
  })

  it('round-trips the empty string as a clear error rather than a crash', () => {
    expect(() => decodeSignal('')).toThrow(CodecError)
  })
})

describe('size', () => {
  it('stays small enough for a reliably scannable QR', () => {
    // The whole reason this codec exists. Measured at 181 bytes -> QR v10 on
    // real devices; anything approaching the verbatim SDP's 542 bytes (v19)
    // would put scanning back in the marginal band.
    const real = extractSignal(makeSdp(), 'offer')
    const code = encodeSignal(offer({ payload: real }))
    expect(code.length).toBeLessThan(260)
  })

  it('adds less for a candidate than its SDP text line would', () => {
    const name = '8f2a1c4e-9b3d-4a17-8c25-6e0f9d4b7a31.local'
    const c = candidate({ address: name, isMdns: true })

    const withCandidate = encodeSignal(offer({ payload: payload({ candidates: [c] }) })).length
    const without = encodeSignal(offer({ payload: payload({ candidates: [] }) })).length
    const lineLength = candidateLine(c).length

    // Even after base64url's 4/3 expansion, and even with the 42-character
    // mDNS name stored as a 16-byte UUID, the packed contribution beats the
    // ~85 characters of `a=candidate:...` it replaces.
    expect(withCandidate - without).toBeLessThan(lineLength)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ClockSync,
  decodeEnvelope,
  encodeEnvelope,
  isValidPeerId,
  makeEnvelope,
  parseAddress,
  sanitizeForRelay,
  TokenBucket,
} from './protocol.ts'
import { ALL_ADDRESS, HOST_ADDRESS, MAX_MESSAGE_BYTES, type Envelope } from './types.ts'

describe('address parsing', () => {
  it('recognises the two reserved addresses', () => {
    expect(parseAddress(HOST_ADDRESS)).toEqual({ kind: 'host' })
    expect(parseAddress(ALL_ADDRESS)).toEqual({ kind: 'broadcast' })
  })

  it('accepts a well-formed peer id', () => {
    expect(parseAddress('ab12')).toEqual({ kind: 'peer', peerId: 'ab12' })
  })

  it('rejects anything that is not a legal address', () => {
    // Non-strings, an invented @-address, and peer ids outside the alphabet.
    for (const bad of [null, undefined, 42, {}, '', 'ab', 'toolongid', 'AB12', 'ab-1', '@everyone']) {
      expect(parseAddress(bad)).toBeNull()
    }
  })

  it('keeps the @ prefix reserved so a peer id can never collide with an address', () => {
    expect(isValidPeerId('@host')).toBe(false)
    expect(isValidPeerId('host')).toBe(true)
  })
})

describe('relay sanitization', () => {
  const incoming = (): Envelope => ({
    v: 1,
    id: 'abc123',
    t: 'position',
    from: 'evil',
    to: 'zz99',
    ts: 1,
    seq: 1,
    p: { x: 10 },
  })

  it('overwrites the fields a sender must not control', () => {
    const clean = sanitizeForRelay(incoming(), 'real', 77, 999)
    expect(clean.from).toBe('real')
    expect(clean.seq).toBe(77)
    expect(clean.ts).toBe(999)
  })

  it('preserves the fields the sender is entitled to', () => {
    // `id` is preserved so an `undeliverable` reply can be correlated; `p` is
    // opaque application data.
    const clean = sanitizeForRelay(incoming(), 'real', 77, 999)
    expect(clean.id).toBe('abc123')
    expect(clean.to).toBe('zz99')
    expect(clean.p).toEqual({ x: 10 })
  })

  it('does not mutate the envelope it was given', () => {
    const original = incoming()
    sanitizeForRelay(original, 'real', 77, 999)
    expect(original.from).toBe('evil')
    expect(original.seq).toBe(1)
  })
})

describe('envelope decoding', () => {
  const good = () => makeEnvelope('ab12', HOST_ADDRESS, 'chat', { text: 'hi' })

  it('accepts a well-formed envelope', () => {
    const result = decodeEnvelope(encodeEnvelope(good()))
    expect(result.ok).toBe(true)
    expect(result.envelope?.t).toBe('chat')
  })

  const rejected = (input: unknown, why: string): void => {
    const result = decodeEnvelope(input)
    expect(result.ok, why).toBe(false)
  }

  it('rejects malformed input rather than letting bad data reach a handler', () => {
    rejected('not json', 'not JSON')
    rejected(JSON.stringify([1, 2, 3]), 'an array')
    rejected(JSON.stringify({ ...good(), v: 2 }), 'a future envelope version')
    rejected(JSON.stringify({ ...good(), id: '' }), 'an empty id')
    rejected(JSON.stringify({ ...good(), t: 5 }), 'a non-string type')
    rejected(JSON.stringify({ ...good(), ts: 'now' }), 'a non-numeric timestamp')
    rejected(JSON.stringify({ ...good(), to: undefined }), 'a missing address')
    rejected(42, 'a number')
    rejected({ ...good() }, 'an object rather than a wire string')
  })

  it('rejects an oversized message before the browser can close the channel', () => {
    // Chromium closes the data channel on overflow rather than throwing, which
    // is a silent hard failure -- so this has to be caught on our side.
    const huge = makeEnvelope('ab12', HOST_ADDRESS, 'chat', { text: 'x'.repeat(MAX_MESSAGE_BYTES) })
    rejected(encodeEnvelope(huge), 'oversized')
  })
})

describe('token bucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    let now = 0
    const bucket = new TokenBucket(3, 1, () => now)
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true])
    expect(bucket.tryTake()).toBe(false)
  })

  it('refills over time', () => {
    let now = 0
    const bucket = new TokenBucket(2, 10, () => now) // 10 per second
    bucket.tryTake()
    bucket.tryTake()
    expect(bucket.tryTake()).toBe(false)
    now += 100 // 100ms -> 1 token
    expect(bucket.tryTake()).toBe(true)
  })

  it('never refills past capacity', () => {
    let now = 0
    const bucket = new TokenBucket(2, 1000, () => now)
    now += 10_000
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, false])
  })
})

describe('clock sync', () => {
  it('keeps the lowest-RTT sample, which is the least distorted', () => {
    const clock = new ClockSync()
    clock.addSample(0, 1000, 400) // rtt 400, offset 1000 - 200 = 800
    clock.addSample(0, 1000, 100) // rtt 100, offset 1000 - 50  = 950  <- best
    clock.addSample(0, 1000, 800) // rtt 800, offset 1000 - 400 = 600
    expect(clock.rttMs).toBe(100)
    expect(clock.offsetMs).toBe(950)
  })

  it('reports -1 RTT before any sample, so a caller cannot mistake it for zero', () => {
    expect(new ClockSync().rttMs).toBe(-1)
  })

  it('converts a local reading into host wall-clock time', () => {
    const clock = new ClockSync()
    clock.addSample(0, 5000, 100) // rtt 100, offset 5000 - 50 = 4950
    clock.anchorTo(1000, 10_000) // at local 1000, host wall clock was 10000
    // 500 local ms later, plus the measured offset.
    expect(clock.hostTime(1500)).toBe(10_000 + 500 + 4950)
  })

  it('returns null rather than a wrong time before it has been anchored', () => {
    const clock = new ClockSync()
    clock.addSample(0, 1000, 100)
    expect(clock.hostTime(0)).toBeNull()
  })

  it('bounds how many samples it retains', () => {
    const clock = new ClockSync(2)
    clock.addSample(0, 1000, 900) // rtt 900
    clock.addSample(0, 1000, 800) // rtt 800
    clock.addSample(0, 1000, 700) // rtt 700
    clock.addSample(0, 1000, 50) // rtt 50  <- best
    // The 900 sample was evicted, but nothing better than 50 exists either way.
    expect(clock.rttMs).toBe(50)
  })
})

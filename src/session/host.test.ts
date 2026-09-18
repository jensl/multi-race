/**
 * The host's invite table is where the subtle bugs live: an SDP answer is
 * structurally valid against any offer with the same m-line shape, so a
 * misrouted answer makes `setRemoteDescription` *succeed* and then fail at ICE
 * half a minute later with nothing pointing at the cause.
 *
 * So these tests are mostly about the failure paths: every way a code can be
 * wrong must produce a specific, actionable error rather than a hang.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostSession, type HostSession } from './host.ts'
import { encodeSignal, type SignalDescription } from './codec.ts'
import { makeEnvelope } from './protocol.ts'
import { extractSignal } from './sdp.ts'
import { ALL_ADDRESS, HOST_ADDRESS, PROTOCOL_VERSION, type SessionCode } from './types.ts'
import {
  createRecordingSignaler,
  FakePeerConnection,
  installFakeRtc,
  makeSdp,
  tick,
  type RecordingSignaler,
} from './test-support/fakes.ts'

const answerPayload = () => ({
  ...extractSignal(makeSdp(), 'answer'),
  setup: 'active',
})

function answerFor(offer: SignalDescription, clientId: string): SessionCode {
  return encodeSignal({
    kind: 'answer',
    sid: offer.sid,
    cid: offer.cid,
    clientId,
    payload: answerPayload(),
  })
}

function helloFor(clientId: string): string {
  return JSON.stringify(
    makeEnvelope('ab12', HOST_ADDRESS, 'hello', { clientId, proto: PROTOCOL_VERSION }),
  )
}

let restore: () => void
beforeEach(() => {
  restore = installFakeRtc()
})
afterEach(() => {
  restore()
})

async function newHost(overrides: Record<string, unknown> = {}) {
  const signaler = createRecordingSignaler()
  const host = createHostSession({ signaler, iceServers: [], ...overrides })
  await host.start()
  return { host, signaler }
}

/** Drives the fake peer connection through a full join, ending in `welcome`. */
async function addGuest(host: HostSession, signaler: RecordingSignaler, clientId: string) {
  const invite = await host.invite()
  const offer = signaler.published.at(-1)
  if (!offer) throw new Error('no offer was published')

  const pending = host.submitAnswer(answerFor(offer, clientId))
  await tick()

  const pc = FakePeerConnection.last
  pc.simulateConnected()
  pc.openChannels()
  pc.channel('ctl').deliver(helloFor(clientId))

  const { peerId } = await pending
  return { peerId, pc, cid: invite.cid }
}

describe('invite acceptance', () => {
  it('accepts a valid answer and resolves with the assigned peer id', async () => {
    const { host, signaler } = await newHost()
    const { peerId, pc } = await addGuest(host, signaler, 'guest-1')

    expect(peerId).toMatch(/^[a-z0-9]{4}$/)
    expect(host.peerCount).toBe(1)
    expect(host.roster.map((r) => r.peerId)).toEqual([peerId])

    // A guest is only joined once `welcome` goes out -- `onopen` alone proves
    // bytes flow, not that the host accepted anyone.
    const welcome = pc
      .channel('ctl')
      .received()
      .find((m) => (m as { t: string }).t === 'welcome') as {
      p: { peerId: string; roster: unknown[]; reattached: boolean }
    }
    expect(welcome).toBeDefined()
    expect(welcome.p.peerId).toBe(peerId)
    expect(welcome.p.reattached).toBe(false)
  })

  it('reports a repeated ClientId as a reattach rather than adding a ghost', async () => {
    const { host, signaler } = await newHost()
    const first = await addGuest(host, signaler, 'same-client')
    const second = await addGuest(host, signaler, 'same-client')

    expect(host.peerCount).toBe(1)
    expect(host.roster[0]?.peerId).toBe(second.peerId)
    expect(second.peerId).not.toBe(first.peerId)
  })
})

describe('rejected codes produce typed errors, never a hang', () => {
  const rejects = async (code: SessionCode, expected: string): Promise<void> => {
    const { host } = await newHost()
    await host.invite()
    await expect(host.submitAnswer(code)).rejects.toMatchObject({ code: expected })
  }

  it('replays an already-used invite as INVITE_USED', async () => {
    const { host, signaler } = await newHost()
    const invite = await host.invite()
    const offer = signaler.published.at(-1)
    if (!offer) throw new Error('no offer')
    const code = answerFor(offer, 'guest-1')

    const pending = host.submitAnswer(code)
    await tick()
    FakePeerConnection.last.simulateConnected()
    FakePeerConnection.last.openChannels()
    FakePeerConnection.last.channel('ctl').deliver(helloFor('guest-1'))
    await pending

    // The same code a second time must be a clear message, not a second join.
    await expect(host.submitAnswer(code)).rejects.toMatchObject({ code: 'INVITE_USED' })
    void invite
  })

  it('rejects a code minted for a different session as WRONG_SESSION', async () => {
    const { host, signaler } = await newHost()
    await host.invite()
    const offer = signaler.published.at(-1)
    if (!offer) throw new Error('no offer')
    const foreign = encodeSignal({
      kind: 'answer',
      sid: 'deadbeef', // not this host's session
      cid: offer.cid,
      clientId: 'guest-1',
      payload: answerPayload(),
    })
    await expect(host.submitAnswer(foreign)).rejects.toMatchObject({ code: 'WRONG_SESSION' })
  })

  it('rejects a code whose cid belongs to no invite as INVITE_UNKNOWN', async () => {
    const { host, signaler } = await newHost()
    await host.invite()
    const offer = signaler.published.at(-1)
    if (!offer) throw new Error('no offer')
    const unknown = encodeSignal({
      kind: 'answer',
      sid: offer.sid,
      cid: 'ffffffffffff',
      clientId: 'guest-1',
      payload: answerPayload(),
    })
    await expect(host.submitAnswer(unknown)).rejects.toMatchObject({ code: 'INVITE_UNKNOWN' })
  })

  it('rejects an offer where an answer is expected, distinctly from a parse failure', async () => {
    const { host, signaler } = await newHost()
    await host.invite()
    const offer = signaler.published.at(-1)
    if (!offer) throw new Error('no offer')
    // Hand back the host's own offer code.
    await expect(host.submitAnswer(encodeSignal(offer))).rejects.toMatchObject({
      code: 'WRONG_KIND',
    })
  })

  it('rejects an expired invite as INVITE_EXPIRED', async () => {
    const { host, signaler } = await newHost({ inviteTtlMs: 5 })
    await host.invite()
    const offer = signaler.published.at(-1)
    if (!offer) throw new Error('no offer')
    await new Promise((r) => setTimeout(r, 20))
    await expect(host.submitAnswer(answerFor(offer, 'guest-1'))).rejects.toMatchObject({
      code: 'INVITE_EXPIRED',
    })
  })

  it('rejects unreadable input as BAD_CODE', async () => {
    await rejects('not-a-real-code' as SessionCode, 'BAD_CODE')
  })
})

describe('relay routing', () => {
  it('delivers a directed message to its target only', async () => {
    const { host, signaler } = await newHost()
    const a = await addGuest(host, signaler, 'guest-a')
    const b = await addGuest(host, signaler, 'guest-b')
    a.pc.channel('ctl').sent.length = 0
    b.pc.channel('ctl').sent.length = 0

    a.pc
      .channel('ctl')
      .deliver(
        JSON.stringify(makeEnvelope('aaaa', b.peerId, 'chat', { text: 'to-b' })),
      )
    await tick()

    expect(b.pc.channel('ctl').received()).toHaveLength(1)
    expect(a.pc.channel('ctl').received()).toHaveLength(0)
  })

  it('excludes the sender from @all, so state is not echoed to its author', async () => {
    const { host, signaler } = await newHost()
    const a = await addGuest(host, signaler, 'guest-a')
    const b = await addGuest(host, signaler, 'guest-b')
    a.pc.channel('ctl').sent.length = 0
    b.pc.channel('ctl').sent.length = 0

    a.pc
      .channel('ctl')
      .deliver(JSON.stringify(makeEnvelope('aaaa', ALL_ADDRESS, 'chat', { text: 'hi' })))
    await tick()

    expect(b.pc.channel('ctl').received()).toHaveLength(1)
    expect(a.pc.channel('ctl').received()).toHaveLength(0)
  })

  it('reports an undeliverable message rather than dropping it silently', async () => {
    const { host, signaler } = await newHost()
    const a = await addGuest(host, signaler, 'guest-a')
    a.pc.channel('ctl').sent.length = 0

    // A peer that is not in the roster. Silently dropping would leave a game
    // waiting forever on a player who is not there.
    a.pc
      .channel('ctl')
      .deliver(JSON.stringify(makeEnvelope('aaaa', 'zzzz', 'chat', { text: 'hi' })))
    await tick()

    const reply = a.pc.channel('ctl').received().find(
      (m) => (m as { t: string }).t === 'undeliverable',
    ) as { p: { reason: string } } | undefined
    expect(reply?.p.reason).toBe('unknown-peer')
  })

  it('rewrites `from` so a guest cannot impersonate another', async () => {
    const { host, signaler } = await newHost()
    const a = await addGuest(host, signaler, 'guest-a')
    const b = await addGuest(host, signaler, 'guest-b')

    const seen: string[] = []
    host.on('message', ({ env }) => seen.push(env.from))

    // `a` claims to be `b`. Without sanitization this would let one guest put
    // words in another's mouth, or forge a timestamp into game state.
    a.pc
      .channel('ctl')
      .deliver(
        JSON.stringify(makeEnvelope(b.peerId, HOST_ADDRESS, 'score', { points: 999 })),
      )
    await tick()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(a.peerId)
    expect(seen[0]).not.toBe(b.peerId)
  })
})

describe('session lifecycle', () => {
  it('refuses an invite before start()', async () => {
    const signaler = createRecordingSignaler()
    const host = createHostSession({ signaler, iceServers: [] })
    await expect(host.invite()).rejects.toThrow(/start\(\)/)
  })

  it('refuses a new invite once the session is full', async () => {
    const { host, signaler } = await newHost({ maxPeers: 1 })
    await addGuest(host, signaler, 'guest-a')
    // The cap counts *joined* peers, so a pending invite is still allowed --
    // only a joined peer closes the door.
    await expect(host.invite()).rejects.toMatchObject({ code: 'SESSION_FULL' })
  })

  it('clears its roster on close', async () => {
    const { host, signaler } = await newHost()
    await addGuest(host, signaler, 'guest-a')
    expect(host.peerCount).toBe(1)
    host.close()
    expect(host.peerCount).toBe(0)
    expect(host.state).toBe('closed')
  })
})

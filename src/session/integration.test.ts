/**
 * End-to-end: a real HostSession talking to a real GuestSession over a linked
 * pair of fake peer connections.
 *
 * This is the readiness check for the game layer. Everything else in the suite
 * tests one side in isolation with the other hand-driven; here both ends run
 * their actual code, so the handshake, the roster, the relay and the message
 * plumbing are all exercised together.
 *
 * It doubles as executable documentation: the game is a thin layer of this
 * shape, and the patterns below are the ones to copy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGuestSession, type GuestSession } from './guest.ts'
import { createHostSession, type HostSession } from './host.ts'
import { ALL_ADDRESS, HOST_ADDRESS, type Envelope } from './types.ts'
import {
  createRecordingSignaler,
  FakePeerConnection,
  installFakeRtc,
  linkPair,
  until,
} from './test-support/fakes.ts'

let restore: () => void
beforeEach(() => {
  restore = installFakeRtc()
})
afterEach(() => {
  restore()
})

interface Joined {
  host: HostSession
  guest: GuestSession
  hostSide: FakePeerConnection
  guestSide: FakePeerConnection
}

/** Runs the full QR handshake between a real host and a real guest. */
async function joinOneGuest(): Promise<Joined> {
  const hostSignaler = createRecordingSignaler()
  const host = createHostSession({ signaler: hostSignaler, iceServers: [] })
  await host.start()
  const invite = await host.invite()

  const guestSignaler = createRecordingSignaler()
  const guest = createGuestSession({ signaler: guestSignaler, iceServers: [] })

  // Fire-and-forget: the guest blocks waiting for the host to consume its
  // answer, which is what the QR ceremony does in reality.
  const joining = guest.join({ code: invite.code })

  await until(() => FakePeerConnection.instances.length >= 2, 'both peer connections')
  const hostSide = FakePeerConnection.instances[0]
  const guestSide = FakePeerConnection.instances[1]
  if (!hostSide || !guestSide) throw new Error('expected two peer connections')

  linkPair(hostSide, guestSide)
  hostSide.openChannels()
  guestSide.openChannels()
  hostSide.simulateConnected()
  guestSide.simulateConnected()

  // The guest publishes its answer code; the host scans it.
  await until(() => guestSignaler.codes.length > 0, 'the guest answer code')
  await host.submitAnswer(guestSignaler.codes[0]!)
  await joining

  return { host, guest, hostSide, guestSide }
}

describe('handshake over a linked pair', () => {
  it('joins, exchanges a roster, and reports both sides as ready', async () => {
    const { host, guest } = await joinOneGuest()

    expect(guest.phase).toBe('joined')
    expect(host.peerCount).toBe(1)
    expect(guest.roster.map((r) => r.peerId)).toEqual([guest.peerId])
    expect(guest.sessionId).toBe(host.sessionId)
  })

  it('assigns the guest an identity the host will route to', async () => {
    const { host, guest } = await joinOneGuest()
    expect(guest.peerId).toMatch(/^[a-z0-9]{4}$/)
    expect(host.roster.map((r) => r.peerId)).toContain(guest.peerId)
  })
})

describe('a round of the math game', () => {
  it('carries a problem out and an answer back', async () => {
    const { host, guest } = await joinOneGuest()

    // --- which is exactly the game loop, from here down ---

    // Host poses a question to everyone.
    const problem = { roundId: 'r1', a: 5, b: 7 }
    const sent = host.send(ALL_ADDRESS, 'problem', problem)
    expect(sent.ok).toBe(true)

    // The guest receives it, addressed from the host.
    const inbox: Envelope[] = []
    guest.on('message', ({ env }) => inbox.push(env))
    await until(() => inbox.length > 0, 'the problem to reach the guest')
    expect(inbox[0]?.t).toBe('problem')
    expect(inbox[0]?.from).toBe('host')
    expect(inbox[0]?.p).toEqual(problem)

    // The guest answers, addressed to the host.
    const answers: Array<{ peerId: string; value: number }> = []
    host.on('message', ({ peerId, env }) => {
      if (env.t === 'answer') answers.push({ peerId, value: (env.p as { value: number }).value })
    })
    guest.send(HOST_ADDRESS, 'answer', { roundId: 'r1', value: 35 })

    await until(() => answers.length > 0, 'the answer to reach the host')
    // `from` is the host's own sanitized attribution, not anything the guest
    // claimed -- so an answer can never be credited to the wrong player.
    expect(answers[0]).toEqual({ peerId: guest.peerId, value: 35 })
  })

  it('lets the host fan a guest answer out to the other guests', async () => {
    const { host, guest, hostSide } = await joinOneGuest()

    const inbox: Envelope[] = []
    guest.on('message', ({ env }) => inbox.push(env))

    // The host decides a result and tells everyone. This is the one broadcast
    // the game needs beyond posing the question.
    const result = { roundId: 'r1', peerId: guest.peerId, value: 35, correct: true, ms: 412 }
    host.broadcast('answered', result)

    await until(() => inbox.length > 0, 'the result to reach the guest')
    expect(inbox[0]?.t).toBe('answered')
    expect(inbox[0]?.p).toEqual(result)

    // And it really went over the wire rather than being read from local state.
    expect(hostSide.channel('ctl').sent.some((s) => s.includes('"answered"'))).toBe(true)
  })

  it('carries a message from one guest to another through the host', async () => {
    const { host, guest } = await joinOneGuest()
    // A second guest, so there is someone to relay to.
    const second = await joinSecondGuest(host)

    const seenByFirst: Envelope[] = []
    guest.on('message', ({ env }) => seenByFirst.push(env))

    // Guest two tells guest one directly. Guests hold no connection to each
    // other; the host is what makes this arrive.
    second.send(guest.peerId!, 'taunt', { text: 'too slow' })

    await until(() => seenByFirst.length > 0, 'the relayed message')
    expect(seenByFirst[0]?.t).toBe('taunt')
    expect(seenByFirst[0]?.p).toEqual({ text: 'too slow' })
    // Rewritten to the real sender, not whatever the second guest claimed.
    expect(seenByFirst[0]?.from).toBe(second.peerId)
  })
})

describe('a guest that says hello before anything is negotiated', () => {
  /**
   * The order a real QR ceremony runs in, and the one the fakes used to skip.
   *
   * On two phones the guest publishes its answer and says `hello` seconds before
   * the host has scanned that answer -- so nothing is connected, and `send`
   * drops rather than queues. Every other test here links the channels first,
   * which is why a fire-and-forget hello passed while real devices could not
   * complete a join at all.
   */
  it('gets in once the channels open, rather than timing out', async () => {
    const hostSignaler = createRecordingSignaler()
    const host = createHostSession({ signaler: hostSignaler, iceServers: [] })
    await host.start()
    const invite = await host.invite()

    const guestSignaler = createRecordingSignaler()
    const guest = createGuestSession({ signaler: guestSignaler, iceServers: [] })
    const joining = guest.join({ code: invite.code })

    // The guest has put its answer on screen. The host has not scanned it, so
    // the peer connections exist but nothing is open.
    await until(() => guestSignaler.codes.length > 0, 'the guest answer code')

    const hostSide = FakePeerConnection.instances[0]
    const guestSide = FakePeerConnection.instances[1]
    if (!hostSide || !guestSide) throw new Error('expected two peer connections')

    linkPair(hostSide, guestSide)
    hostSide.openChannels()
    guestSide.openChannels()
    hostSide.simulateConnected()
    guestSide.simulateConnected()

    await host.submitAnswer(guestSignaler.codes[0]!)
    await joining

    expect(guest.phase).toBe('joined')
    expect(host.peerCount).toBe(1)
    host.close('local')
  })
})

/** Adds another guest to a host that is already running. */
async function joinSecondGuest(host: HostSession): Promise<GuestSession> {
  // `FakePeerConnection.instances` accumulates for the whole test, so index
  // from the count recorded *before* this invite. Indexing from zero would grab
  // the first guest's connections and re-link those instead.
  const before = FakePeerConnection.instances.length
  const signaler = createRecordingSignaler()
  const guest = createGuestSession({ signaler, iceServers: [] })

  // Invite first: `host.invite()` creates the offerer connection and
  // `guest.join` the answerer, which is the order the indices below assume.
  const invite = await host.invite()
  const joining = guest.join({ code: invite.code })

  await until(() => FakePeerConnection.instances.length >= before + 2, 'the second pair')
  const hostSide = FakePeerConnection.instances[before]
  const guestSide = FakePeerConnection.instances[before + 1]
  if (!hostSide || !guestSide) throw new Error('expected two peer connections')

  linkPair(hostSide, guestSide)
  hostSide.openChannels()
  guestSide.openChannels()
  hostSide.simulateConnected()
  guestSide.simulateConnected()

  await until(() => signaler.codes.length > 0, 'the second answer code')
  await host.submitAnswer(signaler.codes[0]!)
  await joining
  return guest
}

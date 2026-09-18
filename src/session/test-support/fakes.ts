/**
 * Test doubles for the browser APIs the session layer sits on.
 *
 * The point of faking `RTCPeerConnection` rather than mocking `Peer` is that
 * these tests exercise the real `HostSession` and `GuestSession` logic --
 * the invite table, the routing rules, the sanitization -- which is where the
 * subtle bugs live. Only the browser is replaced.
 */
import type { SignalDescription } from '../codec.ts'
import { encodeSignal } from '../codec.ts'
import type { AwaitOptions, Signaler } from '../signaler.ts'
import type { SessionCode } from '../types.ts'

const hex = (n: number): string => {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function fingerprint(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

/** Shaped like a real Chrome data-channel SDP, including one TCP candidate. */
export function makeSdp(): string {
  return (
    [
      'v=0',
      'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'a=extmap-allow-mixed',
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      'a=candidate:1467250027 1 udp 2122260223 192.168.1.42 46243 typ host generation 0 network-id 1',
      'a=candidate:935214411 1 udp 1686052607 203.0.113.20 46343 typ srflx raddr 192.168.1.42 rport 46243 generation 0 network-id 1',
      'a=candidate:435653019 1 tcp 1518280447 192.168.1.42 9 typ host tcptype active generation 0 network-id 1',
      `a=ice-ufrag:${hex(2)}`,
      `a=ice-pwd:${hex(11)}`,
      'a=ice-options:trickle',
      `a=fingerprint:sha-256 ${fingerprint()}`,
      'a=setup:actpass',
      'a=mid:0',
      'a=sctp-port:5000',
      'a=max-message-size:262144',
    ].join('\r\n') + '\r\n'
  )
}

export class FakeDataChannel {
  readonly label: string
  readyState: RTCDataChannelState = 'connecting'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: string[] = []

  /**
   * The other end of this channel, when two peer connections are linked. Null
   * in the single-sided tests, where `sent` is inspected directly instead.
   */
  peer: FakeDataChannel | null = null

  constructor(label: string) {
    this.label = label
  }

  send(data: string): void {
    this.sent.push(data)
    const other = this.peer
    // Delivered on a microtask, as a real data channel would be: a synchronous
    // round trip would let a handler observe a state its own send had not yet
    // finished producing.
    if (other) queueMicrotask(() => other.deliver(data))
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }

  // -- test controls
  open(): void {
    this.readyState = 'open'
    this.onopen?.()
  }
  deliver(data: string): void {
    this.onmessage?.({ data })
  }
  /** Everything this channel sent, parsed. */
  received(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown)
  }
}

type Listener = (event: unknown) => void

export class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  static reset(): void {
    FakePeerConnection.instances = []
  }
  static get last(): FakePeerConnection {
    const pc = FakePeerConnection.instances.at(-1)
    if (!pc) throw new Error('no fake peer connection has been created')
    return pc
  }

  readonly config: RTCConfiguration
  readonly channels: FakeDataChannel[] = []
  localDescription: { type: string; sdp: string } | null = null
  remoteDescription: { type: string; sdp: string } | null = null
  iceGatheringState: RTCIceGatheringState = 'new'
  connectionState: RTCPeerConnectionState = 'new'
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null

  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(config: RTCConfiguration) {
    this.config = config
    FakePeerConnection.instances.push(this)
  }

  /** Fired for each channel the offerer creates; used by `linkPair`. */
  onChannelCreated: ((channel: FakeDataChannel) => void) | null = null

  createDataChannel(label: string): FakeDataChannel {
    const channel = new FakeDataChannel(label)
    this.channels.push(channel)
    this.onChannelCreated?.(channel)
    return channel
  }

  async createOffer(): Promise<{ type: 'offer'; sdp: string }> {
    return { type: 'offer', sdp: makeSdp() }
  }
  async createAnswer(): Promise<{ type: 'answer'; sdp: string }> {
    return { type: 'answer', sdp: makeSdp() }
  }

  async setLocalDescription(desc: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = { type: desc.type, sdp: desc.sdp ?? makeSdp() }
    this.iceGatheringState = 'gathering'
    // Complete on a macrotask so callers observe 'gathering' first and the
    // event path is genuinely exercised rather than short-circuited.
    setTimeout(() => {
      this.iceGatheringState = 'complete'
      this.emit('icegatheringstatechange')
    }, 0)
  }

  async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = desc
  }

  addEventListener(type: string, fn: Listener): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(fn)
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn)
  }
  dispatchEvent(event: { type: string }): void {
    this.emit(event.type)
  }
  private emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type })
  }

  close(): void {
    this.connectionState = 'closed'
  }

  // -- test controls
  // Both the property handler and addEventListener listeners fire, as they do
  // in a real browser: `onX` is just a handler registered on the same target.
  private fire(type: string, handler: (() => void) | null): void {
    handler?.()
    this.emit(type)
  }
  simulateConnected(): void {
    this.connectionState = 'connected'
    this.fire('connectionstatechange', this.onconnectionstatechange)
  }
  simulateFailed(): void {
    this.connectionState = 'failed'
    this.fire('connectionstatechange', this.onconnectionstatechange)
  }
  channel(label: string): FakeDataChannel {
    const c = this.channels.find((x) => x.label === label)
    if (!c) throw new Error(`no channel labelled ${label}`)
    return c
  }
  openChannels(): void {
    for (const c of this.channels) c.open()
  }
}

/**
 * Wires two fake peer connections together so they behave like two ends of one
 * real connection: channels the offerer creates appear on the answerer via
 * `ondatachannel`, and a send on either side arrives at the other.
 *
 * This is what makes a true end-to-end test possible -- a real `HostSession`
 * talking to a real `GuestSession`, rather than one side hand-driven.
 */
export function linkPair(offerer: FakePeerConnection, answerer: FakePeerConnection): void {
  const mirror = (channel: FakeDataChannel): void => {
    const other = new FakeDataChannel(channel.label)
    answerer.channels.push(other)
    channel.peer = other
    other.peer = channel
    answerer.ondatachannel?.({ channel: other })
  }
  // Channels the offerer already created, then any it creates later.
  for (const channel of offerer.channels) mirror(channel)
  offerer.onChannelCreated = mirror
}

/** Polls until `predicate` holds. Keeps tests off brittle tick-counting. */
export async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 0))
  }
}

/** Installs the fake globally. Returns a restore function. */
export function installFakeRtc(): () => void {
  const original = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection
  ;(globalThis as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection
  FakePeerConnection.reset()
  return () => {
    ;(globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = original
    FakePeerConnection.reset()
  }
}

/** Records what was published instead of showing a QR. */
export interface RecordingSignaler extends Signaler {
  readonly published: SignalDescription[]
  /** Parallel to `published`, for the tests that need the encoded form. */
  readonly codes: SessionCode[]
  readonly awaited: AwaitOptions[]
}

export function createRecordingSignaler(): RecordingSignaler {
  const published: SignalDescription[] = []
  const codes: SessionCode[] = []
  const awaited: AwaitOptions[] = []
  return {
    kind: 'broadcast-channel',
    published,
    codes,
    awaited,
    async publish(desc) {
      published.push(desc)
      const code = encodeSignal(desc)
      codes.push(code)
      return { code, expiresAt: Date.now() + 120_000 }
    },
    async awaitPeer(opts) {
      awaited.push(opts)
      throw new Error('awaitPeer is not exercised in these tests')
    },
    inject() {},
    dispose() {},
  }
}

/** Resolves after the microtask queue and pending timers have drained. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

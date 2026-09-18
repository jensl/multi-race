# The session library

Everything needed to get N phones into a shared, live, data-only WebRTC session with **no
backend**. The handshake travels over QR codes instead of a signaling server.

You should not need to read the implementation to use it. Read this, then
`integration.test.ts`, which is a worked example of the exact game loop.

```ts
import { createHostSession } from './session/host.ts'
import { createGuestSession } from './session/guest.ts'
import { createCodeSignaler } from './session/signaler.ts'
```

## The mental model

One device is the **host**. Everyone else is a **guest**. Guests hold exactly one
connection — to the host — and the host relays. Guests never talk to each other directly.

```
        guest
          │
 guest ── HOST ── guest
          │
        guest
```

The host is authoritative about two things: **who is in the session**, and **message
attribution** (it rewrites `from` on everything it relays, so a message can never be
credited to the wrong player).

Beyond that the host is just another player. Game rules live in your layer, not here.

## Two things you must provide

The library deliberately doesn't do UI. Before you can connect anyone you need:

1. **A `CodeChannel`** — shows a QR code and reads one back with the camera. The library
   hands you a string; you render it and scan it.
2. **ICE servers** — `[{ urls: 'stun:stun.l.google.com:19302' }]` is fine. See
   "Networking reality" below.

```ts
interface CodeChannel {
  showCode(code: SessionCode, meta: { kind: 'offer' | 'answer'; expiresAt: number }): void
  hideCode(): void
  readCode(opts: { expect: 'offer' | 'answer'; timeoutMs: number; signal?: AbortSignal })
    : Promise<SessionCode>
  dispose?(): void
}

const signaler = createCodeSignaler(myCodeChannel)
```

For developing in two browser tabs with no camera, swap it:

```ts
import { createBroadcastChannelSignaler } from './session/signaler.ts'
const signaler = createBroadcastChannelSignaler('my-app-dev')
```

Same interface, real `RTCPeerConnection`s over loopback. Only the carrier differs.

## Hosting

```ts
const host = createHostSession({
  signaler,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  maxPeers: 8,
})

host.on('peer-joined', ({ peerId, entry, roster }) => {
  console.log(`${entry.name ?? peerId} joined; now ${roster.length}`)
})
host.on('peer-left', ({ peerId, reason }) => { /* update your UI */ })
host.on('message', ({ peerId, env }) => {
  // env.t is your message type, env.p is your payload, peerId is who really sent it
})

await host.start()

// Show a QR; the guest scans it, then shows one back which you scan.
const { code } = await host.invite()
const { peerId } = await host.submitAnswer(scannedCode)

// Talk to everyone, or to one person.
host.broadcast('round-started', { roundId: 'r1' })
host.send(peerId, 'you-are-out', {})
```

Repeat `invite()` → `submitAnswer()` once per guest. Each call produces a **fresh** code,
because each guest gets its own connection.

`invite()` resolves as soon as the code is on screen. `submitAnswer()` resolves once that
guest has actually joined and has a `peerId`.

## Joining

```ts
const guest = createGuestSession({ signaler, iceServers, name: 'Sam' })

guest.on('answer-ready', ({ code }) => { /* show this QR for the host to scan */ })
guest.on('message', ({ from, env }) => { /* ... */ })

// Resolves only once the host has accepted you (see "Joined means welcome" below).
// Omit `code` to have the signaler read one from the camera.
await guest.join({ code: scannedOffer })

guest.send('@host', 'answer', { roundId: 'r1', value: 35 })
guest.send('@all', 'taunt', { text: 'too slow' })   // relayed via the host
guest.send(somePeerId, 'dm', {})                     // also relayed

guest.rttMs()      // -1 until the first sample lands
guest.hostTime()   // host's wall clock, or null before the first sample
```

## Messages

Everything is an envelope. You supply `t` (your type) and `p` (your payload) and never
think about the rest.

```ts
interface Envelope<T> {
  v: 1
  id: string
  t: string          // YOUR type name; a few names are reserved (see below)
  from: PeerId       // rewritten by the host on relay — trustworthy
  to: Address
  ts: number         // host clock
  seq: number        // host-assigned, monotonic
  p?: T              // your payload; anything JSON-serializable
}
```

### Addressing

| `to` | Meaning |
|---|---|
| `'@host'` | the host, and only the host |
| `'@all'` | everyone **except the sender** |
| a `PeerId` | one specific peer, relayed through the host |

`'@all'` excluding the sender is deliberate: echoing a message back to its author forces
every client to implement idempotence. If you want the sender to see its own broadcast,
apply it locally when you send.

**Reserved `t` values** — do not use these for game messages: `hello`, `welcome`, `roster`,
`ping`, `pong`, `bye`, `undeliverable`. `RESERVED_TYPES` in `types.ts` is the live list.

### `send()` never throws

It returns a result, because throwing inside a game loop is how a frame gets lost:

```ts
type SendResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not-connected' | 'backpressure' | 'too-large'
                      | 'unknown-peer' | 'rate-limited' }
```

`backpressure` means the link is congested. For state-like messages, **drop and move on** —
queueing stale state only puts you further behind. For anything that must arrive, retry
when the channel drains.

If a directed message can't be delivered, the host sends back an `undeliverable` message
rather than dropping it silently, so a game never waits forever on a player who left.

## Events

Both sessions return an unsubscribe function from `on`, and handlers that throw are
contained rather than being allowed to corrupt session state.

**Host** — `open`, `invite`, `invite-rejected`, `peer-joined`, `peer-left`, `peer-state`,
`message`, `undeliverable`, `error`.

**Guest** — `phase`, `answer-ready`, `welcome`, `roster`, `peer-joined`, `peer-left`,
`message`, `rtt`, `error`, `closed`.

See `host.ts` / `guest.ts` for the exact shapes; `HostEventMap` and `GuestEventMap` are
the authoritative lists.

## A round of the math game

The whole game is this shape. For a real version see `integration.test.ts`.

```ts
// --- host: pose a question ---
const problem = { roundId: 'r1', a: 5, b: 7 }
const answers: Array<{ peerId: string; value: number; at: number }> = []

host.on('message', ({ peerId, env }) => {
  if (env.t !== 'answer') return
  const { roundId, value } = env.p as { roundId: string; value: number }
  if (roundId !== problem.roundId) return          // ignore a late answer
  if (answers.some((a) => a.peerId === peerId)) return  // first answer only
  answers.push({ peerId, value, at: env.ts })      // env.ts is the host's own clock
  host.broadcast('answered', { roundId, peerId, value })
})

host.broadcast('problem', problem)

// --- guest: answer it ---
guest.on('message', ({ env }) => {
  if (env.t !== 'problem') return
  const { roundId, a, b } = env.p as { roundId: string; a: number; b: number }
  // ...the player types 35...
  guest.send('@host', 'answer', { roundId, value: 35 })
})
```

**Judge speed by `env.ts` on the host, not by a timestamp from the guest.** The host stamps
arrival time with its own clock, so the ordering is authoritative and no clock
synchronisation is needed. `guest.hostTime()` exists if you'd rather display a countdown,
but don't use it for scoring.

## Rules worth not breaking

Each of these is load-bearing; the reasons are in the main README and in code comments.

- **Never call `createDataChannel` on a guest.** The host creates both channels; guests
  receive them. A second creator collides on SCTP stream ids.
- **Don't await ICE gathering before `setLocalDescription`.** It hangs forever. `peer.ts`
  enforces the correct order — don't reach around it.
- **Don't add timestamps to the wire format.** The host's own tables are authoritative;
  that's what removes cross-device clock comparison from the protocol entirely.
- **Don't trust `env.from` on anything a guest sent** — but do trust it on anything
  *relayed through* the host, which is what `host.on('message')` and `guest.on('message')`
  hand you.
- **Don't reserve new `t` values** without adding them to `RESERVED_TYPES`.

## Joined means welcome

A guest is joined when it receives `welcome`, never when the data channel opens. `onopen`
only proves bytes flow — the host may still reject (version mismatch, session full). So:

- `guest.join()` resolving means you are genuinely in. `guest.peerId` is set.
- `guest.phase === 'joined'` is the state to render the lobby on.

## Networking reality

- **Same Wi-Fi or it may not work.** QR replaces the *signaling server* but cannot replace
  a TURN relay, and TURN credentials don't fit in a QR. On a flat LAN, host candidates
  connect directly — measured: real IPs, host-to-host, no relay.
- **STUN is cheap insurance, not a requirement on a LAN.** Keep it configured.
- **Backgrounding drops a peer.** On Android and iOS the page is suspended and the WebRTC
  stack is torn down. Hold a screen wake lock while a session is live, and treat
  `visibilitychange` as a likely disconnect. There is no transparent reconnect — with no
  signaling channel, reconnecting *is* re-pairing with a fresh QR. `ClientId` is persisted
  per tab, so a guest that rejoins reattaches to its roster entry instead of appearing as
  a stranger.
- **The host leaving ends the session.** Host migration would need a new QR ceremony.
- **Send budget:** keep individual messages under 16 KiB (one `MAX_MESSAGE_BYTES`). Larger
  messages are rejected with `too-large` rather than chunked, because Chromium closes the
  channel on overflow instead of throwing.

## Testing against it

`src/session/test-support/fakes.ts` has a fake `RTCPeerConnection` plus `linkPair()`,
which wires two fake connections together so a real `HostSession` can talk to a real
`GuestSession` with no browser involved. That's how `integration.test.ts` runs the game
loop.

```ts
const { hostSide, guestSide } = ...
linkPair(hostSide, guestSide)
hostSide.openChannels()
guestSide.openChannels()
hostSide.simulateConnected()
guestSide.simulateConnected()
```

Use `until(predicate, label)` rather than counting ticks — the handshake is
promise-driven and tick counts are brittle.

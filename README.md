# MultiRace

A small mobile-first multiplayer **math game**. Players get an operation (`5 x 7`) and race
to answer it. Family game, so cheating isn't a concern.

Underneath it is a session layer that gets N phones into a shared, live, data-only WebRTC
session with **no backend** — the offer/answer handshake travels over QR codes instead of a
signaling server, so the app is a pile of static files and a session is self-contained.

> **Where to start:** [`src/session/README.md`](src/session/README.md) is the transport
> guide, with a worked game example;
> [`src/session/integration.test.ts`](src/session/integration.test.ts) is the same loop as
> running code. `CLAUDE.md` has the short version and the pitfalls.

## Running

```bash
npm install
npm run dev
```

Then open the printed **Network** URL on two phones on the same Wi-Fi:

```
https://192.168.x.x:5173/
```

To play the whole multiplayer flow on one machine with no camera, add `?dev=1` and open the
**join** tab first: the loopback channel cannot deliver to a listener that does not exist
yet.

Each phone shows a certificate warning on first visit — the dev cert is self-signed.
Tap **Advanced → Proceed**. This is required: `getUserMedia` (the QR scanner) needs a
secure context, and plain `http://192.168.x.x` is not one.

`scripts/dev-cert.ts` generates the certificate at dev-server start with the machine's
current LAN IPs as `IP Address:` SANs, and regenerates when your addresses change.
`openssl` must be on `PATH`; without it the server falls back to HTTP, which still works
on `localhost` but not from a phone.

## The game

One flow: mode → single/host/join → play → results. The only mode so far is times tables,
2 to 12 (`src/game/problem.ts`).

**Single player** is one 60-second clock and as many problems as you can clear, with the
best score per mode kept in `localStorage`.

**Multiplayer** is ten rounds. Each round counts down 1.5 s so every phone starts together,
opens a ten-second answer window, then holds the outcome on screen for 2.5 s. Everyone who
answers correctly scores — only the finishing order differs — at 3 / 2 / 1 / 1 points, so a
slower player is never shut out of a round and the fourth player still earns something.

Four players at most: the host plus three guests. That is enforced at the session layer,
where the host is not counted as one of the peers.

`src/game/` holds all of it — DOM-free, with the clock injected as a seam, which is what
lets a ten-round game run instantly and deterministically in a test. `src/ui/` is a thin
shell over it. Keep that split: game rules in `src/game/`, pixels in `src/ui/`.

Every knob — rounds, limits, the player cap, the answer grace — is flat and exported from
`src/game/config.ts`, because adjusting one is meant to be a one-line change.

## The QR payload

The wire format is binary because QR capacity is the binding constraint: scanning
reliability collapses above roughly v20, and a slow scan doesn't just annoy — it eats the
ICE handshake window, which is measured in seconds
([w3c/webrtc-pc#2945](https://github.com/w3c/webrtc-pc/issues/2945) documents this exact
architecture failing that way).

Measured on two Android 10 phones:

| | Payload | QR version | Scan time |
|---|---|---|---|
| Verbatim SDP → deflate → base64url | 542 B | **v19** | — |
| **Packed binary** (fingerprint + credentials + candidates; SDP rebuilt on arrival) | 181 B | **v10** | **0.9 s** |

The underlying SDP was 1151 B (879 B after stripping TCP candidates). The v10 is what the
codec buys, and the reason not to let the payload creep: the packed form carries the
fingerprint, credentials and candidates, and the receiver *rebuilds* the SDP rather than
decoding one. Chrome accepts the rebuilt SDP — the codec's core risk — and the handshake
completes off it.

Two properties of the network, both measured on-device and both still load-bearing:

- **mDNS is a non-issue.** The selected pair is real IPs, host-to-host, because having
  camera permission for the scan appears to exempt a device from Chrome's local-IP
  obfuscation.
- **STUN is gathered but not used.** It stays configured as cheap insurance; the LAN-only
  claim holds on a flat subnet, and the scan — not the network — is what would threaten the
  handshake.

## The session layer

```
src/session/
  types.ts      vocabulary: SessionId / ConnectionId / PeerId / ClientId, envelopes, errors
  sdp.ts        all SDP surgery, and only SDP surgery
  codec.ts      the binary wire format; SignalDescription ⇄ SessionCode
  protocol.ts   envelope rules, routing, rate limiting, clock sync — pure functions
  emitter.ts    typed event emitter, no dependencies
  peer.ts       one RTCPeerConnection, wrapped
  signaler.ts   how a signal travels: QR/paste, or BroadcastChannel for dev
  host.ts       star hub: invite table, relay, roster
  guest.ts      one link, always to the host
```

### Why host-star

Every WebRTC link needs its own physical QR ceremony. A full mesh at 8 players is 28
scans against the star's 7 — so star is close to mandatory here, not merely preferable.
It also gives one authority for game state and sidesteps WebKit's quadratic socket
allocation. The accepted cost is that the host leaving ends the session.

### Design decisions worth knowing before changing anything

- **Gathering is triggered by `setLocalDescription`, not by `createOffer`.** Awaiting
  `iceGatheringState === 'complete'` *before* calling it hangs forever. `peer.ts` enforces
  the order so callers cannot get it wrong.
- **`cid` is the routing key, and it is not optional.** An SDP answer is structurally
  valid against any offer with the same m-line shape, so a misrouted answer makes
  `setRemoteDescription` *succeed* and then fail at ICE half a minute later with nothing
  pointing at the cause. The invite table is the only source of truth.
- **No timestamps on the wire.** The host mints every invite and holds its own expiry
  table, so it never trusts or compares a clock that came off the wire. This removes the
  only cross-device clock dependency in the protocol. Deadlines travel as durations
  (`startsInMs`, `limitMs`) applied from local receipt instead.
- **Guests are untrusted.** `hello` is the only message accepted before `welcome`, and the
  host overwrites `from`, `ts` and `seq` on everything it relays.
- **`@all` excludes the sender.** Echoing state back to its author forces every client to
  implement idempotence. A distinct `@everyone` can be added later if chat needs it.
- **A guest is joined on `welcome`, never on the data channel opening.** `onopen` only
  proves bytes flow; the host may still reject.
- **No pre-generated offers.** A warm offer freezes a candidate snapshot at creation time,
  so if the host changes network before it's scanned, the QR carries dead candidates.
- **The `Signaler` interface is the seam.** QR is one implementation; `BroadcastChannel` is
  another, which makes the whole handshake exercisable in two tabs with no camera.

### Deliberately not built

Each of these is a seam left open, not an omission:

- **Binary game state.** Game messages travel as JSON inside the envelope; `codec.ts` is
  per-channel, so a binary format can be added without touching the session layer.
- **Auto-reconnect.** With no signaling channel, reconnecting *is* re-pairing with a fresh
  QR. `ClientId` is persisted per tab, so a guest that does rejoin reattaches to its roster
  entry rather than appearing as a stranger.
- **Message chunking.** Anything over `MAX_MESSAGE_BYTES` (16 KiB) is rejected with
  `too-large` rather than split, because Chromium closes the channel on overflow instead of
  throwing.
- **ICE restart.** Impossible without a return channel — an ICE failure is terminal for that
  guest and needs a fresh invite.

## Checks

```bash
npm run check      # typecheck + tests
npm test           # 132 tests, browser-free
```

The suite covers the codec round-trip and its rejection paths, the routing and
sanitization rules, and the host's invite lifecycle — specifically that a replayed,
expired, wrong-session or unknown `cid` produces a specific typed error rather than a hung
connection. `src/session/test-support/fakes.ts` fakes `RTCPeerConnection` so the real
`HostSession` logic is exercised, not a mock of it.

`integration.test.ts` goes further: `linkPair()` wires two fake connections together, so a
genuine `HostSession` talks to a genuine `GuestSession` and the whole handshake, roster and
relay path runs with no browser involved. It deliberately includes a case that links the two
sides *late*, because the obvious order — channels open before the guest finishes its async
work — is one a camera never produces. That ordering is why `submitAnswer` registers its
`hello` waiter when the peer is created, rather than when the call is made.

## Deploying

```bash
npm run deploy
```

Builds, syncs `dist/` to `s3://<S3_BUCKET>/multirace/`, invalidates `/multirace/*` on the
CloudFront distribution in front of it, and waits for that invalidation to finish — so
the command returning means the new build is being served, not merely that the upload
was accepted. `aws` must be on `PATH` and already authenticated (`aws login`).

The bucket and the distribution are personal infrastructure, so `scripts/deploy.ts`
reads them from `.env` rather than spelling them in a checked-in file. `.env.example`
documents both; copy it and fill in the values:

```bash
cp .env.example .env
```

`.env` is gitignored, and nothing in it is `VITE_`-prefixed, so none of it reaches the
browser bundle. A variable already set in the environment wins over the file, so a
one-off `S3_BUCKET=other npm run deploy` needs no edit. A missing value is a hard error
rather than a default, because deploying to the wrong bucket is worse than not
deploying.

The deployed app is served from a subpath, so production builds set `base: '/multirace/'`
in `vite.config.ts` — without it Vite emits `/assets/...`, which resolves against the
domain root rather than the prefix and 404s. Dev still serves from `/`, so the LAN URL
above is unchanged, and `vite preview` matches the build rather than the dev server.

`scripts/deploy.ts` spells the prefix once and derives the S3 destination, the
invalidation path and the printed URLs from it. Its AWS calls are `execFileSync` rather
than a shell one-liner in `package.json` because the invalidation path contains a `*`,
which needs different quoting in cmd.exe (npm's script shell on Windows) than in bash.

Two behaviours worth knowing:

- **`--delete` is on.** Vite hashes asset filenames, so every build orphans the previous
  bundles; without it they accumulate under the prefix forever. The prefix holds nothing
  but this app, so nothing else is at risk.
- **Directory URLs are served by marker objects.** The distribution has no default root
  object, and its S3 origin is the REST endpoint, which does not resolve directory
  indexes — so `/multirace/` would 403 instead of serving `index.html`. The script
  `put-object`s a key ending in `/` (`multirace/`) holding `index.html`, which is what S3
  returns for exactly that request. It is written *after* the sync because `--delete`
  removes it: it has no counterpart in `dist/`.

## Known constraints

- **Same Wi-Fi only.** QR replaces the signaling server but cannot replace a TURN relay —
  symmetric NAT and CGNAT (most cellular) need one, and its credentials don't fit in a QR.
- **Android Chrome is the target.** `BarcodeDetector` is absent from every iOS browser
  (all WebKit), so an iOS pass would need a ~950KB WASM decoder.
- **The host leaving ends the session.** Host migration would need a new QR ceremony.
- **Backgrounding drops a peer.** Android suspends a hidden page, and a suspended page
  loses its WebRTC stack — so a phone that dims mid-game doesn't pause, it drops out of the
  game. `src/ui/wake-lock.ts` holds a screen lock for the whole session, and a refused lock
  is a warning rather than a failure. There is no transparent reconnect: reconnecting means
  a fresh QR ceremony.

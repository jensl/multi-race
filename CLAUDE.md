# MultiRace

A small mobile-first multiplayer **math game**. Players get an operation (`5 x 7`) and race
to answer it. Family game, so cheating is not a concern.

The WebRTC session layer is **built and device-validated**. The game is **built**: a
single-player mode and a round-based multiplayer game, on one flow of
mode → single/host/join → play → results.

The QR ceremony half of multiplayer has since been run on two phones: the multiplayer flow
is confirmed working on the hardware.

## Where things are

| | |
|---|---|
| `src/session/README.md` | **Start here** for the transport. API guide + worked game example. |
| `src/session/` | The library. Types, codec, peer wrapper, host/guest sessions. |
| `src/session/integration.test.ts` | A real host and guest playing the game loop — executable documentation. |
| `src/game/` | The game itself, DOM-free: problems, scoring, the round loop, the wire protocol. |
| `src/game/multiplayer.test.ts` | Two real guests over the real session layer, playing a whole game. |
| `src/ui/` | The screens. Vanilla TS, no framework. |
| `scripts/dev-cert.ts` | Generates the LAN dev certificate. |
| `scripts/deploy.ts` | Builds and syncs to S3 + invalidates CloudFront. |
| `.env.example` | The deploy target (bucket + distribution id). Copy to `.env` to deploy. |

`src/game/` has no DOM and takes its clock as an injected seam, which is what makes a
ten-round game run instantly and deterministically in a test. `src/ui/` is a thin shell over
it. Keep that split: game rules in `src/game/`, pixels in `src/ui/`.

## Commands

```bash
npm run dev      # HTTPS dev server on the LAN, for phones
npm run check    # typecheck + 132 tests. Run this before saying anything is done.
npm run deploy   # build -> S3 + CloudFront (target from .env; see .env.example)
```

`npm run dev` then `https://<lan-ip>:5173/?dev=1` plays a whole multiplayer game in two
tabs on one machine, with no camera and no scanning. **Open the join tab first**: the
loopback channel cannot deliver to a listener that does not exist yet.

Dev serves over HTTPS with a self-signed cert covering the machine's LAN IPs. Phones show
a one-time certificate warning (Advanced → Proceed). That warning is **not** avoidable and
is **not** optional — `getUserMedia` (the QR scanner) needs a secure context, and
`http://192.168.x.x` is not one.

## Architecture in one paragraph

One host, N guests, star topology. Guests hold exactly one WebRTC connection — to the host
— and the host relays. The handshake travels over QR codes instead of a signaling server,
so there is no backend and the app is static files. The host is authoritative about who is
in the session and about message attribution (it rewrites `from` on relay).

## Things that will bite you

These are all consequences of real failures, not preferences. The reasoning is in
`src/session/README.md` and the main `README.md`.

- **Never call `createDataChannel` on a guest.** The host creates both channels; guests
  receive them. A second creator collides on SCTP stream ids.
- **Never await ICE gathering before `setLocalDescription`.** Gathering is triggered *by*
  `setLocalDescription`; waiting first hangs forever. `peer.ts` enforces the order.
- **Never put timestamps in the wire format.** The host's own tables are authoritative.
  That is what removes cross-device clock comparison from the protocol entirely.
- **Never munge SDP credentials.** Chrome M137+ rejects `setLocalDescription` carrying an
  altered `ice-ufrag`/`ice-pwd`. Candidates are the only thing safe to remove.
- **Never let the payload size creep up.** The packed codec produces a QR v10 that scans in
  under a second. Verbatim SDP is v19, which is slow enough to threaten the ICE window —
  that measurement is why the codec exists.
- **`@all` excludes the sender.** Deliberate; see the session README.
- **Do not trust a guest's `from`.** The host rewrites it. `host.on('message')` is safe.
- **Never `send()` before the channel is open.** `send()` drops with
  `{ok:false, reason:'not-connected'}` rather than queueing, so anything sent early is
  gone silently. The guest's `hello` used to be sent the moment its answer code was
  published — which is seconds before the host scans it — and every real two-phone
  handshake died on a 5s `HELLO_TIMEOUT` because of it. It now waits for the peer's
  `ready` event. **The fakes hid this**: every test linked and opened the channels
  before the guest finished its async work, an order that never happens with a camera
  in the loop. `integration.test.ts` now has a case that links late, on purpose.

## Platform notes

- **Android Chrome is the target.** `BarcodeDetector` is absent from every iOS browser (all
  WebKit), so iOS would need a ~950KB WASM decoder. Don't add iOS-only complexity for free.
- **Same Wi-Fi only.** QR replaces the signaling server but not a TURN relay, and TURN
  credentials don't fit in a QR.
- **Backgrounding drops a peer.** The WebRTC stack is torn down when the page is suspended.
  Hold a screen wake lock while a session is live. There is no transparent reconnect —
  reconnecting means a fresh QR ceremony.

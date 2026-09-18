/**
 * The host's waiting room: seat players, then start.
 *
 * The handshake itself belongs to the session layer, which drives it through the
 * `CodeChannel` the ceremony implements. What lives here is the sequence around
 * it, and the sequence is the part the Phase 0 spike got wrong: it cleared its
 * buttons on any failure and left a red banner and no way forward but a reload.
 * Every failure below has a way back.
 *
 * Two rules keep it from tangling:
 *
 *   - **One invite at a time.** `invite()` has no re-entrancy guard and never
 *     consults its own pending list, so a double tap would build two peer
 *     connections and show two codes with no way to tell which is which.
 *     Everything goes through `inviting`.
 *   - **A rejected code does not cost an invite.** `submitAnswer` only consumes
 *     the invite once the code passes its own checks, so a scan of the wrong
 *     thing is retried against the same invite rather than a new one. Re-inviting
 *     on every bad scan would churn through connections.
 */
import { decodeSignal, encodeSignal, type SignalDescription } from '../../session/codec.ts'
import { createHostSession, type HostSession } from '../../session/host.ts'
import {
  createBroadcastChannelSignaler,
  createCodeSignaler,
  type Signaler,
} from '../../session/signaler.ts'
import type { RosterEntry, SessionCode } from '../../session/types.ts'
import { GAME } from '../../game/config.ts'
import type { GameMode } from '../../game/problem.ts'
import { createHostGame } from '../../game/host-game.ts'
import { actions, button, el, hint, panel, setText } from '../dom.ts'
import { describeError, errorBanner, frame, makeScreen, ICE_SERVERS, type AppContext } from '../screen.ts'
import type { Screen } from '../router.ts'
import { createCeremony, type CeremonyChannel } from '../ceremony.ts'
import { holdWakeLock } from '../wake-lock.ts'
import { createPlaySelect } from './play-select.ts'
import { createGameScreen } from './game-screen.ts'

/** Long enough for a person to notice, aim and decode. */
const REPLY_SCAN_MS = 90_000

export function createHostLobby(ctx: AppContext, mode: GameMode): Screen {
  const ceremony: CeremonyChannel = createCeremony()
  const signaler: Signaler = ctx.dev
    ? createBroadcastChannelSignaler(`multirace:${mode.id}`)
    : createCodeSignaler(ceremony)

  const host: HostSession = createHostSession({
    signaler,
    iceServers: ctx.iceServers ?? ICE_SERVERS,
    name: 'Host',
    maxPeers: GAME.maxPlayers - 1,
  })

  const banner = errorBanner()
  const playerList = el('ul', 'scores')
  const startButton = button('Start game', () => startGame(), { disabled: true })
  const addButton = button('Show a join code', () => void inviteNext(), {
    variant: 'secondary',
  })
  const scanButton = button('Scan their reply', () => void scanReply())
  scanButton.hidden = true
  const cancelButton = button('Cancel', () => cancelInvite(), { variant: 'ghost' })
  cancelButton.hidden = true

  const addPanel = panel(
    'Add a player',
    ceremony.el,
    // Without a scanner the host can still show a code, but cannot read the
    // reply back -- which is the half of the ceremony that finishes the join.
    ceremony.canScan
      ? null
      : el(
          'p',
          'banner bad',
          'This browser cannot scan codes. Show yours, but you will need a phone that can scan to let anyone in.',
        ),
    actions(addButton, scanButton, cancelButton),
    ctx.dev
      ? hint('Dev mode: open a second tab and choose “Join a game”.')
      : hint('They scan your code, then you scan the code they show back.'),
  )

  const roomPanel = panel('Players', playerList)

  const stopWakeLock = holdWakeLock()
  let stopped = false
  let handedOff = false
  let inviting = false
  let currentInvite: { cid: string; offer: SignalDescription } | null = null
  /** Set while the camera is open, so a teardown can abort the scan. */
  let scanController: AbortController | null = null
  const offs: Array<() => void> = []

  // ---------------------------------------------------------------- rendering

  function renderPlayers(): void {
    const entries: Array<{ name: string; isHost: boolean }> = [
      { name: 'Host (you)', isHost: true },
      ...host.roster.map((entry: RosterEntry) => ({
        name: entry.name ?? 'Player',
        isHost: false,
      })),
    ]
    playerList.replaceChildren(
      ...entries.map((entry) =>
        el(
          'li',
          `score${entry.isHost ? ' self' : ''}`,
          el('span', 'score-name', entry.name),
          el('span', 'score-points', entry.isHost ? '👑' : '✓'),
        ),
      ),
    )
    startButton.disabled = host.peerCount < 1
    setText(
      startButton,
      host.peerCount < 1
        ? 'Start game'
        : `Start game (${host.peerCount + 1} players)`,
    )
  }

  function showInviting(on: boolean): void {
    addButton.hidden = on
    scanButton.hidden = !on || ctx.dev
    cancelButton.hidden = !on
  }

  // ------------------------------------------------------------------ inviting

  async function inviteNext(): Promise<void> {
    if (inviting || stopped || handedOff) return
    if (host.peerCount >= GAME.maxPlayers - 1) {
      ceremony.status('The table is full.')
      showInviting(false)
      return
    }
    inviting = true
    banner.clear()
    showInviting(true)
    ceremony.status('Starting…')
    try {
      const invite = await host.invite()
      currentInvite = { cid: invite.cid, offer: decodeSignal(invite.code) }
      ceremony.status('Show this to one player')
      if (ctx.dev) {
        scanButton.hidden = true
        void waitForDevReply()
      }
    } catch (err) {
      inviting = false
      showInviting(false)
      banner.show(describeError(err))
    }
  }

  /**
   * Two tabs on one machine: the loopback signaler carries the answer directly,
   * so there is no code to scan. `awaitPeer` hands back the description, and
   * encoding it again is what `submitAnswer` expects.
   *
   * The offer is re-broadcast until an answer comes back, because
   * `BroadcastChannel` delivers only to listeners that already exist -- the
   * other tab cannot be reached before it opens the join screen, and a host who
   * was ready first would otherwise wait forever on an offer nobody heard.
   */
  async function waitForDevReply(): Promise<void> {
    const invite = currentInvite
    if (!invite) return
    for (;;) {
      try {
        const desc = await signaler.awaitPeer({ expect: 'answer', timeoutMs: 4000 })
        const { peerId } = await host.submitAnswer(encodeSignal(desc))
        onSeated(peerId)
        return
      } catch (err) {
        if (stopped || handedOff || !inviting) return
        // Only an actual wait that ran out means nobody was listening. Testing
        // `instanceof Error` here would classify every one of the session
        // layer's plain-object failures as a retryable timeout, and a real
        // rejection would be re-broadcast at forever instead of being reported.
        if (!/timed out/i.test(describeError(err))) {
          inviting = false
          showInviting(false)
          banner.show(describeError(err))
          return
        }
        try {
          await signaler.publish(invite.offer)
        } catch {
          return
        }
      }
    }
  }

  async function scanReply(): Promise<void> {
    if (!currentInvite || stopped) return
    banner.clear()
    scanButton.hidden = true
    cancelButton.hidden = true

    const controller = new AbortController()
    scanController = controller
    let code: SessionCode
    try {
      code = await ceremony.readCode({ expect: 'answer', timeoutMs: REPLY_SCAN_MS, signal: controller.signal })
    } catch (err) {
      scanController = null
      // A cancelled or timed-out scan leaves the invite untouched, so the same
      // one can be offered again rather than burning a fresh peer connection.
      ceremony.status('No reply was scanned.')
      showInviting(true)
      ceremony.status('Show this to one player')
      if (!isCancellation(err)) banner.show(describeError(err))
      return
    }
    scanController = null

    // Their code belongs to a specific invite. Scanning an old one would be
    // accepted by the host's own checks and then sit waiting for a hello that
    // never comes -- failing five seconds later with nothing to show for it.
    let cid: string
    try {
      cid = decodeSignal(code).cid
    } catch {
      ceremony.status('That was not a usable code. Try again.')
      showInviting(true)
      return
    }
    if (cid !== currentInvite.cid) {
      banner.show('That reply is for an earlier code. Show a new one.')
      cancelInvite()
      return
    }

    ceremony.status('Letting them in…')
    try {
      const { peerId } = await host.submitAnswer(code)
      onSeated(peerId)
    } catch (err) {
      inviting = false
      showInviting(false)
      ceremony.status('')
      banner.show(describeError(err))
      renderPlayers()
    }
  }

  /** A guest is in. Get ready for the next one, unless the table is full. */
  function onSeated(peerId: string): void {
    inviting = false
    currentInvite = null
    renderPlayers()
    ceremony.status(`${host.roster.find((e) => e.peerId === peerId)?.name ?? 'Player'} is in.`)
    if (host.peerCount < GAME.maxPlayers - 1) void inviteNext()
    else showInviting(false)
  }

  function cancelInvite(): void {
    scanController?.abort()
    scanController = null
    inviting = false
    currentInvite = null
    ceremony.hideCode()
    ceremony.status('')
    showInviting(false)
  }

  // ------------------------------------------------------------------- start

  function startGame(): void {
    if (host.peerCount < 1 || handedOff) return
    handedOff = true
    cancelInvite()
    const game = createHostGame({ session: host, mode, hostName: 'Host' })
    // Replaced rather than pushed: there is no going back into a lobby whose
    // players are already in a game.
    //
    // The screen goes up *before* `start()`: starting emits the opening round
    // immediately, and a screen built afterwards would miss the very event that
    // carries the first problem -- leaving the host looking at an empty question
    // while everyone else answers it.
    ctx.router.replace(createGameScreen(ctx, { game, mode, onExit: () => stopHost() }))
    game.start()
  }

  function stopHost(): void {
    if (stopped) return
    stopped = true
    scanController?.abort()
    host.close('local')
  }

  offs.push(host.on('peer-joined', () => renderPlayers()))
  offs.push(
    host.on('peer-left', () => {
      renderPlayers()
      banner.show('A player lost connection.')
    }),
  )
  offs.push(
    host.on('error', ({ error }) => {
      banner.show(error.message)
      showInviting(false)
    }),
  )

  void (async () => {
    try {
      await host.start()
      renderPlayers()
      // Straight into a code. The host opened this screen for one reason, and
      // an empty rectangle with a button under it is a worse first sight than
      // the thing they came here to show.
      void inviteNext()
    } catch (err) {
      banner.show(describeError(err))
    }
  })()

  const screen = frame(
    `${mode.name} — Host`,
    'Add players, then start.',
    banner.el,
    roomPanel,
    addPanel,
    el('div', 'spacer'),
    actions(startButton),
  )

  return makeScreen({
    screen,
    backTo: () => {
      // Leaving the lobby closes the session: guests waiting on a host that
      // walked away would otherwise sit until their liveness timeouts fired.
      stopHost()
      return createPlaySelect(ctx, mode)
    },
    onUnmount: () => {
      for (const off of offs) off()
      ceremony.dispose()
      signaler.dispose()
      stopWakeLock()
      // Only tear the session down if the game did not just take it over.
      if (!handedOff) stopHost()
    },
    onPageHide: () => stopHost(),
  })
}

function isCancellation(err: unknown): boolean {
  return /stopped|cancel/i.test(describeError(err))
}

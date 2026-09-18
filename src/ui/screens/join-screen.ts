/**
 * Joining someone else's game: a name, one scan, then wait.
 *
 * A guest uses the camera **once**. It reads the host's offer, and what comes
 * back is its own answer code, which the host scans off this screen -- there is
 * no second scan to make, and a version of this screen that asked for one would
 * deadlock both phones waiting on each other.
 *
 * A fresh session, signaler and ceremony are built for **every attempt**, and
 * the previous ones torn down first. Three reasons, all of them real:
 * `signaler.dispose()` disposes the channel it was given, so a ceremony shared
 * across attempts is dead after the first failure; a `join()` that fails after
 * building its peer leaves that peer open; and the `CodeChannel` contract has no
 * way to hand a half-used one to a new attempt.
 */
import { createGuestSession, type GuestSession } from '../../session/guest.ts'
import { createBroadcastChannelSignaler, createCodeSignaler, type Signaler } from '../../session/signaler.ts'
import type { GuestPhase } from '../../session/guest.ts'
import type { ClientId } from '../../session/types.ts'
import type { GameMode } from '../../game/problem.ts'
import { createGuestGame } from '../../game/guest-game.ts'
import { actions, button, clear, el, hint, panel, setText } from '../dom.ts'
import { describeError, errorBanner, frame, makeScreen, ICE_SERVERS, type AppContext } from '../screen.ts'
import type { Screen } from '../router.ts'
import { createCeremony, type CeremonyChannel } from '../ceremony.ts'
import { canScan } from '../qr-scanner.ts'
import { holdWakeLock } from '../wake-lock.ts'
import { createPlaySelect } from './play-select.ts'
import { createGameScreen } from './game-screen.ts'

/**
 * The default 8s welcome timeout starts when the guest sends `hello`, which is
 * *before* the host has even seen the answer code -- so it has to cover a person
 * noticing, aiming and decoding. It does not.
 */
const WELCOME_TIMEOUT_MS = 45_000

export function createJoinScreen(ctx: AppContext, mode: GameMode): Screen {
  const banner = errorBanner()
  const statusLine = el('p', 'status', 'Ready when you are.')
  const ceremonySlot = el('div', 'ceremony-slot')

  const nameInput = el('input', 'name-input') as HTMLInputElement
  nameInput.type = 'text'
  nameInput.placeholder = 'Your name'
  nameInput.value = 'Player'
  nameInput.maxLength = 14
  nameInput.autocomplete = 'given-name'
  // Selecting on focus means the placeholder-ish default is replaced by typing
  // rather than appended to, which is what everyone expects of a pre-filled name.
  nameInput.addEventListener('focus', () => nameInput.select())

  const scanButton = button("Scan the host's code", () => void attempt())
  const stopButton = button('Stop', () => abortAttempt(), { variant: 'ghost' })
  stopButton.hidden = true

  const panelEl = panel(
    'Join a game',
    el('label', 'field', el('span', 'field-label', 'Your name'), nameInput),
    ceremonySlot,
    statusLine,
    actions(scanButton, stopButton),
    hint('One player hosts. Everyone else scans the code they show.'),
  )

  // Checked before the player taps scan rather than after the camera fails.
  if (!canScan()) {
    panelEl.prepend(
      el(
        'p',
        'banner bad',
        'This browser cannot scan codes, so it cannot join a game. Host a game instead, or open this page in Android Chrome.',
      ),
    )
  }

  const stopWakeLock = holdWakeLock()
  let guest: GuestSession | null = null
  let ceremony: CeremonyChannel | null = null
  let signaler: Signaler | null = null
  let attemptController: AbortController | null = null
  let leaving = false
  /** Set once the game screen owns the session, so unmounting does not kill it. */
  let handedOff = false

  function teardownAttempt(): void {
    attemptController?.abort()
    attemptController = null
    // `leave()` sends the host a goodbye and closes the peer, which matters
    // because a failed attempt may already have built one.
    guest?.leave('local')
    guest = null
    signaler?.dispose()
    signaler = null
    ceremony?.dispose()
    ceremony = null
    clear(ceremonySlot)
  }

  function abortAttempt(): void {
    teardownAttempt()
    setStatus('Stopped. Ready when you are.')
    scanButton.hidden = false
    stopButton.hidden = true
    ceremonySlot.hidden = true
  }

  function setStatus(text: string): void {
    setText(statusLine, text)
  }

  function describePhase(phase: GuestPhase): string {
    switch (phase) {
      case 'joining':
        return ctx.dev ? 'Looking for a host in another tab…' : "Point the camera at the host's code…"
      case 'answering':
        return 'Show this code to the host.'
      case 'connecting':
        return 'You are in — waiting for the host to start…'
      case 'joined':
        return 'You are in.'
      default:
        return ''
    }
  }

  async function attempt(): Promise<void> {
    if (leaving) return
    teardownAttempt()
    banner.clear()
    scanButton.hidden = true
    stopButton.hidden = false
    ceremonySlot.hidden = false

    const name = nameInput.value.trim() || 'Player'
    const fresh = createCeremony()
    ceremony = fresh
    clear(ceremonySlot)
    ceremonySlot.append(fresh.el)

    // Dev mode has no camera and no QR: both tabs are on one machine, and the
    // loopback signaler carries the offer without anything to scan.
    const freshSignaler: Signaler = ctx.dev
      ? createBroadcastChannelSignaler(`multirace:${mode.id}`)
      : createCodeSignaler(fresh)
    signaler = freshSignaler

    attemptController = new AbortController()

    const session = createGuestSession({
      signaler: freshSignaler,
      iceServers: ctx.iceServers ?? ICE_SERVERS,
      name,
      welcomeTimeoutMs: WELCOME_TIMEOUT_MS,
    })
    guest = session

    const entered = new Promise<void>((resolve, reject) => {
      session.on('phase', ({ phase }) => {
        setStatus(describePhase(phase))
        if (phase === 'failed') reject(new Error('That did not work. Try again.'))
      })
      session.on('error', ({ error }) => {
        banner.show(error.message)
      })
      session.on('welcome', () => resolve())
      session.on('closed', () => {
        if (!leaving) reject(new Error('The host ended the session.'))
      })
    })

    try {
      // Passing the client id explicitly: `getClientId()` returns a different id
      // per call when storage is unavailable, and the game is scored by it.
      const clientId: ClientId = ctx.clientId
      await Promise.all([session.join({ clientId }), entered])
    } catch (err) {
      if (leaving) return
      teardownAttempt()
      scanButton.hidden = false
      stopButton.hidden = true
      setStatus('')
      banner.show(describeError(err))
      return
    }

    if (leaving) return
    const game = createGuestGame({ session, clientId: ctx.clientId })
    handedOff = true
    ctx.router.replace(
      createGameScreen(ctx, {
        game,
        mode,
        // Ownership passes to the game screen, so the teardown follows it there
        // rather than running when this screen is replaced.
        onExit: () => teardownAttempt(),
      }),
    )
  }

  const screen = frame(
    `${mode.name} — Join`,
    undefined,
    banner.el,
    panelEl,
  )

  return makeScreen({
    screen,
    backTo: () => createPlaySelect(ctx, mode),
    onUnmount: () => {
      leaving = true
      if (!handedOff) teardownAttempt()
      stopWakeLock()
    },
    onPageHide: () => teardownAttempt(),
  })
}

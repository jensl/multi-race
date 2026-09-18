/**
 * The game itself, on both sides of the wire.
 *
 * The host and the guest emit the same events for the same moments, so this
 * screen does not know which end it is on -- it renders a phase, a problem, a
 * scoreboard and a countdown, and calls `submit` when a number is typed. The
 * only thing that differs is what leaving means, and that arrives as `onExit`.
 *
 * The problem is *known* during the countdown -- every phone has to hold it
 * before answering opens, or the phone that received it first would get a head
 * start -- but it is deliberately not shown until then.
 */
import { GAME } from '../../game/config.ts'
import { isHostGame, type GamePhase, type GameSession, type ResultRound } from '../../game/events.ts'
import type { GameMode } from '../../game/problem.ts'
import type { Player, PlayerId, Scores } from '../../game/scoring.ts'
import { button, el } from '../dom.ts'
import { makeScreen, type AppContext } from '../screen.ts'
import type { Screen } from '../router.ts'
import { createProblemView, type ProblemView, type ScoreRow } from '../problem-view.ts'
import { holdWakeLock } from '../wake-lock.ts'
import { createPlaySelect } from './play-select.ts'
import { createMultiResults } from './results.ts'

export interface GameScreenOptions {
  game: GameSession
  mode: GameMode
  /** Tears the session down. Called only when the player truly leaves. */
  onExit?: () => void
}

export function createGameScreen(ctx: AppContext, options: GameScreenOptions): Screen {
  const { game, mode } = options
  const maxDigits = String(mode.maxAnswer).length

  let typed = ''
  /** True once this screen has stopped: no further events should move it. */
  let finished = false
  let tornDown = false

  let players: readonly Player[] = game.players
  let scores: Scores = {}
  let answered: PlayerId[] = []
  let lastAnswer: number | null = null
  let countdownMs: number = GAME.countdownMs
  let limitMs: number = GAME.roundLimitMs
  let roundIndex = 0
  let total = game.total || GAME.rounds

  function selfHasAnswered(): boolean {
    return answered.includes(game.playerId)
  }

  function canAnswer(): boolean {
    return game.phase === 'open' && !selfHasAnswered()
  }

  function onDigit(digit: number): void {
    if (!canAnswer() || typed.length >= maxDigits) return
    // A leading zero is never part of an answer, only a slip.
    if (typed === '' && digit === 0) return
    typed += String(digit)
    view.setInput(typed)
  }

  function onBackspace(): void {
    if (!canAnswer() || typed === '') return
    typed = typed.slice(0, -1)
    view.setInput(typed)
  }

  function onSubmit(): void {
    if (!canAnswer() || typed === '') return
    const value = Number(typed)
    typed = ''
    view.setInput('')
    game.submit(value)
  }

  const view: ProblemView = createProblemView({ onDigit, onBackspace, onSubmit })
  const stopWakeLock = holdWakeLock()

  function refreshScores(): void {
    const rows: ScoreRow[] = players.map((player) => ({
      id: player.playerId,
      name: player.name,
      score: scores[player.playerId] ?? 0,
      done: answered.includes(player.playerId),
      isSelf: player.playerId === game.playerId,
    }))
    // A scoreboard of one is not a scoreboard.
    view.setScores(rows.length > 1 ? rows : [])
  }

  /** Paints whatever the current phase should look like. */
  function render(): void {
    const phase = game.phase
    // Read from the controller rather than remembered from an event, so a screen
    // that arrived late still knows what is being asked.
    const problem = game.problem

    if (problem && (phase === 'open' || phase === 'result')) view.showProblem(problem)
    else if (phase === 'countdown') view.setProblemText('Get ready…')
    else view.setProblemText('')

    if (phase === 'idle') view.setStatus('Waiting for the host to start…')
    else if (phase === 'countdown') view.setStatus(`Round ${roundIndex + 1} of ${total}`)
    else if (phase === 'open')
      view.setStatus(selfHasAnswered() ? 'Answered — waiting for the others' : '')
    else if (phase === 'result')
      view.setStatus(lastAnswer === null ? '' : `The answer was ${lastAnswer}`)

    view.setRound(`${Math.min(roundIndex + 1, total)} / ${total}`)
    view.setKeypadEnabled(canAnswer())
    refreshScores()
  }

  function applyResult(result: ResultRound): void {
    scores = result.scores
    lastAnswer = result.answer
    // During the result the "done" marks become who actually scored.
    answered = result.awards.map((award) => award.playerId)
  }

  // --------------------------------------------------------------- lifecycle

  function stopDrawing(): void {
    cancelAnimationFrame(frame)
    for (const off of offs) off()
  }

  /**
   * Repaints on a plain interval, whatever else is or is not firing.
   *
   * Everything above repaints on an event, or on an animation frame. Both are
   * things this screen has no way to verify: `requestAnimationFrame` stops in a
   * hidden page, and an event that was never delivered leaves no trace. A host
   * whose screen stayed on "Get ready…" while the game had plainly moved on is
   * exactly that failure -- state correct, paint stale -- and there is no way to
   * tell from here which of the two messengers went quiet.
   *
   * This is the backstop. It costs one `render()` that writes almost nothing
   * (every setter checks before it touches the DOM), and it means the screen is
   * a function of the controller's state rather than a record of messages it
   * happened to receive.
   */
  const converge = setInterval(() => {
    if (!finished) render()
  }, 250)

  /** Releases this screen's own resources without touching the session. */
  function quietTeardown(): void {
    if (tornDown) return
    tornDown = true
    stopDrawing()
    clearInterval(converge)
    view.dispose()
    stopWakeLock()
  }

  function leave(): void {
    if (finished) return
    // Ending a host's game drops everyone in it, so it is worth one question.
    if (isHostGame(game) && !window.confirm('End the game for everyone?')) return
    finished = true
    quietTeardown()
    options.onExit?.()
    ctx.router.replace(createPlaySelect(ctx, mode))
  }

  function showResults(): void {
    if (finished) return
    finished = true
    // The session survives this: a rematch replays on the same connections, and
    // a guest has to stay connected to be picked up by one.
    quietTeardown()
  }

  const exitButton = button(isHostGame(game) ? 'End game' : 'Leave', () => leave(), {
    variant: 'ghost',
  })
  exitButton.classList.add('exit-key')

  // Declared before the subscriptions: an event handler can reach `stopDrawing`,
  // which reads this, and a subscription that fires before it is initialised
  // would throw rather than no-op.
  let frame = 0

  const offs = [
    game.on('started', ({ total: rounds, players: roster }) => {
      total = rounds
      players = roster
      render()
    }),
    game.on('players', ({ players: roster }) => {
      players = roster
      refreshScores()
    }),
    game.on('round', ({ index, total: rounds, startsInMs, limitMs: limit }) => {
      roundIndex = index
      total = rounds
      countdownMs = startsInMs
      limitMs = limit
      answered = []
      lastAnswer = null
      typed = ''
      view.setInput('')
      render()
    }),
    game.on('open', () => render()),
    game.on('progress', ({ answered: list }) => {
      answered = list
      render()
    }),
    game.on('feedback', ({ kind }) => {
      view.flash(kind)
      // A wrong answer clears so the retry starts from nothing; a correct one
      // stays up until the round is over.
      if (kind === 'wrong') {
        typed = ''
        view.setInput('')
      }
      render()
    }),
    game.on('result', ({ result }) => {
      applyResult(result)
      render()
    }),
    game.on('over', ({ standings }) => {
      showResults()
      // The results screen keeps the session and watches it for a restart, so a
      // rematch is a button on that screen rather than a second screen here.
      ctx.router.replace(
        createMultiResults(ctx, {
          game,
          mode,
          standings,
          ...(options.onExit ? { onExit: options.onExit } : {}),
        }),
      )
    }),
    game.on('aborted', ({ reason }) => {
      showResults()
      ctx.router.replace(
        createMultiResults(ctx, {
          game,
          mode,
          standings: [],
          aborted: reason,
          ...(options.onExit ? { onExit: options.onExit } : {}),
        }),
      )
    }),
  ]

  // The clock is drawn, not obeyed: the controller decides when a phase ends.
  let drawnPhase: GamePhase | null = null
  const draw = (): void => {
    if (finished) return
    const phase = game.phase

    // Repaint whenever the phase moves, not only when an event says so. Event
    // delivery is the one thing this screen cannot check, and a missed `open`
    // leaves a player staring at "Get ready" while the rest of the room answers
    // -- which is a bug this screen has already had once. Sampling the phase
    // makes the reveal a function of controller state rather than of having
    // caught the right moment.
    if (phase !== drawnPhase) {
      drawnPhase = phase
      render()
    }

    const totalMs = phase === 'countdown' ? countdownMs : limitMs
    view.setTimer(game.remainingMs(), totalMs)
    frame = requestAnimationFrame(draw)
  }
  frame = requestAnimationFrame(draw)

  view.el.append(el('div', 'exit-row', exitButton))
  view.setMode(mode.name)
  render()

  return makeScreen({
    screen: view.el,
    backTo: () => {
      leave()
      return createPlaySelect(ctx, mode)
    },
    onUnmount: () => {
      // Reached by the hand-off to the results screen as well as by an exit, so
      // it only ever releases this screen's own resources.
      quietTeardown()
    },
    // Tell the others now rather than leaving them to the liveness timeout.
    onPageHide: () => options.onExit?.(),
  })
}

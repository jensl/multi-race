/**
 * Single player: one clock, as many problems as you can clear.
 *
 * The screen owns three things the controller deliberately does not: the digits
 * being typed, the animation loop that moves the clock bar, and the wake lock.
 */
import { GAME } from '../../game/config.ts'
import type { GameMode } from '../../game/problem.ts'
import { createSingleGame, type SingleGame } from '../../game/single.ts'
import { button, el } from '../dom.ts'
import { makeScreen, type AppContext } from '../screen.ts'
import type { Screen } from '../router.ts'
import { createProblemView } from '../problem-view.ts'
import { holdWakeLock } from '../wake-lock.ts'
import { createPlaySelect } from './play-select.ts'
import { createSingleResults } from './results.ts'

export function createSingleScreen(ctx: AppContext, mode: GameMode): Screen {
  // The longest answer the mode can pose bounds what may be typed, rather than a
  // constant that would quietly drift from the mode.
  const maxDigits = String(mode.maxAnswer).length
  const seconds = Math.round(GAME.singleDurationMs / 1000)

  let typed = ''
  let leaving = false

  function onDigit(digit: number): void {
    if (typed.length >= maxDigits) return
    // A leading zero is never part of an answer, only a slip.
    if (typed === '' && digit === 0) return
    typed += String(digit)
    view.setInput(typed)
  }

  function onBackspace(): void {
    if (typed === '') return
    typed = typed.slice(0, -1)
    view.setInput(typed)
  }

  function onSubmit(): void {
    if (typed === '') return
    const value = Number(typed)
    typed = ''
    view.setInput('')
    game.submit(value)
  }

  const view = createProblemView({ onDigit, onBackspace, onSubmit })
  const game: SingleGame = createSingleGame({ mode })
  const stopWakeLock = holdWakeLock()

  view.setMode(mode.name)
  view.setRound(`${seconds} seconds`)
  view.setScores([])
  const first = game.problem
  if (first) view.showProblem(first)
  view.setInput('')

  const offs = [
    game.on('problem', ({ problem }) => {
      view.showProblem(problem)
      view.setInput('')
    }),
    game.on('correct', ({ solved }) => {
      view.flash('correct')
      view.setRound(`${solved} solved`)
    }),
    game.on('wrong', () => {
      view.flash('wrong')
    }),
    game.on('over', ({ solved, reason }) => {
      if (reason === 'stopped') return
      leaving = true
      ctx.router.replace(createSingleResults(ctx, mode, solved))
    }),
  ]

  // The clock bar is presentation only: the controller decides when time is up
  // and this just draws the time it reports.
  let frame = 0
  const draw = (): void => {
    if (leaving) return
    view.setTimer(game.remainingMs(), GAME.singleDurationMs)
    frame = requestAnimationFrame(draw)
  }
  frame = requestAnimationFrame(draw)

  // Without this the only way out of a run is the hardware back gesture, which
  // is not a thing a player should have to discover.
  const exitButton = button('Leave', () => {
    if (leaving) return
    ctx.router.replace(createPlaySelect(ctx, mode))
  }, { variant: 'ghost' })
  exitButton.classList.add('exit-key')
  view.el.append(el('div', 'exit-row', exitButton))

  return makeScreen({
    screen: view.el,
    backTo: () => createPlaySelect(ctx, mode),
    onUnmount: () => {
      leaving = true
      cancelAnimationFrame(frame)
      // Unsubscribe before stopping: `stop()` reports an ending, and a screen
      // that has already been left must not navigate on it.
      for (const off of offs) off()
      game.stop()
      view.dispose()
      stopWakeLock()
    },
  })
}

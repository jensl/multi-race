/**
 * Single player: one clock, as many problems as you can clear before it runs out.
 *
 * Deliberately not built as "a host with no guests". The two share a problem
 * generator, a keypad and a problem view, but nothing else: a solo game has no
 * rounds, no scoring order and no authority to defer to, and expressing it as a
 * degenerate multiplayer game would mean every one of those absences had to be
 * special-cased somewhere. A hundred lines of separate loop is the cheaper,
 * clearer trade.
 *
 * No DOM, no `localStorage` -- the best score is the UI's business, since node
 * has neither and this module has to run under the test runner.
 */
import { type GameClock, realClock } from './clock.ts'
import type { Handler } from '../session/emitter.ts'
import { createEmitter } from '../session/emitter.ts'
import { GAME } from './config.ts'
import { generateProblem, solve, type GameMode, type Problem } from './problem.ts'
import { mulberry32, randomSeed, type Rng } from './rng.ts'

export type SingleEvent =
  /**
   * A new problem. The *first* one is posed during construction, so a listener
   * attached afterwards will not see it -- read `problem` for whatever is on
   * screen right now, and treat this as a change notification.
   */
  | { t: 'problem'; problem: Problem; index: number }
  /** This device's own answer, judged immediately -- there is nobody to ask. */
  | { t: 'correct'; value: number; solved: number }
  | { t: 'wrong'; value: number }
  | { t: 'over'; solved: number; reason: 'time' | 'stopped' }

export type SingleEventMap = { [E in SingleEvent as E['t']]: Omit<E, 't'> }

export interface SingleGame {
  readonly solved: number
  readonly problem: Problem | null
  readonly finished: boolean
  /** Milliseconds left on the clock, floored at zero. */
  remainingMs(): number
  submit(value: number): void
  stop(): void
  on<K extends keyof SingleEventMap & string>(k: K, fn: Handler<SingleEventMap[K]>): () => void
}

export interface SingleOptions {
  mode: GameMode
  clock?: GameClock
  seed?: number
  durationMs?: number
}

export function createSingleGame(options: SingleOptions): SingleGame {
  const clock = options.clock ?? realClock
  const durationMs = options.durationMs ?? GAME.singleDurationMs
  const rng: Rng = mulberry32(options.seed ?? randomSeed())
  const emitter = createEmitter<SingleEventMap>()

  const startedAt = clock.now()
  const deadline = startedAt + durationMs

  let problem: Problem | null = null
  let previous: Problem | undefined
  let solved = 0
  let index = 0
  let finished = false

  function nextProblem(): void {
    problem = generateProblem(options.mode, rng, previous)
    previous = problem
    index += 1
    emitter.emit('problem', { problem, index })
  }

  const cancel = clock.after(durationMs, () => {
    if (finished) return
    finished = true
    emitter.emit('over', { solved, reason: 'time' })
  })

  function submit(value: number): void {
    if (finished || !problem) return
    if (value === solve(problem)) {
      solved += 1
      emitter.emit('correct', { value, solved })
      nextProblem()
      return
    }
    // No penalty and no lockout: the clock is the penalty, and a wrong answer
    // that ended your run would punish a mistyped digit rather than a wrong sum.
    emitter.emit('wrong', { value })
  }

  function stop(): void {
    if (finished) return
    finished = true
    cancel()
    emitter.emit('over', { solved, reason: 'stopped' })
  }

  nextProblem()

  return {
    get solved() {
      return solved
    },
    get problem() {
      return problem
    },
    get finished() {
      return finished
    },
    remainingMs: () => Math.max(0, deadline - clock.now()),
    submit,
    stop,
    on: emitter.on,
  }
}

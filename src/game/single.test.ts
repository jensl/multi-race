/**
 * Single player is one clock and a pile of problems, so what is worth pinning
 * is that the clock is the only thing that can end a run: a wrong answer costs
 * time and nothing else, and the score stops moving the moment time is up.
 *
 * The clock is injected, so a minute-long game runs instantly and every
 * boundary is exact rather than approximately observed.
 */
import { describe, expect, it } from 'vitest'
import { findMode, solve, type GameMode, type Problem } from './problem.ts'
import { createSingleGame, type SingleEvent } from './single.ts'
import { manualClock } from './test-support/manual-clock.ts'

const DURATION = 60_000

function multiply(): GameMode {
  const found = findMode('multiply')
  if (!found) throw new Error('the multiply mode is missing')
  return found
}

interface Run {
  game: ReturnType<typeof createSingleGame>
  clock: ReturnType<typeof manualClock>
  /** Every problem posed, in order. */
  problems: Problem[]
  events: SingleEvent[]
}

function start(options: { seed?: number; durationMs?: number } = {}): Run {
  const clock = manualClock()
  const game = createSingleGame({
    mode: multiply(),
    clock,
    seed: options.seed ?? 4242,
    durationMs: options.durationMs ?? DURATION,
  })

  const problems: Problem[] = []
  const events: SingleEvent[] = []
  // The first problem is posed during construction, before a listener can
  // attach, so it is picked up from the getter rather than from the event.
  if (game.problem) problems.push(game.problem)

  game.on('problem', ({ problem }) => problems.push(problem))
  game.on('over', (e) => events.push({ t: 'over', ...e }))
  game.on('wrong', (e) => events.push({ t: 'wrong', ...e }))
  game.on('correct', (e) => events.push({ t: 'correct', ...e }))

  return { game, clock, problems, events }
}

describe('starting a run', () => {
  it('poses a problem immediately, without waiting to be asked', () => {
    const run = start()
    expect(run.problems).toHaveLength(1)
    expect(run.game.problem).toEqual(run.problems[0])
    expect(run.game.solved).toBe(0)
    expect(run.game.finished).toBe(false)
  })

  it('counts the clock down from the full duration', () => {
    const run = start({ durationMs: 30_000 })
    expect(run.game.remainingMs()).toBe(30_000)
  })
})

describe('answering', () => {
  it('scores a correct answer and moves straight on', () => {
    const run = start()
    const first = run.game.problem
    if (!first) throw new Error('no first problem')

    run.game.submit(solve(first))

    expect(run.game.solved).toBe(1)
    expect(run.problems).toHaveLength(2)
    // A new problem, never the one just answered.
    expect(run.game.problem).not.toEqual(first)
    expect(run.events[0]?.t).toBe('correct')
  })

  it('does not advance or score a wrong answer, and does not end the run', () => {
    const run = start()
    const first = run.game.problem
    if (!first) throw new Error('no first problem')

    run.game.submit(solve(first) + 1)

    expect(run.game.solved).toBe(0)
    expect(run.game.problem).toEqual(first)
    expect(run.game.finished).toBe(false)
    expect(run.events[0]?.t).toBe('wrong')
  })

  it('lets a player recover from a wrong answer', () => {
    const run = start()
    const first = run.game.problem
    if (!first) throw new Error('no first problem')

    run.game.submit(solve(first) + 1)
    run.game.submit(solve(first))

    expect(run.game.solved).toBe(1)
    expect(run.events.map((e) => e.t)).toEqual(['wrong', 'correct'])
  })

  it('counts a run of correct answers, and only ever one per problem', () => {
    const run = start()
    for (let i = 0; i < 20; i++) {
      const problem = run.game.problem
      if (!problem) throw new Error('no problem')
      run.game.submit(solve(problem))
    }
    expect(run.game.solved).toBe(20)
    expect(run.problems).toHaveLength(21)
  })
})

describe('running out of time', () => {
  it('ends the run when the clock does, with no further problems', () => {
    const run = start({ durationMs: 10_000 })

    const first = run.game.problem
    if (!first) throw new Error('no problem')
    run.game.submit(solve(first))
    expect(run.problems).toHaveLength(2)

    run.clock.advance(10_000)

    expect(run.game.finished).toBe(true)
    expect(run.events.filter((e) => e.t === 'over')).toEqual([
      { t: 'over', solved: 1, reason: 'time' },
    ])
    expect(run.game.remainingMs()).toBe(0)
    // The problem on screen stays put; nothing new is dealt after time is up.
    expect(run.problems).toHaveLength(2)
  })

  it('ignores an answer typed after the clock ran out', () => {
    const run = start({ durationMs: 1000 })
    const stuck = run.game.problem
    if (!stuck) throw new Error('no problem')

    run.clock.advance(1000)
    run.game.submit(solve(stuck))

    expect(run.game.solved).toBe(0)
    expect(run.game.problem).toEqual(stuck)
  })

  it('does not fire a second ending when the clock outlives a stop', () => {
    const run = start({ durationMs: 1000 })
    run.game.stop()
    run.clock.advance(5000)
    expect(run.events).toEqual([{ t: 'over', solved: 0, reason: 'stopped' }])
  })

  it('does not report a stopped run as a time-out', () => {
    const run = start()
    run.game.stop()
    expect(run.game.finished).toBe(true)
    expect(run.events).toEqual([{ t: 'over', solved: 0, reason: 'stopped' }])
  })

  it('does not fire a second ending if stopped twice', () => {
    const run = start()
    run.game.stop()
    run.game.stop()
    expect(run.events).toHaveLength(1)
  })
})

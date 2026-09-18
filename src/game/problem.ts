/**
 * What a problem is, and where problems come from.
 *
 * A `Problem` is the wire format as well as the model: `{ a, b, op }` is small
 * enough to send as-is, and the answer is derived from it rather than carried
 * alongside. That keeps a round message tiny and means the correct answer is
 * never something a client could quietly read out of its own inbox.
 */
import { intBetween, type Rng } from './rng.ts'

/** Wire values stay ASCII; `formatProblem` is what maps them to typography. */
export type Op = 'x' | '+' | '-' | '÷'

export interface Problem {
  a: number
  b: number
  op: Op
}

const OPS: readonly Op[] = ['x', '+', '-', '÷']

const GLYPH: Record<Op, string> = { x: '×', '+': '+', '-': '−', '÷': '÷' }

/** A problem's answer. Total over `Op`, so a new op cannot be half-added. */
export function solve(p: Problem): number {
  switch (p.op) {
    case 'x':
      return p.a * p.b
    case '+':
      return p.a + p.b
    case '-':
      return p.a - p.b
    case '÷':
      return p.a / p.b
  }
}

export function formatProblem(p: Problem): string {
  return `${p.a} ${GLYPH[p.op]} ${p.b}`
}

export interface GameMode {
  id: string
  name: string
  blurb: string
  /** The largest answer the mode can pose. Bounds the keypad and the answer check. */
  maxAnswer: number
  /**
   * Every problem must have a **whole-number** answer.
   *
   * The keypad types digits, the answer check compares integers, and a result
   * carrying a fractional answer is rejected by the guest's parser outright --
   * so a mode that could pose `7 ÷ 2` would break the game rather than merely
   * look odd. A division mode satisfies this by choosing `a = b * q` rather than
   * by rounding here. `problem.test.ts` enforces it across the registry.
   */
  generate(rng: Rng): Problem
}

/**
 * Multiplication tables, 2..12.
 *
 * The factor floor is 2, not 1: a `× 1` is not arithmetic, and a run of them
 * makes a game feel broken rather than easy.
 */
const MIN_FACTOR = 2
const MAX_FACTOR = 12

const multiplication: GameMode = {
  id: 'multiply',
  name: 'Multiplication',
  blurb: `Times tables, ${MIN_FACTOR} to ${MAX_FACTOR}`,
  maxAnswer: MAX_FACTOR * MAX_FACTOR,
  generate: (rng) => ({
    a: intBetween(rng, MIN_FACTOR, MAX_FACTOR),
    b: intBetween(rng, MIN_FACTOR, MAX_FACTOR),
    op: 'x',
  }),
}

/**
 * The registry the mode-select screen renders. One entry today; adding another
 * is additive, which is the entire point of the indirection.
 */
export const MODES: readonly GameMode[] = [multiplication]

export function findMode(id: string): GameMode | undefined {
  return MODES.find((m) => m.id === id)
}

/** Bound on the no-repeat retry, so a mode with a tiny problem space still returns. */
const AVOID_ATTEMPTS = 8

/**
 * A problem, never the same one twice in a row.
 *
 * Repeats are the difference between "shuffled" and "buggy" to a player, and a
 * mode like `× 1`-excluded tables can produce them often enough to be noticed.
 */
export function generateProblem(mode: GameMode, rng: Rng, previous?: Problem): Problem {
  let problem = mode.generate(rng)
  for (let i = 0; i < AVOID_ATTEMPTS && previous && sameProblem(problem, previous); i++) {
    problem = mode.generate(rng)
  }
  return problem
}

export function sameProblem(a: Problem, b: Problem): boolean {
  return a.a === b.a && a.b === b.b && a.op === b.op
}

/** Guards a `Problem` that arrived over the wire before anything renders it. */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return (
    typeof p.a === 'number' &&
    Number.isSafeInteger(p.a) &&
    typeof p.b === 'number' &&
    Number.isSafeInteger(p.b) &&
    typeof p.op === 'string' &&
    OPS.includes(p.op as Op) &&
    Math.abs(p.a) <= 10_000 &&
    Math.abs(p.b) <= 10_000
  )
}

/**
 * The problem generator is what every player sees, so its invariants are worth
 * pinning: problems in range, solvable, never repeated back to back, and
 * reproducible from a seed -- the last of which is what makes the round loop
 * testable at all.
 */
import { describe, expect, it } from 'vitest'
import {
  findMode,
  formatProblem,
  generateProblem,
  isProblem,
  MODES,
  sameProblem,
  solve,
  type Problem,
} from './problem.ts'
import { mulberry32 } from './rng.ts'

const multiply = findMode('multiply')

function mode(id: string): (typeof MODES)[number] {
  const found = findMode(id)
  if (!found) throw new Error(`no mode "${id}"`)
  return found
}

describe('the mode registry', () => {
  it('offers multiplication under a stable id', () => {
    expect(MODES.map((m) => m.id)).toEqual(['multiply'])
    expect(mode('multiply').name).toBe('Multiplication')
  })

  it('returns undefined for an unknown mode rather than throwing', () => {
    expect(findMode('nope')).toBeUndefined()
  })
})

describe('multiplication problems', () => {
  it('stays within the tables the mode advertises', () => {
    const rng = mulberry32(7)
    const m = multiply
    if (!m) throw new Error('no multiply mode')

    for (let i = 0; i < 500; i++) {
      const p = generateProblem(m, rng)
      expect(p.op).toBe('x')
      expect(p.a).toBeGreaterThanOrEqual(2)
      expect(p.a).toBeLessThanOrEqual(12)
      expect(p.b).toBeGreaterThanOrEqual(2)
      expect(p.b).toBeLessThanOrEqual(12)
      // The advertised ceiling is what bounds keypad input, so it must be real.
      expect(solve(p)).toBeLessThanOrEqual(m.maxAnswer)
    }
  })

  it('never poses the same problem twice in a row, which reads as a bug', () => {
    const rng = mulberry32(11)
    const m = multiply
    if (!m) throw new Error('no multiply mode')

    let previous: Problem | undefined
    for (let i = 0; i < 500; i++) {
      const p = generateProblem(m, rng, previous)
      if (previous) expect(sameProblem(p, previous)).toBe(false)
      previous = p
    }
  })

  it('is reproducible from a seed, so a whole game can be replayed in a test', () => {
    const m = mode('multiply')
    const a = Array.from({ length: 20 }, (_, i) => generateProblem(m, mulberry32(42 + i)))
    const b = Array.from({ length: 20 }, (_, i) => generateProblem(m, mulberry32(42 + i)))
    expect(a).toEqual(b)
  })

  it('differs between seeds', () => {
    const m = mode('multiply')
    const a = Array.from({ length: 10 }, () => generateProblem(m, mulberry32(1)))
    const b = Array.from({ length: 10 }, () => generateProblem(m, mulberry32(2)))
    expect(a).not.toEqual(b)
  })
})

describe('solve', () => {
  it('answers every op the wire format allows', () => {
    expect(solve({ a: 7, b: 8, op: 'x' })).toBe(56)
    expect(solve({ a: 7, b: 8, op: '+' })).toBe(15)
    expect(solve({ a: 7, b: 8, op: '-' })).toBe(-1)
    expect(solve({ a: 56, b: 8, op: '÷' })).toBe(7)
  })

  it('renders with typographic operators rather than the ASCII wire form', () => {
    expect(formatProblem({ a: 5, b: 8, op: 'x' })).toBe('5 × 8')
    expect(formatProblem({ a: 5, b: 8, op: '-' })).toBe('5 − 8')
  })
})

describe('isProblem', () => {
  it('accepts what the generator produces', () => {
    const m = mode('multiply')
    expect(isProblem(generateProblem(m, mulberry32(3)))).toBe(true)
  })

  it('rejects anything that would render as NaN or an unknown operator', () => {
    const rejected: Array<[unknown, string]> = [
      [null, 'null'],
      ['5 x 8', 'a string'],
      [{ a: 5, b: 8, op: '^' }, 'an op not in the wire format'],
      [{ a: Number.NaN, b: 8, op: 'x' }, 'a NaN operand'],
      [{ a: 5.5, b: 8, op: 'x' }, 'a fractional operand'],
      [{ a: 5, b: 8 }, 'a missing op'],
      [{ a: 1e12, b: 8, op: 'x' }, 'an operand past the sane bound'],
    ]
    for (const [input, why] of rejected) {
      expect(isProblem(input), why).toBe(false)
    }
  })
})

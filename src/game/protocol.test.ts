/**
 * The parsers are the boundary between an untrusted guest and the host's score
 * table. A payload that gets past them is one the round loop will act on, so
 * each rejection below is a way a guest could otherwise corrupt a game -- by
 * accident, a bug, or a malformed message from a mismatched build.
 */
import { describe, expect, it } from 'vitest'
import {
  makeRoundId,
  parseAnswer,
  parseOver,
  parseProgress,
  parseResult,
  parseRound,
  parseStart,
} from './protocol.ts'

const MAX_ANSWER = 144

function answer(overrides: Record<string, unknown> = {}): unknown {
  return { roundId: 'g1-r0', value: 56, ...overrides }
}

function round(overrides: Record<string, unknown> = {}): unknown {
  return {
    roundId: 'g1-r0',
    index: 0,
    total: 10,
    problem: { a: 7, b: 8, op: 'x' },
    startsInMs: 1500,
    limitMs: 10000,
    ...overrides,
  }
}

describe('parsing a guest answer', () => {
  it('accepts a well-formed answer', () => {
    expect(parseAnswer(answer(), MAX_ANSWER)).toEqual({ roundId: 'g1-r0', value: 56 })
  })

  it('accepts a zero, which is a legal answer to some problems', () => {
    expect(parseAnswer(answer({ value: 0 }), MAX_ANSWER)).toEqual({ roundId: 'g1-r0', value: 0 })
  })

  it('accepts a negative, which a subtraction mode would need', () => {
    expect(parseAnswer(answer({ value: -56 }), MAX_ANSWER)).toEqual({
      roundId: 'g1-r0',
      value: -56,
    })
  })

  it('rejects a value past what the mode can pose', () => {
    expect(parseAnswer(answer({ value: MAX_ANSWER + 1 }), MAX_ANSWER)).toBeNull()
  })

  it('rejects anything that is not a whole number', () => {
    const rejected: Array<[unknown, string]> = [
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'infinity'],
      ['56', 'a string'],
      [5.6, 'a float'],
      [1e9, 'an oversized integer'],
      [null, 'null'],
      [undefined, 'undefined'],
    ]
    for (const [value, why] of rejected) {
      expect(parseAnswer(answer({ value }), MAX_ANSWER), why).toBeNull()
    }
  })

  it('rejects a missing or unusable round id', () => {
    const rejected: Array<[unknown, string]> = [
      [undefined, 'missing'],
      ['', 'empty'],
      [7, 'a number'],
      ['x'.repeat(1000), 'far too long'],
    ]
    for (const [roundId, why] of rejected) {
      expect(parseAnswer(answer({ roundId }), MAX_ANSWER), why).toBeNull()
    }
  })

  it('rejects a payload that is not an object at all', () => {
    for (const input of [null, 'answer', 42, []]) {
      expect(parseAnswer(input, MAX_ANSWER)).toBeNull()
    }
  })

  it('ignores extra fields rather than trusting them', () => {
    const parsed = parseAnswer(answer({ rank: 0, playerId: 'someone-else' }), MAX_ANSWER)
    expect(parsed).toEqual({ roundId: 'g1-r0', value: 56 })
  })
})

describe('parsing host messages', () => {
  it('accepts a well-formed round', () => {
    const parsed = parseRound(round())
    expect(parsed?.problem).toEqual({ a: 7, b: 8, op: 'x' })
    expect(parsed?.startsInMs).toBe(1500)
  })

  it('rejects a round carrying a problem that would render as NaN', () => {
    expect(parseRound(round({ problem: { a: Number.NaN, b: 8, op: 'x' } }))).toBeNull()
    expect(parseRound(round({ problem: { a: 7, b: 8, op: '^' } }))).toBeNull()
    expect(parseRound(round({ problem: null }))).toBeNull()
  })

  it('rejects a round with a nonsensical duration', () => {
    expect(parseRound(round({ limitMs: 0 }))).toBeNull()
    expect(parseRound(round({ limitMs: -1 }))).toBeNull()
    expect(parseRound(round({ startsInMs: -1 }))).toBeNull()
    expect(parseRound(round({ limitMs: '10000' }))).toBeNull()
  })

  it('accepts a start message', () => {
    const players = [{ playerId: 'host', name: 'Host' }]
    expect(parseStart({ modeId: 'multiply', total: 10, players })).toEqual({
      modeId: 'multiply',
      total: 10,
      players,
    })
  })

  it('rejects a start message with no rounds in it', () => {
    const players = [{ playerId: 'host', name: 'Host' }]
    expect(parseStart({ modeId: 'multiply', total: 0, players })).toBeNull()
    expect(parseStart({ modeId: '', total: 10, players })).toBeNull()
    expect(parseStart(null)).toBeNull()
  })

  it('rejects a start message whose player list is unusable', () => {
    // A guest renders its scoreboard from this list, so a bad entry would show up
    // as an unnamed row rather than as a dropped message.
    expect(parseStart({ modeId: 'multiply', total: 10 })).toBeNull()
    expect(parseStart({ modeId: 'multiply', total: 10, players: 'host' })).toBeNull()
    expect(
      parseStart({ modeId: 'multiply', total: 10, players: [{ playerId: 'host' }] }),
    ).toBeNull()
    expect(
      parseStart({ modeId: 'multiply', total: 10, players: [{ name: 'Host' }] }),
    ).toBeNull()
  })

  it('accepts a progress message and rejects a non-string id inside it', () => {
    expect(parseProgress({ roundId: 'g1-r0', answered: ['a', 'b'] })).toEqual({
      roundId: 'g1-r0',
      answered: ['a', 'b'],
    })
    expect(parseProgress({ roundId: 'g1-r0', answered: ['a', 7] })).toBeNull()
    expect(parseProgress({ roundId: 'g1-r0', answered: 'a' })).toBeNull()
  })

  it('accepts a result and defaults timedOut rather than trusting a truthy value', () => {
    const parsed = parseResult({
      roundId: 'g1-r0',
      answer: 56,
      awards: [{ playerId: 'a', rank: 0, points: 3 }],
      scores: { a: 3 },
      timedOut: 'yes',
    })
    expect(parsed?.timedOut).toBe(false)
    expect(parsed?.awards).toEqual([{ playerId: 'a', rank: 0, points: 3 }])
  })

  it('rejects a result carrying a non-integer score', () => {
    expect(
      parseResult({ roundId: 'g1-r0', answer: 56, awards: [], scores: { a: 'three' } }),
    ).toBeNull()
    expect(
      parseResult({
        roundId: 'g1-r0',
        answer: 56,
        awards: [{ playerId: 'a', rank: 0, points: Number.NaN }],
        scores: {},
      }),
    ).toBeNull()
  })

  it('accepts final standings and rejects one missing a place', () => {
    const good = {
      standings: [{ playerId: 'a', name: 'Ana', score: 9, place: 1 }],
    }
    expect(parseOver(good)).toEqual(good)
    expect(parseOver({ standings: [{ playerId: 'a', name: 'Ana', score: 9 }] })).toBeNull()
    expect(parseOver({ standings: [{ playerId: 'a', name: 7, score: 9, place: 1 }] })).toBeNull()
  })
})

describe('round ids', () => {
  it('cannot collide across a rematch in the same session', () => {
    // Ids from the round index alone would repeat, and a late answer to game one
    // would then look like an answer to game two.
    expect(makeRoundId(1, 0)).toBe('g1-r0')
    expect(makeRoundId(2, 0)).not.toBe(makeRoundId(1, 0))
  })
})

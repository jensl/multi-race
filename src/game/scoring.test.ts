/**
 * Scoring is where a family game is either fair or quietly discouraging, so the
 * properties that matter are the social ones: everyone who answers gets
 * something, and nobody is ranked below someone who did the same or worse.
 */
import { describe, expect, it } from 'vitest'
import {
  awardRound,
  pointsForRank,
  scoreOf,
  standings,
  type Player,
  type Scores,
} from './scoring.ts'

const ANA = 'client-ana'
const BEN = 'client-ben'
const CASS = 'client-cass'
const DEV = 'client-dev'

function player(playerId: string, name: string): Player {
  return { playerId, name }
}

describe('points by rank', () => {
  it('pays 3, 2, 1 down the finishing order', () => {
    expect([0, 1, 2].map(pointsForRank)).toEqual([3, 2, 1])
  })

  it('does not run out of points at the player cap', () => {
    // The cap is one host plus three guests, so rank 3 is reachable.
    expect(pointsForRank(3)).toBe(1)
  })

  it('still returns points for a rank past the table, rather than undefined', () => {
    expect(pointsForRank(99)).toBe(1)
  })
})

describe('awarding a round', () => {
  it('credits everyone who answered, in finishing order', () => {
    const { awards, scores } = awardRound([ANA, BEN, CASS], {})
    expect(awards).toEqual([
      { playerId: ANA, rank: 0, points: 3 },
      { playerId: BEN, rank: 1, points: 2 },
      { playerId: CASS, rank: 2, points: 1 },
    ])
    expect(scores).toEqual({ [ANA]: 3, [BEN]: 2, [CASS]: 1 })
  })

  it('leaves a player who did not answer with no score entry at all', () => {
    const { scores } = awardRound([ANA, BEN, CASS], {})
    expect(scoreOf(scores, DEV)).toBe(0)
    expect(scores[DEV]).toBeUndefined()
  })

  it('accumulates across rounds instead of replacing', () => {
    const first = awardRound([ANA, BEN], {})
    const second = awardRound([BEN, ANA], first.scores)
    expect(second.scores).toEqual({ [ANA]: 5, [BEN]: 5 })
  })

  it('does not mutate the scores it was handed', () => {
    const before: Scores = { [ANA]: 4 }
    awardRound([ANA], before)
    expect(before).toEqual({ [ANA]: 4 })
  })

  it('pays a lone player first place', () => {
    const { scores } = awardRound([ANA], {})
    expect(scores).toEqual({ [ANA]: 3 })
  })

  it('pays nobody when the round times out unanswered', () => {
    const { awards, scores } = awardRound([], { [ANA]: 3 })
    expect(awards).toEqual([])
    expect(scores).toEqual({ [ANA]: 3 })
  })
})

describe('final standings', () => {
  const players = [player(ANA, 'Ana'), player(BEN, 'Ben'), player(CASS, 'Cass')]

  it('orders by score, highest first', () => {
    const result = standings(players, { [ANA]: 5, [BEN]: 9, [CASS]: 1 })
    expect(result.map((s) => s.name)).toEqual(['Ben', 'Ana', 'Cass'])
    expect(result.map((s) => s.place)).toEqual([1, 2, 3])
  })

  it('gives tied players the same place and skips the next one', () => {
    const result = standings(players, { [ANA]: 7, [BEN]: 7, [CASS]: 2 })
    expect(result.map((s) => s.name)).toEqual(['Ana', 'Ben', 'Cass'])
    expect(result.map((s) => s.place)).toEqual([1, 1, 3])
  })

  it('includes a player who never scored, at the bottom on zero', () => {
    const result = standings(players, { [ANA]: 4 })
    expect(result.map((s) => s.name)).toEqual(['Ana', 'Ben', 'Cass'])
    expect(result.map((s) => s.score)).toEqual([4, 0, 0])
    expect(result.map((s) => s.place)).toEqual([1, 2, 2])
  })

  it('handles a game where nobody scored at all', () => {
    const result = standings(players, {})
    expect(result.map((s) => s.place)).toEqual([1, 1, 1])
    expect(result.every((s) => s.score === 0)).toBe(true)
  })

  it('does not reorder the players it was handed', () => {
    const input = [player(ANA, 'Ana'), player(BEN, 'Ben')]
    standings(input, { [ANA]: 1, [BEN]: 5 })
    expect(input.map((p) => p.name)).toEqual(['Ana', 'Ben'])
  })
})

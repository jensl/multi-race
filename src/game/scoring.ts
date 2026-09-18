/**
 * Who scored what, and in which order.
 *
 * Pure functions only. The host owns the authoritative tally, so keeping this
 * free of state means the one place that mutates a score is the round loop --
 * and the arithmetic can be reasoned about (and tested) without a session.
 */
import { HOST_PEER_ID, type ClientId } from '../session/types.ts'

/**
 * The identity a player is scored under.
 *
 * For a guest this is its `ClientId`; for the host it is `HOST_PEER_ID`, which
 * has no client id of its own because the host never appears in its own roster.
 *
 * **It is never a guest's `PeerId`.** A guest whose phone slept reattaches under
 * its persisted `ClientId`, and the host mints it a *new* `peerId` when it does
 * -- so scoring by peer id would reset a returning player to zero, and a
 * reattached player would appear twice in a standings table.
 */
export type PlayerId = ClientId | typeof HOST_PEER_ID

export type Scores = Record<string, number>

export interface Player {
  playerId: PlayerId
  name: string
}

export interface Award {
  playerId: PlayerId
  /** 0-based finishing order within the round. */
  rank: number
  points: number
}

/**
 * Points by finishing order. Everyone who answers correctly scores -- only the
 * order differs -- so a slower player is never shut out of a round.
 *
 * The last entry repeats because the fourth player scores the same as the
 * third; the table is shorter than the player cap only by intent.
 */
export const RANK_POINTS = [3, 2, 1, 1] as const

/**
 * The table stops at four players, which is `GAME.maxPlayers` -- one host plus
 * three guests, enforced at the session layer. The final entry repeats so that
 * the fourth player still scores something rather than being the only one who
 * played and earned nothing.
 */
export function pointsForRank(rank: number): number {
  return RANK_POINTS[rank] ?? RANK_POINTS[RANK_POINTS.length - 1] ?? 1
}

export function scoreOf(scores: Scores, playerId: PlayerId): number {
  return scores[playerId] ?? 0
}

/**
 * Applies one round's finishing order to the running totals.
 *
 * `order` is the players who answered correctly, in the order the host accepted
 * their answers. Anyone absent from it scored nothing this round, which is what
 * makes running out of time indistinguishable from never answering.
 */
export function awardRound(
  order: readonly PlayerId[],
  scores: Scores,
): { awards: Award[]; scores: Scores } {
  const next: Scores = { ...scores }
  const awards: Award[] = order.map((playerId, rank) => {
    const points = pointsForRank(rank)
    next[playerId] = scoreOf(next, playerId) + points
    return { playerId, rank, points }
  })
  return { awards, scores: next }
}

export interface Standing extends Player {
  score: number
  /** Competition ranking: 1, 2, 2, 4. Ties share a place and skip the next. */
  place: number
}

/**
 * Final standings, highest first. Ties share a place rather than being broken
 * arbitrarily -- two children who both answered every problem deserve the same
 * medal, and any tiebreak here would be inventing a result.
 */
export function standings(players: readonly Player[], scores: Scores): Standing[] {
  const ordered = [...players].sort((a, b) => scoreOf(scores, b.playerId) - scoreOf(scores, a.playerId))

  let place = 0
  let previousScore: number | null = null
  return ordered.map((player, index) => {
    const score = scoreOf(scores, player.playerId)
    if (score !== previousScore) {
      place = index + 1
      previousScore = score
    }
    return { ...player, score, place }
  })
}

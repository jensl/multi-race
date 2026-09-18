/**
 * The game's messages, and the parsers that stand between them and game state.
 *
 * Every `t` is prefixed `game:` so it can never collide with `RESERVED_TYPES`
 * (`session/types.ts`) -- a framework type arriving as a game message, or the
 * reverse, would be a genuinely confusing bug to chase.
 *
 * Two rules from the session README shape everything below:
 *
 *   - **No timestamps on the wire.** Deadlines travel as *durations*
 *     (`startsInMs`, `limitMs`) applied from local receipt. Cross-device clock
 *     comparison is exactly what the session layer was designed to avoid, and
 *     re-introducing it for a countdown would undo that for no gain -- on a LAN
 *     the difference between devices is single-digit milliseconds.
 *   - **Nothing from a guest is trusted.** The host validates every answer
 *     before it touches a score.
 *
 * One more rule that is not obvious from the session API: the host *relays* any
 * non-reserved type from a guest to everyone else, with `from` rewritten to that
 * guest. So a guest can put a well-formed `game:result` in front of every other
 * guest. Both ends therefore check the sender, not just the type: a guest drops
 * any `game:*` message that did not come from the host, and the host drops any
 * guest message that is not an answer. `host.on('message')` guarantees `from` is
 * truthful -- that is what makes the check possible.
 *
 * All of it travels on the default `control` channel. `game:round` and
 * `game:result` are ordered state transitions, and the `state` channel is
 * unreliable (`peer.ts`), so a dropped round message would silently stall a game.
 */
import { isProblem, type Problem } from './problem.ts'
import type { Award, Player, PlayerId, Scores, Standing } from './scoring.ts'

export const GAME = {
  start: 'game:start',
  round: 'game:round',
  progress: 'game:progress',
  result: 'game:result',
  over: 'game:over',
  players: 'game:players',
  answer: 'game:answer',
} as const

export type GameType = (typeof GAME)[keyof typeof GAME]

// ------------------------------------------------------------ host to everyone

export interface StartPayload {
  modeId: string
  /** Rounds in this game. Sent so a guest can render "3 of 10" before round one. */
  total: number
  /**
   * Everyone playing, host included.
   *
   * The host has no roster entry of its own (`host.ts` only adds guests), so
   * without this a guest could not name the host in a scoreboard or recognise
   * it in a progress list.
   */
  players: Player[]
}

/** Sent when someone joins or leaves mid-game. */
export type PlayersPayload = Player[]


export interface RoundPayload {
  roundId: string
  /** 0-based, for "Round 3 of 10". */
  index: number
  total: number
  problem: Problem
  /** Countdown before answering opens, so every phone starts together. */
  startsInMs: number
  limitMs: number
}

export interface ProgressPayload {
  roundId: string
  /** Who has answered correctly so far -- the only thing a guest may be told. */
  answered: PlayerId[]
}

export interface ResultPayload {
  roundId: string
  /** The correct answer, revealed only now that the round is over. */
  answer: number
  awards: Award[]
  scores: Scores
  /** True when the round ended on the clock rather than on everyone answering. */
  timedOut: boolean
}

export interface OverPayload {
  standings: Standing[]
}

// ------------------------------------------------------------- guest to host

export interface AnswerPayload {
  roundId: string
  value: number
}

// ------------------------------------------------------------------- parsing

const MAX_ID = 64

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v)
}

/** Bounded so a guest cannot send a megabyte of "round id" and be answered. */
function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID
}

/**
 * A guest's answer, validated.
 *
 * This is the one payload that arrives from an untrusted source, so it is
 * checked rather than cast: `value` must be a safe integer inside the mode's
 * answer range. A `NaN`, a string, a float, or `1e9` is dropped here rather than
 * reaching the round's tally.
 *
 * `maxAnswer` comes from the live mode; a negative answer is legal in principle
 * (a future subtraction mode) so the lower bound is the negative of it.
 */
export function parseAnswer(p: unknown, maxAnswer: number): AnswerPayload | null {
  if (!isRecord(p)) return null
  if (!isId(p.roundId)) return null
  if (!isInt(p.value)) return null
  if (Math.abs(p.value) > maxAnswer) return null
  return { roundId: p.roundId, value: p.value }
}

export function parseStart(p: unknown): StartPayload | null {
  if (!isRecord(p)) return null
  if (typeof p.modeId !== 'string' || p.modeId.length === 0 || p.modeId.length > MAX_ID) return null
  if (!isInt(p.total) || p.total < 1 || p.total > 100) return null
  const players = parsePlayers(p.players)
  if (!players) return null
  return { modeId: p.modeId, total: p.total, players }
}

/**
 * Host-to-guest payloads are parsed too, though the host is not an adversary.
 * A malformed one would otherwise render as `NaN × undefined` on a child's
 * screen, which is a worse failure than a dropped message.
 */
export function parseRound(p: unknown): RoundPayload | null {
  if (!isRecord(p)) return null
  if (!isId(p.roundId)) return null
  if (!isInt(p.index) || p.index < 0 || !isInt(p.total) || p.total < 1 || p.total > 100) return null
  if (!isProblem(p.problem)) return null
  if (!isNum(p.startsInMs) || p.startsInMs < 0 || p.startsInMs > 60_000) return null
  if (!isNum(p.limitMs) || p.limitMs <= 0 || p.limitMs > 300_000) return null
  return {
    roundId: p.roundId,
    index: p.index,
    total: p.total,
    problem: p.problem,
    startsInMs: p.startsInMs,
    limitMs: p.limitMs,
  }
}

export function parseProgress(p: unknown): ProgressPayload | null {
  if (!isRecord(p)) return null
  if (!isId(p.roundId)) return null
  if (!Array.isArray(p.answered)) return null
  const answered = p.answered.filter(isId)
  if (answered.length !== p.answered.length) return null
  return { roundId: p.roundId, answered }
}

export function parseResult(p: unknown): ResultPayload | null {
  if (!isRecord(p)) return null
  if (!isId(p.roundId)) return null
  if (!isInt(p.answer)) return null
  if (!Array.isArray(p.awards)) return null
  const awards: Award[] = []
  for (const raw of p.awards) {
    if (!isRecord(raw)) return null
    if (!isId(raw.playerId) || !isInt(raw.rank) || !isInt(raw.points)) return null
    awards.push({ playerId: raw.playerId, rank: raw.rank, points: raw.points })
  }
  if (!isRecord(p.scores)) return null
  const scores: Scores = {}
  for (const [key, value] of Object.entries(p.scores)) {
    if (!isInt(value)) return null
    scores[key] = value
  }
  return { roundId: p.roundId, answer: p.answer, awards, scores, timedOut: p.timedOut === true }
}

export function parseOver(p: unknown): OverPayload | null {
  if (!isRecord(p)) return null
  if (!Array.isArray(p.standings)) return null
  const out: Standing[] = []
  for (const raw of p.standings) {
    if (!isRecord(raw)) return null
    if (!isId(raw.playerId) || typeof raw.name !== 'string' || raw.name.length > MAX_ID) return null
    if (!isInt(raw.score) || !isInt(raw.place)) return null
    out.push({ playerId: raw.playerId, name: raw.name, score: raw.score, place: raw.place })
  }
  return { standings: out }
}

export function parsePlayers(p: unknown): Player[] | null {
  if (!Array.isArray(p)) return null
  const out: Player[] = []
  for (const raw of p) {
    if (!isRecord(raw)) return null
    if (!isId(raw.playerId)) return null
    if (typeof raw.name !== 'string' || raw.name.length > MAX_ID) return null
    out.push({ playerId: raw.playerId, name: raw.name })
  }
  return out
}

/**
 * A round id that cannot collide with an earlier game's.
 *
 * Rematches reuse the same session, so ids derived from the round index alone
 * would repeat across games -- and an answer already in flight from game one
 * would then look like an answer to game two's first round.
 *
 * The counter is module-level rather than per-controller so that it keeps
 * increasing even if a caller builds a fresh controller for a rematch.
 */
let gameNonce = 0

export function nextGameNonce(): number {
  gameNonce += 1
  return gameNonce
}

export function makeRoundId(nonce: number, index: number): string {
  return `g${nonce}-r${index}`
}

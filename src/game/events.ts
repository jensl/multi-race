/**
 * The events a running game emits, and the interface both roles present.
 *
 * The point of a shared vocabulary is that the host and the guest produce the
 * *same* events for the same moments, so one screen renders a game without
 * knowing which end it is on. The host is authoritative and the guest is told,
 * but "a round opened" looks identical from both sides -- which is what keeps
 * the multiplayer screen from being two screens wearing a trenchcoat.
 */
import type { Handler } from '../session/emitter.ts'
import type { HostGame } from './host-game.ts'
import type { Problem } from './problem.ts'
import type { Award, Player, PlayerId, Scores, Standing } from './scoring.ts'

/**
 * `countdown` is the "get ready" beat before answering opens. The problem is
 * known from the start of it -- every phone has it in hand so they open
 * together -- but nothing may be answered yet.
 */
export type GamePhase = 'idle' | 'countdown' | 'open' | 'result' | 'over'

export type GameEvent =
  /** A game (or a rematch) has begun. */
  | { t: 'started'; total: number; modeId: string; players: Player[] }
  /** A new problem is coming. Count it down; do not accept answers yet. */
  | { t: 'round'; index: number; total: number; problem: Problem; startsInMs: number; limitMs: number }
  /** Answering is open. */
  | { t: 'open'; index: number }
  /** Someone answered correctly. Carries the identity to mark done. */
  | { t: 'progress'; answered: PlayerId[] }
  /** This device's own answer, judged locally so the feedback is instant. */
  | { t: 'feedback'; kind: 'correct' | 'wrong'; value: number }
  /** The round is over. `answer` is revealed only now. */
  | { t: 'result'; result: ResultRound }
  /** The roster changed mid-game. */
  | { t: 'players'; players: Player[] }
  /** Final standings. */
  | { t: 'over'; standings: Standing[] }
  /** The game cannot continue -- the session went away. */
  | { t: 'aborted'; reason: string }

/** The round outcome as it reaches a renderer, on either side of the wire. */
export interface ResultRound {
  roundId: string
  answer: number
  awards: Award[]
  scores: Scores
  timedOut: boolean
}

export type GameEventMap = { [E in GameEvent as E['t']]: Omit<E, 't'> }

/**
 * What the game screen holds, whichever role built it.
 *
 * `playerId` is this device's own identity, so a screen can find itself in
 * `awards`, in a progress list, and in the final standings without the two
 * controllers having to agree on anything else.
 */
export interface GameSession {
  readonly role: 'host' | 'guest'
  readonly playerId: PlayerId
  readonly phase: GamePhase
  readonly total: number
  readonly players: readonly Player[]
  /** Identity of the round in play, or null before the first one. */
  readonly roundId: string | null
  /**
   * The problem in play, or null before the first round.
   *
   * Readable at any time on purpose: a screen built *after* a round was already
   * posed would otherwise have missed the event carrying it and show nothing.
   * The screen decides when to reveal it -- it is withheld until the countdown
   * ends -- but the controller is the one place it lives.
   */
  readonly problem: Problem | null
  /** This device's answer. Judged immediately; scored authoritatively. */
  submit(value: number): void
  /** Milliseconds left in the current phase -- the round limit, or the countdown. */
  remainingMs(): number
  stop(): void
  on<K extends keyof GameEventMap & string>(k: K, fn: Handler<GameEventMap[K]>): () => void
}

/**
 * Narrows a session to the host's -- the only one that can begin a game.
 *
 * `role` is the discriminant, so this is a narrowing rather than a cast, and it
 * keeps the "only the host may start" rule in one place instead of an
 * `as HostGame` at every call site.
 */
export function isHostGame(game: GameSession): game is HostGame {
  return game.role === 'host'
}

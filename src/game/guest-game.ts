/**
 * The guest's view of a game. It renders what the host says and answers to it.
 *
 * The guest judges its own answer before sending it. That is not a claim of
 * authority -- the host re-checks every value against the problem it posed and
 * ignores anything wrong -- it is a latency decision: a round trip to be told
 * "no" would cost the player a visible fraction of a ten-second round, and the
 * answer is already computable locally. So a wrong answer never reaches the
 * wire, and only a correct one is sent on to be ranked.
 *
 * Every message here is checked against `HOST_PEER_ID`. The transport will relay
 * a guest's `game:result` to the other guests, so the type alone proves nothing;
 * `from` is the host's own sanitized attribution and is the only thing that
 * distinguishes an instruction from a guest talking to its friends.
 */
import type { GuestSession } from '../session/guest.ts'
import { createEmitter } from '../session/emitter.ts'
import { HOST_ADDRESS, HOST_PEER_ID, type ClientId } from '../session/types.ts'
import { type GameClock, realClock } from './clock.ts'
import type { GameEventMap, GamePhase, GameSession } from './events.ts'
import { solve, type Problem } from './problem.ts'
import {
  GAME,
  parseOver,
  parsePlayers,
  parseProgress,
  parseResult,
  parseRound,
  parseStart,
  type RoundPayload,
} from './protocol.ts'
import type { Player } from './scoring.ts'

export interface GuestGameOptions {
  session: GuestSession
  /**
   * This device's player identity, captured once at start.
   *
   * `getClientId()` falls back to a fresh UUID when `sessionStorage` is
   * unavailable, so calling it twice can return two different ids -- and a
   * player who cannot find themselves in a scoreboard is worse than useless.
   */
  clientId: ClientId
  clock?: GameClock
}

export interface GuestGame extends GameSession {
  readonly role: 'guest'
}

export function createGuestGame(options: GuestGameOptions): GuestGame {
  const { session, clientId } = options
  const clock = options.clock ?? realClock
  const emitter = createEmitter<GameEventMap>()

  let phase: GamePhase = 'idle'
  let total = 0
  let players: Player[] = []
  let problem: Problem | null = null

  let roundId = ''
  let roundIndex = 0
  let roundOpensAt = 0
  let roundEndsAt = 0
  /** Set once this device has answered correctly; it is done for the round. */
  let selfDone = false

  let cancelCountdown: (() => void) | null = null
  let stopped = false

  function applyRound(payload: RoundPayload): void {
    roundId = payload.roundId
    roundIndex = payload.index
    total = payload.total
    problem = payload.problem
    selfDone = false
    phase = 'countdown'

    roundOpensAt = clock.now() + payload.startsInMs
    roundEndsAt = roundOpensAt + payload.limitMs

    emitter.emit('round', {
      index: payload.index,
      total: payload.total,
      problem: payload.problem,
      startsInMs: payload.startsInMs,
      limitMs: payload.limitMs,
    })

    cancelCountdown?.()
    const forRound = roundId
    cancelCountdown = clock.after(payload.startsInMs, () => {
      cancelCountdown = null
      if (stopped || roundId !== forRound || phase !== 'countdown') return
      phase = 'open'
      emitter.emit('open', { index: roundIndex })
    })
  }

  const offMessage = session.on('message', ({ env }) => {
    // Only the host may drive this game.
    if (env.from !== HOST_PEER_ID) return

    switch (env.t) {
      case GAME.start: {
        const start = parseStart(env.p)
        if (!start) return
        total = start.total
        players = start.players
        // Deliberately not `countdown`: the countdown belongs to a round, and its
        // length arrives with the round. This message alone means "a game exists";
        // a device that joined mid-game sits here until the next round reaches it.
        phase = 'idle'
        emitter.emit('started', { total: start.total, modeId: start.modeId, players: start.players })
        return
      }
      case GAME.round: {
        const payload = parseRound(env.p)
        if (payload) applyRound(payload)
        return
      }
      case GAME.progress: {
        const progress = parseProgress(env.p)
        // A progress note for a round that is already over is stale, not news.
        if (progress && progress.roundId === roundId) {
          emitter.emit('progress', { answered: progress.answered })
        }
        return
      }
      case GAME.result: {
        const result = parseResult(env.p)
        if (!result || result.roundId !== roundId) return
        phase = 'result'
        cancelCountdown?.()
        cancelCountdown = null
        emitter.emit('result', { result })
        return
      }
      case GAME.players: {
        const list = parsePlayers(env.p)
        if (list) {
          players = list
          emitter.emit('players', { players: list })
        }
        return
      }
      case GAME.over: {
        const over = parseOver(env.p)
        if (!over) return
        phase = 'over'
        cancelCountdown?.()
        cancelCountdown = null
        emitter.emit('over', { standings: over.standings })
        return
      }
      default:
        return
    }
  })

  const offClosed = session.on('closed', () => {
    if (stopped) return
    stopped = true
    cancelCountdown?.()
    cancelCountdown = null
    emitter.emit('aborted', { reason: 'The host ended the game.' })
  })

  return {
    role: 'guest',
    playerId: clientId,
    get phase() {
      return phase
    },
    get total() {
      return total
    },
    get players() {
      return players
    },
    get roundId() {
      return roundId === '' ? null : roundId
    },
    get problem() {
      return problem
    },

    submit(value: number): void {
      if (phase !== 'open' || !problem || selfDone) return
      // Past the local deadline the host would reject it anyway; stopping here
      // saves a player the confusion of an answer that visibly landed and then
      // did not count.
      if (clock.now() > roundEndsAt) return
      if (value !== solve(problem)) {
        emitter.emit('feedback', { kind: 'wrong', value })
        return
      }
      selfDone = true
      emitter.emit('feedback', { kind: 'correct', value })
      session.send(HOST_ADDRESS, GAME.answer, { roundId, value })
    },

    remainingMs(): number {
      const now = clock.now()
      if (phase === 'countdown') return Math.max(0, roundOpensAt - now)
      if (phase === 'open') return Math.max(0, roundEndsAt - now)
      return 0
    },

    stop(): void {
      stopped = true
      cancelCountdown?.()
      cancelCountdown = null
      offMessage()
      offClosed()
    },

    on: emitter.on,
  }
}

/**
 * The host's round loop. The host is the only authority on who answered first.
 *
 * Three things shape this file more than anything else:
 *
 * **The host never receives its own broadcasts.** `@all` excludes the sender by
 * design, and the host is not a peer at all -- `host.send(HOST_PEER_ID, ...)`
 * fails with `unknown-peer`. So every state change is applied twice: once to the
 * guests over the wire, once to this device through its own emitter. The host is
 * a player like anyone else, and its own answer takes the same path through
 * `acceptAnswer` as a guest's, so its rank is not privileged by a special case.
 *
 * **Order is decided by arrival, not by anything a guest claims.** `env.ts` is
 * stamped by the host at the moment it sanitizes an inbound envelope, so sorting
 * by it is sorting by arrival. A monotonic counter over arrivals says the same
 * thing more directly and gives the host's own answer a well-defined position
 * without threading an envelope through.
 *
 * **A round's field of play is frozen when it opens.** `participants` is
 * captured at round start and never grows, so a player who joins mid-round
 * cannot barge in and take rank one, and a player who drops never holds the
 * round open -- they move to `absent`, which removes them from the wait without
 * touching their score.
 */
import type { HostSession } from '../session/host.ts'
import { createEmitter } from '../session/emitter.ts'
import { HOST_PEER_ID, type ClientId, type PeerId } from '../session/types.ts'
import { GAME as TUNABLES } from './config.ts'
import { type GameClock, realClock } from './clock.ts'
import type { GameEventMap, GamePhase, GameSession } from './events.ts'
import { generateProblem, solve, type GameMode, type Problem } from './problem.ts'
import {
  GAME,
  makeRoundId,
  nextGameNonce,
  parseAnswer,
  type ResultPayload,
  type RoundPayload,
} from './protocol.ts'
import { awardRound, standings, type Player, type PlayerId, type Scores } from './scoring.ts'
import { mulberry32, randomSeed, type Rng } from './rng.ts'

export interface HostGameOptions {
  session: HostSession
  mode: GameMode
  hostName?: string
  clock?: GameClock
  seed?: number
  rounds?: number
  roundLimitMs?: number
  countdownMs?: number
  resultMs?: number
  graceMs?: number
}

export interface HostGame extends GameSession {
  readonly role: 'host'
  /** Begins a game, or a rematch. Scores are zeroed either way. */
  start(): void
}

export function createHostGame(options: HostGameOptions): HostGame {
  const { session, mode } = options
  const clock = options.clock ?? realClock
  const hostName = options.hostName ?? 'Host'
  const rounds = options.rounds ?? TUNABLES.rounds
  const roundLimitMs = options.roundLimitMs ?? TUNABLES.roundLimitMs
  const countdownMs = options.countdownMs ?? TUNABLES.countdownMs
  const resultMs = options.resultMs ?? TUNABLES.resultMs
  const graceMs = options.graceMs ?? TUNABLES.answerGraceMs

  const emitter = createEmitter<GameEventMap>()
  const rng: Rng = mulberry32(options.seed ?? randomSeed())

  /** Names outlive roster entries -- `dropPeer` deletes the entry on a disconnect. */
  const names = new Map<PlayerId, string>([[HOST_PEER_ID, hostName]])
  /** Everyone who has been in this game, so a leaver still appears in the result. */
  const played = new Map<PlayerId, string>()
  /** The roster is already pruned when `peer-left` fires, so we keep our own map. */
  const clientOf = new Map<PeerId, ClientId>()

  let phase: GamePhase = 'idle'
  let nonce = 0
  let roundIndex = 0
  let roundId = ''
  let problem: Problem | null = null
  let previous: Problem | undefined
  let scores: Scores = {}

  // --- per round ---
  let participants = new Set<PlayerId>()
  let absent = new Set<PlayerId>()
  let correct = new Set<PlayerId>()
  let order: PlayerId[] = []
  let roundOpensAt = 0
  let roundEndsAt = 0

  let cancelCountdown: (() => void) | null = null
  let cancelDeadline: (() => void) | null = null
  let cancelNextRound: (() => void) | null = null
  let stopped = false

  // Seed from whoever is already here. `peer-joined` only fires for guests that
  // arrive *after* this controller exists, and the lobby may well have seated
  // them first -- without this a game built after the lobby would recognise no
  // peers at all and silently discard every answer it received.
  for (const entry of session.roster) {
    clientOf.set(entry.peerId, entry.clientId)
    names.set(entry.clientId, entry.name ?? 'Player')
  }

  function cancelTimers(): void {
    cancelCountdown?.()
    cancelDeadline?.()
    cancelNextRound?.()
    cancelCountdown = null
    cancelDeadline = null
    cancelNextRound = null
  }

  /** Who is here right now. The host is a player and is never in its own roster. */
  function connectedPlayers(): Player[] {
    const list: Player[] = [{ playerId: HOST_PEER_ID, name: hostName }]
    for (const entry of session.roster) {
      list.push({ playerId: entry.clientId, name: names.get(entry.clientId) ?? 'Player' })
    }
    return list
  }

  function remember(player: Player): void {
    names.set(player.playerId, player.name)
    played.set(player.playerId, player.name)
  }

  /** True once nobody is left to wait for. An empty set of the awaited is vacuously done. */
  function roundComplete(): boolean {
    for (const playerId of participants) {
      if (absent.has(playerId)) continue
      if (!correct.has(playerId)) return false
    }
    return true
  }

  function endRound(timedOut: boolean): void {
    if (phase !== 'open' && phase !== 'countdown') return
    cancelCountdown?.()
    cancelDeadline?.()
    cancelCountdown = null
    cancelDeadline = null
    phase = 'result'

    const outcome = awardRound(order, scores)
    scores = outcome.scores
    const result: ResultPayload = {
      roundId,
      answer: problem ? solve(problem) : 0,
      awards: outcome.awards,
      scores,
      timedOut,
    }
    session.broadcast(GAME.result, result)
    emitter.emit('result', { result })

    const last = roundIndex + 1 >= rounds
    const forRound = roundId
    cancelNextRound = clock.after(resultMs, () => {
      cancelNextRound = null
      if (stopped || roundId !== forRound) return
      if (last) finish()
      else beginRound(roundIndex + 1)
    })
  }

  /** Records a correct answer. Returns false for anything not counted. */
  function acceptAnswer(playerId: PlayerId, value: number): boolean {
    if (phase !== 'open' || !problem) return false
    // Not a participant means someone who arrived after this round began. Letting
    // them in would hand rank one to a player who never saw the problem start.
    if (!participants.has(playerId)) return false
    if (correct.has(playerId)) return false
    if (clock.now() > roundEndsAt + graceMs) return false
    if (value !== solve(problem)) return false

    correct.add(playerId)
    order.push(playerId)
    const answered = [...correct]
    session.broadcast(GAME.progress, { roundId, answered })
    emitter.emit('progress', { answered })

    if (roundComplete()) endRound(false)
    return true
  }

  function beginRound(index: number): void {
    if (stopped) return
    roundIndex = index
    roundId = makeRoundId(nonce, index)
    problem = generateProblem(mode, rng, previous)
    previous = problem

    // Frozen now and not reconsidered: see the note at the top of the file.
    participants = new Set(connectedPlayers().map((p) => p.playerId))
    absent = new Set()
    correct = new Set()
    order = []

    roundOpensAt = clock.now() + countdownMs
    roundEndsAt = roundOpensAt + roundLimitMs
    phase = 'countdown'

    const payload: RoundPayload = {
      roundId,
      index,
      total: rounds,
      problem,
      startsInMs: countdownMs,
      limitMs: roundLimitMs,
    }
    session.broadcast(GAME.round, payload)
    emitter.emit('round', { index, total: rounds, problem, startsInMs: countdownMs, limitMs: roundLimitMs })

    // Every callback checks the round it was armed for. Without that, round N's
    // deadline firing during round N's own result would open round N+1 already
    // expired, and every round after it would collapse in sequence.
    const forRound = roundId
    cancelCountdown = clock.after(countdownMs, () => {
      cancelCountdown = null
      if (stopped || roundId !== forRound || phase !== 'countdown') return
      phase = 'open'
      emitter.emit('open', { index })
      cancelDeadline = clock.after(roundLimitMs + graceMs, () => {
        cancelDeadline = null
        if (stopped || roundId !== forRound || phase !== 'open') return
        endRound(true)
      })
    })
  }

  function finish(): void {
    cancelTimers()
    phase = 'over'
    const final = standings(
      [...played].map(([playerId, name]) => ({ playerId, name })),
      scores,
    )
    session.broadcast(GAME.over, { standings: final })
    emitter.emit('over', { standings: final })
  }

  function abort(reason: string): void {
    cancelTimers()
    phase = 'over'
    emitter.emit('aborted', { reason })
  }

  // ------------------------------------------------------------ session wiring

  session.on('peer-joined', ({ peerId, entry }) => {
    clientOf.set(peerId, entry.clientId)
    const player = { playerId: entry.clientId, name: entry.name ?? 'Player' }
    remember(player)
    emitter.emit('players', { players: connectedPlayers() })

    if (phase === 'idle' || phase === 'over') return

    // Joined mid-game: a fresh QR ceremony takes far longer than one round, so
    // they cannot meaningfully be placed into this one. They are told the state
    // of play and picked up by the next `beginRound`.
    session.send(peerId, GAME.players, connectedPlayers())
    session.send(peerId, GAME.start, {
      modeId: mode.id,
      total: rounds,
      players: connectedPlayers(),
    })
  })

  session.on('peer-left', ({ peerId }) => {
    const clientId = clientOf.get(peerId)
    clientOf.delete(peerId)
    if (!clientId) return

    const stillHere = phase === 'idle' || phase === 'over'
    if (!stillHere) {
      // Drop out of the wait without touching the score -- and never un-mark the
      // absence on a rejoin, because a player who was gone never saw the problem.
      if (participants.has(clientId)) {
        absent.add(clientId)
        if (roundComplete()) endRound(false)
      }
    }
    emitter.emit('players', { players: connectedPlayers() })

    // A game of one is not a game. `phase !== 'idle'` rather than "still
    // playing" on purpose: it has to fire from the results screen too, or the
    // host is left offering a rematch to an empty room -- `start()` refuses an
    // empty roster, so the button simply does nothing when pressed.
    if (phase !== 'idle' && session.roster.length === 0) abort('Everyone else left the game.')
  })

  session.on('message', ({ peerId, env }) => {
    // The transport relays any non-reserved type from a guest to everyone, so a
    // guest could put a `game:result` in front of the other guests. Only answers
    // are ever accepted from this side.
    if (env.t !== GAME.answer) return
    const clientId = clientOf.get(peerId)
    if (!clientId) return
    const answer = parseAnswer(env.p, mode.maxAnswer)
    if (!answer) return
    // Belt and braces on top of the phase check in `acceptAnswer`: a late answer
    // carries the round it was meant for, and a stale one must not score.
    if (answer.roundId !== roundId) return
    acceptAnswer(clientId, answer.value)
  })

  function start(): void {
    if (phase !== 'idle' && phase !== 'over') return
    if (session.roster.length === 0) return
    if (stopped) return

    cancelTimers()
    nonce = nextGameNonce()
    scores = {}
    played.clear()
    for (const player of connectedPlayers()) remember(player)

    session.broadcast(GAME.start, {
      modeId: mode.id,
      total: rounds,
      players: connectedPlayers(),
    })
    emitter.emit('started', {
      total: rounds,
      modeId: mode.id,
      players: connectedPlayers(),
    })
    beginRound(0)
  }

  return {
    role: 'host',
    playerId: HOST_PEER_ID,
    get phase() {
      return phase
    },
    get total() {
      return rounds
    },
    get players() {
      return connectedPlayers()
    },
    get roundId() {
      return roundId === '' ? null : roundId
    },
    get problem() {
      return problem
    },

    submit(value: number): void {
      if (phase !== 'open' || !problem) return
      if (correct.has(HOST_PEER_ID)) return
      if (value !== solve(problem)) {
        emitter.emit('feedback', { kind: 'wrong', value })
        return
      }
      emitter.emit('feedback', { kind: 'correct', value })
      acceptAnswer(HOST_PEER_ID, value)
    },

    remainingMs(): number {
      const now = clock.now()
      if (phase === 'countdown') return Math.max(0, roundOpensAt - now)
      if (phase === 'open') return Math.max(0, roundEndsAt - now)
      return 0
    },

    stop(): void {
      stopped = true
      cancelTimers()
    },

    on: emitter.on,
    start,
  }
}

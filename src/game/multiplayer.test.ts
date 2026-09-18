/**
 * The whole game, over the real session layer.
 *
 * A real `HostSession` and real `GuestSession`s, linked through the fake peer
 * connections the session suite already uses, driven by the real host and guest
 * controllers. The QR ceremony is the genuine article: both sides run
 * `createCodeSignaler`, and codes travel the long way round through a scripted
 * channel rather than being handed across by the test. Only the camera and the
 * screen are replaced.
 *
 * This is the readiness check for the game layer. Everything the two controllers
 * have to agree on -- which problem, who answered first, when a round is over,
 * what a score is -- is only really exercised when both ends are running.
 *
 * The game's own timers come from one `ManualClock` shared by every controller,
 * so a ten-round game costs no wall-clock time. The session's internal timers
 * stay real and untouched; the two do not interfere, because the game only ever
 * asks its injected clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GuestSession } from '../session/guest.ts'
import { createHostSession, type HostSession } from '../session/host.ts'
import { createCodeSignaler } from '../session/signaler.ts'
import { installFakeRtc, tick, until } from '../session/test-support/fakes.ts'
import { ALL_ADDRESS, HOST_ADDRESS, type ClientId } from '../session/types.ts'
import { GAME as TUNABLES } from './config.ts'
import type { GameSession, ResultRound } from './events.ts'
import { createGuestGame, type GuestGame } from './guest-game.ts'
import { createHostGame, type HostGame } from './host-game.ts'
import { findMode, solve, type GameMode, type Problem } from './problem.ts'
import { GAME } from './protocol.ts'
import type { Standing } from './scoring.ts'
import { joinGuest } from './test-support/lobby.ts'
import { manualClock, type ManualClock } from './test-support/manual-clock.ts'
import { scriptedChannel, type ScriptedCodeChannel } from './test-support/scripted-channel.ts'

/** Fixed so every run poses the same problems, and a failure is reproducible. */
const SEED = 20_260_912

function multiply(): GameMode {
  const found = findMode('multiply')
  if (!found) throw new Error('the multiply mode is missing')
  return found
}

/** Everything one device's screen would have rendered over a game. */
interface Feed {
  problems: Problem[]
  results: ResultRound[]
  /** One table per game, so a rematch shows up as a second entry. */
  standings: Standing[][]
  feedback: Array<'correct' | 'wrong'>
  aborted: string[]
  opens: number
  /** Games begun, rematches included. */
  starts: number
}

function watch(game: GameSession): Feed {
  const f: Feed = {
    problems: [],
    results: [],
    standings: [],
    feedback: [],
    aborted: [],
    opens: 0,
    starts: 0,
  }
  game.on('started', () => {
    f.starts += 1
  })
  game.on('round', ({ problem }) => f.problems.push(problem))
  game.on('result', ({ result }) => f.results.push(result))
  game.on('over', ({ standings }) => f.standings.push(standings))
  game.on('feedback', ({ kind }) => f.feedback.push(kind))
  game.on('aborted', ({ reason }) => f.aborted.push(reason))
  game.on('open', () => {
    f.opens += 1
  })
  return f
}

interface Limits {
  rounds: number
  roundLimitMs: number
  countdownMs: number
  resultMs: number
}

interface Room extends Limits {
  host: HostSession
  sessions: GuestSession[]
  clientIds: ClientId[]
  channels: ScriptedCodeChannel[]
  hostGame: HostGame
  guestGames: GuestGame[]
  games: GameSession[]
  feeds: Feed[]
  clock: ManualClock
}

interface RoomOptions extends Partial<Limits> {
  guests?: number
}

// Sessions live for the length of one test; `afterEach` closes them so the
// host's 5s sweep interval does not outlive the test that armed it.
let restore: () => void
let open: Array<{ host?: HostSession; guest?: GuestSession }> = []

beforeEach(() => {
  restore = installFakeRtc()
  open = []
})

afterEach(() => {
  for (const s of open) {
    s.host?.close('local')
    s.guest?.leave('local')
  }
  restore()
})

/** A started host, N joined guests, and a game controller on every device. */
async function makeRoom(options: RoomOptions = {}): Promise<Room> {
  const limits: Limits = {
    rounds: options.rounds ?? TUNABLES.rounds,
    roundLimitMs: options.roundLimitMs ?? TUNABLES.roundLimitMs,
    countdownMs: options.countdownMs ?? TUNABLES.countdownMs,
    resultMs: options.resultMs ?? TUNABLES.resultMs,
  }
  const clock = manualClock()

  const host = createHostSession({
    signaler: createCodeSignaler(scriptedChannel()),
    iceServers: [],
    // The cap counts peers, and the host is not one, so three guests is a full
    // house. Without this the session would happily seat eight.
    maxPeers: TUNABLES.maxPlayers - 1,
    name: 'Host',
  })
  await host.start()
  open.push({ host })

  const joined = []
  for (let i = 0; i < (options.guests ?? 2); i++) {
    const guest = await joinGuest(host, { name: `Player ${i + 1}` })
    open.push({ guest: guest.guest })
    joined.push(guest)
  }

  const hostGame = createHostGame({
    session: host,
    mode: multiply(),
    clock,
    seed: SEED,
    hostName: 'Host',
    ...limits,
  })
  // One clock across every controller, so advancing it moves the whole room.
  const guestGames = joined.map((j) => createGuestGame({ session: j.guest, clientId: j.clientId, clock }))

  const games: GameSession[] = [hostGame, ...guestGames]
  return {
    ...limits,
    host,
    sessions: joined.map((j) => j.guest),
    clientIds: joined.map((j) => j.clientId),
    channels: joined.map((j) => j.channel),
    hostGame,
    guestGames,
    games,
    feeds: games.map(watch),
    clock,
  }
}

/** Starts the game and waits for every device to have seen the first problem. */
async function beginPlay(room: Room): Promise<Problem> {
  room.hostGame.start()
  await until(
    () => room.feeds.every((f) => f.problems.length >= 1),
    'the first round to reach every device',
  )
  const problem = room.feeds[0]?.problems[0]
  if (!problem) throw new Error('no problem was posed')
  return problem
}

/** Runs the countdown out, so answering is open everywhere. */
async function openRound(room: Room): Promise<void> {
  room.clock.advance(room.countdownMs)
  await until(
    () => room.games.every((g) => g.phase === 'open'),
    'every device to open the round',
  )
}

/** The host's score for a guest, which is keyed by ClientId rather than PeerId. */
function scoreFor(room: Room, result: ResultRound | undefined, guest: number): number | undefined {
  const clientId = room.clientIds[guest]
  return clientId === undefined ? undefined : result?.scores[clientId]
}

describe('posing a problem', () => {
  it('shows every device the same problem', async () => {
    const room = await makeRoom({ guests: 2 })
    const problem = await beginPlay(room)

    expect(room.feeds).toHaveLength(3)
    for (const f of room.feeds) expect(f.problems[0]).toEqual(problem)
  })

  it('withholds the answer until the round is over', async () => {
    const room = await makeRoom({ guests: 1 })
    const problem = await beginPlay(room)
    await openRound(room)

    for (const f of room.feeds) expect(f.results).toHaveLength(0)

    room.guestGames[0]?.submit(solve(problem))
    room.hostGame.submit(solve(problem))
    await until(() => room.feeds[1]?.results.length === 1, 'the round result')

    expect(room.feeds[1]?.results[0]?.answer).toBe(solve(problem))
  })
})

describe('deciding who was first', () => {
  it('ranks by arrival order and pays 3, 2, 1 down it', async () => {
    const room = await makeRoom({ guests: 2 })
    const problem = await beginPlay(room)
    await openRound(room)

    // Deliberately not the order the players are seated in.
    room.guestGames[1]?.submit(solve(problem))
    await tick()
    room.guestGames[0]?.submit(solve(problem))
    await tick()
    room.hostGame.submit(solve(problem))
    await until(() => room.feeds[0]?.results.length === 1, 'the round result')

    const awards = room.feeds[0]?.results[0]?.awards ?? []
    expect(awards.map((a) => a.playerId)).toEqual([room.clientIds[1], room.clientIds[0], 'host'])
    expect(awards.map((a) => a.points)).toEqual([3, 2, 1])
  })

  it('gives the host no advantage beyond having answered when it answered', async () => {
    const room = await makeRoom({ guests: 1 })
    const problem = await beginPlay(room)
    await openRound(room)

    // The guest answers first, and the host's own answer is judged through the
    // same path as anyone else's -- so the host comes second, not first.
    room.guestGames[0]?.submit(solve(problem))
    await tick()
    room.hostGame.submit(solve(problem))
    await until(() => room.feeds[0]?.results.length === 1, 'the round result')

    const awards = room.feeds[0]?.results[0]?.awards ?? []
    expect(awards[0]?.playerId).toBe(room.clientIds[0])
    expect(awards[1]?.playerId).toBe('host')
  })

  it('ignores a device answering a round that is already finished', async () => {
    const room = await makeRoom({ guests: 1, rounds: 2, roundLimitMs: 60_000 })
    const first = await beginPlay(room)
    await openRound(room)

    room.guestGames[0]?.submit(solve(first))
    await tick()
    room.hostGame.submit(solve(first))
    await until(() => room.feeds[0]?.results.length === 1, 'round one to finish')

    const stale = room.feeds[0]?.results[0]?.roundId
    if (!stale) throw new Error('no round id')

    room.clock.advance(room.resultMs + room.countdownMs)
    await until(() => room.feeds[0]!.problems.length >= 2, 'round two')
    await openRound(room)

    // A straggler from round one turns up after round two has opened.
    room.sessions[0]?.send(HOST_ADDRESS, GAME.answer, { roundId: stale, value: 999 })
    await tick()

    const second = room.feeds[0]?.problems[1]
    if (!second) throw new Error('no second problem')
    room.guestGames[0]?.submit(solve(second))
    await tick()
    room.hostGame.submit(solve(second))
    await until(() => room.feeds[0]?.results.length === 2, 'round two to finish')

    // The stale answer earned nothing: round two was won by the real answer.
    expect(room.feeds[0]?.results[1]?.awards.map((a) => a.playerId)).toEqual([
      room.clientIds[0],
      'host',
    ])
  })
})

describe('judging an answer', () => {
  it('gives a wrong answer no score and lets the player try again', async () => {
    const room = await makeRoom({ guests: 1, roundLimitMs: 60_000 })
    const problem = await beginPlay(room)
    await openRound(room)

    const guest = room.guestGames[0]
    const guestFeed = room.feeds[1]
    guest?.submit(solve(problem) + 1)
    expect(guestFeed?.feedback).toEqual(['wrong'])
    expect(room.feeds[0]?.results).toHaveLength(0)

    guest?.submit(solve(problem))
    expect(guestFeed?.feedback).toEqual(['wrong', 'correct'])
    await tick()
    room.hostGame.submit(solve(problem))
    await until(() => room.feeds[0]?.results.length === 1, 'the round result')
    expect(scoreFor(room, room.feeds[0]?.results[0], 0)).toBe(3)
  })

  it('refuses a value the mode could not have posed', async () => {
    const room = await makeRoom({ guests: 1, roundLimitMs: 60_000 })
    const problem = await beginPlay(room)
    await openRound(room)

    const roundId = room.hostGame.roundId
    if (!roundId) throw new Error('no live round')

    // A guest may send anything at all. None of it may reach the tally.
    for (const value of ['56', 1e9, 5.5, null, true, { value: 56 }]) {
      room.sessions[0]?.send(HOST_ADDRESS, GAME.answer, { roundId, value })
    }
    room.sessions[0]?.send(HOST_ADDRESS, GAME.answer, { value: solve(problem) })
    await tick()

    expect(room.feeds[0]?.results).toHaveLength(0)
    expect(room.hostGame.phase).toBe('open')

    // And the round is not wedged: a real answer still lands.
    room.hostGame.submit(solve(problem))
    await tick()
    room.guestGames[0]?.submit(solve(problem))
    await until(() => room.feeds[0]?.results.length === 1, 'the round result')
    expect(room.feeds[0]?.results[0]?.answer).toBe(solve(problem))
  })

  it("does not let one guest's message drive another guest", async () => {
    const room = await makeRoom({ guests: 2 })
    await beginPlay(room)
    await openRound(room)

    // The transport relays this to the other guest with `from` rewritten, so it
    // arrives shaped exactly like an instruction from the host. Only `from`
    // distinguishes the two.
    room.sessions[0]?.send(ALL_ADDRESS, GAME.result, {
      roundId: room.hostGame.roundId,
      answer: 12345,
      awards: [{ playerId: 'x', rank: 0, points: 99 }],
      scores: { x: 99 },
      timedOut: false,
    })
    await tick()

    expect(room.feeds[2]?.results).toHaveLength(0)
    expect(room.feeds[2]?.standings).toHaveLength(0)
  })
})

describe('ending a round', () => {
  it('ends as soon as everyone has answered, without waiting out the clock', async () => {
    const room = await makeRoom({ guests: 1, roundLimitMs: 60_000 })
    const problem = await beginPlay(room)
    await openRound(room)

    room.guestGames[0]?.submit(solve(problem))
    await tick()
    room.hostGame.submit(solve(problem))
    await until(() => room.feeds[0]?.results.length === 1, 'the round result')

    expect(room.feeds[0]?.results[0]?.timedOut).toBe(false)
    // Not a tick past the countdown has passed: the early end closed the round,
    // with a whole minute still on its clock.
    expect(room.clock.now()).toBe(room.countdownMs)
  })

  it('times out when a player never answers, and scores them nothing', async () => {
    const room = await makeRoom({ guests: 2, roundLimitMs: 5000 })
    const problem = await beginPlay(room)
    await openRound(room)

    room.guestGames[0]?.submit(solve(problem))
    await tick()
    room.hostGame.submit(solve(problem))
    await tick()
    // Still open: nobody is waiting on the second guest to be told anything.
    expect(room.feeds[0]?.results).toHaveLength(0)

    // Walk to just past the deadline, allowance for a late answer included.
    room.clock.advance(5000 + TUNABLES.answerGraceMs)
    await until(() => room.feeds[0]?.results.length === 1, 'the timed-out result')

    const result = room.feeds[0]?.results[0]
    expect(result?.timedOut).toBe(true)
    expect(scoreFor(room, result, 0)).toBe(3)
    expect(scoreFor(room, result, 1)).toBeUndefined()
  })

  it('still counts an answer that lands after the clock ran out', async () => {
    const room = await makeRoom({ guests: 1, roundLimitMs: 5000 })
    const problem = await beginPlay(room)
    await openRound(room)

    // The guest's window opened when the round reached it, which is after the
    // host's did -- so it answers on its own deadline, and the message is still
    // in flight as the host's clock passes the same mark. Without the allowance
    // the round would already have closed on the host and dropped it.
    room.clock.advance(5000)
    room.guestGames[0]?.submit(solve(problem))
    room.clock.advance(TUNABLES.answerGraceMs - 1)
    await tick()

    // It counted: the round is still open only because the host has yet to
    // answer, and the guest is already marked done. Without the allowance the
    // round would have closed on the host's clock and dropped the answer.
    room.hostGame.submit(solve(problem))
    await until(() => room.feeds[0]?.results.length === 1, 'the round result')

    const result = room.feeds[0]?.results[0]
    expect(result?.timedOut).toBe(false)
    expect(result?.awards[0]?.playerId).toBe(room.clientIds[0])
  })

  it('stops waiting on a player who drops mid-round', async () => {
    const room = await makeRoom({ guests: 2, roundLimitMs: 60_000 })
    const problem = await beginPlay(room)
    await openRound(room)

    room.guestGames[0]?.submit(solve(problem))
    await tick()
    room.hostGame.submit(solve(problem))
    await tick()
    expect(room.feeds[0]?.results).toHaveLength(0)

    // `kick` is the host's own drop path -- the same one a peer's liveness
    // timeout and a real connection loss both funnel through. Driving it
    // directly is necessary here because the fake peer connection does not
    // propagate one side closing to the other.
    const dropped = room.sessions[1]?.peerId
    if (!dropped) throw new Error('no peer id for the second guest')
    room.host.kick(dropped)
    await until(() => room.feeds[0]?.results.length === 1, 'the round to close on the drop')

    const result = room.feeds[0]?.results[0]
    expect(result?.timedOut).toBe(false)
    // The player who left kept no score for a round they never finished.
    expect(scoreFor(room, result, 1)).toBeUndefined()
  })

  it('aborts rather than playing on to an empty room', async () => {
    const room = await makeRoom({ guests: 1, roundLimitMs: 60_000 })
    await beginPlay(room)
    await openRound(room)

    const only = room.sessions[0]?.peerId
    if (!only) throw new Error('no peer id for the guest')
    room.host.kick(only)
    await until(() => room.feeds[0]?.aborted.length === 1, 'the abort')
    expect(room.feeds[0]?.aborted[0]).toMatch(/left/i)
  })

  it('does not let a player who arrived mid-round answer it', async () => {
    const room = await makeRoom({ guests: 1, roundLimitMs: 60_000 })
    const problem = await beginPlay(room)
    await openRound(room)

    const roundId = room.hostGame.roundId
    if (!roundId) throw new Error('no live round')

    const latecomer = await joinGuest(room.host, { name: 'Latecomer' })
    open.push({ guest: latecomer.guest })
    await tick()

    // Their answer is well-formed and correct, and still must not count: they
    // never saw the problem start, so they cannot be ranked against it.
    latecomer.guest.send(HOST_ADDRESS, GAME.answer, { roundId, value: solve(problem) })
    await tick()
    expect(room.feeds[0]?.results).toHaveLength(0)

    // The next round does pick them up. This one first has to end, and since the
    // seated guest never answered it can only end on the clock.
    room.clock.advance(room.roundLimitMs + TUNABLES.answerGraceMs)
    await until(() => room.feeds[0]!.results.length === 1, 'the first round to time out')
    room.clock.advance(room.resultMs)
    await until(() => room.feeds[0]!.problems.length >= 2, 'the next round')
    expect(room.hostGame.players.map((p) => p.name)).toContain('Latecomer')
  })
})

describe('a whole game', () => {
  async function playToTheEnd(room: Room): Promise<void> {
    for (let round = 0; round < room.rounds; round++) {
      if (round === 0) await beginPlay(room)
      else {
        room.clock.advance(room.resultMs)
        await until(() => room.feeds[0]!.problems.length >= round + 1, `round ${round + 1}`)
      }
      await openRound(room)

      const problem = room.feeds[0]?.problems[round]
      if (!problem) throw new Error(`no problem for round ${round}`)
      // Everyone answers, in seat order, so the round can close early.
      for (const guest of room.guestGames) {
        guest.submit(solve(problem))
        await tick()
      }
      room.hostGame.submit(solve(problem))
      await until(() => room.feeds[0]!.results.length === round + 1, `result ${round + 1}`)
    }
    room.clock.advance(room.resultMs)
    await until(() => room.feeds[0]!.standings.length === 1, 'the final standings')
  }

  it('runs ten rounds to a standings table every device agrees on', async () => {
    const room = await makeRoom({ guests: 2, roundLimitMs: 60_000 })
    await playToTheEnd(room)

    const standings = room.feeds[0]?.standings[0] ?? []
    // The finishing order is the same every round, so ten rounds of 3/2/1 land
    // on 30/20/10 in seat order.
    expect(standings.map((s) => s.name)).toEqual(['Player 1', 'Player 2', 'Host'])
    expect(standings.map((s) => s.score)).toEqual([30, 20, 10])
    expect(standings.map((s) => s.place)).toEqual([1, 2, 3])

    // And every device was told the same table, not just the host.
    expect(room.feeds[1]?.standings[0]).toEqual(standings)
    expect(room.feeds[2]?.standings[0]).toEqual(standings)
  })

  it('resets the scores on a rematch, over the same connections', async () => {
    const room = await makeRoom({ guests: 1, rounds: 1, roundLimitMs: 60_000 })
    await playToTheEnd(room)
    expect(room.feeds[0]?.standings[0]?.map((s) => s.score)).toEqual([3, 2])

    const peersBefore = room.host.peerCount
    room.hostGame.start()
    await until(() => room.feeds[0]!.problems.length >= 2, 'the rematch to begin')
    // A rematch is not a re-handshake: nobody re-joins.
    expect(room.host.peerCount).toBe(peersBefore)

    // Every device is told a new game began. The guest's results screen has
    // nothing else to go on -- it is the only signal that a rematch happened,
    // and a screen that stopped listening is how a guest waits forever on a game
    // that already started.
    for (const feed of room.feeds) expect(feed.starts).toBe(2)

    await openRound(room)
    const problem = room.feeds[0]?.problems[1]
    if (!problem) throw new Error('no rematch problem')
    room.hostGame.submit(solve(problem))
    // The guest sits this one out, so it can only end on the clock.
    room.clock.advance(room.roundLimitMs + TUNABLES.answerGraceMs)
    await until(() => room.feeds[0]!.results.length === 2, 'the rematch result')

    // Only the host scored, and the guest's win in the first game is gone rather
    // than carried forward.
    expect(room.feeds[0]?.results[1]?.scores).toEqual({ host: 3 })
  })

  it('says so when the last guest leaves after the final round', async () => {
    const room = await makeRoom({ guests: 1, rounds: 1, roundLimitMs: 60_000 })
    await playToTheEnd(room)
    expect(room.feeds[0]?.standings).toHaveLength(1)

    const only = room.sessions[0]?.peerId
    if (!only) throw new Error('no peer id for the guest')
    room.host.kick(only)
    await until(() => (room.feeds[0]?.aborted.length ?? 0) === 1, 'the abort')

    // The game is over, but the room emptying still matters: the results screen
    // offers a rematch off the back of it, and `start()` refuses an empty roster
    // -- so without this the host presses a button that does nothing at all.
    expect(room.feeds[0]?.aborted[0]).toMatch(/left/i)
  })
})

describe('the lobby', () => {
  it('caps the room at three guests, so the points table cannot run out', async () => {
    const host = createHostSession({
      signaler: createCodeSignaler(scriptedChannel()),
      iceServers: [],
      maxPeers: TUNABLES.maxPlayers - 1,
    })
    await host.start()
    open.push({ host })

    for (let i = 0; i < TUNABLES.maxPlayers - 1; i++) {
      const guest = await joinGuest(host, { name: `Player ${i + 1}` })
      open.push({ guest: guest.guest })
    }
    expect(host.peerCount).toBe(3)

    await expect(host.invite()).rejects.toMatchObject({ code: 'SESSION_FULL' })
  })

  it('refuses to start a game with nobody in it', async () => {
    const host = createHostSession({
      signaler: createCodeSignaler(scriptedChannel()),
      iceServers: [],
      maxPeers: TUNABLES.maxPlayers - 1,
    })
    await host.start()
    open.push({ host })

    const game = createHostGame({ session: host, mode: multiply(), clock: manualClock(), seed: SEED })
    let started = 0
    game.on('started', () => {
      started += 1
    })

    game.start()
    await tick()
    expect(started).toBe(0)
    expect(game.phase).toBe('idle')
  })
})

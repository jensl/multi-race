/**
 * Every knob a game can be tuned by, in one place.
 *
 * Deliberately flat and exported rather than threaded through call sites: these
 * are guesses at what feels right for a family around a table, and the point of
 * collecting them is that adjusting one is a one-line change with no ripples.
 */
export const GAME = {
  /** Rounds in one multiplayer game. */
  rounds: 10,
  /** How long answering stays open in a round. */
  roundLimitMs: 10_000,
  /** "Get ready" beat before a round opens, so every phone starts together. */
  countdownMs: 1500,
  /** How long the round's outcome stays on screen before the next one. */
  resultMs: 2500,
  /** Total clock in single player. */
  singleDurationMs: 60_000,
  /**
   * One host plus three guests.
   *
   * Three keeps a round's result readable on one phone screen without
   * scrolling, and matches `RANK_POINTS` -- which pays the fourth player the
   * same as the third precisely so a full house never runs out of table.
   *
   * Enforced at the session layer as `maxPeers: maxPlayers - 1`, because the
   * host is not a peer. Without that the session would happily accept eight
   * guests and five of them would score on a table that stops at four.
   */
  maxPlayers: 4,
  /**
   * Slack on the host's deadline, which guests do not get.
   *
   * A guest's clock starts when `game:round` reaches it, which is always *after*
   * the host's start -- so without this the only error the deadline can make is
   * discarding an answer that was genuinely in time. One-way LAN latency is a
   * few milliseconds, but Wi-Fi power-save and a scheduling hitch can push a
   * single packet past 100 ms, so the budget is generous.
   */
  answerGraceMs: 300,
} as const

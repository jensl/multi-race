/**
 * The single-player high score, kept per mode on the device.
 *
 * `localStorage` rather than anything shared, because there is no backend and
 * no account -- and it is wrapped because storage can throw (private mode,
 * storage disabled) and a game must not fail to start over a scoreboard.
 */
const PREFIX = 'multirace:best:'

export function bestFor(modeId: string): number {
  try {
    const raw = localStorage.getItem(PREFIX + modeId)
    const value = raw === null ? 0 : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/** Records a run and returns the best score known so far. */
export function recordBest(modeId: string, score: number): number {
  const previous = bestFor(modeId)
  if (score <= previous) return previous
  try {
    localStorage.setItem(PREFIX + modeId, String(score))
  } catch {
    // Not worth telling anyone about; the run still counts on screen.
  }
  return score
}

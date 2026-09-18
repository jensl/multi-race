/**
 * What the game leaves on the screen.
 *
 * The two endings differ in more than layout: a solo run ends in a number, and a
 * multiplayer game ends in a table plus a decision only the host can make.
 *
 * The multiplayer screen stays *subscribed* to the game after the final whistle,
 * which is the whole reason it takes a session rather than a standings array.
 * A rematch runs on the same connections, so the only thing separating the
 * result screen from the next game is the host pressing a button -- and the only
 * way a guest can learn that happened is by still listening. A screen that
 * unsubscribed when it appeared left the guest waiting forever for a game that
 * had already started.
 *
 * Which cuts both ways: staying subscribed is also how a guest finds out that
 * the session ended instead, and stops offering a rematch nobody is left to
 * play. Anything this screen offers has to be something that can still happen.
 */
import { isHostGame, type GameSession } from '../../game/events.ts'
import type { GameMode } from '../../game/problem.ts'
import type { Standing } from '../../game/scoring.ts'
import { actions, button, el, hint, panel } from '../dom.ts'
import { frame, makeScreen, type AppContext } from '../screen.ts'
import type { Screen } from '../router.ts'
import { bestFor, recordBest } from '../best-score.ts'
import { createModeSelect } from './mode-select.ts'
import { createSingleScreen } from './single-screen.ts'
import { createGameScreen } from './game-screen.ts'

const MEDALS = ['🥇', '🥈', '🥉']

function placeLabel(place: number): string {
  return MEDALS[place - 1] ?? `#${place}`
}

export function createSingleResults(ctx: AppContext, mode: GameMode, solved: number): Screen {
  const previous = bestFor(mode.id)
  const best = recordBest(mode.id, solved)
  const isRecord = solved > 0 && solved >= best && solved > previous

  const summary = el(
    'div',
    'game-body',
    el('p', 'problem', String(solved)),
    el('p', 'status', solved === 1 ? 'problem solved' : 'problems solved'),
    el('p', 'status', isRecord ? `New best for ${mode.name}!` : best > 0 ? `Best so far: ${best}` : ''),
  )

  const body = panel(
    null,
    actions(
      button('Play again', () => ctx.router.replace(createSingleScreen(ctx, mode))),
      button('Back to menu', () => ctx.router.replace(createModeSelect(ctx)), {
        variant: 'secondary',
      }),
    ),
  )

  const screen = frame(mode.name, undefined, summary, el('div', 'spacer'), body)
  return makeScreen({ screen, backTo: () => createModeSelect(ctx) })
}

export interface MultiResultsOptions {
  game: GameSession
  mode: GameMode
  standings: readonly Standing[]
  /** Tears the session down when the player leaves for good. */
  onExit?: () => void
  /** Shown instead of the usual line when the game ended early. */
  aborted?: string
}

export function createMultiResults(ctx: AppContext, options: MultiResultsOptions): Screen {
  const { game, mode } = options
  const host = isHostGame(game)
  const aborted = options.aborted
  const list = el('ol', 'standings')

  for (const standing of options.standings) {
    const isSelf = standing.playerId === game.playerId
    list.append(
      el(
        'li',
        `standing${isSelf ? ' self' : ''}${standing.place === 1 ? ' gold' : ''}`,
        el('span', 'place', placeLabel(standing.place)),
        el('span', 'who', isSelf ? `${standing.name} (you)` : standing.name),
        el('span', 'total', String(standing.score)),
      ),
    )
  }

  function openGame(): Screen {
    return createGameScreen(ctx, {
      game,
      mode,
      ...(options.onExit ? { onExit: options.onExit } : {}),
    })
  }

  // Someone started another game. On a guest this is the *only* way back in, and
  // it is why this screen subscribes before offering a rematch button.
  const offStarted = game.on('started', () => {
    ctx.router.replace(openGame())
  })

  // The game ended for a reason other than running out of rounds -- the other
  // side left, or the session dropped. Keep the table, but stop offering things
  // that cannot happen any more.
  const offAborted = game.on('aborted', ({ reason }) => {
    ctx.router.replace(
      createMultiResults(ctx, {
        game,
        mode,
        standings: options.standings,
        ...(options.onExit ? { onExit: options.onExit } : {}),
        aborted: reason,
      }),
    )
  })

  // A rematch needs a finished game *and* someone left to play it with. Offering
  // one after an abort is a button that does nothing: `start()` refuses a game
  // with an empty roster, so the host taps "Play again" and the screen does not
  // move. And a guest waiting for a rematch after the host has walked off waits
  // for the rest of the afternoon.
  const canRematch = host && !aborted && game.players.length > 1

  const buttons: HTMLElement[] = []
  if (canRematch) {
    // Only starts it. This screen is already watching for `started`, so the
    // navigation is not a second, separately-ordered step that could be missed.
    buttons.push(button('Play again', () => game.start()))
  } else if (!host && !aborted) {
    buttons.push(hint('Waiting for the host to start another game…'))
  }
  buttons.push(
    button(host ? 'Back to menu' : 'Leave', () => {
      options.onExit?.()
      ctx.router.replace(createModeSelect(ctx))
    }, { variant: canRematch ? 'secondary' : 'primary' }),
  )

  const hasTable = options.standings.length > 0
  const screen = frame(
    hasTable ? 'Final scores' : 'Game over',
    aborted ?? (host ? undefined : 'Your connection is kept between games.'),
    list,
    el('div', 'spacer'),
    panel(null, actions(...buttons)),
  )

  return makeScreen({
    screen,
    backTo: () => {
      options.onExit?.()
      return createModeSelect(ctx)
    },
    onUnmount: () => {
      offStarted()
      offAborted()
    },
    onPageHide: () => options.onExit?.(),
  })
}

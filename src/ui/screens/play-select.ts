/**
 * How you are playing this round: alone, or with others and in which seat.
 *
 * The back destination is rebuilt rather than kept alive, which is what the
 * router's model requires -- the mode screen it came from was unmounted, and
 * rebuilding it is cheap because it holds nothing.
 */
import { actions, button, el, hint, panel } from '../dom.ts'
import { makeScreen, frame, type AppContext } from '../screen.ts'
import type { Screen } from '../router.ts'
import type { GameMode } from '../../game/problem.ts'
import { createModeSelect } from './mode-select.ts'
import { createSingleScreen } from './single-screen.ts'
import { createHostLobby } from './host-lobby.ts'
import { createJoinScreen } from './join-screen.ts'

export function createPlaySelect(ctx: AppContext, mode: GameMode): Screen {
  const body = panel(
    null,
    actions(
      button('Single player', () => ctx.router.go(createSingleScreen(ctx, mode))),
      button('Host a game', () => ctx.router.go(createHostLobby(ctx, mode)), {
        variant: 'secondary',
      }),
      button('Join a game', () => ctx.router.go(createJoinScreen(ctx, mode)), {
        variant: 'secondary',
      }),
      hint('Everyone needs to be on the same Wi-Fi.'),
    ),
  )

  const screen = frame(mode.name, 'How are you playing?', el('div', 'spacer'), body)
  return makeScreen({
    screen,
    backTo: () => createModeSelect(ctx),
  })
}

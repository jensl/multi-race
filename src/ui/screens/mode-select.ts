/**
 * The first screen: which kind of problem.
 *
 * One entry today. It is a screen rather than a hard-coded default because the
 * registry it renders is the extension point -- a new mode appears here by being
 * added to `MODES` and nothing else.
 */
import { el } from '../dom.ts'
import { makeScreen, frame, type AppContext } from '../screen.ts'
import type { Screen } from '../router.ts'
import { MODES } from '../../game/problem.ts'
import { createPlaySelect } from './play-select.ts'

export function createModeSelect(ctx: AppContext): Screen {
  const list = el('div', 'modes')

  for (const mode of MODES) {
    const card = el(
      'button',
      'mode',
      el('span', 'name', mode.name),
      el('span', 'blurb', mode.blurb),
    )
    card.type = 'button'
    card.addEventListener('click', () => ctx.router.go(createPlaySelect(ctx, mode)))
    list.append(card)
  }

  const screen = frame('MultiRace', 'Race the clock, or race each other.', list)
  return makeScreen({ screen })
}

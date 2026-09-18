/**
 * The answer pad: digits, a backspace, and a submit.
 *
 * A custom pad rather than `<input type="number">` for three reasons that all
 * matter on a phone in a race: the Android numeric keyboard varies wildly
 * between OEMs and some of them insert separators or decimals, it covers half
 * the screen the moment it opens, and it cannot be styled into a thumb-sized
 * target. This can be all three.
 *
 * Physical keys are wired too. It costs a few lines and it means the whole game
 * is playable in a desktop browser tab, which is where it gets developed and
 * where the two-tab multiplayer run happens.
 */
import { el } from './dom.ts'

export interface KeypadHandlers {
  onDigit(digit: number): void
  onBackspace(): void
  onSubmit(): void
}

export interface Keypad {
  readonly el: HTMLElement
  /** Blocks input without hiding the pad, for the countdown before a round opens. */
  setEnabled(on: boolean): void
  dispose(): void
}

interface Key {
  label: string
  kind: 'digit' | 'back' | 'submit'
  digit?: number
}

const KEYS: readonly Key[] = [
  { label: '1', kind: 'digit', digit: 1 },
  { label: '2', kind: 'digit', digit: 2 },
  { label: '3', kind: 'digit', digit: 3 },
  { label: '4', kind: 'digit', digit: 4 },
  { label: '5', kind: 'digit', digit: 5 },
  { label: '6', kind: 'digit', digit: 6 },
  { label: '7', kind: 'digit', digit: 7 },
  { label: '8', kind: 'digit', digit: 8 },
  { label: '9', kind: 'digit', digit: 9 },
  { label: '⌫', kind: 'back' },
  { label: '0', kind: 'digit', digit: 0 },
  { label: '✓', kind: 'submit' },
]

export function createKeypad(handlers: KeypadHandlers): Keypad {
  let enabled = true

  const grid = el('div', 'keypad')

  const fire = (key: Key): void => {
    if (!enabled) return
    if (key.kind === 'digit' && key.digit !== undefined) handlers.onDigit(key.digit)
    else if (key.kind === 'back') handlers.onBackspace()
    else handlers.onSubmit()
  }

  for (const key of KEYS) {
    const node = el('button', `key ${key.kind}`, key.label)
    node.type = 'button'
    // Only the submit is a full-fidelity press; the digits repeat fast enough
    // that a long press should do nothing surprising.
    node.addEventListener('click', () => fire(key))
    grid.append(node)
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Leave real typing alone if anything ever gains a text field.
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    if (event.ctrlKey || event.metaKey || event.altKey) return

    if (event.key >= '0' && event.key <= '9') {
      event.preventDefault()
      fire({ label: event.key, kind: 'digit', digit: Number(event.key) })
      return
    }
    if (event.key === 'Backspace') {
      event.preventDefault()
      fire({ label: '', kind: 'back' })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      fire({ label: '', kind: 'submit' })
    }
  }

  window.addEventListener('keydown', onKeyDown)

  return {
    el: grid,
    setEnabled(on) {
      enabled = on
      grid.classList.toggle('disabled', !on)
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown)
    },
  }
}

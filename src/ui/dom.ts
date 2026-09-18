/**
 * Enough DOM helpers to stop writing `document.createElement` forty times.
 *
 * Deliberately tiny. Everything below is either creating an element, attaching
 * a handler, or replacing children -- the moment this file grows a diffing
 * algorithm it has become a bad framework, and the screens are small enough that
 * updating the two or three nodes that actually change is both less code and
 * less to go wrong.
 */

export type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  append(node, children)
  return node
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function clear(parent: Element): void {
  parent.replaceChildren()
}

export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

/** Toggles a class and reports whether it changed, so callers can skip a layout read. */
export function toggleClass(node: Element, name: string, on: boolean): boolean {
  if (node.classList.contains(name) === on) return false
  node.classList.toggle(name, on)
  return true
}

export interface ButtonOptions {
  variant?: 'primary' | 'secondary' | 'ghost'
  /** Blocks tapping without hiding the button, for a step that is not ready yet. */
  disabled?: boolean
}

/**
 * A full-width, thumb-sized button. `touch-action: manipulation` on the class is
 * what removes the double-tap-zoom delay, which matters in a flow where a player
 * taps scan, aims, and taps again quickly.
 */
export function button(
  label: string,
  onClick: () => void,
  options: ButtonOptions = {},
): HTMLButtonElement {
  const node = el('button', options.variant ? options.variant : undefined, label)
  node.type = 'button'
  if (options.disabled) node.disabled = true
  node.addEventListener('click', onClick)
  return node
}

/** A labelled row of buttons, hidden entirely when the list is empty. */
export function actions(...buttons: Array<HTMLElement | null>): HTMLElement {
  const present = buttons.filter((b): b is HTMLElement => b !== null)
  const wrap = el('div', 'actions', ...present)
  if (present.length === 0) wrap.hidden = true
  return wrap
}

/** A titled panel. Panels are the only layout primitive the screens need. */
export function panel(title: string | null, ...children: Child[]): HTMLElement {
  return el('section', 'panel', title === null ? null : el('h2', undefined, title), ...children)
}

/** A line of small print, used for state and hints. */
export function hint(text: string): HTMLElement {
  return el('p', 'hint', text)
}

/**
 * Small pieces every screen needs: a frame to build in, a tidy-up hook, and the
 * shared runtime a screen is handed when it is built.
 */
import type { ClientId } from '../session/types.ts'
import { el } from './dom.ts'
import type { Router, Screen } from './router.ts'

export interface AppContext {
  router: Router
  /**
   * This device's player identity, read *once* at startup.
   *
   * `getClientId()` falls back to a fresh UUID per call when `sessionStorage` is
   * unavailable (private mode, storage disabled), so calling it in two places
   * can produce two identities -- and a player who cannot find themselves in a
   * scoreboard is worse than one who never had a name.
   */
  clientId: ClientId
  iceServers: RTCIceServer[]
  /** `?dev=1`: two tabs on one machine, loopback instead of QR. */
  dev: boolean
}

export interface ScreenParts {
  screen: HTMLElement
  /** Where back goes, or null to let the browser leave the app. */
  backTo?: () => Screen | null
  onUnmount?: () => void
  onMount?: () => void
  /** Say goodbye to peers when the page goes away; see `Screen.onPageHide`. */
  onPageHide?: () => void
}

export function makeScreen(parts: ScreenParts): Screen {
  return {
    el: parts.screen,
    backTo: parts.backTo ?? (() => null),
    unmount: parts.onUnmount ?? (() => {}),
    ...(parts.onMount ? { mounted: parts.onMount } : {}),
    ...(parts.onPageHide ? { onPageHide: parts.onPageHide } : {}),
  }
}

/** A `.screen` wrapper with the standard heading. */
export function frame(title: string, subtitle?: string, ...children: Node[]): HTMLElement {
  const screen = el('div', 'screen')
  screen.append(el('h1', undefined, title))
  if (subtitle) screen.append(el('p', 'sub', subtitle))
  screen.append(...children)
  return screen
}

/** A red banner for a failure the player can do something about. */
export function errorBanner(): { el: HTMLElement; show(message: string): void; clear(): void } {
  const node = el('p', 'banner bad')
  node.hidden = true
  return {
    el: node,
    show(message) {
      node.textContent = message
      node.hidden = false
    },
    clear() {
      node.hidden = true
    },
  }
}

/**
 * A message fit to put on a screen, from anything that can be thrown.
 *
 * The session layer's errors are **plain objects**, not `Error` instances --
 * `sessionError()` builds `{ code, message, fatal }` -- and their `message` is
 * documented as already being human-readable *specifically so a screen can show
 * it*. Testing `instanceof Error` alone throws all of that away and replaces
 * every specific, actionable failure with the same shrug, which is the opposite
 * of what the field is for.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (typeof err === 'string' && err.length > 0) return err
  return 'Something went wrong. Try again.'
}

/**
 * The ICE servers every session is configured with.
 *
 * STUN is cheap insurance rather than a requirement: on a flat LAN the host
 * candidates connect directly, and the device run confirmed real IPs were used.
 * It costs nothing to keep, and it is what makes a less tidy network work.
 * There is no TURN -- a relay needs credentials, and credentials do not fit in
 * a QR code.
 */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

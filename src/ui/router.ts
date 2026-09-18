/**
 * One screen at a time, with the hardware back button wired up.
 *
 * This is **not** a stack. A screen that leaves the display is torn down
 * completely -- its camera stopped, its timers cleared, its session closed --
 * because a phone game holds real resources and a hidden screen holding them is
 * how a camera light stays on. A stack would imply those screens could be shown
 * again unchanged, and they cannot.
 *
 * So a screen declares where back should go instead, and that destination is
 * built fresh when the button is pressed. That also matches the flow: there is
 * no sensible "forward" from a results screen, only a new game or the menu.
 */
export interface Screen {
  readonly el: HTMLElement
  /**
   * Where the back gesture goes, or null to let the browser leave the app.
   * Called only after this screen has been unmounted.
   */
  backTo(): Screen | null
  /** Released when the screen leaves the display. Must be idempotent. */
  unmount(): void
  /** Called after the element is in the document. */
  mounted?(): void
  /**
   * The page is going away -- a closed tab, a swipe-away, a reload.
   *
   * Worth handling because a screen holding a session can say goodbye in a few
   * milliseconds, while saying nothing means every peer waits out the liveness
   * timeout instead, which is a visibly frozen game.
   */
  onPageHide?(): void
}

export interface Router {
  /** Shows a screen, adding a history entry so back has something to consume. */
  go(screen: Screen): void
  /** Replaces the current screen without adding an entry -- a step, not a move. */
  replace(screen: Screen): void
}

/**
 * The root screen is built by a factory that receives the router, because a
 * screen needs a router to navigate and the router needs a screen to show --
 * a cycle worth solving with a callback rather than a placeholder and a cast.
 */
export function createRouter(container: HTMLElement, makeRoot: (router: Router) => Screen): Router {
  let current: Screen | null = null

  function show(screen: Screen, onScreen: boolean): void {
    const previous = current
    current = screen
    if (previous) {
      previous.unmount()
      previous.el.remove()
    }
    container.replaceChildren(screen.el)
    if (onScreen) screen.mounted?.()
  }

  // The app must own at least one history entry, or the first back press would
  // leave the page before the handler could do anything.
  history.replaceState({ multirace: 0 }, '')

  // One listener for the whole app rather than one per screen: a screen that
  // registered its own would have to remember to take it off, and the ones that
  // forget are exactly the ones holding a live session.
  window.addEventListener('pagehide', () => {
    current?.onPageHide?.()
  })

  window.addEventListener('popstate', () => {
    const leaving = current
    if (!leaving) return
    const destination = leaving.backTo()
    if (!destination) {
      // Nothing to go back to inside the app: let the browser continue out of it.
      current = null
      leaving.unmount()
      return
    }
    // A destination was found, so the entry this press consumed is put straight
    // back. Otherwise every press would eat one and the app would walk out of
    // itself after a few screens.
    history.pushState({ multirace: 1 }, '')
    show(destination, true)
  })

  const router: Router = {
    go(screen) {
      history.pushState({ multirace: 1 }, '')
      show(screen, true)
    },
    replace(screen) {
      show(screen, true)
    },
  }

  show(makeRoot(router), true)
  return router
}

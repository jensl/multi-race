/**
 * Minimal typed event emitter. No dependencies.
 *
 * Three semantics that matter and are easy to get wrong:
 *   - `emit` iterates a SNAPSHOT, so a handler that subscribes or unsubscribes
 *     during dispatch cannot change who receives the current event.
 *   - `emit` is synchronous and ordered.
 *   - A throwing handler is contained. One broken listener must not stop the
 *     others or corrupt session state mid-dispatch.
 */

export type Handler<T> = (ev: T) => void

export interface Emitter<Events extends Record<string, unknown>> {
  /** Returns an unsubscribe function, so callers never need `off` bookkeeping. */
  on<K extends keyof Events & string>(key: K, fn: Handler<Events[K]>): () => void
  off<K extends keyof Events & string>(key: K, fn: Handler<Events[K]>): void
  emit<K extends keyof Events & string>(key: K, ev: Events[K]): void
  clear(): void
}

/**
 * @param onHandlerError Called when a listener throws. Defaults to `console.error`.
 *   Deliberately not re-emitted as an 'error' event: this emitter is generic and
 *   cannot assume the event map has one, or that it carries thrown errors.
 */
export function createEmitter<Events extends Record<string, unknown>>(
  onHandlerError?: (err: unknown, key: string) => void,
): Emitter<Events> {
  const handlers = new Map<string, Set<Handler<never>>>()

  function emit<K extends keyof Events & string>(key: K, ev: Events[K]): void {
    const set = handlers.get(key)
    if (!set || set.size === 0) return
    for (const fn of [...set]) {
      try {
        ;(fn as Handler<Events[K]>)(ev)
      } catch (err) {
        if (onHandlerError) onHandlerError(err, key)
        else console.error(`[session] handler for "${key}" threw:`, err)
      }
    }
  }

  return {
    on(key, fn) {
      let set = handlers.get(key)
      if (!set) {
        set = new Set()
        handlers.set(key, set)
      }
      const erased = fn as Handler<never>
      set.add(erased)
      return () => set.delete(erased)
    },
    off(key, fn) {
      handlers.get(key)?.delete(fn as Handler<never>)
    },
    emit,
    clear() {
      handlers.clear()
    },
  }
}

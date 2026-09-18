/**
 * A failed join has to leave the session rejoinable.
 *
 * The QR ceremony fails constantly in normal use -- a code is mis-scanned, the
 * camera sees a product barcode, the host is still fumbling with their phone --
 * and every one of those failures has to end somewhere the player can retry
 * from. `join()` accepts being called again from `failed` and nowhere else,
 * which is the shape the intent is visible in; these tests hold it to that.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGuestSession } from './guest.ts'
import { createCodeSignaler, type CodeChannel } from './signaler.ts'
import { installFakeRtc } from './test-support/fakes.ts'
import type { SessionCode } from './types.ts'

/** A channel with no camera and no screen, driven entirely by the test. */
function channel(readCode: CodeChannel['readCode']): CodeChannel {
  return {
    showCode: () => {},
    hideCode: () => {},
    readCode,
  }
}

let restore: () => void
beforeEach(() => {
  restore = installFakeRtc()
})
afterEach(() => {
  restore()
})

describe('a join that fails before a peer exists', () => {
  it('leaves the session failed rather than stuck mid-join', async () => {
    const guest = createGuestSession({
      signaler: createCodeSignaler(channel(() => Promise.reject(new Error('no camera')))),
      iceServers: [],
    })

    // The code never decodes, so the failure lands before any peer is built.
    await expect(guest.join({ code: 'not a session code' as SessionCode })).rejects.toThrow()
    expect(guest.phase).toBe('failed')
  })

  it('can be joined again, rather than being bricked by one mis-scan', async () => {
    const guest = createGuestSession({
      signaler: createCodeSignaler(channel(() => Promise.reject(new Error('no camera')))),
      iceServers: [],
    })

    await expect(guest.join({ code: 'nonsense' as SessionCode })).rejects.toThrow()

    // The retry must get past the guard and fail on its own merits -- a second
    // "already joined" here would mean the player had to reload the page.
    const retry = guest.join({ code: 'still nonsense' as SessionCode })
    await expect(retry).rejects.toThrow()
    await expect(retry).rejects.not.toThrow(/already joined/)
    expect(guest.phase).toBe('failed')
  })

  it('reports failed when the camera gives up waiting for an offer', async () => {
    const guest = createGuestSession({
      signaler: createCodeSignaler(channel(() => Promise.reject(new Error('scan cancelled')))),
      iceServers: [],
    })

    // No code supplied, so the signaler drives the camera itself.
    await expect(guest.join()).rejects.toThrow(/scan cancelled/)
    expect(guest.phase).toBe('failed')
  })
})

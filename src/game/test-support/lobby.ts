/**
 * Runs the real QR ceremony for one guest, with only the glass replaced.
 *
 * Both sides use the genuine `createCodeSignaler`, so a test that calls this is
 * exercising `publish`, `awaitPeer` and `deliver` -- envelope decode included --
 * rather than a shortcut that hands the two sessions each other's codes. The
 * codes themselves still travel the long way round, exactly as they do when a
 * human points a camera at a screen.
 */
import { createGuestSession, type GuestSession } from '../../session/guest.ts'
import type { HostSession } from '../../session/host.ts'
import { createCodeSignaler } from '../../session/signaler.ts'
import { FakePeerConnection, linkPair, until } from '../../session/test-support/fakes.ts'
import type { ClientId } from '../../session/types.ts'
import { scriptedChannel, type ScriptedCodeChannel } from './scripted-channel.ts'

export interface JoinedGuest {
  guest: GuestSession
  channel: ScriptedCodeChannel
  clientId: ClientId
}

export interface JoinOptions {
  name?: string
  /** Pin the identity, so a test can simulate a reattach under a known ClientId. */
  clientId?: ClientId
}

/**
 * Host shows an offer, the guest scans it, the guest shows an answer, the host
 * scans that. The order of the `FakePeerConnection` indices below depends on it:
 * `invite()` builds the offerer connection, and `join()` the answerer.
 *
 * `FakePeerConnection.instances` accumulates across a whole test file, so the
 * pair is located from the count taken *before* the invite -- indexing from zero
 * would re-link a previous guest's connections instead of these.
 */
export async function joinGuest(
  host: HostSession,
  options: JoinOptions = {},
): Promise<JoinedGuest> {
  const before = FakePeerConnection.instances.length

  const invite = await host.invite()
  const channel = scriptedChannel()
  const clientId = options.clientId ?? crypto.randomUUID()
  const guest = createGuestSession({
    signaler: createCodeSignaler(channel),
    iceServers: [],
    // The default 8s welcome timeout starts when the guest sends `hello`, which
    // is *before* the host has seen the answer QR. A human has to notice, aim and
    // decode in that window, so the real flow needs the generous budget too.
    welcomeTimeoutMs: 45_000,
    ...(options.name === undefined ? {} : { name: options.name }),
  })

  const joining = guest.join({ clientId })
  // Queue the offer now: `join()` only asks for it after a few awaits, and
  // `provide` holds a code until something is reading.
  channel.provide(invite.code)

  await until(() => FakePeerConnection.instances.length >= before + 2, 'both peer connections')
  const hostSide = FakePeerConnection.instances[before]
  const guestSide = FakePeerConnection.instances[before + 1]
  if (!hostSide || !guestSide) throw new Error('expected two peer connections')

  linkPair(hostSide, guestSide)
  hostSide.openChannels()
  guestSide.openChannels()
  hostSide.simulateConnected()
  guestSide.simulateConnected()

  await until(() => channel.shown.length > 0, 'the guest answer code')
  const answerCode = channel.shown[0]?.code
  if (!answerCode) throw new Error('the guest published no answer code')
  await host.submitAnswer(answerCode)
  await joining

  return { guest, channel, clientId }
}

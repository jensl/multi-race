/**
 * Boots the app.
 *
 * Almost nothing lives here on purpose: which mode is selected, which session is
 * open, and what a back press means all belong to the screen that owns them.
 */
import { getClientId } from './session/guest.ts'
import { createRouter } from './ui/router.ts'
import { ICE_SERVERS, type AppContext } from './ui/screen.ts'
import { createModeSelect } from './ui/screens/mode-select.ts'
import './ui/styles.css'

function boot(): void {
  const container = document.getElementById('app')
  if (!container) throw new Error('#app is missing from index.html')

  const params = new URLSearchParams(location.search)
  let ctx: AppContext

  createRouter(container, (router) => {
    ctx = {
      // Read once. `getClientId` falls back to a fresh id on every call when
      // storage is unavailable, so a second read could disagree with this one --
      // and the game is scored by this id.
      clientId: getClientId(),
      iceServers: ICE_SERVERS,
      // `?dev=1` swaps the QR ceremony for a loopback channel, so two tabs on
      // one laptop can play the whole game with no camera and no phones.
      dev: params.get('dev') === '1',
      router,
    }
    return createModeSelect(ctx)
  })
}

boot()

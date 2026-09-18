import { defineConfig } from 'vite'
import { ensureDevCert, lanAddresses } from './scripts/dev-cert.ts'

// getUserMedia (the QR scanner) requires a secure context. `localhost` counts,
// but `http://192.168.x.x` does not -- so LAN testing on real phones needs HTTPS
// with a certificate whose SANs actually cover the LAN IP.
const devCert = ensureDevCert()
if (!devCert) {
  const ips = lanAddresses()
  console.warn(
    `\n  ! openssl not available -- serving over HTTP.\n` +
      `    Desktop testing at http://localhost:5173 works, but phones cannot reach\n` +
      `    it: ${ips.length ? ips.map((ip) => `http://${ip}:5173`).join(', ') : 'no LAN address found'}\n` +
      `    is not a secure context, so the camera will be blocked.\n`,
  )
}

export default defineConfig(({ mode }) => ({
  // The deployed app lives under a subpath of the assets domain (see
  // `scripts/deploy.ts`), while the dev server serves from the root. Vite
  // defaults to `/`, which emits asset URLs like `/assets/index.js` -- those
  // resolve against the domain root and 404 in production. Keyed off `mode`
  // rather than `command` because `vite preview` reports `command: 'serve'`
  // while serving the production build, and has to agree with the build.
  base: mode === 'production' ? '/multirace/' : '/',
  server: {
    host: true, // bind 0.0.0.0 so phones on the same Wi-Fi can reach the dev server
    ...(devCert ? { https: devCert } : {}),
  },
  build: {
    rollupOptions: {
      // Relative paths are resolved against Vite's root, which avoids
      // pulling in @types/node purely to spell an absolute path.
      input: {
        main: 'index.html',
      },
    },
  },
}))

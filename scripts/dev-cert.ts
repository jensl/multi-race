/**
 * Generates a self-signed certificate for LAN development, with real `IP:`
 * SAN entries.
 *
 * Why not `@vitejs/plugin-basic-ssl`'s `domains` option: it emits extra domains
 * as DNS SANs, and browsers refuse to match an IP-literal URL against a DNS
 * entry -- an IP address must appear as an iPAddress SAN (RFC 6125). Phones
 * connect by IP, so a `DNS:192.168.1.42` entry is silently useless and the
 * phone shows a name-mismatch error regardless.
 *
 * The certificate is regenerated whenever this machine's addresses change,
 * which matters on a laptop that moves between networks.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

const DIR = '.certs'
const KEY_PATH = join(DIR, 'dev-key.pem')
const CERT_PATH = join(DIR, 'dev-cert.pem')
const SANS_PATH = join(DIR, 'sans.txt')

export interface DevCert {
  key: Buffer
  cert: Buffer
}

/** Every non-internal IPv4 on this machine, which is how a phone will reach us. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const iface of Object.values(networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
  }
  return out
}

/**
 * Returns a usable certificate, or null if `openssl` is unavailable -- in which
 * case the caller should fall back to plain HTTP and the dev is limited to
 * `localhost`, where a secure context is granted without a certificate.
 */
export function ensureDevCert(): DevCert | null {
  const sans = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)]
  const signature = sans.join(',')

  const fresh =
    existsSync(SANS_PATH) &&
    readFileSync(SANS_PATH, 'utf8').trim() === signature &&
    existsSync(KEY_PATH) &&
    existsSync(CERT_PATH)

  if (!fresh) {
    try {
      mkdirSync(DIR, { recursive: true })
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', KEY_PATH,
          '-out', CERT_PATH,
          '-days', '365',
          '-subj', '/CN=MultiRace Dev',
          '-addext', `subjectAltName=${signature}`,
        ],
        { stdio: 'ignore' },
      )
      writeFileSync(SANS_PATH, signature)
    } catch {
      return null
    }
  }

  return { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) }
}

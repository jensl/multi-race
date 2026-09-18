/**
 * Publishes `dist/` to the assets bucket and clears the CloudFront cache.
 *
 * Assumes `aws` is on PATH and already authenticated (`aws login`).
 *
 * The bucket and the distribution are personal infrastructure, so they are read
 * from `.env` (gitignored) rather than spelled here. `.env.example` documents
 * both; missing values are a hard error, because deploying to a guessed bucket
 * is worse than not deploying.
 *
 * The AWS calls go through `execFileSync` rather than a shell one-liner in
 * `package.json` because the invalidation path ends in `/*`. A shell one-liner
 * would have to quote that glob correctly in whichever dialect npm picks --
 * cmd.exe on Windows, where single quotes are not quotes at all -- and
 * `execFileSync` passes argv directly, so there is nothing to quote.
 *
 * Exits only once the invalidation has finished, so the new build is actually
 * being served by the time this returns.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// Reads `.env` into `process.env`. Variables already set in the real
// environment win over the file, so a one-off
// `S3_BUCKET=other npm run deploy` needs no edit here. A missing file is fine
// -- `required` below reports whatever is actually unset.
try {
  process.loadEnvFile('.env')
} catch {
  /* no .env: the per-variable check is the better error message. */
}

/** Reads a required setting, or names what is missing and where it belongs. */
function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(
      `\nMissing ${name}. Copy .env.example to .env and fill it in --\n` +
        `that file is gitignored, and only the deploy target lives there.`,
    )
    process.exit(1)
  }
  return value
}

const BUCKET = required('S3_BUCKET')
const DISTRIBUTION_ID = required('CLOUDFRONT_DISTRIBUTION_ID')

/**
 * The prefix is the app's name, so it is not infrastructure and stays here. It
 * is spelled once because it appears in the S3 destination, the invalidation
 * path and the printed URLs, and all three have to agree. `/multirace/*` is
 * already wired to the bucket origin as a cache behavior of the distribution
 * above, and `vite.config.ts` hardcodes the same prefix as its `base`.
 */
const PREFIX = 'multirace'

const DEST = `s3://${BUCKET}/${PREFIX}/`
const SITE = `https://${BUCKET}/${PREFIX}/`

/**
 * Invalidation is asynchronous, so the script polls for it. A wildcard path on
 * a site this size normally clears in well under a minute; the timeout is only
 * there so a stuck invalidation cannot hang a deploy forever.
 */
const POLL_MS = 5_000
const TIMEOUT_MS = 10 * 60_000

/** Runs an AWS CLI command with its output left on the terminal. */
function aws(args: string[]): void {
  execFileSync('aws', args, { stdio: 'inherit' })
}

/** Runs an AWS CLI command and returns its stdout, for results worth reading. */
function awsCapture(args: string[]): string {
  return execFileSync('aws', args, { encoding: 'utf8' })
}

/**
 * Blocks this thread. Everything here is synchronous, so there is no event loop
 * to sleep on and `Atomics.wait` is the way to pause without a dependency.
 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Polls until the invalidation reports `Completed`, printing a dot per poll so
 * a slow one reads as slow rather than hung. Returns the elapsed milliseconds,
 * or null if it outlives TIMEOUT_MS -- which means the wait gave up, not that
 * the deploy failed.
 */
function waitForInvalidation(id: string): number | null {
  const started = Date.now()

  for (;;) {
    const status = awsCapture([
      'cloudfront', 'get-invalidation',
      '--distribution-id', DISTRIBUTION_ID,
      '--id', id,
      '--query', 'Invalidation.Status',
      '--output', 'text',
    ]).trim()

    if (status === 'Completed') return Date.now() - started
    if (Date.now() - started > TIMEOUT_MS) return null

    sleep(POLL_MS)
    process.stdout.write('.')
  }
}

// Guarding the destructive step: `--delete` against a missing or empty dist/
// would clear the live site. `npm run deploy` always builds first, but this
// script can also be run on its own.
if (!existsSync('dist/index.html')) {
  console.error('\nNo dist/index.html -- run `npm run build` first, or use `npm run deploy`.')
  process.exit(1)
}

try {
  console.log(`\nDeploying dist/ to ${DEST}`)

  // --delete drops the previous build's bundles. Vite hashes asset filenames, so
  // every rebuild orphans the old ones; left alone they accumulate under the
  // prefix forever. Nothing but this app lives there.
  aws(['s3', 'sync', 'dist/', DEST, '--delete'])

  // This distribution has no default root object, and its S3 origin is the REST
  // endpoint, which does not resolve directory indexes -- so `/multirace/` would
  // 403 rather than serve index.html. An object whose key ends in `/` is what S3
  // returns for exactly that request, so the entry point gets a marker holding
  // its own index.html. It is written after the sync because `--delete` removes
  // it: it has no counterpart in dist/.
  awsCapture([
    's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', `${PREFIX}/`,
    '--body', 'dist/index.html',
    // `s3api` does not infer a content type from the extension the way
    // `s3 cp` does, and without this the page downloads instead of rendering.
    '--content-type', 'text/html',
  ])

  const { Invalidation } = JSON.parse(
    awsCapture([
      'cloudfront', 'create-invalidation',
      '--distribution-id', DISTRIBUTION_ID,
      '--paths', `/${PREFIX}/*`,
    ]),
  ) as { Invalidation: { Id: string } }

  // Creating the invalidation only queues it: until it finishes, CloudFront is
  // still serving the previous build from its edges. Waiting turns the exit code
  // into the answer to the question actually being asked at a deploy -- "is the
  // new version live yet?" -- rather than "did AWS accept the request?".
  console.log(`\nWaiting for invalidation ${Invalidation.Id} to finish`)
  const elapsed = waitForInvalidation(Invalidation.Id)
  process.stdout.write('\n')

  if (elapsed === null) {
    console.error(
      `\nInvalidation ${Invalidation.Id} is still InProgress after ${TIMEOUT_MS / 60_000} minutes.\n` +
        `The upload itself succeeded and CloudFront will finish clearing on its own -- ` +
        `nothing needs re-running.`,
    )
    process.exit(1)
  }

  console.log(`\nDeployed     ${SITE}`)
  console.log(`Invalidation ${Invalidation.Id} cleared in ${(elapsed / 1000).toFixed(1)}s.`)
} catch (error) {
  console.error(`\nDeploy failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

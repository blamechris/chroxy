/**
 * #8151 round-2 review (Critical 3a) — the counterpart to
 * reject-node-pty-import.mjs: a `node:module` resolve hook that makes
 * `import('node-pty')` SUCCEED (redirected to a trivial stub module),
 * so node-pty-probe.js's "available" branch can be exercised under a
 * controlled, real import — not by injecting a boolean directly.
 *
 * Also counts resolve() calls via PTY_RESOLVE_COUNT_FILE, same contract as
 * reject-node-pty-import.mjs, so a test can prove the probe doesn't
 * re-resolve on a cached second call regardless of which outcome it cached.
 */
import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STUB_URL = pathToFileURL(join(__dirname, 'fake-node-pty-stub.mjs')).href
const countFile = process.env.PTY_RESOLVE_COUNT_FILE

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node-pty') {
      if (countFile) appendFileSync(countFile, '.')
      return { url: STUB_URL, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

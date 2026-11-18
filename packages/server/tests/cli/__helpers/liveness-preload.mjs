/**
 * TEST-ONLY child preload for spawned-CLI E2E tests (#9074). Loaded into the spawned
 * `chroxy` process through `NODE_OPTIONS=--import=<this file>` (see runCli's `env`).
 * It never ships: nothing under src/ imports it.
 *
 * It makes the spawned CLI fully hermetic about the two things #9074 touches, and it
 * reports what happened on stderr, so a test can tell the intended path from a wrong
 * one that happens to print the same "Not running":
 *
 *   process.kill:
 *     kill(CHROXY_TEST_SYNTHETIC_PID, 0), with signal exactly 0, answers "alive"
 *     WITHOUT a real probe and writes LIVENESS_PRELOAD_PROBE_OK. Any other call
 *     (another pid, an omitted signal, which defaults to SIGTERM, or any real
 *     signal) is refused: it writes LIVENESS_PRELOAD_REFUSED and throws.
 *   fetch:
 *     Nothing ever reaches the network: the real fetch is never called. The
 *     planted URL, http://127.0.0.1:<CHROXY_TEST_ALLOWED_PORT>/..., gets the same
 *     rejection an unbound port produces (TypeError 'fetch failed', cause
 *     ECONNREFUSED) and writes LIVENESS_PRELOAD_EXPECTED_FETCH. Any other URL,
 *     including the default 127.0.0.1:8765 where a developer's own chroxy may
 *     listen, writes LIVENESS_PRELOAD_REFUSED and is rejected.
 *
 * Both variables are required. Without them every call is refused, so a
 * misconfigured test fails closed and visibly.
 */
const syntheticPid = Number(process.env.CHROXY_TEST_SYNTHETIC_PID)
const allowedPort = Number(process.env.CHROXY_TEST_ALLOWED_PORT)
const mark = (line) => { try { process.stderr.write(`${line}\n`) } catch { /* stderr closed */ } }

process.kill = function testOnlyKill(pid, signal) {
  if (Number.isSafeInteger(syntheticPid) && syntheticPid > 0 && pid === syntheticPid && signal === 0) {
    mark(`LIVENESS_PRELOAD_PROBE_OK pid=${pid}`)
    return true
  }
  mark(`LIVENESS_PRELOAD_REFUSED kill pid=${String(pid)} signal=${String(signal)}`)
  const err = new Error('liveness-preload: refused process.kill in a spawned E2E test')
  err.code = 'ETESTREFUSED'
  throw err
}

globalThis.fetch = async function testOnlyFetch(input) {
  let url = null
  try { url = new URL(typeof input === 'string' ? input : String(input?.url ?? input)) } catch { /* unparseable */ }
  const expected = url !== null
    && Number.isSafeInteger(allowedPort) && allowedPort > 0
    && url.protocol === 'http:'
    && url.hostname === '127.0.0.1'
    && Number(url.port) === allowedPort
  if (expected) {
    mark(`LIVENESS_PRELOAD_EXPECTED_FETCH ${url.protocol}//${url.host}${url.pathname}`)
    const refused = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${allowedPort}`), { code: 'ECONNREFUSED' })
    throw new TypeError('fetch failed', { cause: refused })
  }
  mark(`LIVENESS_PRELOAD_REFUSED fetch ${url ? `${url.protocol}//${url.host}${url.pathname}` : 'unparseable'}`)
  throw new TypeError('liveness-preload: refused fetch in a spawned E2E test')
}

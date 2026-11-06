/**
 * Run a regular expression that came from configuration against a string
 * without ever letting it hold the daemon's event loop.
 *
 * `RegExp.prototype.test` cannot be interrupted, and a backtracking pattern can
 * take seconds on a few hundred characters, so no static screen can prove a
 * pattern safe. The guarantee here is a TIME BOUND instead: the match runs in a
 * persistent worker thread, with
 *   - a deadline per match (`timeoutMs`, default 50 ms) after which the worker is
 *     terminated and replaced, and the match counts as NO MATCH;
 *   - a cap on the tested text (`maxInput`, default 1000 characters): a longer
 *     string is NOT tested and counts as no match (testing only a prefix would
 *     let an anchored pattern match a message it never saw the end of);
 *   - a bound on queued jobs (`maxQueued` overall, `maxQueuedPerKey` per caller
 *     key): a job over either bound is refused and counts as no match, so one
 *     caller cannot queue unlimited work on the shared chain;
 *   - one match at a time, so a pattern that runs out its deadline cannot make a
 *     later, harmless match time out beside it.
 * The caller treats "no match" as the conservative answer (for the prompt
 * evaluator: the message is evaluated normally instead of skipped).
 *
 * The worker needs no native module and no process flags. It is referenced only
 * while a match is pending, so an idle worker never keeps the process alive.
 */
import { Worker } from 'node:worker_threads'
import { createLogger } from '../logger.js'

const log = createLogger('bounded-regex')

export const DEFAULT_TIMEOUT_MS = 50
export const DEFAULT_MAX_INPUT = 1000
export const DEFAULT_MAX_QUEUED = 32
export const DEFAULT_MAX_QUEUED_PER_KEY = 4
const WARN_INTERVAL_MS = 60_000
const STARTUP_TIMEOUT_MS = 2000

/**
 * @param {{ timeoutMs?: number, maxInput?: number, maxQueued?: number, maxQueuedPerKey?: number, warnIntervalMs?: number, workerUrl?: URL }} [opts]
 */
export function createBoundedRegexMatcher({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxInput = DEFAULT_MAX_INPUT,
  maxQueued = DEFAULT_MAX_QUEUED,
  maxQueuedPerKey = DEFAULT_MAX_QUEUED_PER_KEY,
  warnIntervalMs = WARN_INTERVAL_MS,
  workerUrl = new URL('./bounded-regex-worker.js', import.meta.url),
} = {}) {
  let worker = null
  let online = null // Promise<boolean> for the current worker
  let seq = 0
  let chain = Promise.resolve()
  let timeouts = 0
  let refused = 0
  let queued = 0
  const perKey = new Map()
  let lastWarn = 0
  let unwarned = 0

  function spawn() {
    const w = new Worker(workerUrl)
    // Referenced while a match is pending (so an awaiting caller keeps the loop
    // alive), unreferenced when idle (see finish).
    worker = w
    online = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), STARTUP_TIMEOUT_MS)
      w.once('online', () => { clearTimeout(timer); resolve(true) })
      w.once('error', () => { clearTimeout(timer); resolve(false) })
      w.once('exit', () => { clearTimeout(timer); resolve(false) })
    })
    const forget = () => { if (worker === w) { worker = null; online = null } }
    w.on('error', forget)
    w.on('exit', forget)
    return w
  }

  function drop(w) {
    if (worker === w) { worker = null; online = null }
    w.terminate().catch(() => {})
  }

  async function run(source, text) {
    const w = worker || spawn()
    // The deadline is for the MATCH: it starts once the worker is up.
    if (!(await online)) { drop(w); return false }
    return new Promise((resolve) => {
      const id = ++seq
      let settled = false
      const finish = (matched) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        w.unref()
        w.off('message', onMessage)
        w.off('error', onGone)
        w.off('exit', onGone)
        resolve(matched)
      }
      // One job per worker at a time, and this listener is removed in finish(),
      // so a reply for another job cannot normally arrive here; the id check is
      // defence in depth, not the thing that keeps jobs apart.
      const onMessage = (m) => { if (m?.id === id) finish(m.matched === true) }
      const onGone = () => finish(false)
      const timer = setTimeout(() => {
        timeouts++
        unwarned++
        const now = Date.now()
        if (lastWarn === 0 || now - lastWarn >= warnIntervalMs) {
          lastWarn = now
          log.warn(`a configured pattern ran past ${timeoutMs}ms and was stopped (counted as no match; ${unwarned} since the last notice)`)
          unwarned = 0
        }
        drop(w)
        finish(false)
      }, timeoutMs)
      w.on('message', onMessage)
      w.once('error', onGone)
      w.once('exit', onGone)
      w.postMessage({ id, source, text })
    })
  }

  return {
    /**
     * @param {string} source pattern source (compiled case-insensitively)
     * @param {string} text
     * @param {string} [key] caller identity for the per-caller queue bound
     * @returns {Promise<boolean>} true only for a match found within the deadline
     */
    test(source, text, key = '') {
      const str = String(text)
      if (str.length > maxInput) return Promise.resolve(false)
      const mine = perKey.get(key) || 0
      if (queued >= maxQueued || mine >= maxQueuedPerKey) { refused++; return Promise.resolve(false) }
      queued++
      perKey.set(key, mine + 1)
      const p = chain.then(() => run(source, str))
      chain = p.catch(() => {})
      const done = () => {
        queued--
        const n = (perKey.get(key) || 1) - 1
        if (n <= 0) perKey.delete(key); else perKey.set(key, n)
      }
      p.then(done, done)
      return p
    },
    stats: () => ({ timeouts, refused, queued }),
    /** Stop the worker (tests, shutdown). */
    close() { if (worker) drop(worker) },
  }
}

/** The matcher the daemon uses. */
export const boundedRegex = createBoundedRegexMatcher()

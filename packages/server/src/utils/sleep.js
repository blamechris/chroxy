// utils/sleep.js (#5371) — shared cancellable sleep + exponential-backoff calc.
//
// Replaces the hand-rolled
//   new Promise((resolve, reject) => {
//     const timer = setTimeout(resolve, ms)
//     signal.addEventListener('abort', () => { clearTimeout(timer); reject() }, { once: true })
//   })
// idiom that was copied across tunnel/base.js (start-retry + recovery loops)
// and push.js. Each copy was a chance to forget the clearTimeout or the
// listener cleanup — a hung promise / leaked listener.
//
// Scope note: supervisor.js's timers are stored-field restart timers and a
// reject-after-timeout RACE (Promise.race against a push), not this
// sleep-with-abort idiom, so they are intentionally NOT migrated here.

/**
 * Resolve after `ms` milliseconds. When an AbortSignal is supplied and fires,
 * the timer is cleared and the promise REJECTS with an AbortError — callers
 * (the tunnel start/recovery retry loops) rely on the rejection to bail out of
 * their wait rather than silently finishing the sleep.
 *
 * @param {number} ms delay in milliseconds
 * @param {AbortSignal} [signal] optional cancellation signal
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError() {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

/**
 * Exponential backoff for a 1-indexed attempt: `base * 2^(attempt-1)`,
 * optionally capped at `max`.
 *
 * @param {number} attempt 1-indexed attempt number
 * @param {number} base base delay in milliseconds
 * @param {number} [max] optional ceiling
 * @returns {number} delay in milliseconds
 */
export function backoffDelay(attempt, base, max = Infinity) {
  return Math.min(base * Math.pow(2, attempt - 1), max)
}

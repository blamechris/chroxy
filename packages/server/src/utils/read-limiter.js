/**
 * Bounded admission for expensive reads.
 *
 * A transcript read can allocate tens of megabytes, and the WebSocket server
 * dispatches messages concurrently, so a connection that sends many requests
 * at once used to get that many simultaneous buffers. This limiter puts one
 * policy in front of such a read:
 *
 *   - a daemon-wide cap on reads running at once (`maxConcurrent`);
 *   - a per-client cap on distinct reads outstanding, running or queued
 *     (`maxPerClient`);
 *   - a bound on the number of queued reads (`maxQueued`) — past it, a request
 *     is refused immediately instead of waiting;
 *   - coalescing: requests carrying the same `key` while one is outstanding
 *     share its single read and its result;
 *   - cancellation: a request whose `signal` aborts stops waiting, and a read
 *     nobody is waiting for any more is dropped from the queue, or told to stop
 *     through the `signal` handed to `run` if it already started.
 *
 * The result of a coalesced read is shared between callers and must be treated
 * as read-only.
 */

export class ReadLimitError extends Error {
  /** @param {'client'|'queue'} scope */
  constructor(scope, message) {
    super(message)
    this.name = 'ReadLimitError'
    this.code = 'READ_LIMIT'
    this.scope = scope
  }
}

export class ReadCancelledError extends Error {
  constructor() {
    super('Read cancelled')
    this.name = 'ReadCancelledError'
    this.code = 'READ_CANCELLED'
  }
}

/**
 * @param {{ maxConcurrent?: number, maxPerClient?: number, maxQueued?: number }} [opts]
 */
export function createReadLimiter({ maxConcurrent = 4, maxPerClient = 2, maxQueued = 32, maxWaitersPerJob = 64 } = {}) {
  // Capacity kept for callers that are not `restricted` (a session-scoped
  // connection is): one running slot, and the tail of the queue.
  const reservedRunning = maxConcurrent > 1 ? 1 : 0
  const restrictedQueueCap = maxQueued > 8 ? maxQueued - 8 : Math.max(1, Math.ceil(maxQueued / 2))
  for (const [name, v] of Object.entries({ maxConcurrent, maxPerClient, maxQueued, maxWaitersPerJob })) {
    if (!Number.isInteger(v) || v < 1) throw new RangeError(`createReadLimiter: ${name} must be a positive integer`)
  }

  /** @type {Map<string, Job>} key -> outstanding job (queued or running) */
  const jobs = new Map()
  /** @type {Job[]} */
  const queue = []
  let running = 0

  /**
   * @typedef {object} Job
   * @property {string} key
   * @property {(signal: AbortSignal) => Promise<any>} run
   * @property {Map<string, number>} clients  client key -> its waiters on this job
   * @property {number} waiters       callers still waiting
   * @property {AbortController} abort
   * @property {Promise<any>} promise
   * @property {boolean} started
   * @property {boolean} done  the read has finished (or failed)
   */

  function outstandingFor(clientKey) {
    let n = 0
    for (const job of jobs.values()) if (job.clients.has(clientKey)) n++
    return n
  }

  function pump() {
    while (running < maxConcurrent && queue.length > 0) {
      // The first queued job allowed to start now: a restricted one may not take
      // the last running slot.
      const at = queue.findIndex((j) => !j.restricted || running < maxConcurrent - reservedRunning)
      if (at < 0) return
      const [job] = queue.splice(at, 1)
      if (job.waiters === 0) continue // everyone left while it queued
      running++
      job.started = true
      job.start()
    }
  }

  /**
   * @template T
   * @param {{ key: string, clientKey: string, signal?: AbortSignal }} req
   * @param {(signal: AbortSignal) => Promise<T>} run
   * @returns {Promise<T>}
   */
  function submit({ key, clientKey, signal, restricted = false }, run) {
    if (signal?.aborted) return Promise.reject(new ReadCancelledError())

    let job = jobs.get(key)
    const joining = job !== undefined
    if (!joining || !job.clients.has(clientKey)) {
      if (outstandingFor(clientKey) >= maxPerClient) {
        return Promise.reject(new ReadLimitError('client', 'Too many transcript requests from this connection are in progress'))
      }
    }
    if (!joining) {
      if (running >= maxConcurrent && queue.length >= maxQueued) {
        return Promise.reject(new ReadLimitError('queue', 'Too many transcript requests are in progress'))
      }
      if (restricted && queue.length >= restrictedQueueCap) {
        return Promise.reject(new ReadLimitError('queue', 'Too many transcript requests are in progress'))
      }
      job = createJob(key, run)
      job.restricted = restricted
      jobs.set(key, job)
      queue.push(job)
    }
    if (job.waiters >= maxWaitersPerJob) {
      return Promise.reject(new ReadLimitError('queue', 'Too many transcript requests are in progress'))
    }
    // An unrestricted caller joining a restricted read lifts the restriction (only
    // once it has been admitted).
    if (!restricted) job.restricted = false
    job.clients.set(clientKey, (job.clients.get(clientKey) || 0) + 1)
    job.waiters++
    const j = job
    pump()

    return new Promise((resolve, reject) => {
      let settled = false
      const detach = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        j.waiters--
        // This caller no longer counts against its client's outstanding reads.
        const left = (j.clients.get(clientKey) || 1) - 1
        if (left > 0) j.clients.set(clientKey, left)
        else j.clients.delete(clientKey)
        if (j.waiters === 0) {
          // Nobody is waiting: a queued read never starts, a running one is told to stop.
          if (!j.started) {
            const i = queue.indexOf(j)
            if (i >= 0) queue.splice(i, 1)
            jobs.delete(j.key)
          } else if (!j.done) {
            // Forget it now so a fresh request for the same key starts its own
            // read rather than joining one that is being stopped.
            if (jobs.get(j.key) === j) jobs.delete(j.key)
            j.abort.abort()
          }
        }
      }
      const onAbort = () => {
        const wasSettled = settled
        detach()
        if (!wasSettled) reject(new ReadCancelledError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      j.promise.then(
        (v) => { if (!settled) { detach(); resolve(v) } },
        (e) => { if (!settled) { detach(); reject(e) } },
      )
    })
  }

  function createJob(key, run) {
    const abort = new AbortController()
    /** @type {Job} */
    const job = { key, run, clients: new Map(), waiters: 0, abort, started: false, done: false, restricted: false, promise: null, start: null }
    job.promise = new Promise((resolve, reject) => {
      job.start = () => {
        Promise.resolve()
          .then(() => run(abort.signal))
          .then(
            (v) => { job.done = true; resolve(v) },
            (e) => { job.done = true; reject(e) },
          )
          .finally(() => {
            running--
            // A later request for the same key must read afresh.
            if (jobs.get(key) === job) jobs.delete(key)
            pump()
          })
      }
    })
    // A job nobody is waiting on any more can still reject (cancelled read);
    // keep that from surfacing as an unhandled rejection.
    job.promise.catch(() => {})
    return job
  }

  return {
    submit,
    /** For tests and diagnostics. */
    stats: () => ({ running, queued: queue.length, outstanding: jobs.size }),
  }
}

/**
 * The key a connection's reads are counted under, and whether it is restricted.
 * A session-scoped connection is counted by its CREDENTIAL (the pairing token it
 * authenticated with), so one token cannot widen its share by opening more
 * connections; an unscoped connection is counted by connection. Scoped callers
 * are `restricted`: they cannot take the capacity reserved for the others.
 * @param {{ id?: string, authToken?: string, boundSessionId?: unknown }} client
 * @param {(c: object) => boolean} isScoped
 */
export function admissionFor(client, isScoped) {
  const scoped = isScoped(client)
  const key = scoped && typeof client?.authToken === 'string' && client.authToken
    ? `credential:${client.authToken}`
    : String(client?.id ?? '')
  return { clientKey: key, restricted: scoped }
}

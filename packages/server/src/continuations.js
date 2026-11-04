/** Path-only, daemon-lifetime opportunities. Filesystem probes run in a child. */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const CONTINUATION_TTL_MS = 30 * 60_000
const MAX_CONTINUATIONS = 50

/** One killable worker globally; a stuck syscall cannot fill libuv's pool or
 * create an unbounded process queue. Keep the slot until child close. The worker
 * path seam is direct-test-only, never populated from HTTP input. */
export function createContinuationProbe({ workerPath = fileURLToPath(new URL('./continuation-metadata-worker.js', import.meta.url)), timeoutMs = 1000 } = {}) {
  let active = false
  return (entries) => {
    if (active || entries.length === 0) return Promise.resolve(null)
    active = true
    return new Promise((resolve) => {
      let child, timer, settled = false, output = ''
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      try {
        child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'ignore'] })
        timer = setTimeout(() => { finish(null); child.kill('SIGKILL') }, timeoutMs)
        child.on('error', () => { active = false; finish(null) })
        child.on('close', (code) => {
          active = false
          let result = null
          if (code === 0) {
            try { result = JSON.parse(output) } catch { /* unavailable */ }
          }
          finish(result)
        })
        child.stdout.on('data', (chunk) => {
          output += chunk
          if (output.length > 65_536) { finish(null); child.kill('SIGKILL') }
        })
        child.stdin.on('error', () => { finish(null); child.kill('SIGKILL') })
        child.stdin.end(JSON.stringify(entries.map(({ id, seedPath, cwd }) => ({ id, seedPath, cwd }))))
      } catch {
        if (child) child.kill('SIGKILL')
        else active = false
        finish(null)
      }
    })
  }
}

const probeMetadata = createContinuationProbe()
function expired(entry, now) {
  return now - entry.ts > CONTINUATION_TTL_MS || entry.ts > now + 60_000
}

async function refreshMetadata(server, now, probe) {
  if (server._continuationRefresh) return server._continuationRefresh
  const entries = [...(server._continuations?.values() || [])].filter((entry) => !expired(entry, now) && !entry.baselineFailed)
  if (entries.length === 0) return
  const refresh = (async () => {
    const results = await probe(entries)
    for (const entry of entries) {
      if (server._continuations?.get(entry.id) !== entry) continue
      if (!results || !Object.hasOwn(results, entry.id)) {
        // Without the announcement's initial snapshot we cannot tell whether a
        // later successful check sees the original file or a replacement. Only
        // a newer announcement may establish another baseline in that case.
        if (entry.fingerprint === undefined) {
          entry.fingerprint = null
          entry.baselineFailed = true
        }
        entry.unavailable = 'metadata timeout'
        continue
      }
      const current = results[entry.id]
      if (entry.fingerprint === undefined) entry.fingerprint = current
      entry.unavailable = !current || !entry.fingerprint ? 'missing' : current !== entry.fingerprint ? 'changed' : null
    }
  })()
  server._continuationRefresh = refresh
  try { await refresh } finally { if (server._continuationRefresh === refresh) server._continuationRefresh = null }
}

export function recordContinuation(server, event, now = Date.now(), probe = probeMetadata) {
  const { seedPath, cwd } = event.data
  const id = createHash('sha256').update(JSON.stringify([cwd, seedPath])).digest('hex')
  if (!server._continuations) server._continuations = new Map()
  const previous = server._continuations.get(id)
  if (previous && event.ts <= previous.ts) return { opportunity: previous, duplicate: true }
  const opportunity = { id, seedPath, cwd, ts: event.ts, fingerprint: undefined, unavailable: 'checking metadata' }
  server._continuations.delete(id)
  server._continuations.set(id, opportunity)
  while (server._continuations.size > MAX_CONTINUATIONS) server._continuations.delete(server._continuations.keys().next().value)
  // The isolated probe never delays the ingest acknowledgement.
  if (server._continuationRefresh) {
    // That batch already captured its entries. Joining its promise would leave
    // this announcement unexamined until a later refresh could adopt a new file.
    opportunity.fingerprint = null
    opportunity.baselineFailed = true
    opportunity.unavailable = 'metadata timeout'
  } else {
    void refreshMetadata(server, now, probe).catch(() => {})
  }
  return { opportunity, duplicate: false }
}

export async function listContinuations(server, now = Date.now(), probe = probeMetadata) {
  await refreshMetadata(server, now, probe)
  return [...(server._continuations?.values() || [])].reverse().map((entry) => {
    const unavailable = expired(entry, now) ? 'expired' : entry.unavailable
    return { id: entry.id, seedPath: entry.seedPath, cwd: entry.cwd, ts: entry.ts, available: unavailable === null, unavailable }
  })
}

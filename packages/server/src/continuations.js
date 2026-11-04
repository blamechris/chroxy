/** Path-only, daemon-lifetime continuation opportunities. Never opens seed content. */
import { statSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const CONTINUATION_TTL_MS = 30 * 60_000
const MAX_CONTINUATIONS = 50

function fingerprint(seedPath, cwd) {
  try {
    const seed = statSync(seedPath)
    if (!seed.isFile() || !statSync(cwd).isDirectory()) return null
    return `${seed.dev}:${seed.ino}:${seed.size}:${seed.mtimeMs}:${seed.ctimeMs}`
  } catch { return null }
}

export function recordContinuation(server, event, now = Date.now()) {
  const { seedPath, cwd } = event.data
  const id = createHash('sha256').update(JSON.stringify([cwd, seedPath])).digest('hex')
  if (!server._continuations) server._continuations = new Map()
  const previous = server._continuations.get(id)
  // Retries must not refresh the TTL or adopt a replacement file.
  if (previous && event.ts <= previous.ts) return { opportunity: previous, duplicate: true }
  const opportunity = { id, seedPath, cwd, ts: event.ts, receivedAt: now, fingerprint: fingerprint(seedPath, cwd) }
  server._continuations.delete(id)
  server._continuations.set(id, opportunity)
  while (server._continuations.size > MAX_CONTINUATIONS) server._continuations.delete(server._continuations.keys().next().value)
  return { opportunity, duplicate: false }
}

export function listContinuations(server, now = Date.now()) {
  return [...(server._continuations?.values() || [])].reverse().map((entry) => {
    const current = fingerprint(entry.seedPath, entry.cwd)
    const unavailable = now - entry.ts > CONTINUATION_TTL_MS || entry.ts > now + 60_000
      ? 'expired'
      : !current || !entry.fingerprint ? 'missing' : current !== entry.fingerprint ? 'changed' : null
    return { id: entry.id, seedPath: entry.seedPath, cwd: entry.cwd, ts: entry.ts, available: unavailable === null, unavailable }
  })
}

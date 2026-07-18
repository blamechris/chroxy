/**
 * MCP server spawn trust store (#4457).
 *
 * Persists per-tuple trust decisions so a user is asked exactly ONCE per
 * (server_name, command, args[0]) tuple — not on every chroxy restart. The
 * tuple deliberately excludes args[1..N] so a legitimate version bump
 * (e.g. args[1] = "mcp-github@1.4.2" → "mcp-github@1.5.0") doesn't re-prompt,
 * but a binary swap (`command: rm -rf` instead of `node`) DOES.
 *
 * Storage: ~/.chroxy/mcp-trust.json (mode 0600). Atomic writes via temp +
 * rename so a crashed `chroxy doctor` mid-prompt can't corrupt the file.
 *
 * Concurrency: #4460. Two MCPFleet clients started in parallel can both
 * pass through their trustGate (load → prompt → recordTrust) interleaved,
 * yielding the event loop on the prompt `await`. `recordTrust` itself is
 * sync (writeFileSync + renameSync), so the in-process race exists only at
 * the FLEET layer — but withTrustStoreLock() gives that layer a per-path
 * async mutex it can wrap the whole gate in, so prompts surface one at a
 * time (UX) AND the load+write critical section is serialised across all
 * gates in the same process.
 *
 * v1 has no "session-only" tier — once trusted, trusted forever for that
 * tuple. Users who need to revoke can edit the JSON directly. A future
 * iteration can add expiry timestamps without breaking the file format.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

// Per-path tail of an in-process async mutex chain (#4460). Each
// withTrustStoreLock call awaits the current tail, then publishes a new
// tail (its own settle-promise). When a section finishes, if its
// published tail is still the map entry (nothing queued behind), we drop
// the entry so a long-lived daemon doesn't retain resolved promises
// for every trust-store path ever written.
const _trustStoreLocks = new Map()

/**
 * Run `critical` while holding the per-path async lock. Other calls for the
 * same path queue behind. Used by byok-mcp-fleet.js to serialise the
 * load→prompt→recordTrust sequence so two parallel trustGates can't both
 * observe an empty store and clobber each other's writes (#4460), and so
 * the human-facing trust prompts surface one at a time rather than two
 * modals fighting over the dashboard.
 *
 * Re-entrancy: NOT re-entrant. Calling withTrustStoreLock from inside
 * another withTrustStoreLock for the same path deadlocks. Callers MUST
 * keep the critical section narrow (the gate sequence is fine; nested
 * gates are not a thing).
 */
export async function withTrustStoreLock(filePath, critical) {
  const prev = _trustStoreLocks.get(filePath) || Promise.resolve()
  let release
  const myTail = new Promise((resolve) => { release = resolve })
  _trustStoreLocks.set(filePath, myTail)
  try {
    await prev
    return await critical()
  } finally {
    release()
    // Drop the map entry only if no one else queued behind us. If someone
    // did, they replaced our myTail with their own; leave that in place.
    if (_trustStoreLocks.get(filePath) === myTail) {
      _trustStoreLocks.delete(filePath)
    }
  }
}

export function defaultTrustStorePath() {
  return process.env.CHROXY_MCP_TRUST_PATH || join(homedir(), '.chroxy', 'mcp-trust.json')
}

/**
 * Return a credential-stripped, stable form of a remote MCP server url for
 * use as a trust key (#6821). Strips userinfo (`user:pass@`), query, and
 * fragment — none of those belong on disk, and stripping them means a
 * rotated token or a changed query param does not re-prompt for the same
 * endpoint. An unparseable url is keyed verbatim (best-effort stable key).
 */
function sanitizeTrustUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

/**
 * Build the canonical tuple key.
 *
 * Two shapes (#6821):
 *   - remote transport: `{ name, url }` → keyed on `(name, sanitized-url)` as
 *     a 2-element array. A remote server has no `command`, so it needs its own
 *     tuple; the sanitized url carries no credentials onto disk.
 *   - stdio transport:  `{ name, command, args }` → keyed on
 *     `(name, command, args[0])` as a 3-element array. server.args may be
 *     undefined or empty — we still produce a key (args[0] is the empty
 *     string) so the consent flow works for shell-built-in-style configs like
 *     `{ command: 'true' }`.
 *
 * The two shapes never alias: a 2-element JSON array can never string-equal a
 * 3-element one.
 *
 * #4461: serialise via JSON.stringify so component values containing the
 * separator (spaces, NUL bytes, brackets, quotes) cannot collide. The
 * encoded form is also readable on disk under cat ~/.chroxy/mcp-trust.json,
 * which makes hand-debugging trust entries practical. The pre-#4461 NUL
 * separator (\\0-delimited triplet) is structurally vulnerable to a
 * tampered on-disk entry that re-uses a NUL inside name/command — JSON-
 * stringified tuples are unambiguous by construction (quoted strings escape
 * every embedded quote and control char), so no separator hack is needed.
 */
export function trustTupleKey(server) {
  if (!server || typeof server !== 'object') throw new Error('trustTupleKey: missing server')
  const name = String(server.name || '')
  const url = sanitizeTrustUrl(typeof server.url === 'string' ? server.url : '')
  if (url) {
    return JSON.stringify([name, url])
  }
  const command = String(server.command || '')
  const arg0 = Array.isArray(server.args) && server.args.length > 0 ? String(server.args[0]) : ''
  return JSON.stringify([name, command, arg0])
}

/**
 * Load the trust store from disk. Missing file is normal (first run).
 * Malformed file falls back to empty + warns — never throws.
 */
export function loadTrustStore(filePath = defaultTrustStorePath(), { log } = {}) {
  if (!existsSync(filePath)) return { tuples: new Set(), path: filePath }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    const arr = Array.isArray(raw?.trustedTuples) ? raw.trustedTuples : []
    const tuples = new Set()
    const entries = []
    for (const t of arr) {
      if (!t || typeof t.key !== 'string') continue
      // #4461: recompute the canonical key from the recorded components and
      // drop any entry whose stored `key` doesn't match. A tampered entry
      // (e.g. stored key kept but command swapped to something dangerous)
      // yields a mismatch and is silently dropped — the user re-prompts
      // for that tuple on next start. Pre-tamper trust is forfeit; correct
      // behaviour given the integrity claim is broken.
      const args0 = typeof t.args0 === 'string' ? t.args0 : ''
      const recomputed = trustTupleKey({
        name: typeof t.name === 'string' ? t.name : '',
        command: typeof t.command === 'string' ? t.command : '',
        // Remote entries (#6821) persist a `url` and no command/args — the
        // recompute keys on it. Stdio entries have no `url`, so this is '' and
        // the (command, args0) branch is taken.
        url: typeof t.url === 'string' ? t.url : '',
        args: [args0],
      })
      if (recomputed !== t.key) {
        log?.warn?.(`MCP trust store ${filePath} entry "${t.name}" key tampered (recomputed mismatch); dropping`)
        continue
      }
      tuples.add(t.key)
      entries.push(t)
    }
    return { tuples, path: filePath, entries }
  } catch (err) {
    log?.warn?.(`MCP trust store ${filePath} unreadable: ${err?.message || err}`)
    return { tuples: new Set(), path: filePath }
  }
}

/**
 * Append a trust decision. Idempotent — re-recording an already-trusted
 * tuple is a no-op (no duplicate entries). Writes via temp + rename so a
 * crashed write cannot corrupt the file.
 */
export function recordTrust(server, filePath = defaultTrustStorePath()) {
  const key = trustTupleKey(server)
  const existing = loadTrustStore(filePath)
  if (existing.tuples.has(key)) return existing
  const entries = Array.isArray(existing.entries) ? [...existing.entries] : []
  const isRemote = typeof server.url === 'string' && server.url.length > 0
  entries.push(
    isRemote
      // Remote transport (#6821): persist name + sanitized url only — never
      // the headers/tokens, and never url credentials.
      ? {
          key,
          name: server.name,
          url: sanitizeTrustUrl(server.url),
          trustedAt: new Date().toISOString(),
        }
      : {
          key,
          name: server.name,
          command: server.command,
          args0: Array.isArray(server.args) && server.args.length > 0 ? server.args[0] : '',
          trustedAt: new Date().toISOString(),
        },
  )
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify({ trustedTuples: entries }, null, 2), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch {}
  // #4463: when renameSync throws (cross-device link, FS quota, ACL) the
  // temp file would otherwise be left behind. Unlink it on the failure
  // path and re-throw the ORIGINAL rename error so the caller sees the
  // real failure rather than a cleanup-side ENOENT. The cleanup unlink
  // swallows its own errors (the temp may already be gone if the rename
  // partially succeeded or the FS removed it).
  try {
    renameSync(tmp, filePath)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return loadTrustStore(filePath)
}

export function isTrusted(store, server) {
  if (!store || !store.tuples) return false
  return store.tuples.has(trustTupleKey(server))
}

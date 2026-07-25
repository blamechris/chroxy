/**
 * MCP server spawn trust store (#4457).
 *
 * Persists per-config trust decisions so a user is asked exactly ONCE per
 * spawn-determining configuration — not on every chroxy restart.
 *
 * ## The key covers EVERYTHING that determines what executes (#7001)
 *
 * Up to v1 the key was the partial tuple `(name, command, args[0])` for stdio
 * and `(name, sanitized-url)` for remote. That was unsound: `args[1..N]` and
 * `env` are exactly as spawn-determining as `command`, so all three of
 *
 *     { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }
 *     { command: 'npx', args: ['-y', '@attacker/pwn'] }
 *     { command: 'npx', args: ['-y', '…'], env: { NODE_OPTIONS: '--require /tmp/evil.js' } }
 *
 * collapsed onto the SAME key `["github","npx","-y"]`. Once any one of them was
 * trusted, `isTrusted()` returned true for the other two, so a remove + re-add
 * of the same name could swap in arbitrary host code with no trust prompt at all
 * — and re-spawn it silently on every later session start. `_buildChildEnv()` is
 * `{ ...process.env, ...config.env }`, so an injected `NODE_OPTIONS` alone was
 * enough; it did not even need to change `command`.
 *
 * v2 therefore keys on a sha256 of a CANONICAL (key-sorted) JSON encoding of the
 * full spawn-determining config — a digest rather than another hand-picked tuple,
 * so a future spawn-determining field cannot be forgotten the way `env` was:
 *
 *   - stdio:  `{ v, kind: 'stdio',  name, command, argsDigest, envDigest }`
 *   - remote: `{ v, kind: 'remote', name, url, urlDigest, headersDigest }`
 *
 * `args` / `env` / `headers` and the raw url enter the key as DIGESTS, never in
 * cleartext, for one reason: the components are persisted (see below) and those
 * fields routinely carry credentials (`--api-key=…`, `GITHUB_TOKEN`,
 * `Authorization`, `?token=`). Digesting them keeps the key exhaustive while the
 * store keeps its "no credential material ever reaches disk" property.
 *
 * Two deliberate consequences:
 *
 *   1. **Version bumps now re-prompt.** The pre-v2 rationale for excluding
 *      `args[1..N]` was that `mcp-github@1.4.2` → `@1.5.0` shouldn't re-ask. But
 *      "the package changed" is indistinguishable from "the package was swapped",
 *      and one prompt per genuine config edit is the correct price for closing an
 *      RCE path.
 *   2. **A rotated credential inside a remote url re-prompts** — reversing the
 *      #6821 note that a changed query param would not. A query param can change
 *      what the endpoint does, and the SANITIZED url is published verbatim on the
 *      `mcp_servers` broadcast (`redactMcpUrl`), so a sanitized-url-only key was
 *      publicly known and freely inheritable by a different effective config.
 *
 * MIGRATION: v1 entries are DROPPED at load, not honoured (`loadTrustStore`
 * requires `v === 2` and recomputes the key from the persisted components). There
 * is deliberately NO compatibility shim — keeping the weak key alive for existing
 * records would keep the collision exploitable. Previously-trusted servers
 * re-prompt exactly once and are rewritten as v2 on the next allow. Re-prompting
 * is the fail-safe direction; silently honouring a weak key is not.
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
 * There is no "session-only" tier — once trusted, trusted forever for that
 * exact config. Users who need to revoke can edit the JSON directly. A future
 * iteration can add expiry timestamps without breaking the file format.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * On-disk trust-record version. Bumped to 2 by #7001 (partial tuple → full
 * spawn-config digest). `loadTrustStore` honours ONLY this version, so bumping it
 * again is the supported way to force a re-prompt if the key composition ever
 * has to change once more.
 */
export const TRUST_KEY_VERSION = 2

/**
 * Sentinel for an absent/empty args list or string map. Deliberately not a valid
 * sha256 hex string (64 hex chars), so "no env" can never be confused with the
 * digest of some env, and the on-disk record stays readable.
 */
const EMPTY_DIGEST = 'none'

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
 * endpoint. An unparseable url maps to a fixed placeholder — NEVER the raw
 * input: recordTrust persists this value to disk, and a malformed url can
 * still embed credential material (`user:pass@`, `?token=`). Collapsing all
 * unparseable urls for a server name onto one key is fail-safe, because an
 * unparseable url can never be connected to anyway (config parsing rejects
 * it and fetch would throw).
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
    return 'invalid-url'
  }
}

function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * Deterministic JSON encoding: object keys sorted, array order preserved (arg
 * ORDER is semantic — `['-e', 'code']` is not `['code', '-e']`).
 *
 * #4461's property is preserved for free: every string is JSON-quoted, so a
 * component value containing a separator, quote, NUL or newline cannot be made to
 * straddle a field boundary and collide with a different component split.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

/**
 * Digest of a spawn argv list. Order-sensitive, covers EVERY element (the v1 key
 * covered only `args[0]`, which is what made `['-y', '@attacker/pwn']` collide
 * with `['-y', '@modelcontextprotocol/server-github']`).
 */
export function argsDigest(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a)) : []
  if (list.length === 0) return EMPTY_DIGEST
  return sha256Hex(canonicalJson(list))
}

/**
 * Digest of a string→string map (`env` or `headers`), canonically ordered so key
 * insertion order cannot change the key. Values are hashed, never persisted —
 * `env` and `headers` routinely carry API tokens.
 *
 * A `__proto__` key present as an OWN property (JSON.parse produces one) is
 * covered like any other: `Object.entries` sees it, so it enters the digest and
 * cannot be used to smuggle an uncovered difference past the key.
 */
export function stringMapDigest(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return EMPTY_DIGEST
  const entries = Object.entries(map)
    .map(([k, v]) => [String(k), String(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  if (entries.length === 0) return EMPTY_DIGEST
  return sha256Hex(canonicalJson(entries))
}

/**
 * The canonical component bag a trust key hashes over — and, verbatim, the record
 * `recordTrust` persists. Keeping "what is hashed" and "what is stored" the SAME
 * object is what lets `loadTrustStore` recompute the key from disk (the #4461
 * tamper check) without ever storing a credential in cleartext.
 *
 * Two shapes (#6821), discriminated by an explicit `kind` so they can never
 * alias:
 *   - remote: `{ v, kind: 'remote', name, url, urlDigest, headersDigest }` —
 *     `url` is the credential-stripped display form; `urlDigest` covers the FULL
 *     raw url (userinfo, query, fragment) so a changed query param is a different
 *     endpoint configuration.
 *   - stdio: `{ v, kind: 'stdio', name, command, argsDigest, envDigest }` —
 *     `command` stays cleartext (it is the field the consent prompt shows, and a
 *     binary path is not credential material); the full argv and env are covered
 *     by digests.
 */
export function trustKeyComponents(server) {
  if (!server || typeof server !== 'object') throw new Error('trustTupleKey: missing server')
  const name = String(server.name || '')
  const rawUrl = typeof server.url === 'string' ? server.url : ''
  if (rawUrl) {
    return {
      v: TRUST_KEY_VERSION,
      kind: 'remote',
      name,
      url: sanitizeTrustUrl(rawUrl),
      urlDigest: sha256Hex(rawUrl),
      headersDigest: stringMapDigest(server.headers),
    }
  }
  return {
    v: TRUST_KEY_VERSION,
    kind: 'stdio',
    name,
    command: String(server.command || ''),
    argsDigest: argsDigest(server.args),
    envDigest: stringMapDigest(server.env),
  }
}

/**
 * The trust key for a server config: sha256 over the canonical component bag.
 *
 * Named `trustTupleKey` for continuity with #4457/#4461 call sites, but since
 * #7001 it is a DIGEST of the whole spawn-determining config, not a tuple of
 * hand-picked fields. Two configs share a key iff they would spawn/connect
 * identically.
 */
export function trustTupleKey(server) {
  return sha256Hex(canonicalJson(trustKeyComponents(server)))
}

/**
 * Rebuild the component bag from a persisted record, reading EXACTLY the fields
 * the bag defines (never a spread of the raw entry — an attacker-added extra key
 * must not be able to participate in the recompute). Returns null for anything
 * that is not a current-version record, which includes every v1 entry: those
 * carry `args0` and no `v`, so they are dropped rather than honoured.
 */
function componentsFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (entry.v !== TRUST_KEY_VERSION) return null
  const str = (v) => (typeof v === 'string' ? v : '')
  if (entry.kind === 'remote') {
    return {
      v: TRUST_KEY_VERSION,
      kind: 'remote',
      name: str(entry.name),
      url: str(entry.url),
      urlDigest: str(entry.urlDigest),
      headersDigest: str(entry.headersDigest),
    }
  }
  if (entry.kind === 'stdio') {
    return {
      v: TRUST_KEY_VERSION,
      kind: 'stdio',
      name: str(entry.name),
      command: str(entry.command),
      argsDigest: str(entry.argsDigest),
      envDigest: str(entry.envDigest),
    }
  }
  return null
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
    let legacyDropped = 0
    for (const t of arr) {
      if (!t || typeof t.key !== 'string') continue
      // #7001: a pre-v2 record was computed with the weak (name, command,
      // args[0]) / (name, sanitized-url) key, which collided across configs that
      // spawn different code. It is DROPPED, never translated — honouring it
      // would keep that collision exploitable. The user re-prompts once and the
      // record is rewritten as v2 on the next allow.
      const components = componentsFromEntry(t)
      if (!components) {
        legacyDropped += 1
        continue
      }
      // #4461: recompute the canonical key from the recorded components and
      // drop any entry whose stored `key` doesn't match. A tampered entry
      // (e.g. stored key kept but command swapped to something dangerous)
      // yields a mismatch and is silently dropped — the user re-prompts
      // for that config on next start. Pre-tamper trust is forfeit; correct
      // behaviour given the integrity claim is broken.
      const recomputed = sha256Hex(canonicalJson(components))
      if (recomputed !== t.key) {
        log?.warn?.(`MCP trust store ${filePath} entry "${t.name}" key tampered (recomputed mismatch); dropping`)
        continue
      }
      tuples.add(t.key)
      entries.push(t)
    }
    if (legacyDropped > 0) {
      log?.warn?.(
        `MCP trust store ${filePath}: dropped ${legacyDropped} pre-v${TRUST_KEY_VERSION} trust record(s) ` +
        '— they were keyed on a partial config (command + args[0] only) and are no longer honoured (#7001); ' +
        'affected MCP servers will ask for trust once more',
      )
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
  // #7001: persist the component bag the key was hashed over, verbatim, so
  // loadTrustStore can recompute and verify it. Only digests of args/env/headers
  // and of the raw url are written — no argv element, env value, header value or
  // url credential ever reaches disk.
  entries.push({ ...trustKeyComponents(server), key, trustedAt: new Date().toISOString() })
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

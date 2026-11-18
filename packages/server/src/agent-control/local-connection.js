/**
 * agent-control: local daemon connection resolution.
 *
 * Resolves how to reach the daemon this CLI/MCP process should talk to,
 * without ever printing or logging the resolved token. Mirrors the pattern
 * already used by `cli/status-cmd.js` and `cli/shell-cmd.js`: prefer the
 * connection.json `port` field (the local loopback port — written
 * specifically "so loopback CLIs hit the right port even in tunnel mode",
 * see supervisor.js #5683) and always dial `127.0.0.1`, never the public
 * tunnel host, for the default local case.
 *
 * A remote endpoint is never inferred — callers must pass `--url` (or
 * `CHROXY_AGENT_CONTROL_URL`) explicitly, plus an explicit token. A plain
 * `ws://` endpoint on any host that is not loopback is additionally REFUSED
 * unless the caller opts in with `allowInsecureWs: true` (#7969): the bearer
 * token is sent in the first `auth` frame, before any key exchange, so on
 * cleartext `ws://` anyone on the network path can read it, and an identity
 * pin cannot help (the pin is only checked after the token has gone out).
 *
 * This module never reads or writes connection.json for anything other than
 * the local default path, and — deliberately, unlike `readConnectionInfo()` in
 * `../connection-info.js` — never DELETES it. That shared helper's existing
 * "unlink a stale file whose recorded pid is no longer running" side effect
 * is correct for the daemon's own lifecycle tooling (`status`/`pair-code`/…),
 * but agent-control is a new READ-ONLY consumer with no business mutating a
 * file another process (or the user) may still care about; it does its own
 * non-mutating read + liveness check via `getConnectionInfoPath()` instead.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isIPv4 } from 'node:net'
import { getConnectionInfoPath } from '../connection-info.js'
import { readTrustedSecretFile } from '../trusted-file-read.js'

export const DEFAULT_LOCAL_PORT = 8765
const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * Non-mutating equivalent of `readConnectionInfo()` — reads and parses
 * connection.json (respecting `CHROXY_CONFIG_DIR` via `getConnectionInfoPath`)
 * and reports whether the recorded pid still looks alive, but never unlinks
 * the file. Returns `null` for "no file" or "unparseable", exactly like the
 * mutating version, so callers can't distinguish those cases either way.
 *
 * @param {object} [deps]
 * @param {function} [deps.getConnectionInfoPath]
 * @returns {object|null}
 */
export function readConnectionInfoNonMutating(deps = {}) {
  const getPath = deps.getConnectionInfoPath || getConnectionInfoPath
  const path = getPath()
  if (!existsSync(path)) return null
  let info
  try {
    info = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
  if (!info || typeof info !== 'object') return null
  if (info.pid != null) {
    try {
      process.kill(info.pid, 0) // signal 0 = existence check, no side effect
    } catch {
      // Stale — the daemon that wrote this is gone. Report it as such
      // (resolveLocalConnection treats a dead pid the same as "not running"
      // below) WITHOUT deleting the file — a stale connection.json is
      // evidence, not litter this module gets to clean up.
      return { ...info, _stale: true }
    }
  }
  return info
}

function isValidPort(port) {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
}

// TWO host predicates live in this module, on purpose. They answer different
// questions and must not be unified (a unification already regressed the local
// default path once — #7969 review):
//
//   hostStaysOnThisMachine      "does traffic to this host stay on this
//                               machine?" — the transport gate in
//                               `validateExplicitUrl`. Broad: all of
//                               127.0.0.0/8 qualifies, because every address
//                               in it is loopback.
//   hostNamesTheDialedListener  "does a URL in connection.json describe the
//                               listener that will be dialed at 127.0.0.1?" —
//                               the port fallback in `loopbackPortFromUrl`.
//                               Narrow: a URL on 127.0.0.2 is a loopback
//                               address but is NOT the socket at 127.0.0.1, so
//                               a port borrowed from it would point the local
//                               default path at the wrong listener.
//
// Widening the second to match the first changes where the default (local)
// path dials; narrowing the first to match the second would refuse
// `ws://127.0.0.2:…`, which stays on this machine.

/**
 * The transport gate's predicate: is traffic to this host kept on this
 * machine? Applied to the hostname `new URL(...)` produced (so it is already
 * WHATWG-normalized: lowercased, percent-decoded, `127.1` / `0x7f.1` /
 * `2130706433` expanded to `127.0.0.1`, `[0:0:0:0:0:0:0:1]` shortened to
 * `[::1]`). A host qualifies ONLY if it is
 *
 *   - exactly `localhost`;
 *   - an IPv4 literal in 127.0.0.0/8; or
 *   - exactly `[::1]`.
 *
 * Everything else is remote, and callers fail closed on it. That deliberately
 * includes spellings that look local: `localhost.` (trailing dot — a distinct,
 * resolvable name), `foo.localhost`, `localhost.localdomain`,
 * `127.0.0.1.evil.com`, `0.0.0.0`, `[::]`, and IPv4-mapped IPv6 such as
 * `[::ffff:7f00:1]`. This is stricter than `isLoopbackHost` in `../bind-host.js`
 * on purpose: that one answers "is this bind address worth a warning", where a
 * false positive is tolerable; this one gates whether a bearer token may be
 * sent in cleartext, where it is not.
 */
function hostStaysOnThisMachine(hostname) {
  if (typeof hostname !== 'string') return false
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4(hostname) && hostname.split('.')[0] === '127'
}

/**
 * The port fallback's predicate: does a URL recorded in connection.json
 * describe the listener `resolveLocalConnection` will dial at `127.0.0.1`?
 * This is the exact match this module has always used — `127.0.0.1`,
 * `localhost`, `::1`, `[::1]` — kept byte-for-byte so the local default path
 * resolves exactly as it did before the transport gate existed. It is
 * deliberately NOT `hostStaysOnThisMachine`: see the note above.
 */
function hostNamesTheDialedListener(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/**
 * Extract a port from a URL — but ONLY when the URL's host names the listener
 * this module dials (`hostNamesTheDialedListener`).
 * A public tunnel URL (`https://<random>.trycloudflare.com`, or an explicit
 * `wss://host:443/...`) is the daemon's PUBLIC endpoint; its port number is
 * Cloudflare's edge port, not the local daemon's bind port, so it must never
 * be used to derive where to dial 127.0.0.1. connection.json's explicit
 * `port` field (the local loopback port, written by supervisor.js) is
 * therefore always preferred — this is only a fallback for older
 * connection.json shapes that lack it.
 */
function loopbackPortFromUrl(url) {
  if (typeof url !== 'string' || !url) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!hostNamesTheDialedListener(parsed.hostname)) return null
  if (!parsed.port) return null
  const port = Number(parsed.port)
  return isValidPort(port) ? port : null
}

/**
 * Resolve the local daemon's WebSocket URL + auth token from connection.json,
 * without ever including the token in a thrown message, log, or returned
 * diagnostic field beyond the dedicated `token` property.
 *
 * @param {object} [deps] - injection seam for tests
 * @param {function} [deps.readConnectionInfo]
 * @returns {{ ok: true, url: string, token: string|null, port: number } | { ok: false, reason: string }}
 */
export function resolveLocalConnection(deps = {}) {
  const readInfo = deps.readConnectionInfo || readConnectionInfoNonMutating
  const info = readInfo()
  if (!info || info._stale) {
    return { ok: false, reason: 'not_running' }
  }
  const port =
    (isValidPort(info.port) && info.port)
    || loopbackPortFromUrl(info.httpUrl)
    || loopbackPortFromUrl(info.wsUrl)
    || DEFAULT_LOCAL_PORT

  // Deliberately always loopback — never the tunnel host. Connecting to the
  // public tunnel URL would route agent-control traffic over the network
  // (and through Cloudflare) for what is, by default, a same-machine control
  // surface; a remote endpoint must be requested explicitly (see
  // resolveConnectionTarget below).
  const url = `ws://127.0.0.1:${port}`
  return { ok: true, url, token: info.apiToken ?? null, port }
}

/**
 * Validate an explicit (non-local) endpoint URL. Requires `ws:`/`wss:`,
 * rejects userinfo-bearing URLs (`ws://token@host/...`) — a token belongs in
 * the auth message, never embedded in a URL where it would be logged by
 * every layer that logs "the URL it connected to" (proxies, shell history if
 * typed, this module's own error paths) — and refuses cleartext `ws://` to a
 * host that is not loopback (#7969) unless `allowInsecureWs` is exactly `true`.
 *
 * Checks run in this order and the first failure wins: parses → scheme → no
 * embedded credentials → insecure transport. The token check belongs to the
 * caller and comes after all of these.
 *
 * Exported because it is the ONE implementation of the TRANSPORT rule (not of
 * "loopback" in general — see the note on the two host predicates above): the resolver
 * below and `main()`'s fail-fast startup check in `mcp-server.js` both call it,
 * so the two can never disagree about which targets are refused.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {boolean} [opts.allowInsecureWs] - only the boolean `true` opts in; a
 *   truthy non-boolean (`'false'`, `1`) does not
 * @returns {{ ok: true, insecureRemoteWs: boolean } | { ok: false, reason: 'invalid_url'|'invalid_url_scheme'|'url_contains_credentials'|'insecure_remote_ws' }}
 *   `insecureRemoteWs` is true when the URL is a remote `ws://` target that the
 *   caller opted in to, so a caller can warn about it.
 */
export function validateExplicitUrl(url, opts = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return { ok: false, reason: 'invalid_url_scheme' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'url_contains_credentials' }
  }
  const insecureRemoteWs = parsed.protocol === 'ws:' && !hostStaysOnThisMachine(parsed.hostname)
  if (insecureRemoteWs && opts.allowInsecureWs !== true) {
    return { ok: false, reason: 'insecure_remote_ws' }
  }
  return { ok: true, insecureRemoteWs }
}

/**
 * Resolve the connection target for the agent-control client from CLI
 * options / environment, honoring the "no implicit remote" rule: a remote
 * (non-local) endpoint is only ever used when explicitly configured via
 * `explicitUrl` (CLI `--url`) or the `CHROXY_AGENT_CONTROL_URL` env var —
 * never inferred from connection.json's public tunnel fields.
 *
 * @param {object} [opts]
 * @param {string} [opts.explicitUrl] - explicit `--url` (or equivalent) value
 * @param {string} [opts.explicitToken] - explicit token (never taken from argv in the CLI layer)
 * @param {boolean} [opts.allowInsecureWs] - #7969: opt in to a cleartext `ws://`
 *   endpoint on a non-loopback host (only the boolean `true` counts). There is
 *   deliberately no environment-variable equivalent.
 * @param {object} [opts.env] - injection seam for tests (defaults to process.env)
 * @param {object} [opts.deps] - forwarded to resolveLocalConnection
 * @returns {{ ok: true, url: string, token: string|null, source: 'explicit'|'local' } | { ok: false, reason: string }}
 *   `reason` for an explicit target is one of the `validateExplicitUrl`
 *   reasons, then `remote_requires_token`.
 */
export function resolveConnectionTarget(opts = {}) {
  const env = opts.env || process.env
  const explicitUrl = opts.explicitUrl || env.CHROXY_AGENT_CONTROL_URL || null

  if (explicitUrl) {
    const validation = validateExplicitUrl(explicitUrl, { allowInsecureWs: opts.allowInsecureWs })
    if (!validation.ok) return validation
    const token = opts.explicitToken ?? env.CHROXY_AGENT_CONTROL_TOKEN ?? null
    if (!token) {
      return { ok: false, reason: 'remote_requires_token' }
    }
    return { ok: true, url: explicitUrl, token, source: 'explicit' }
  }

  const local = resolveLocalConnection(opts.deps)
  if (!local.ok) return local
  if (!local.token) {
    return { ok: false, reason: 'no_local_token' }
  }
  return { ok: true, url: local.url, token: local.token, source: 'local' }
}

/** Env var naming the 0600 file that holds an agent principal token (#9121). */
export const PRINCIPAL_TOKEN_FILE_ENV = 'CHROXY_AGENT_TOKEN_FILE'

// A principal token is `randomBytes(32).toString('base64url')` (43 chars, contract
// section 3). Accept the base64url alphabet with a generous length band, so a later
// token length needs no client change, and refuse anything else (whitespace, a pasted
// JSON blob) before it is ever sent.
const PRINCIPAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/
const PRINCIPAL_TOKEN_FILE_MAX_SIZE = 4096

/**
 * Read a principal token file (#9121) through the trusted-file read: exactly mode
 * 0600, owned by this uid, not a symlink, at most 4 KiB, read from the same fd that
 * was checked. One trailing newline is tolerated. Never throws for an expected
 * outcome and never puts the file's content into a reason.
 *
 * @param {string} path
 * @param {object} [deps] - `readTrustedSecretFile` test seam
 * @returns {{ ok: true, token: string } | { ok: false, reason: 'principal_token_file_absent'|'principal_token_file_untrusted'|'principal_token_file_malformed', code?: string }}
 */
export function readPrincipalTokenFile(path, deps = {}) {
  const read = deps.readTrustedSecretFile || readTrustedSecretFile
  const result = read(path, { mode: 0o600, checkOwner: true, maxSize: PRINCIPAL_TOKEN_FILE_MAX_SIZE })
  if (result.status === 'absent') return { ok: false, reason: 'principal_token_file_absent' }
  if (result.status !== 'ok') return { ok: false, reason: 'principal_token_file_untrusted', code: typeof result.code === 'string' ? result.code.slice(0, 32) : 'EUNKNOWN' }
  const token = String(result.content).replace(/\r?\n$/, '')
  if (!PRINCIPAL_TOKEN_PATTERN.test(token)) return { ok: false, reason: 'principal_token_file_malformed' }
  return { ok: true, token }
}

/**
 * Resolve the connection for agent-control's principal (read-only observer) mode
 * (#9121, S6 of #9112; docs/security/agent-principals.md sections 2 and 3).
 *
 * - The token file is validated FIRST, and the token comes ONLY from the file named
 *   by `CHROXY_AGENT_TOKEN_FILE` (`readPrincipalTokenFile`). This path never reads
 *   `CHROXY_AGENT_CONTROL_TOKEN` and NEVER opens connection.json, so the primary
 *   token is not loaded into this process at all, not even to be discarded. A
 *   missing or untrusted file fails closed; there is no fallback in either direction.
 * - Because connection.json is not read, the local default is `ws://127.0.0.1` at
 *   DEFAULT_LOCAL_PORT. A daemon on another port is named with an explicit
 *   `--url` / `CHROXY_AGENT_CONTROL_URL`, which must pass `validateExplicitUrl`
 *   (with no insecure opt-in) and must then name a host that stays on this machine
 *   (`hostStaysOnThisMachine`), whatever its scheme: the daemon accepts a principal
 *   only from a loopback peer (D8).
 *
 * @param {object} [opts]
 * @param {string} [opts.explicitUrl]
 * @param {string} [opts.tokenFile] - overrides the env var (tests / programmatic callers)
 * @param {object} [opts.env]
 * @param {object} [opts.deps] - forwarded to readPrincipalTokenFile
 * @returns {{ ok: true, url: string, token: string, source: 'explicit'|'default' } | { ok: false, reason: string, code?: string }}
 */
export function resolvePrincipalConnectionTarget(opts = {}) {
  const env = opts.env || process.env
  const tokenFile = opts.tokenFile || env[PRINCIPAL_TOKEN_FILE_ENV] || null
  if (!tokenFile) return { ok: false, reason: 'principal_token_file_unset' }
  const read = readPrincipalTokenFile(tokenFile, opts.deps)
  if (!read.ok) return read

  const explicitUrl = opts.explicitUrl || env.CHROXY_AGENT_CONTROL_URL || null
  if (!explicitUrl) {
    return { ok: true, url: `ws://127.0.0.1:${DEFAULT_LOCAL_PORT}`, token: read.token, source: 'default' }
  }
  const validation = validateExplicitUrl(explicitUrl, { allowInsecureWs: false })
  if (!validation.ok) return validation
  if (!hostStaysOnThisMachine(new URL(explicitUrl).hostname)) {
    return { ok: false, reason: 'principal_requires_loopback' }
  }
  return { ok: true, url: explicitUrl, token: read.token, source: 'explicit' }
}

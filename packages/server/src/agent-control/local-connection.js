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
 * `CHROXY_AGENT_CONTROL_URL`) explicitly, plus an explicit token. This module
 * never reads or writes connection.json for anything other than the local
 * default path, and — deliberately, unlike `readConnectionInfo()` in
 * `../connection-info.js` — never DELETES it. That shared helper's existing
 * "unlink a stale file whose recorded pid is no longer running" side effect
 * is correct for the daemon's own lifecycle tooling (`status`/`pair-code`/…),
 * but agent-control is a new READ-ONLY consumer with no business mutating a
 * file another process (or the user) may still care about; it does its own
 * non-mutating read + liveness check via `getConnectionInfoPath()` instead.
 */
import { existsSync, readFileSync } from 'node:fs'
import { getConnectionInfoPath } from '../connection-info.js'

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

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

/**
 * Extract a port from a URL — but ONLY when the URL's host is loopback.
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
  if (!isLoopbackHostname(parsed.hostname)) return null
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
 * Validate an explicit (non-local) endpoint URL. Requires `ws:`/`wss:` and
 * rejects userinfo-bearing URLs (`ws://token@host/...`) — a token belongs in
 * the auth message, never embedded in a URL where it would be logged by
 * every layer that logs "the URL it connected to" (proxies, shell history if
 * typed, this module's own error paths).
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateExplicitUrl(url) {
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
  return { ok: true }
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
 * @param {object} [opts.env] - injection seam for tests (defaults to process.env)
 * @param {object} [opts.deps] - forwarded to resolveLocalConnection
 * @returns {{ ok: true, url: string, token: string|null, source: 'explicit'|'local' } | { ok: false, reason: string }}
 */
export function resolveConnectionTarget(opts = {}) {
  const env = opts.env || process.env
  const explicitUrl = opts.explicitUrl || env.CHROXY_AGENT_CONTROL_URL || null

  if (explicitUrl) {
    const validation = validateExplicitUrl(explicitUrl)
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

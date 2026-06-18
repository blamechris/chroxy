/**
 * Endpoint + secret resolution for the hook emitters (#5413 Phase 4).
 *
 * Resolution order (env override first — tests rely on it and must never
 * touch the real ~/.chroxy):
 *
 *   endpoint: CHROXY_INGEST_URL → host+port from `CHROXY_HOST` / the
 *             `~/.chroxy/config.json` `host`+`port` keys (CHROXY_CONFIG_DIR
 *             honored) → default 127.0.0.1:8765
 *   secret:   CHROXY_INGEST_SECRET → `~/.chroxy/ingest-secret`
 *             (provisioned 0600 by the daemon, see event-ingest.js)
 *
 * The `host` key mirrors the daemon's bind override (config.host / CHROXY_HOST,
 * see server-cli.js → bind-host.js). A wildcard bind (0.0.0.0 / ::) is still
 * reachable via loopback, so only an explicit NON-wildcard host overrides the
 * 127.0.0.1 default — otherwise a daemon bound to a specific interface would
 * silently swallow every hook emit (audit P2-12).
 *
 * Everything here is read-only and failure-tolerant: a missing/garbled
 * config file falls back to defaults, a missing secret returns null and the
 * emitter exits silently — hooks must never block Claude Code.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isIPv6 } from 'node:net'

/** Matches server-cli.js: `config.port || parseInt(process.env.PORT || '8765')`. */
export const DEFAULT_PORT = 8765

/** Bind values that are reachable via loopback — never override 127.0.0.1. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*'])

export function configDir(env = process.env) {
  return env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}

/**
 * Resolve the daemon host. CHROXY_HOST wins over config.host (mirroring the
 * daemon's own precedence); a wildcard / empty value falls back to loopback.
 */
function resolveHost(env, cfg) {
  for (const candidate of [env.CHROXY_HOST, cfg && cfg.host]) {
    if (typeof candidate !== 'string') continue
    const h = candidate.trim()
    if (h.length === 0 || WILDCARD_HOSTS.has(h)) continue
    return h
  }
  return '127.0.0.1'
}

/**
 * Bracket IPv6 literals so the URL authority is well-formed. Mirrors the
 * server's bind-host.js formatHostForUrl — only ACTUAL IPv6 literals are
 * bracketed (an accidental `host:port` string must not be mis-bracketed).
 */
function formatHostForUrl(host) {
  return isIPv6(host) ? `[${host}]` : host
}

/** Full URL for POST /api/events on the local daemon. */
export function resolveIngestUrl(env = process.env) {
  if (typeof env.CHROXY_INGEST_URL === 'string' && env.CHROXY_INGEST_URL.length > 0) {
    return env.CHROXY_INGEST_URL
  }
  let port = DEFAULT_PORT
  let cfg = null
  try {
    const raw = readFileSync(join(configDir(env), 'config.json'), 'utf-8')
    cfg = JSON.parse(raw)
    if (typeof cfg.port === 'number' && Number.isInteger(cfg.port) && cfg.port >= 1 && cfg.port <= 65535) {
      port = cfg.port
    }
  } catch {
    // No config / unreadable / invalid JSON — default host + port.
  }
  const host = formatHostForUrl(resolveHost(env, cfg))
  return `http://${host}:${port}/api/events`
}

/** The daemon-level ingest secret, or null when unavailable (emit becomes a no-op). */
export function resolveIngestSecret(env = process.env) {
  if (typeof env.CHROXY_INGEST_SECRET === 'string' && env.CHROXY_INGEST_SECRET.length > 0) {
    return env.CHROXY_INGEST_SECRET
  }
  try {
    const secret = readFileSync(join(configDir(env), 'ingest-secret'), 'utf-8').trim()
    return secret.length > 0 ? secret : null
  } catch {
    return null
  }
}

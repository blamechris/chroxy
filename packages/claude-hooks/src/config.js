/**
 * Endpoint + secret resolution for the hook emitters (#5413 Phase 4).
 *
 * Resolution order (env override first — tests rely on it and must never
 * touch the real ~/.chroxy):
 *
 *   endpoint: CHROXY_INGEST_URL → `~/.chroxy/config.json` `port` key
 *             (CHROXY_CONFIG_DIR honored) → default port 8765
 *   secret:   CHROXY_INGEST_SECRET → `~/.chroxy/ingest-secret`
 *             (provisioned 0600 by the daemon, see event-ingest.js)
 *
 * Everything here is read-only and failure-tolerant: a missing/garbled
 * config file falls back to defaults, a missing secret returns null and the
 * emitter exits silently — hooks must never block Claude Code.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Matches server-cli.js: `config.port || parseInt(process.env.PORT || '8765')`. */
export const DEFAULT_PORT = 8765

export function configDir(env = process.env) {
  return env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')
}

/** Full URL for POST /api/events on the local daemon. */
export function resolveIngestUrl(env = process.env) {
  if (typeof env.CHROXY_INGEST_URL === 'string' && env.CHROXY_INGEST_URL.length > 0) {
    return env.CHROXY_INGEST_URL
  }
  let port = DEFAULT_PORT
  try {
    const raw = readFileSync(join(configDir(env), 'config.json'), 'utf-8')
    const cfg = JSON.parse(raw)
    if (typeof cfg.port === 'number' && Number.isInteger(cfg.port) && cfg.port >= 1 && cfg.port <= 65535) {
      port = cfg.port
    }
  } catch {
    // No config / unreadable / invalid JSON — default port.
  }
  return `http://127.0.0.1:${port}/api/events`
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

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
 *             (provisioned 0600 by the daemon, see event-ingest.js — and
 *             read back under the SAME 0600/owner boundary the daemon
 *             enforces, #7894; see resolveIngestSecret below)
 *
 * The `host` key mirrors the daemon's bind override (config.host / CHROXY_HOST,
 * see server-cli.js → bind-host.js). A wildcard bind (0.0.0.0 / ::) is still
 * reachable via loopback, so only an explicit NON-wildcard host overrides the
 * 127.0.0.1 default — otherwise a daemon bound to a specific interface would
 * silently swallow every hook emit (audit P2-12).
 *
 * Everything here is read-only and failure-tolerant: a missing/garbled
 * config file falls back to defaults, a missing OR untrustworthy secret
 * (absent, wrong mode, wrong owner, a symlink) returns null and the emitter
 * exits silently — hooks must never block Claude Code.
 */

import { readFileSync, openSync, fstatSync, closeSync, constants as fsConstants } from 'node:fs'
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

/**
 * #7894 — parity with the daemon's read-time mode+owner check on the same
 * file (`assertIngestSecretFileTrusted` in packages/server/src/event-ingest.js,
 * #7246/#7889): mode exactly 0600, owner uid === this process's uid, POSIX
 * only (win32 mode bits don't reflect NTFS ACLs — the same carve-out every
 * sibling credential store in this codebase uses). This package has zero
 * runtime deps and no dependency on @chroxy/server, so it cannot import that
 * (unexported, private) daemon function — the literal is reproduced here
 * instead. `pins the required mode` in tests/emit.test.js is the parity pin.
 *
 * Unlike the daemon, which THROWS on an untrustworthy file (it must not
 * trust an INCOMING credential), this reader is fetching its OWN outbound
 * credential: a bad file means "treat the secret as absent", never a throw
 * — hooks must never block Claude Code, and sending a secret the daemon
 * will 401 anyway would only leak it onto the wire for nothing.
 */
export const INGEST_SECRET_REQUIRED_MODE = 0o600

/**
 * One stderr line, unconditionally (not gated behind CHROXY_HOOKS_DEBUG) —
 * a silently-disabled ingest secret is otherwise invisible, since the
 * caller just sees every notification stop flowing with no error anywhere.
 */
function warnIngestSecretRejected(path, reason) {
  try {
    process.stderr.write(`chroxy-hooks: refusing to read ${path} (${reason}) — fix with: chmod 600 ${path}\n`)
  } catch {
    // stderr unavailable (e.g. torn-down process) — nothing more to do; the
    // caller still fails closed below regardless.
  }
}

/**
 * Open `path` refusing a final-component symlink (`O_NOFOLLOW` on POSIX —
 * undefined/0 on win32, where the mode/owner checks below are skipped
 * entirely anyway, matching the daemon's carve-out, so there is nothing
 * left for a symlink swap to bypass on that platform), then verify the
 * OPENED FILE's mode and owner via `fstat` on that same handle — never a
 * separate `statSync` followed by a fresh `readFileSync(path)`, which
 * reopens the path and re-introduces exactly the check/read TOCTOU #7893
 * describes fixing via openNoFollow+fstat — and read the secret from that
 * handle.
 *
 * Returns the trimmed secret, or null for every "not trustworthy" outcome:
 * absent (ENOENT — the normal case before a daemon has ever provisioned
 * the file), a symlink, wrong mode, wrong owner, or any other open/stat
 * failure. Every null caused by a file that DOES exist logs the one-line
 * stderr warning above; a genuinely missing file does not (that is the
 * ordinary "daemon hasn't started yet" case, not a misconfiguration).
 */
function readTrustedIngestSecretFile(path) {
  const isWin32 = process.platform === 'win32'
  const hasONoFollow = !isWin32 && typeof fsConstants.O_NOFOLLOW === 'number' && fsConstants.O_NOFOLLOW !== 0
  const flags = hasONoFollow ? (fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW) : fsConstants.O_RDONLY

  let fd
  try {
    fd = openSync(path, flags)
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    if (err && err.code === 'ELOOP') {
      warnIngestSecretRejected(path, 'refusing to follow a symlink')
      return null
    }
    // Any other open failure (EACCES, ENOTDIR, a race that isn't ENOENT, …)
    // — fail closed like the daemon does for "statSync fails for a reason
    // other than absent": a failure to CHECK is a refusal, not an absence.
    warnIngestSecretRejected(path, `unable to open (${err && err.code ? err.code : err && err.message})`)
    return null
  }

  try {
    if (!isWin32) {
      const stat = fstatSync(fd)
      const perms = stat.mode & 0o777
      if (perms !== INGEST_SECRET_REQUIRED_MODE) {
        warnIngestSecretRejected(path, `mode ${perms.toString(8).padStart(3, '0')}, must be 0600`)
        return null
      }
      const uid = typeof process.getuid === 'function' ? process.getuid() : null
      if (uid !== null && stat.uid !== uid) {
        warnIngestSecretRejected(path, `owned by uid ${stat.uid}, expected uid ${uid}`)
        return null
      }
    }
    const secret = readFileSync(fd, 'utf-8').trim()
    return secret.length > 0 ? secret : null
  } catch (err) {
    warnIngestSecretRejected(path, `unable to read (${err && err.code ? err.code : err && err.message})`)
    return null
  } finally {
    closeSync(fd)
  }
}

/** The daemon-level ingest secret, or null when unavailable (emit becomes a no-op). */
export function resolveIngestSecret(env = process.env) {
  if (typeof env.CHROXY_INGEST_SECRET === 'string' && env.CHROXY_INGEST_SECRET.length > 0) {
    return env.CHROXY_INGEST_SECRET
  }
  return readTrustedIngestSecretFile(join(configDir(env), 'ingest-secret'))
}

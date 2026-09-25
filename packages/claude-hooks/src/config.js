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
 *
 * `fix` is supplied per call site rather than hardcoded to `chmod 600
 * <path>` here: a wrong-OWNER rejection is not fixed by chmod (that needs
 * `chown`, or simply removing the file so the daemon mints a fresh one), and
 * neither is a non-regular-file or symlink rejection — a blanket "fix with:
 * chmod 600" for every reason sends an operator chasing the wrong fix for
 * three of this function's six call sites.
 */
function warnIngestSecretRejected(path, reason, fix) {
  try {
    process.stderr.write(`chroxy-hooks: refusing to read ${path} (${reason}) — fix: ${fix}\n`)
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
 * `O_NONBLOCK` is also set on POSIX. Without it, `openSync` on a FIFO with
 * no writer connected BLOCKS THE ENTIRE PROCESS indefinitely — confirmed by
 * direct repro: a same-uid, mode-0600 FIFO planted at the secret path (e.g.
 * `mkfifo -m 600 ~/.chroxy/ingest-secret`) hangs this synchronous call
 * forever, and since the open() is synchronous there is no event-loop turn
 * left for any caller-side timeout to fire — every hook invocation from
 * then on wedges. `hooks must never block Claude Code` (module doc above)
 * makes a hang strictly worse than the every other failure mode here, which
 * all resolve to null. `O_NONBLOCK` has no effect on a regular file (the
 * only thing this path is ever supposed to be), so the happy path is
 * unchanged; for a FIFO it makes `open` return immediately regardless of a
 * writer. The `stat.isFile()` check below is the second half of the fix: it
 * rejects a FIFO/socket/device outright even when `O_NONBLOCK` lets the
 * open through and even if its mode+uid happen to match (an attacker who
 * can plant a same-uid 0600 FIFO can also keep a writer attached to feed
 * fake bytes through it — non-blocking open alone doesn't stop that).
 *
 * Returns the trimmed secret, or null for every "not trustworthy" outcome:
 * absent (ENOENT — the normal case before a daemon has ever provisioned
 * the file), a symlink, a non-regular file, wrong mode, wrong owner, or any
 * other open/stat/read failure. Every null caused by a file that DOES exist
 * logs the one-line stderr warning above; a genuinely missing file does not
 * (that is the ordinary "daemon hasn't started yet" case, not a
 * misconfiguration).
 */
// Exported ONLY so tests can reach the `__testBetweenCheckAndReadSeam`
// parameter directly — `resolveIngestSecret` below (the sole production
// call site) never passes a 2nd argument, so no production input can ever
// supply one.
export function readTrustedIngestSecretFile(path, __testBetweenCheckAndReadSeam) {
  const isWin32 = process.platform === 'win32'
  const hasONoFollow = !isWin32 && typeof fsConstants.O_NOFOLLOW === 'number' && fsConstants.O_NOFOLLOW !== 0
  const hasONonBlock = !isWin32 && typeof fsConstants.O_NONBLOCK === 'number' && fsConstants.O_NONBLOCK !== 0
  let flags = fsConstants.O_RDONLY
  if (hasONoFollow) flags |= fsConstants.O_NOFOLLOW
  if (hasONonBlock) flags |= fsConstants.O_NONBLOCK

  let fd
  try {
    fd = openSync(path, flags)
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    if (err && err.code === 'ELOOP') {
      warnIngestSecretRejected(path, 'refusing to follow a symlink', `remove ${path} and let the daemon recreate it`)
      return null
    }
    // Any other open failure (EACCES, ENOTDIR, a race that isn't ENOENT, …)
    // — fail closed like the daemon does for "statSync fails for a reason
    // other than absent": a failure to CHECK is a refusal, not an absence.
    warnIngestSecretRejected(
      path,
      `unable to open (${err && err.code ? err.code : err && err.message})`,
      `check that ${path} exists and is readable`,
    )
    return null
  }

  try {
    if (!isWin32) {
      const stat = fstatSync(fd)
      if (!stat.isFile()) {
        warnIngestSecretRejected(path, 'not a regular file', `remove ${path} and let the daemon recreate it`)
        return null
      }
      const perms = stat.mode & 0o777
      if (perms !== INGEST_SECRET_REQUIRED_MODE) {
        warnIngestSecretRejected(path, `mode ${perms.toString(8).padStart(3, '0')}, must be 0600`, `chmod 600 ${path}`)
        return null
      }
      const uid = typeof process.getuid === 'function' ? process.getuid() : null
      if (uid !== null && stat.uid !== uid) {
        // chmod cannot fix this — the mode is already correct. Only chown
        // (or deleting the file so the daemon mints a fresh, self-owned one)
        // changes the owner; naming the wrong tool sends an operator in
        // circles re-running chmod against a file that is already 0600.
        warnIngestSecretRejected(
          path,
          `owned by uid ${stat.uid}, expected uid ${uid}`,
          `chown it to uid ${uid}, or remove ${path} and let the daemon recreate it`,
        )
        return null
      }
    }
    // TEST-ONLY seam (`__testDescendSeam` pattern, byok-tool-executor.js):
    // reachable only when a test calls `readTrustedIngestSecretFile` directly
    // with a 2nd argument — `resolveIngestSecret`, the one production call
    // site, always calls it with a single argument, so no value derived from
    // `env` (or anything else a caller controls) can ever populate this
    // parameter. Lets a test swap the file at `path` for a DIFFERENT one,
    // between the fstat check above and the read below, while `fd` still
    // refers to the ORIGINAL (already-verified) inode — proving the read
    // below draws from `fd`, never from a fresh open of `path`.
    if (__testBetweenCheckAndReadSeam) __testBetweenCheckAndReadSeam(path, fd)
    const secret = readFileSync(fd, 'utf-8').trim()
    return secret.length > 0 ? secret : null
  } catch (err) {
    warnIngestSecretRejected(
      path,
      `unable to read (${err && err.code ? err.code : err && err.message})`,
      `check that ${path} is a readable regular file`,
    )
    return null
  } finally {
    // A throwing `finally` REPLACES whatever the try/catch above was about
    // to return — an EBADF/EIO here would turn a clean `null` return into an
    // uncaught throw out of `resolveIngestSecret`, violating this function's
    // own "never throw" contract even though `runEmit`'s outer try/catch and
    // the CLI's unconditional `process.exit(0)` would still stop it from
    // reaching Claude Code. Best-effort close; a close failure changes
    // nothing about whether the read above already succeeded or failed.
    try { closeSync(fd) } catch { /* best-effort */ }
  }
}

/** The daemon-level ingest secret, or null when unavailable (emit becomes a no-op). */
export function resolveIngestSecret(env = process.env) {
  if (typeof env.CHROXY_INGEST_SECRET === 'string' && env.CHROXY_INGEST_SECRET.length > 0) {
    return env.CHROXY_INGEST_SECRET
  }
  return readTrustedIngestSecretFile(join(configDir(env), 'ingest-secret'))
}

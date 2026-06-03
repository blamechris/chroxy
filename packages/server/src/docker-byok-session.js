/**
 * docker-byok provider (#4053) — runs the claude-byok agent loop on the
 * host (chroxy speaks HTTPS to api.anthropic.com directly), but redirects
 * built-in tool execution (Read / Write / Edit / Bash / Glob / Grep) into
 * an isolated Docker container.
 *
 * Design summary
 * --------------
 * BYOK is in-process: the agent loop runs inside chroxy and there is no
 * subprocess for the model. The isolation boundary here is the TOOLS —
 * the model can still read and write files, but those file ops act on
 * the CONTAINER'S filesystem (which mounts the host cwd at /workspace),
 * and Bash commands the model wants to run execute inside the container
 * with `--cap-drop ALL`, a pids cap, and a non-root user. Anything else
 * — model streaming, permission gating, MCP dispatch, cost accounting —
 * is inherited unchanged from ClaudeByokSession.
 *
 * What's in v1 (this file)
 * ------------------------
 *   - Container lifecycle: start (with preflight `docker info`), destroy
 *   - Workspace volume mount at /workspace (cwd → /workspace, same as
 *     docker-sdk-session.js)
 *   - Tool dispatch override (`_dispatchBuiltinTool`) for the file/bash
 *     surface. Read uses `cat`; Write uses `tee` via stdin; Edit reads,
 *     mutates host-side, writes back; Bash/Glob/Grep run via
 *     `bash -c` inside the container.
 *   - ANTHROPIC_API_KEY forwarded into the container at `docker run`
 *     time (the AC asks for it; the running agent in chroxy is what
 *     actually authenticates to the Anthropic API — the container has
 *     the env in case a Bash command needs it, e.g. a `claude -p` smoke
 *     test inside the container).
 *   - TodoWrite + WebFetch stay host-side (TodoWrite is an in-memory
 *     map; WebFetch is HTTP from chroxy and doesn't touch the FS).
 *   - MCP, Task subagent, permission gating, cost accounting — all
 *     inherited verbatim from ClaudeByokSession.
 *
 * Deferred (follow-up issues)
 * ---------------------------
 *   - (none currently tracked — see "Recently added" below)
 *
 * Recently added
 * --------------
 *   - Per-session container reuse / pooling (#5022 — landed)
 *   - DevContainer / Compose-driven environments (#5024 — landed)
 *   - Snapshot / restore (#5023 — landed)
 *   - postCreateCommand hook (#5025) — opt-in DevContainer-style setup
 *     command (single string or array) that runs once inside the
 *     container before any tool dispatch. Marker-cached on /tmp so a
 *     pooled container that already ran the same command skips it.
 *     This is the explicit ctor opt with marker caching + timeout +
 *     error handling. The `useDevcontainer` overlay parses a
 *     devcontainer.json's own `postCreateCommand` field separately and
 *     runs it non-fatally inside `_startContainer` — that path predates
 *     #5025 and remains the devcontainer-config integration.
 *
 * DevContainer + Compose (#5024)
 * -----------------------------
 *   - `useDevcontainer: true` — start() parses .devcontainer/
 *     devcontainer.json (or .devcontainer.json) from cwd, validates
 *     mounts/env via the shared `devcontainer-config.js` helper, then
 *     overlays `image` / `remoteUser` / `containerEnv` / `mounts` /
 *     `forwardPorts` / `postCreateCommand` onto the bare-image launch.
 *     Explicit constructor opts always win — devcontainer.json is the
 *     fallback default.
 *   - `composeFile: '<path>'` + optional `composeService: '<name>'` —
 *     start() shells `docker compose up -d` against the file (under a
 *     session-scoped project id), identifies the named service's
 *     container, and attaches to it. destroy() runs `docker compose
 *     down --remove-orphans` against the same project so the whole
 *     stack tears down. Pooling is disabled in compose mode.
 *   - Default (neither opt) — original v1 bare-image launch path.
 *
 * Snapshot / restore (#5023)
 * --------------------------
 *   - `snapshot({ name? })` runs `docker commit <containerId>
 *     chroxy-byok-snap:<rand>-<ts>` via the backend, marks the live
 *     container "soiled" so the pool evicts it on release (#5043), and
 *     writes a small metadata JSON to `snapshotsDir` (defaults to
 *     `~/.chroxy/snapshots/`, override via `CHROXY_CONFIG_DIR`) so ops
 *     can list snapshot names without parsing `docker image ls`.
 *   - To restore, pass `snapshotImage: <tag>` to the constructor. The
 *     session uses that tag as the image at `docker run` time and skips
 *     the `useradd` + `chown` setup (the snapshot already has those
 *     baked in). The restored container is auto-soiled — restoring
 *     previous state into a live container couples it to the snapshot's
 *     original conversation history.
 *   - Pool interaction: a snapshotted or restored container goes
 *     through `release()` as normal, but the pool sees the soil marker
 *     and evicts inline instead of pooling. UI / multi-snapshot listing
 *     is deferred to a follow-up.
 *
 * Per `project_worktree_before_docker.md` in project memory: worktree
 * isolation happens BEFORE Docker. This class does not own worktree
 * setup — the SessionManager / environment-manager already worktree the
 * cwd before constructing the session, and we mount whatever cwd the
 * SessionManager hands us.
 */

import { execFile } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { isAbsolute, posix } from 'path'
import { ClaudeByokSession } from './byok-session.js'
import { DockerBackend } from './environments/backends/docker.js'
import { classifyDockerError } from './docker-session.js'
import { buildPoolKey, getSharedPool, isPoolEnabled } from './docker-byok-pool.js'
import { createLogger } from './logger.js'
import {
  parseDevContainer,
  validateMounts,
  sanitizeContainerEnv,
} from './devcontainer-config.js'
import { isOperatorTimeoutInRange } from './duration.js'

const log = createLogger('docker-byok')

/** POSIX username pattern — same shape as docker-sdk-session.js. */
const VALID_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/

const DEFAULT_IMAGE = 'node:22-slim'
const DEFAULT_MEMORY_LIMIT = '2g'
const DEFAULT_CPU_LIMIT = '2'
const DEFAULT_USER = 'chroxy'
const CONTAINER_WORKSPACE = '/workspace'

/**
 * Cap on Read output size to keep tool_result payloads bounded.
 * Mirrors the host-side `readFileTool` philosophy — large files should
 * be sliced via `offset`/`limit`.
 */
const READ_MAX_BYTES = 256 * 1024

/**
 * Cap on Write payload size. Larger writes should be done by the model
 * via a sequence of smaller writes or — better — a Bash command that
 * stages the content from a file already inside the container.
 */
const WRITE_MAX_BYTES = 512 * 1024

/**
 * Default cap on how long a postCreateCommand can run before it's
 * treated as a hang. Five minutes mirrors what DevContainer-style
 * setups (npm install, apt-get install) typically need on first run
 * while still bounding a runaway script. Callers can override via the
 * `postCreateTimeoutMs` ctor opt (#5025).
 */
const DEFAULT_POST_CREATE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Where the post-create completion marker lives inside the container.
 * `/tmp` survives across `docker exec` invocations within the same
 * container (the layered FS persists for the container's lifetime), so
 * a future session that reuses the same container via the pool can
 * probe this file and skip re-running an already-applied setup.
 *
 * The marker filename embeds a SHA-256 fingerprint of the command, so
 * a CHANGED command produces a different marker and is re-applied.
 */
const POST_CREATE_MARKER_PREFIX = '/tmp/.chroxy-post-create-'

/**
 * #5067 — Per-stream cap on captured postCreateCommand output included
 * in the `post_create_command_failed` error event payload. Sized so the
 * trailing tail of a typical `npm install` failure (the lines that
 * actually identify the broken package) survives, while a runaway
 * script that spammed MBs of progress can't push the WS frame past the
 * encryption ceiling. We keep the TAIL because diagnostic info (the
 * actual exception, ENOENT, exit codes) almost always lands at the end.
 */
const POST_CREATE_OUTPUT_CAP_BYTES = 4 * 1024

/**
 * Truncate a captured stream to the last `cap` bytes, emitting a
 * `[truncated — first N bytes omitted]` prefix when we drop anything.
 * The header is a single line so log scrapers can detect truncation
 * without parsing the whole payload. Bytes (not chars) — a UTF-8
 * multibyte sequence at the cut boundary will be replaced by U+FFFD
 * when decoded, which is acceptable for a diagnostic tail.
 */
function tailCapture(text, cap = POST_CREATE_OUTPUT_CAP_BYTES) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= cap) return text
  const omitted = buf.length - cap
  const tail = buf.subarray(buf.length - cap).toString('utf8')
  return `[truncated — first ${omitted} bytes omitted]\n${tail}`
}

/**
 * Map a host-absolute file_path under this.cwd into the container's
 * /workspace mount. Defends against path traversal by refusing absolute
 * paths that aren't under cwd. Relative paths are joined onto
 * /workspace using POSIX semantics — the container is always Linux.
 *
 * Returns a string the model can pass into a `docker exec` command, or
 * throws an Error whose message is safe to surface as a tool_result.
 *
 * @param {string} filePath
 * @param {string} hostCwd
 */
export function remapToContainerPath(filePath, hostCwd) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    const err = new Error('file_path is required')
    err.code = 'EINVAL'
    throw err
  }
  if (typeof hostCwd !== 'string' || hostCwd.length === 0) {
    const err = new Error('host cwd is not configured')
    err.code = 'EINVAL'
    throw err
  }
  // POSIX containers — normalise the host cwd to a POSIX-style mount
  // root so prefix-matching works on Windows hosts too. Trailing
  // slashes get stripped so `cwd === '/Users/foo'` and the file
  // `/Users/foo` itself map to '/workspace' rather than '/workspace/'.
  const normHostCwd = hostCwd.replace(/\/+$/, '')
  if (isAbsolute(filePath)) {
    if (filePath === normHostCwd) return CONTAINER_WORKSPACE
    if (filePath.startsWith(normHostCwd + '/')) {
      const suffix = filePath.slice(normHostCwd.length)
      const joined = posix.join(CONTAINER_WORKSPACE, suffix)
      // The suffix preserves a leading `/`, so a payload like
      // `${cwd}/../etc/passwd` makes posix.join() see the second
      // argument as absolute and DISCARD the /workspace prefix — the
      // result would be `/etc/passwd`. Re-assert the same containment
      // guard as the relative branch so a `..` after the cwd prefix
      // can't escape the workspace mount.
      if (joined !== CONTAINER_WORKSPACE && !joined.startsWith(CONTAINER_WORKSPACE + '/')) {
        const err = new Error(`path outside workspace: ${filePath} resolves to ${joined}`)
        err.code = 'EACCES'
        throw err
      }
      return joined
    }
    const err = new Error(`path outside workspace: ${filePath} is not under ${normHostCwd}`)
    err.code = 'EACCES'
    throw err
  }
  // Relative path → join onto /workspace.
  const joined = posix.join(CONTAINER_WORKSPACE, filePath)
  if (joined !== CONTAINER_WORKSPACE && !joined.startsWith(CONTAINER_WORKSPACE + '/')) {
    // posix.join() collapses `../` segments — if the result escapes
    // /workspace, refuse the call. The `+ '/'` is important so that
    // `/workspaceX` (some sibling path that happens to share the
    // prefix) can't masquerade as the workspace.
    const err = new Error(`path outside workspace: ${filePath} resolves to ${joined}`)
    err.code = 'EACCES'
    throw err
  }
  return joined
}

/**
 * Quote a string for safe interpolation inside single-quoted bash
 * arguments. Mirrors the shellQuote pattern used elsewhere in chroxy.
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * Coerce a `postCreateCommand` opt into a single shell-string that the
 * container can run via `bash -c`. DevContainer's spec allows either a
 * single command string or an array of strings; we honour both. Arrays
 * are joined with ` && ` so every step must succeed — if step 1 fails,
 * step 2 doesn't run, and the overall exit code is non-zero (which the
 * session treats as a setup failure).
 *
 * Returns `null` when the opt is missing, an empty string, or an empty
 * array — those all mean "no post-create hook" and let `start()` skip
 * the marker probe entirely (#5025).
 *
 * Strictness: any non-string entry inside an array throws (#5063 review
 * — Copilot). Silently dropping a non-string entry would mask
 * misconfiguration (e.g. `postCreateCommand: ['npm install', null,
 * 'npm test']` would have run install + test, skipping the failed
 * middle slot, instead of failing loudly at construction). The same
 * goes for empty-string entries — those almost certainly indicate a
 * typo / templating bug and should be surfaced.
 */
export function normalizePostCreateCommand(value) {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    const parts = value.map((entry, idx) => {
      if (typeof entry !== 'string') {
        throw new Error(
          `postCreateCommand[${idx}] must be a string (got ${entry === null ? 'null' : typeof entry})`,
        )
      }
      const trimmed = entry.trim()
      if (trimmed.length === 0) {
        throw new Error(`postCreateCommand[${idx}] must be a non-empty string`)
      }
      return trimmed
    })
    return parts.join(' && ')
  }
  throw new Error('postCreateCommand must be a string or an array of strings')
}

export class DockerByokSession extends ClaudeByokSession {
  static get displayLabel() {
    return 'Claude (BYOK — Docker container)'
  }

  static get capabilities() {
    return { ...ClaudeByokSession.capabilities, containerized: true }
  }

  /**
   * Preflight credentials block. Same shape as ClaudeByokSession — the
   * agent loop still runs on the host so the credential set / hint /
   * required-ness is identical to host-side BYOK. The container itself
   * does NOT need to be authenticated to talk to Anthropic; chroxy
   * does that. ANTHROPIC_API_KEY is forwarded as a convenience for the
   * model's Bash command (e.g. a one-off `curl api.anthropic.com`).
   */
  static get preflight() {
    return {
      ...ClaudeByokSession.preflight,
      label: 'Claude (BYOK — Docker container)',
    }
  }

  /**
   * Reuse ClaudeByokSession's resolveAuth: same env vars, same
   * credential file path, same readiness rules. The container's
   * absence of ~/.chroxy state does NOT change anything here — the
   * agent loop runs on the host.
   */
  static resolveAuth(env, helpers) {
    return ClaudeByokSession.resolveAuth(env, helpers)
  }

  /**
   * @param {object} [opts]
   * @param {string} [opts.image='node:22-slim']     Container image
   * @param {string} [opts.memoryLimit='2g']         `docker run --memory`
   * @param {string} [opts.cpuLimit='2']             `docker run --cpus`
   * @param {string} [opts.containerUser='chroxy']   Non-root user inside container
   * @param {string} [opts.containerId]              Attach to an existing container
   *   instead of launching one (env-manager managed). When omitted, the
   *   session owns the container and tears it down on destroy().
   * @param {boolean} [opts.useDevcontainer=false]   #5024: Opt-in flag
   *   — when true, parse `.devcontainer/devcontainer.json` (or the
   *   `.devcontainer.json` sidecar) from cwd and overlay its
   *   `image` / `remoteUser` / `containerEnv` / `mounts` /
   *   `forwardPorts` / `postCreateCommand` onto the launch. Explicit
   *   constructor opts always win; devcontainer.json is the fallback
   *   default. No-op when the file is absent or malformed.
   *
   *   This is opt-in (not auto-discovery from cwd) so existing
   *   sessions whose cwd happens to contain a devcontainer.json don't
   *   silently change behaviour. The caller (CLI flag, dashboard
   *   toggle, env-manager) is responsible for setting this when the
   *   user has asked for devcontainer-driven environments.
   * @param {string} [opts.composeFile]              #5024: Path to a
   *   `docker-compose.yml`. When set, start() runs `docker compose up
   *   -d` under a session-scoped project id and attaches to the named
   *   service container. destroy() runs `docker compose down
   *   --remove-orphans` to tear the whole stack down. Pooling is
   *   disabled in this mode.
   *
   *   This is opt-in (not auto-discovery from cwd) — see the note on
   *   `useDevcontainer` above. The caller passes the path explicitly.
   * @param {string} [opts.composeService]           #5024: Optional
   *   service name from the compose file to attach to (the "primary"
   *   service). When omitted, the first service from `docker compose
   *   ps` is picked.
   * @param {string|string[]} [opts.postCreateCommand=null]
   *   #5025: DevContainer-style setup command(s) that run inside the
   *   container once after launch and before the session is marked
   *   ready. Strings run verbatim; arrays are joined with ` && ` so
   *   every step must succeed. A SHA-256 marker file on /tmp prevents
   *   re-execution when the same container is reused across sessions
   *   (#5022 pool). Only runs for owned containers — externally-managed
   *   containers are the caller's responsibility. This ctor opt is
   *   independent of (and runs in addition to) any `postCreateCommand`
   *   field parsed from devcontainer.json under `useDevcontainer`.
   * @param {number} [opts.postCreateTimeoutMs=300_000]
   *   #5025: Cap on how long postCreateCommand can run before it's
   *   treated as a hang (default 5 minutes).
   * @param {object} [opts._dockerBackend]           Test seam — pre-built backend
   * @param {Function} [opts._execFile]              Test seam — used by preflight
   *   (defaults to child_process.execFile)
   * @param {object} [opts._pool]                    Test seam — explicit pool
   *   instance. When omitted and pooling is enabled (via env), the shared
   *   process-wide pool is used. When omitted and pooling is disabled,
   *   pooling is skipped entirely (per-session lifecycle only).
   * @param {Record<string,string>} [opts._poolEnv]  Test seam — alternate env
   *   for pool enablement, defaults to `process.env`.
   */
  constructor(opts = {}) {
    // Forward every BaseSession/ClaudeByokSession opt verbatim via
    // spread (`...opts`) so the lint-session-opt-forwarding linter is
    // satisfied and we never accidentally drop a BaseSession opt
    // (`feedback_jsonl_subprocess_middle_layer.md` in project memory).
    // Override `provider` so the session reports `docker-byok` for
    // wire-protocol consumers (display label, capabilities matrix).
    super({ ...opts, provider: opts.provider || 'docker-byok' })

    // #5024: DevContainer auto-discovery (off by default). When set,
    // start() reads `.devcontainer/devcontainer.json` from cwd and
    // overlays its `image` / `remoteUser` / `containerEnv` / `mounts` /
    // `forwardPorts` / `postCreateCommand` onto the session defaults.
    // Explicit constructor opts always win — devcontainer.json acts as
    // the "fallback default" when the operator hasn't set a field.
    this._useDevcontainer = opts.useDevcontainer === true
    // Record raw caller opts now so the merge in start() can tell
    // "caller set image=X" apart from "default".
    this._explicitImage = opts.image
    this._explicitContainerUser = opts.containerUser
    this._dcConfig = null

    // #5024: Docker Compose support. When `composeFile` is set, start()
    // shells out `docker compose up -d` against that file and attaches
    // to the named service container instead of running a fresh image.
    // The compose stack is owned by THIS session: destroy() tears it
    // down with `docker compose down --remove-orphans`. To attach to a
    // pre-existing compose stack, pass `containerId` instead.
    this._composeFile = typeof opts.composeFile === 'string' && opts.composeFile.trim()
      ? opts.composeFile.trim()
      : null
    this._composeService = typeof opts.composeService === 'string' && opts.composeService.trim()
      ? opts.composeService.trim()
      : null
    // Compose project id — a session-scoped suffix so two sessions
    // pointed at the same compose file get isolated stacks. Mirrors
    // environment-manager's `chroxy-${envId}` naming. Resolved lazily
    // in start() so construction stays deterministic.
    this._composeProject = null

    const user = opts.containerUser || DEFAULT_USER
    if (!VALID_USERNAME_RE.test(user)) {
      throw new Error(`Invalid containerUser "${user}" — must match POSIX username rules`)
    }
    this._containerUser = user
    this._image = opts.image || DEFAULT_IMAGE
    this._memoryLimit = opts.memoryLimit || DEFAULT_MEMORY_LIMIT
    this._cpuLimit = opts.cpuLimit || DEFAULT_CPU_LIMIT
    // External container support — when an env-manager hands us an
    // already-running containerId we attach to it and DON'T tear it
    // down on destroy.
    const containerId = typeof opts.containerId === 'string' ? opts.containerId.trim() : null
    this._containerId = containerId || null
    this._containerOwned = !containerId
    this._dockerBackend = opts._dockerBackend || new DockerBackend()
    this._execFile = opts._execFile || execFile
    this._containerReady = false
    // #5022: across-session idle pool. Off by default — opted in via env
    // or by passing an explicit `_pool` instance. Per-session reuse of
    // the same container across multiple turns is unconditional and
    // independent of pooling.
    // #5024: pooling is also disabled when the session manages a
    // compose stack — the pool key is shaped for single-container
    // resource shape (image/memory/cpu/user) and would silently reuse
    // a bare-image container for a compose session. The destroy() path
    // for compose unconditionally runs `docker compose down`.
    const poolEnv = opts._poolEnv || process.env
    if (opts._pool) {
      this._pool = opts._pool
    } else if (!opts.containerId && !this._composeFile && isPoolEnabled(poolEnv)) {
      this._pool = getSharedPool(poolEnv)
    } else {
      this._pool = null
    }
    // Set to `true` if the container picked up THIS session originated
    // from the pool — used at destroy() time to decide between pool
    // release and inline `docker rm -f`.
    this._acquiredFromPool = false

    // #5025 — DevContainer-style postCreateCommand hook. Normalised to
    // a single string (arrays joined with ` && `) and SHA-256-hashed so
    // a marker file on /tmp lets a reused pool container skip the run
    // when the same command was already applied. `null` (the default)
    // disables the hook entirely — start() takes no extra round trips.
    //
    // Timeout is validated via the shared `isOperatorTimeoutInRange`
    // helper (#5063 review — Copilot). Same MAX_SANE_DURATION_MS (24h)
    // ceiling the protocol schemas + ws-history apply — a typoed
    // `postCreateTimeoutMs: 99999999999` (extra digit) silently falls
    // back to the 5-minute default and logs a warning instead of
    // creating a many-hours `docker exec` hang.
    this._postCreateCommand = normalizePostCreateCommand(opts.postCreateCommand)
    this._postCreateTimeoutMs = isOperatorTimeoutInRange(opts.postCreateTimeoutMs, {
      name: 'postCreateTimeoutMs',
      log,
    })
      ? opts.postCreateTimeoutMs
      : DEFAULT_POST_CREATE_TIMEOUT_MS
    this._postCreateMarkerPath = this._postCreateCommand
      ? `${POST_CREATE_MARKER_PREFIX}${createHash('sha256').update(this._postCreateCommand).digest('hex').slice(0, 16)}`
      : null
  }

  /**
   * Preflight check: confirm the local Docker daemon is reachable
   * before any state mutation. Resolves true on success, rejects with
   * a classified error (code:'docker_not_running' etc.) on failure.
   *
   * Exposed as a method so callers (tests, dashboards) can probe
   * docker readiness without instantiating the full session.
   */
  _preflightDocker() {
    return new Promise((resolve, reject) => {
      this._execFile('docker', ['info'], { encoding: 'utf-8', timeout: 10_000 }, (err, _stdout, stderr) => {
        if (err) {
          const classified = classifyDockerError(err, stderr)
          const error = new Error(classified.message)
          error.code = classified.code
          reject(error)
          return
        }
        resolve(true)
      })
    })
  }

  /**
   * Launch the container if we own it, then call super.start() so the
   * Anthropic client / MCP fleet / ready event all wire up normally.
   *
   * When attaching to an external container (env-manager managed),
   * skips the launch but still preflights `docker info` so a dead
   * daemon doesn't silently fail the first tool call.
   */
  async start() {
    try {
      await this._preflightDocker()
    } catch (err) {
      // Surface preflight failures as a session error (same shape as
      // docker-sdk-session uses for its own start-failure path) and
      // tear down — the session can't function without Docker.
      this.emit('error', {
        code: err.code || 'docker_error',
        message: `docker-byok preflight: ${err.message}`,
      })
      await this.destroy()
      return
    }

    if (this._containerOwned) {
      try {
        await this._acquireOrStartContainer()
      } catch (err) {
        this.emit('error', {
          code: err.code || 'docker_error',
          message: `docker-byok failed to start container: ${err.message}`,
        })
        await this.destroy()
        return
      }

      // #5025: run the DevContainer-style postCreateCommand after the
      // container is up but before super.start() — that way a setup
      // failure (missing package.json, broken npm script) fails the
      // session start instead of silently surfacing on the first tool
      // call. Only runs for OWNED containers; externally-managed ones
      // are the caller's responsibility (e.g. an env-manager that
      // already drove its own post-create).
      if (this._postCreateCommand) {
        try {
          await this._runPostCreateCommandIfNeeded()
        } catch (err) {
          // #5067 — Surface BOTH captured streams so the operator can
          // diagnose without re-running the failed setup. The backend's
          // `execInEnvironment` (docker.js) attaches `stdout` / `stderr`
          // on the rejected Error; we tail-cap each to keep the event
          // payload bounded. `err.stdout` / `err.stderr` are guaranteed
          // to be strings (empty when not captured) for the docker-backed
          // path; the `?? ''` guards a synthetic throw (e.g. invalid user
          // regex) that didn't pass through the docker exec callback.
          this.emit('error', {
            code: 'post_create_command_failed',
            message: `docker-byok postCreateCommand failed: ${err.message}`,
            stdout: tailCapture(err.stdout ?? ''),
            stderr: tailCapture(err.stderr ?? ''),
          })
          await this.destroy()
          return
        }
      }
    } else {
      // External container — verify it's reachable before we lie to
      // the model about being ready.
      try {
        await this._verifyContainer()
      } catch (err) {
        this.emit('error', {
          code: err.code || 'docker_error',
          message: `docker-byok external container not reachable: ${err.message}`,
        })
        await this.destroy()
        return
      }
    }

    // Fix for PR #5021 review (Copilot, comment id 3348029212): only
    // mark the container ready AFTER super.start() succeeds, and
    // self-destroy on its failure. Pre-fix, super.start()'s missing-
    // creds path emitted 'error' and returned without setting
    // _processReady — leaving the owned container running with
    // _containerReady === true and nobody guaranteed to call destroy().
    try {
      await super.start()
    } catch (err) {
      this.emit('error', {
        code: 'session_start_failed',
        message: `docker-byok session start failed: ${err.message}`,
      })
      await this.destroy()
      return
    }
    if (!this._processReady) {
      // super.start() emitted its own 'error' event (e.g. missing
      // creds) and returned without marking the session ready. Tear
      // down the owned container so we don't leak it.
      await this.destroy()
      return
    }
    this._containerReady = true
  }

  /**
   * Compute the pool key for this session's resource shape. Same shape
   * used by `DockerContainerPool` so acquire / release lookups match.
   *
   * The host cwd is part of the key because /workspace is bind-mounted
   * from cwd — reusing a container across cwds would silently surface
   * files from another workspace.
   */
  _poolKey() {
    return buildPoolKey({
      image: this._image,
      cwd: this.cwd || process.cwd(),
      memoryLimit: this._memoryLimit,
      cpuLimit: this._cpuLimit,
      containerUser: this._containerUser,
    })
  }

  /**
   * Mark this session's live container "soiled" — its filesystem has
   * been coupled to the current conversation (most often by taking a
   * Docker snapshot) and MUST NOT be handed to a future session via the
   * pool. The pool intercepts the next `release()` and evicts inline.
   *
   * Integration point for #5023 (docker-byok snapshot/restore): when
   * snapshot support lands, the snapshot helper must call this AFTER
   * `docker commit` succeeds (the snapshot includes the writable layer,
   * so the container's auth / files / artifacts are now part of an
   * image that's tied to this conversation). The restore-from-snapshot
   * path does the same — restoring previous state into the live
   * container couples it to a specific session's history.
   *
   * No-ops cleanly when pooling is disabled (no `_pool`) or when the
   * session does not hold a container (no `_containerId` yet). Safe to
   * call multiple times — `markSoiled` is idempotent.
   */
  markActiveContainerSoiled() {
    if (!this._pool) return
    if (!this._containerId) return
    this._pool.markSoiled(this._containerId)
  }

  /**
   * If pooling is enabled, try to claim a warm container for this
   * session's resource shape. On a hit, verify the container still
   * responds to `docker exec` — if so, skip `_startContainer()`
   * entirely. On a miss (or on a verify failure), fall back to a fresh
   * launch.
   *
   * #5022 — across-session idle pool. Per-session reuse of the same
   * container across turns is handled in `_dispatchBuiltinTool` and
   * does not depend on the pool.
   */
  async _acquireOrStartContainer() {
    // #5024: compose mode short-circuits the entire pool + bare-image
    // path. The compose stack owns its own container; destroy()
    // unwinds it with `docker compose down`.
    if (this._composeFile) {
      await this._startComposeStack()
      return
    }
    // #5024: devcontainer parsing must happen BEFORE the pool lookup
    // because the resolved image/user are part of the pool key.
    if (this._useDevcontainer) {
      this._resolveDevContainer()
    }
    if (this._pool) {
      const key = this._poolKey()
      const reused = this._pool.acquire(key)
      if (reused) {
        this._containerId = reused
        try {
          await this._verifyContainer()
          // Pool hit: skip `useradd` + `chown` — the previous session
          // ran them inside THIS container, and we're reusing the same
          // running container (it never stopped, so `/etc/passwd` and
          // `/workspace` ownership stay put). If pooling ever switches
          // to stop/start (or commit/restart), this assumption needs to
          // be revisited — a stopped-then-restarted container preserves
          // its layered FS but the previous-session assumption about
          // "the user already exists" still holds at the FS level.
          this._acquiredFromPool = true
          log.info(`reused pooled container ${reused.slice(0, 12)}`)
          return
        } catch (err) {
          // The pooled container died while idle (daemon restart, OOM
          // kill). Forget it and fall through to a fresh launch. Use
          // the pool's `forget()` helper so `_createdAt` gets cleared
          // alongside the `docker rm -f` — otherwise the map slowly
          // leaks across long-running servers (#5045 review). Fire-and-
          // forget; we don't block start on cleanup of a dead id.
          log.warn(`pooled container ${reused.slice(0, 12)} failed verify: ${err.message} — launching fresh`)
          this._containerId = null
          this._pool.forget(reused).catch(() => {})
        }
      }
    }
    await this._startContainer()
  }

  /**
   * #5024: Parse `.devcontainer/devcontainer.json` from cwd and
   * overlay supported fields onto this session's state. Explicit
   * constructor opts always win — devcontainer.json is the fallback.
   * No-op when no devcontainer.json exists or the file is malformed
   * (the parser logs and returns `{}`).
   *
   * Stores the parsed config in `this._dcConfig` so `_startContainer`
   * can apply `mounts` / `containerEnv` / `forwardPorts` /
   * `postCreateCommand` to the `docker run` and `docker exec` calls.
   */
  _resolveDevContainer() {
    const cwd = this.cwd || process.cwd()
    const config = parseDevContainer(cwd, { logger: log })
    if (config && Object.keys(config).length > 0) {
      log.info(`devcontainer.json overlay active (cwd=${cwd})`)
    }
    // image: caller opt wins over devcontainer.json wins over DEFAULT_IMAGE.
    if (!this._explicitImage && config.image) {
      this._image = config.image
    }
    // remoteUser: caller opt wins over devcontainer.json wins over DEFAULT_USER.
    if (!this._explicitContainerUser && config.remoteUser) {
      // Validate the user name — devcontainer.json is untrusted input.
      if (VALID_USERNAME_RE.test(config.remoteUser)) {
        this._containerUser = config.remoteUser
      } else {
        log.warn(`devcontainer.json remoteUser "${config.remoteUser}" rejected — keeping ${this._containerUser}`)
      }
    }
    // Validate mounts and env now so a bad value surfaces at start time
    // instead of when docker rejects the run call.
    this._dcConfig = {
      ...config,
      mounts: validateMounts(config.mounts, cwd, { logger: log }),
      containerEnv: sanitizeContainerEnv(config.containerEnv, { logger: log }),
    }
  }

  /**
   * #5024: Bring up the compose stack and identify the primary service
   * container. The stack is owned by THIS session — destroy() runs
   * `docker compose down --remove-orphans` against the same project id.
   *
   * Mirrors EnvironmentManager._createComposeEnvironment so the
   * security posture is identical: the named service container has its
   * non-root user created the same way the bare-image path does, the
   * host cwd is mounted at /workspace via the compose file (the user
   * is responsible for that volume mapping), and tool dispatch goes
   * through the same `_execAsContainerUser` path.
   */
  async _startComposeStack() {
    if (!this._composeProject) {
      this._composeProject = `chroxy-byok-${randomBytes(6).toString('hex')}`
    }
    const cwd = this.cwd || process.cwd()
    log.info(`docker-byok compose stack starting (file=${this._composeFile} project=${this._composeProject} service=${this._composeService || '<first>'})`)
    let result
    try {
      result = await this._dockerBackend.createComposeEnvironment({
        envId: this._composeProject,
        cwd,
        composeFile: this._composeFile,
        composeProject: this._composeProject,
        containerUser: this._containerUser,
        primaryService: this._composeService,
      })
    } catch (err) {
      const error = new Error(`docker compose start failed: ${err.message}`)
      error.code = err.code || 'compose_start_failed'
      throw error
    }
    this._containerId = result.containerId
    log.info(`docker-byok compose primary container: ${this._containerId.slice(0, 12)}`)
  }

  /**
   * Launch a long-lived container with the host cwd mounted at
   * /workspace and the standard chroxy hardening (cap-drop, pids
   * limit, no-new-privileges, non-root user). Mirrors the runArgs
   * shape used by docker-sdk-session.js so the security posture is
   * identical across the two providers.
   */
  _startContainer() {
    return new Promise((resolve, reject) => {
      const runArgs = [
        'run', '-d', '--init', '--rm',
        '--memory', this._memoryLimit,
        '--cpus', this._cpuLimit,
        '--pids-limit', '512',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '-v', `${this.cwd || process.cwd()}:${CONTAINER_WORKSPACE}`,
        '-w', CONTAINER_WORKSPACE,
      ]

      // Issue AC: forward ANTHROPIC_API_KEY at `docker run` time. The
      // agent loop on the host is what actually authenticates to the
      // Anthropic API, but the model may want to invoke `curl` or a
      // CLI inside the container that expects this env var.
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (apiKey) {
        runArgs.push('--env', `ANTHROPIC_API_KEY=${apiKey}`)
      }

      // #5024: devcontainer.json overlay — extra mounts, env, and port
      // forwards. Mounts and env were already validated/sanitized by
      // `_resolveDevContainer()`; whatever survived is safe to pass
      // straight through. `forwardPorts` accepts integers and
      // "host:container" strings — both shapes emit `-p X:Y`.
      const dc = this._dcConfig
      if (dc) {
        if (Array.isArray(dc.mounts)) {
          for (const mount of dc.mounts) {
            runArgs.push('--mount', mount)
          }
        }
        if (dc.containerEnv && typeof dc.containerEnv === 'object') {
          for (const [key, value] of Object.entries(dc.containerEnv)) {
            runArgs.push('--env', `${key}=${value}`)
          }
        }
        if (Array.isArray(dc.forwardPorts)) {
          for (const port of dc.forwardPorts) {
            if (typeof port === 'number' && Number.isFinite(port) && port > 0 && port < 65536) {
              runArgs.push('-p', `${port}:${port}`)
            } else if (typeof port === 'string' && /^\d+(:\d+)?$/.test(port)) {
              // Bare-port strings ("3000") would otherwise become
              // `docker run -p 3000`, which Docker treats as "publish
              // container port 3000 to a RANDOM host port" — surprising
              // for a DevContainer-style forward where the model
              // expects 3000:3000. Normalise to host:container when the
              // colon is missing so the numeric and string forms
              // behave identically.
              const normalized = port.includes(':') ? port : `${port}:${port}`
              runArgs.push('-p', normalized)
            } else {
              log.warn(`devcontainer.json forwardPorts entry rejected (invalid): ${port}`)
            }
          }
        }
      }

      if (process.platform === 'linux') {
        runArgs.push('--add-host', 'host.docker.internal:host-gateway')
      }

      runArgs.push(this._image, 'sleep', 'infinity')

      log.info(
        `starting container (image=${this._image} memory=${this._memoryLimit} cpus=${this._cpuLimit})`,
      )

      this._execFile('docker', runArgs, { encoding: 'utf-8', timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          const classified = classifyDockerError(err, stderr)
          const error = new Error(classified.message)
          error.code = classified.code
          reject(error)
          return
        }
        this._containerId = stdout.trim()
        log.info(`container started: ${this._containerId.slice(0, 12)}`)

        // Set up non-root user + chown workspace so the model isn't
        // running as root inside the container. Same script
        // docker-sdk-session uses — keep the two in lockstep.
        const setupCmd = [
          `useradd -m -s /bin/bash ${this._containerUser}`,
          `chown ${this._containerUser}:${this._containerUser} ${CONTAINER_WORKSPACE}`,
        ].join(' && ')

        this._execFile('docker', [
          'exec', this._containerId, 'bash', '-c', setupCmd,
        ], { encoding: 'utf-8', timeout: 30_000 }, (setupErr) => {
          if (setupErr) {
            reject(new Error(`Failed to create container user: ${setupErr.message}`))
            return
          }
          log.info(`created non-root user "${this._containerUser}" in container`)

          // #5024: devcontainer.json postCreateCommand. Runs once,
          // after useradd, as the non-root user. Failures are
          // non-fatal — log a warning so the session can still start.
          // postCreateCommand in devcontainer.json is primarily for
          // installing language toolchains; bound at 5 minutes here,
          // same ceiling DockerBackend._runPostCreateCommand uses.
          const dcLocal = this._dcConfig
          if (dcLocal && typeof dcLocal.postCreateCommand === 'string' && dcLocal.postCreateCommand.length > 0) {
            this._execFile('docker', [
              'exec', '-u', this._containerUser, this._containerId, 'bash', '-c', dcLocal.postCreateCommand,
            ], { encoding: 'utf-8', timeout: 300_000 }, (postErr) => {
              if (postErr) {
                log.warn(`postCreateCommand failed (non-fatal): ${postErr.message}`)
              } else {
                log.info('postCreateCommand completed')
              }
              resolve()
            })
            return
          }
          resolve()
        })
      })
    })
  }

  /**
   * #5025 — DevContainer-style postCreateCommand hook.
   *
   * Idempotency contract: a SHA-256-derived marker file lives at
   * `/tmp/.chroxy-post-create-<hash>` inside the container. If the
   * probe (`test -f <marker>`) succeeds, the command has already been
   * applied to THIS container and we skip the run entirely — that's
   * the whole reason the #5022 pool layer is useful for setup-heavy
   * workspaces. A different command produces a different hash, so a
   * change to `postCreateCommand` between sessions reuses the same
   * container but re-runs setup.
   *
   * Failure surface: any non-zero exit (including timeout, backend
   * reject, or marker-write failure) throws — the caller is `start()`,
   * which converts the throw into a `post_create_command_failed` error
   * event and tears the session down. The marker is only written on
   * full success (command itself succeeds AND the marker write
   * succeeds), so a half-applied state can never be cached.
   */
  async _runPostCreateCommandIfNeeded() {
    if (!this._postCreateCommand || !this._postCreateMarkerPath) return
    // Probe for the marker. The backend rejects on non-zero exit, so a
    // `test -f` that finds the marker resolves clean and a missing
    // marker throws. Catch the throw and fall through to the run path
    // — any OTHER failure (daemon down, exec disabled) will also throw
    // here, and the run path will rediscover the underlying error.
    let markerPresent = false
    try {
      await this._execAsContainerUser({
        cmd: `test -f ${shellQuote(this._postCreateMarkerPath)}`,
        timeout: 10_000,
      })
      markerPresent = true
    } catch {
      markerPresent = false
    }
    if (markerPresent) {
      log.info(`postCreateCommand already applied (marker ${this._postCreateMarkerPath.slice(-12)}) — skipping`)
      return
    }

    log.info(`running postCreateCommand (timeout=${this._postCreateTimeoutMs}ms)`)
    // Run the command. The backend's execInEnvironment forwards both
    // stdout and stderr and rejects on non-zero exit, so we don't need
    // to inspect an exit code here — a throw IS the failure path.
    await this._execAsContainerUser({
      cmd: this._postCreateCommand,
      timeout: this._postCreateTimeoutMs,
    })

    // Stamp the marker so the next session that lands on this container
    // skips the run. `mkdir -p` on the prefix would be wrong (the prefix
    // is /tmp, which always exists), so just `touch` the file. Failure
    // here ALSO fails the post-create — without a marker write, a
    // future reuse would re-run a command we just successfully applied,
    // which would be wasteful and (for non-idempotent commands like
    // `apt-get install`) potentially incorrect.
    await this._execAsContainerUser({
      cmd: `touch ${shellQuote(this._postCreateMarkerPath)}`,
      timeout: 10_000,
    })
    log.info(`postCreateCommand applied — marker stamped at ${this._postCreateMarkerPath.slice(-12)}`)
  }

  /**
   * Confirm an externally-managed container is reachable via
   * `docker exec`. Used when `containerId` was supplied at construction.
   */
  _verifyContainer() {
    return new Promise((resolve, reject) => {
      this._execFile('docker', [
        'exec', this._containerId, 'true',
      ], { encoding: 'utf-8', timeout: 10_000 }, (err, _stdout, stderr) => {
        if (err) {
          const classified = classifyDockerError(err, stderr)
          const error = new Error(classified.message)
          error.code = classified.code
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  /**
   * Override ClaudeByokSession's dispatcher: route file ops and Bash
   * into the container instead of running them in-process on the host.
   *
   * TodoWrite stays host-side (it's a pure in-memory map). WebFetch
   * stays host-side (it's HTTP and never touches the host FS — putting
   * it in the container would only add latency).
   */
  async _dispatchBuiltinTool({ toolName, input, signal }) {
    if (!this._containerReady || !this._containerId) {
      return {
        content: `docker-byok: container not ready (tool ${toolName})`,
        isError: true,
      }
    }
    try {
      switch (toolName) {
        case 'Read':
          return await this._containerRead(input)
        case 'Write':
          return await this._containerWrite(input)
        case 'Edit':
          return await this._containerEdit(input)
        case 'Bash':
          return await this._containerBash(input, signal)
        case 'Glob':
          return await this._containerGlob(input, signal)
        case 'Grep':
          return await this._containerGrep(input, signal)
        case 'TodoWrite':
        case 'WebFetch':
        case 'AskUserQuestion':
          // Host-side execution is correct for these — see class docstring.
          return await super._dispatchBuiltinTool({ toolName, input, signal })
        default:
          return await super._dispatchBuiltinTool({ toolName, input, signal })
      }
    } catch (err) {
      // Mirror byok-tool-executor.js's catch-all: surface as an
      // is_error tool_result so the model can recover or report up.
      return {
        content: `Tool ${toolName} failed in docker-byok: ${err?.message || String(err)}`,
        isError: true,
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tool implementations — container-side
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run a bash command inside the container as the non-root container
   * user. Single source of truth for every tool dispatch so the `useradd`
   * + `chown /workspace` setup done at container start is actually
   * respected. Mirrors `streamCliInEnvironment`'s `-u <user>` behaviour.
   *
   * Fix for PR #5021 review (Copilot, comment id 3348029166): pre-fix,
   * every tool ran as root in the container because the backend's
   * execInEnvironment didn't forward a `-u` flag. The hardening
   * (`--cap-drop ALL`, `no-new-privileges`) still capped what root could
   * do, but the explicit non-root design intent was silently violated.
   */
  _execAsContainerUser({ cmd, timeout = 30_000 }) {
    return this._dockerBackend.execInEnvironment(this._containerId, {
      cmd,
      timeout,
      user: this._containerUser,
    })
  }

  async _containerRead(input) {
    const containerPath = remapToContainerPath(input?.file_path, this.cwd)
    // Use sed for offset/limit slicing inside the container so we
    // don't transfer megabytes only to throw them away on the host.
    // Default cap mirrors readFileTool's "2000 lines" — apply both a
    // line cap (sed -n) AND a byte cap (head -c) so a single 1GB line
    // can't blow the tool_result payload.
    const offset = Number(input?.offset)
    const limit = Number(input?.limit)
    const startLine = Number.isFinite(offset) && offset > 0 ? offset : 1
    const lineCap = Number.isFinite(limit) && limit > 0 ? limit : 2000
    const endLine = startLine + lineCap - 1
    // Fix for PR #5021 review (Copilot, comment id 3348029235): match
    // the host-side BYOK Read output format (5-space-padded line number,
    // arrow separator) so the model sees the same line-numbered shape
    // regardless of provider. The `awk` runs INSIDE the container after
    // the `sed | head` slice, so we still apply the line cap and the
    // byte cap before formatting (a 1GB line stays bounded).
    const cmd = `sed -n '${startLine},${endLine}p' ${shellQuote(containerPath)} | head -c ${READ_MAX_BYTES} | awk -v start=${startLine} 'BEGIN{n=start} {printf "%5d→%s\\n", n, $0; n++}'`
    const { stdout, stderr } = await this._execAsContainerUser({ cmd, timeout: 30_000 })
    if (stderr && stderr.trim()) {
      return { content: `Read failed: ${stderr.trim()}`, isError: true }
    }
    return { content: stdout, isError: false }
  }

  async _containerWrite(input) {
    const containerPath = remapToContainerPath(input?.file_path, this.cwd)
    // Fix for PR #5021 review (Copilot, comment id 3348029266): host-side
    // writeFileTool returns EINVAL when content is missing/non-string;
    // pre-fix this branch silently truncated the file to zero bytes.
    // Allow an empty string (the model may legitimately want to clear a
    // file) but refuse undefined / number / boolean / null.
    if (typeof input?.content !== 'string') {
      return { content: 'EINVAL: content is required (string)', isError: true }
    }
    const content = input.content
    if (Buffer.byteLength(content, 'utf8') > WRITE_MAX_BYTES) {
      return {
        content: `Write refused: content exceeds ${WRITE_MAX_BYTES} bytes — split into smaller writes`,
        isError: true,
      }
    }
    // Stream the content via a heredoc-style pipe. `tee` is friendly
    // when stdin is provided; `mkdir -p` ensures parent dirs exist.
    // We base64-encode on the way in to dodge any quoting hazards
    // with newlines / single quotes / backticks in `content`.
    const encoded = Buffer.from(content, 'utf8').toString('base64')
    const parentDir = posix.dirname(containerPath)
    const cmd = [
      `mkdir -p ${shellQuote(parentDir)}`,
      `echo ${shellQuote(encoded)} | base64 -d > ${shellQuote(containerPath)}`,
      `wc -c < ${shellQuote(containerPath)}`,
    ].join(' && ')
    const { stdout, stderr } = await this._execAsContainerUser({ cmd, timeout: 30_000 })
    if (stderr && stderr.trim()) {
      return { content: `Write failed: ${stderr.trim()}`, isError: true }
    }
    const bytesWritten = Number(stdout.trim()) || 0
    return {
      content: `Wrote ${bytesWritten} bytes to ${input.file_path}.`,
      isError: false,
    }
  }

  async _containerEdit(input) {
    const containerPath = remapToContainerPath(input?.file_path, this.cwd)
    const oldString = typeof input?.old_string === 'string' ? input.old_string : ''
    const newString = typeof input?.new_string === 'string' ? input.new_string : ''
    const replaceAll = input?.replace_all === true
    if (oldString.length === 0) {
      return { content: 'Edit refused: old_string is required', isError: true }
    }
    // Read the file via the same execInEnvironment path so a missing
    // file surfaces as a tool_result rather than an exception.
    const { stdout: existing, stderr: readErr } = await this._execAsContainerUser({
      cmd: `cat ${shellQuote(containerPath)}`,
      timeout: 30_000,
    })
    if (readErr && readErr.trim()) {
      return { content: `Edit failed: ${readErr.trim()}`, isError: true }
    }
    let replacements = 0
    let updated
    if (replaceAll) {
      const parts = existing.split(oldString)
      replacements = parts.length - 1
      updated = parts.join(newString)
    } else {
      const idx = existing.indexOf(oldString)
      if (idx === -1) {
        return {
          content: `Edit failed: old_string not found in ${input.file_path}`,
          isError: true,
        }
      }
      const dup = existing.indexOf(oldString, idx + oldString.length)
      if (dup !== -1) {
        return {
          content: `Edit failed: old_string matches multiple sites in ${input.file_path}; add context or pass replace_all`,
          isError: true,
        }
      }
      replacements = 1
      updated = existing.slice(0, idx) + newString + existing.slice(idx + oldString.length)
    }
    if (replacements === 0) {
      return {
        content: `Edit failed: old_string not found in ${input.file_path}`,
        isError: true,
      }
    }
    const writeResult = await this._containerWrite({ file_path: input.file_path, content: updated })
    if (writeResult.isError) return writeResult
    return {
      content: `Replaced ${replacements} occurrence(s) in ${input.file_path}.`,
      isError: false,
    }
  }

  async _containerBash(input, signal) {
    const command = input?.command
    if (typeof command !== 'string' || command.length === 0) {
      return { content: 'EINVAL: command is required', isError: true }
    }
    if (signal?.aborted) {
      return { content: 'Interrupted before docker exec', isError: true }
    }
    const requested = Number(input?.timeout)
    // 600s ceiling mirrors the host-side Bash tool — long enough for
    // a slow test suite but bounded so the session never strands on a
    // runaway loop.
    const timeoutMs = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, 600_000)
      : 30_000
    const { stdout, stderr } = await this._execAsContainerUser({
      cmd: command,
      timeout: timeoutMs,
    })
    const parts = []
    if (stdout) parts.push(`stdout:\n${stdout}`)
    if (stderr) parts.push(`stderr:\n${stderr}`)
    parts.push('[exit=0]')
    return { content: parts.join('\n\n'), isError: false }
  }

  async _containerGlob(input, signal) {
    const pattern = input?.pattern
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return { content: 'EINVAL: pattern is required', isError: true }
    }
    if (/[$`;|&><()\\\n\r]/.test(pattern)) {
      return {
        content: 'EINVAL: glob pattern contains shell-dangerous characters',
        isError: true,
      }
    }
    if (signal?.aborted) {
      return { content: 'Interrupted before docker exec', isError: true }
    }
    const root = input?.path
      ? remapToContainerPath(input.path, this.cwd)
      : CONTAINER_WORKSPACE
    const cmd = `shopt -s globstar nullglob; cd ${shellQuote(root)} && for f in ${pattern}; do printf '%s\\n' "$f"; done`
    const { stdout, stderr } = await this._execAsContainerUser({ cmd, timeout: 30_000 })
    if (!stdout && stderr && stderr.trim()) {
      return { content: `Glob failed: ${stderr.trim()}`, isError: true }
    }
    const files = stdout.split('\n').filter(Boolean)
    if (files.length === 0) return { content: `No matches for ${pattern}`, isError: false }
    return { content: files.join('\n'), isError: false }
  }

  async _containerGrep(input, signal) {
    const pattern = input?.pattern
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return { content: 'EINVAL: pattern is required', isError: true }
    }
    if (signal?.aborted) {
      return { content: 'Interrupted before docker exec', isError: true }
    }
    const root = input?.path
      ? remapToContainerPath(input.path, this.cwd)
      : CONTAINER_WORKSPACE
    const ci = input?.['-i'] === true ? '-i' : ''
    const ln = input?.['-n'] !== false ? '-n' : ''
    const globArg = typeof input?.glob === 'string' && input.glob.length > 0
      ? ` --glob ${shellQuote(input.glob)}` : ''
    const rgCmd = `rg ${ci} ${ln} --no-heading${globArg} ${shellQuote(pattern)} ${shellQuote(root)}`
    const grepCmd = `grep -r ${ci} ${ln} ${shellQuote(pattern)} ${shellQuote(root)}`
    // Fix for PR #5021 review (Copilot, comment id 3348029186): rg and
    // grep -r both exit 1 on "no matches", and execInEnvironment rejects
    // on any non-zero exit, so the "No matches for ${pattern}" branch
    // was unreachable. Mask the exit code so we can distinguish
    // legitimate "no matches" (empty stdout, empty stderr) from real
    // failures (non-empty stderr). The host-side equivalent
    // (byok-tool-executor.js) uses the same `|| true` pattern.
    const cmd = `if command -v rg >/dev/null 2>&1; then ${rgCmd}; else ${grepCmd}; fi; true`
    const { stdout, stderr } = await this._execAsContainerUser({ cmd, timeout: 30_000 })
    if (!stdout && stderr && stderr.trim()) {
      return { content: `Grep failed: ${stderr.trim()}`, isError: true }
    }
    if (!stdout) return { content: `No matches for ${pattern}`, isError: false }
    return { content: stdout, isError: false }
  }

  /**
   * Tear down the container we own, then call super.destroy() so the
   * agent-loop teardown (MCP fleet, permissions, listeners) runs.
   * When attached to an external container, leave it running.
   *
   * #5022: when pooling is enabled and the session went start-clean
   * (`_containerReady` was set), the container is released back to the
   * pool for the next session of the same resource shape to claim. On
   * any error path — or if pooling is disabled — fall back to inline
   * `docker rm -f`.
   */
  async destroy() {
    const containerId = this._containerId
    const owned = this._containerOwned
    const wasReady = this._containerReady
    const pool = this._pool
    const acquiredFromPool = this._acquiredFromPool
    // #5024: compose teardown uses `docker compose down` against the
    // session-scoped project id. Snapshot the project + file BEFORE
    // nulling state so the finally-block has them.
    const composeFile = this._composeFile
    const composeProject = this._composeProject
    const cwd = this.cwd || process.cwd()
    this._containerId = null
    this._containerReady = false
    this._acquiredFromPool = false
    try {
      await super.destroy()
    } finally {
      if (composeFile && composeProject) {
        // Compose mode: tear the whole stack down. The pool is
        // disabled in compose mode so we never need the release path.
        log.info(`removing compose stack ${composeProject} (file=${composeFile})`)
        try {
          await this._dockerBackend.destroyComposeEnvironment({
            composeFile,
            composeProject,
            cwd,
          })
        } catch (err) {
          log.warn(`compose destroy failed: ${err.message}`)
        }
      } else if (!containerId || !owned) {
        // Nothing for us to clean up — externally-managed container
        // stays running for whoever owns it.
      } else if (pool && wasReady) {
        // Healthy session end → hand back to the pool. The pool may
        // still evict (over cap, shutting down) but that's its call.
        log.info(`releasing container ${containerId.slice(0, 12)} to pool`)
        try {
          await pool.release(this._poolKeyFor(containerId), containerId)
        } catch (err) {
          log.warn(`pool release of ${containerId.slice(0, 12)} failed: ${err.message} — falling back to docker rm -f`)
          await this._rmContainer(containerId)
        }
      } else {
        log.info(`removing container ${containerId.slice(0, 12)}${acquiredFromPool ? ' (was pooled)' : ''}`)
        await this._rmContainer(containerId)
      }
    }
  }

  /**
   * Inline `docker rm -f` fallback. Swallows errors — the alternative
   * is leaking a container, which is worse than a warn log.
   */
  _rmContainer(containerId) {
    return new Promise((resolve) => {
      // `execFile` ignores `stdio`; cap `maxBuffer` so a misbehaving
      // docker(8) can't OOM us on stderr.
      this._execFile('docker', ['rm', '-f', containerId], { maxBuffer: 64 * 1024 }, (err) => {
        if (err) log.warn(`failed to remove container ${containerId.slice(0, 12)}: ${err.message}`)
        resolve()
      })
    })
  }

  /**
   * Pool key for a specific container id. Currently this just computes
   * from the session's resource shape — the containerId arg is here
   * because the destroy() path may be called after `this._containerId`
   * has been nulled out. Kept as a method so a future variant (per-
   * container key derived from labels) can override.
   */
  _poolKeyFor(_containerId) {
    return this._poolKey()
  }
}

// Re-exported for tests + dashboard introspection.
export { CONTAINER_WORKSPACE }

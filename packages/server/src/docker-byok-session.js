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
 * DevContainer build / dockerFile / dockerComposeFile (#5078)
 * ----------------------------------------------------------
 *   - `build` (object: dockerfile / context / args / target) or the
 *     legacy `dockerFile` string in devcontainer.json — start() shells
 *     `docker build` against the project dir and uses the resulting tag
 *     as the image. The tag is a deterministic SHA-256 of the build
 *     inputs, so a repeat session with identical inputs reuses the
 *     already-built image (docker's own layer cache makes the rebuild a
 *     fast no-op). `build.target` threads to `docker build --target`.
 *     `build.context` (and `..`) resolves relative to the
 *     devcontainer.json DIRECTORY, then is contained to the project cwd —
 *     a context that escapes the workspace is refused. An explicit `image`
 *     constructor opt always wins over a devcontainer build.
 *   - `dockerComposeFile` (string | array) in devcontainer.json — when
 *     `useDevcontainer` is set and no explicit `composeFile` opt was
 *     passed, the file (resolved relative to the devcontainer.json dir)
 *     is treated as if the operator passed `composeFile`, and the primary
 *     service is taken from devcontainer.json's `service` field. The same
 *     compose lifecycle (up / attach / down) and pooling-disabled posture
 *     as the explicit `composeFile` opt applies. Arrays are threaded
 *     through in full as a base + override overlay — `_composeUp`/
 *     `_composeDown` emit one `-f <file>` per entry in declared order so
 *     compose merges them (later files override earlier ones). (#5124)
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
import { mkdirSync, writeFileSync, unlinkSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { homedir, tmpdir } from 'os'
import { isAbsolute, join, posix, resolve, sep } from 'path'
import { ClaudeByokSession } from './byok-session.js'
import { DockerBackend } from './environments/backends/docker.js'
import { classifyDockerError } from './docker-session.js'
import { buildPoolKey, getSharedPool, isPoolEnabled } from './docker-byok-pool.js'
import { getSharedComposeStateStore } from './byok-compose-state-shared.js'
import { createLogger } from './logger.js'
import { writeFileRestricted } from './platform.js'
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
   * #5069 — surface streamed `postCreateCommand` output. `setup_log` is a
   * transient event carrying one chunk of the container-setup command's
   * stdout/stderr as it runs, so the dashboard / mobile client can show
   * progress during a multi-minute `npm install` / `apt-get` instead of a
   * silent session. session-manager.js:_wireSessionEvents reads
   * `customEvents` to build the TRANSIENT_EVENTS set it bridges to
   * `session_event` listeners; an event missing from this list fires on the
   * local EventEmitter and never reaches ws-forwarding. We extend (rather
   * than replace) the inherited BYOK set so tool_start / tool_result /
   * tool_input_delta / agent_* keep flowing.
   */
  static get customEvents() {
    return [...ClaudeByokSession.customEvents, 'setup_log']
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
   * @param {string} [opts.snapshotImage]            Restore from a snapshot tag
   *   produced by a previous `snapshot()` call (#5023). When set, the
   *   container is launched from this image instead of `opts.image`, the
   *   `useradd` setup is skipped (the snapshot has the user baked in),
   *   and the live container is auto-soiled so it does NOT return to the
   *   pool (a restored container's FS is coupled to the snapshot's
   *   original conversation).
   * @param {string} [opts.snapshotsDir]             Override the directory
   *   snapshot metadata JSONs are written to. Defaults to
   *   `${CHROXY_CONFIG_DIR ?? ~/.chroxy}/snapshots`. Tests inject a tmp dir.
   * @param {string} [opts.sourceSessionId]          Optional session id to
   *   embed in snapshot metadata. The session itself has no sessionId
   *   field; the SessionManager owns the id and can pass it through.
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
    // #5078: normalised devcontainer.json `build` / `dockerFile` spec,
    // resolved in `_resolveDevContainer()`. Stays null until then (or
    // when no build is declared / an explicit image opt wins).
    this._dcBuild = null
    // #5080: short SHA-1 of the resolved devcontainer overlay, used to
    // namespace the pool key so a changed devcontainer.json invalidates
    // any pooled container provisioned against the old config. Stays
    // null until `_resolveDevContainer()` runs (or `useDevcontainer` is
    // false), which keeps the pool key shape backward-compatible for
    // non-devcontainer sessions.
    this._devcontainerFingerprint = null

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
    // #5079 — host-side tmpfile path for the compose env-file. Written
    // at compose-up time when ANTHROPIC_API_KEY is present in the host
    // env, passed to every `docker exec` via `--env-file` so the key is
    // forwarded into model-spawned commands WITHOUT exposing it on the
    // host's process-listing (`docker exec --env KEY=secret` is visible
    // in `ps`). The file is mode 0600 and lives under os.tmpdir(); it's
    // unlinked on destroy() (and best-effort on start-failure paths).
    this._composeEnvFile = null
    // Test seam: override the writer / unlinker so tests can assert the
    // file lifecycle without touching the real filesystem.
    this._writeEnvFile = opts._writeEnvFile || ((p, c) => writeFileSync(p, c, { mode: 0o600 }))
    this._unlinkEnvFile = opts._unlinkEnvFile || ((p) => { try { unlinkSync(p) } catch { /* ignore */ } })
    this._envForApiKey = opts._envForApiKey || process.env
    // #5081 — crash-durable record of the compose project id so a daemon
    // crash between `compose up` and `compose down` leaves an on-disk paper
    // trail the boot-time sweep can clean up. record()'d after a successful
    // `compose up`, forget()'d after a clean `compose down`. Resolved lazily
    // in `_getComposeStateStore()` to the shared singleton (so the boot sweep
    // and live sessions agree on one state file) ONLY in compose mode —
    // non-compose sessions never touch it, keeping their test paths off the
    // real home. Injectable for tests.
    this._composeStateStore = opts._composeStateStore || null

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
    // #5023 snapshot / restore opts. All string opts are trimmed before
    // the length check so callers passing whitespace-only values (e.g.
    // `'   '`) get the same default as no-opt-at-all — matches how
    // composeFile / composeService / containerId / snapshotImage handle
    // their inputs (#5100 review).
    this._snapshotImage = typeof opts.snapshotImage === 'string' && opts.snapshotImage.trim().length > 0
      ? opts.snapshotImage.trim()
      : null
    this._snapshotsDir = typeof opts.snapshotsDir === 'string' && opts.snapshotsDir.trim().length > 0
      ? opts.snapshotsDir.trim()
      : join(process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy'), 'snapshots')
    this._sourceSessionId = typeof opts.sourceSessionId === 'string' && opts.sourceSessionId.trim().length > 0
      ? opts.sourceSessionId.trim()
      : null
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
          // #5068: distinguish two failure modes that previously shared
          // one error code. A `post_create_marker_write_failed` tag on
          // the throw means the command itself succeeded — only the
          // SHA-256 marker `touch` failed. The session is functional
          // (setup was applied inside this container), but a future
          // pool reuse will re-run setup because the cache marker
          // wasn't stamped. Surface that as a non-fatal warning and
          // keep the session alive. Anything else (or a missing tag)
          // is a real command failure: tear down the owned container.
          if (err && err.code === 'post_create_marker_write_failed') {
            log.warn(`docker-byok postCreateCommand marker write failed (non-fatal — command did succeed): ${err.message}`)
            // #5089 review (Copilot, comment id 3349977279): soil the
            // pool container so it isn't recycled. Without this, the
            // next session that acquires this container sees no marker,
            // re-runs the full postCreateCommand, and almost certainly
            // re-fails the marker write for the same underlying reason
            // (read-only /tmp, no space, AppArmor profile). That re-run
            // is wasteful for idempotent commands like `npm install`
            // and potentially incorrect for non-idempotent ones like
            // `apt-get install`. Soiling makes the pool evict THIS
            // container on release() and start a fresh one for the
            // next acquire, while the current session continues to
            // ready — the command DID succeed inside this container.
            this.markActiveContainerSoiled()
            this.emit('error', {
              code: 'post_create_marker_write_failed',
              message: `docker-byok postCreateCommand marker write failed: ${err.message}`,
              fatal: false,
            })
          } else {
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

    // #5023: a container restored from a snapshot inherits the
    // snapshot's writable layer — auth files, history, scratch state.
    // Mark it soiled so it does NOT return to the pool for an unrelated
    // session to acquire. No-ops cleanly when pooling is disabled.
    if (this._snapshotImage && this._containerOwned) {
      this.markActiveContainerSoiled()
    }
  }

  /**
   * Compute the pool key for this session's resource shape. Same shape
   * used by `DockerContainerPool` so acquire / release lookups match.
   *
   * The host cwd is part of the key because /workspace is bind-mounted
   * from cwd — reusing a container across cwds would silently surface
   * files from another workspace.
   *
   * #5080: When `useDevcontainer` is set, the resolved devcontainer
   * overlay's SHA-1 fingerprint is also part of the key so a changed
   * `.devcontainer/devcontainer.json` (new mount, different
   * `containerEnv`, etc.) cannot silently reuse a container provisioned
   * against the OLD config. Non-devcontainer sessions pass null and the
   * key shape stays exactly as it was — those sessions can still pool
   * with each other.
   */
  _poolKey() {
    return buildPoolKey({
      image: this._image,
      cwd: this.cwd || process.cwd(),
      memoryLimit: this._memoryLimit,
      cpuLimit: this._cpuLimit,
      containerUser: this._containerUser,
      devcontainerFingerprint: this._devcontainerFingerprint,
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
   * Snapshot the live container's writable layer into a Docker image
   * tag via `docker commit`, then mark the container "soiled" so the
   * pool evicts it on release. Writes a small metadata JSON to
   * `snapshotsDir` so ops can list snapshot names without parsing
   * `docker image ls` — see class docstring's snapshot/restore section.
   *
   * Returns a `{ tag, name, createdAt, sourceCwd, sourceImage,
   * sourceSessionId }` shape. The `tag` is what a future session passes
   * to the constructor as `snapshotImage` to restore.
   *
   * Throws when the container is not ready (no `start()`, or
   * `destroy()` already ran). Surfaces backend errors (out-of-disk,
   * daemon dead) as a plain Error — callers decide whether to retry.
   *
   * #5023.
   *
   * @param {object} [opts]
   * @param {string} [opts.name] Human-readable name for the snapshot
   * @returns {Promise<{tag:string, name:string, createdAt:string,
   *   sourceCwd:string, sourceImage:string, sourceSessionId:string|null}>}
   */
  async snapshot({ name } = {}) {
    if (!this._containerReady || !this._containerId) {
      const err = new Error('docker-byok snapshot(): container is not ready')
      err.code = 'docker_byok_not_ready'
      throw err
    }
    const tag = this._generateSnapshotTag()
    const sourceCwd = this.cwd || process.cwd()
    const sourceImage = this._snapshotImage || this._image
    const snapName = this._resolveSnapshotName(name, tag)
    const createdAt = new Date().toISOString()

    log.info(`snapshot: committing ${this._containerId.slice(0, 12)} → ${tag}`)
    await this._dockerBackend.commitEnvironment(this._containerId, tag)

    // Mark soiled BEFORE writing metadata. If metadata persistence
    // fails (disk full, permission denied) we still want the soil
    // marker stuck on — the snapshot tag exists in the daemon and the
    // container's writable layer has leaked into it.
    this.markActiveContainerSoiled()

    const metadata = {
      tag,
      name: snapName,
      createdAt,
      sourceCwd,
      sourceImage,
      sourceSessionId: this._sourceSessionId,
    }
    try {
      this._persistSnapshotMetadata(tag, metadata)
    } catch (err) {
      // Persistence is best-effort — the snapshot tag in the daemon is
      // the source of truth. Log and continue so the caller still gets
      // the tag. Defensive message extraction (#5100 review) so a
      // non-Error throw (string / plain object) doesn't crash the
      // log call itself — the whole point of this branch is to keep
      // snapshot() reliable when metadata persistence fails.
      const msg = err && typeof err.message === 'string' ? err.message : String(err)
      log.warn(`snapshot: failed to persist metadata for ${tag}: ${msg}`)
    }
    log.info(`snapshot: ${tag} (name="${snapName}") committed`)
    return metadata
  }

  /**
   * Validate `opts.name` against Docker tag rules so the field stays
   * safe to surface into the image tag later (#5076).
   *
   *   - undefined / null         → fall back to the tag slug (the
   *     "name is optional" contract: omitted = auto-generated slug)
   *   - non-string               → EINVAL
   *   - empty / whitespace-only  → EINVAL (per #5076 AC: a string that
   *     trims to nothing is not "omitted" — the caller passed
   *     something and it carries no usable identifier, so reject at
   *     the API boundary rather than silently substituting the slug)
   *   - > 64 chars (post-trim)   → EINVAL (Docker caps at 128; we cap
   *     at 64 to leave headroom for a `<name>-<ts>` composite tag)
   *   - uppercase or chars       → EINVAL
   *     outside `[a-z0-9._-]`,
   *     or leading `.` / `-`     → EINVAL (Docker tag grammar requires
   *     the leading char to be `[a-zA-Z0-9_]`; we mirror that minus
   *     the uppercase half)
   *
   * Returns the trimmed, validated name (or the tag-slug fallback for
   * the omitted case).
   *
   * @param {unknown} name
   * @param {string} tag The auto-generated tag, used for the fallback
   * @returns {string}
   */
  _resolveSnapshotName(name, tag) {
    if (name === undefined || name === null) {
      return tag.split(':').pop()
    }
    if (typeof name !== 'string') {
      const err = new Error(
        `docker-byok snapshot(): name must be a string, got ${typeof name}`,
      )
      err.code = 'EINVAL'
      throw err
    }
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      // Whitespace-only — the caller passed *something*, but it
      // carries no usable identifier. Per #5076 AC, this is EINVAL at
      // the API boundary rather than a silent fallback (which would
      // mask the caller's bug and produce repeated warn-line noise).
      const err = new Error(
        'docker-byok snapshot(): name must not be empty or whitespace-only',
      )
      err.code = 'EINVAL'
      throw err
    }
    // 64 chars leaves room for a `<name>-<13-digit-ts>` composite tag
    // under Docker's 128-char ceiling. Bias toward strictness now so
    // tightening later is not a breaking change.
    if (trimmed.length > 64) {
      const err = new Error(
        `docker-byok snapshot(): name is ${trimmed.length} chars; max is 64`,
      )
      err.code = 'EINVAL'
      throw err
    }
    // Docker tag charset: lowercase ASCII letters, digits, `.`, `_`,
    // `-`. The leading character must be `[a-z0-9_]` — Docker's own
    // grammar permits a leading underscore (`[a-zA-Z0-9_][a-zA-Z0-9._-]
    // {0,127}`), so we mirror that minus the uppercase half. `.` and
    // `-` are still forbidden as the leading char per the reference
    // grammar.
    if (!/^[a-z0-9_][a-z0-9._-]*$/.test(trimmed)) {
      const err = new Error(
        'docker-byok snapshot(): name must be lowercase and contain only [a-z0-9._-], starting with [a-z0-9_]',
      )
      err.code = 'EINVAL'
      throw err
    }
    return trimmed
  }

  /**
   * Build a snapshot tag of the form `chroxy-byok-snap:<16-hex>-<ts>`.
   * 8 bytes of randomness + a millisecond timestamp keep tags unique
   * within a single host. Image tags must be lowercase ASCII;
   * `randomBytes` hex satisfies the Docker tag rules.
   */
  _generateSnapshotTag() {
    const rand = randomBytes(8).toString('hex')
    const ts = Date.now()
    return `chroxy-byok-snap:${rand}-${ts}`
  }

  /**
   * Write the snapshot metadata JSON next to its siblings in
   * `_snapshotsDir`. The filename uses the tag's identifier portion so
   * a future ops listing reads back deterministically.
   *
   * Best-effort, sync I/O: we hold a docker tag whether or not the
   * sidecar JSON lands. The mkdir is recursive so a brand-new
   * `~/.chroxy/snapshots/` is created on demand.
   *
   * Uses the shared `writeFileRestricted` helper (#5100 review) so the
   * write is atomic (temp+rename) and the file lands at 0600 on POSIX
   * with the same cross-platform contract every other
   * `$CHROXY_CONFIG_DIR` state file uses (session-state, credentials,
   * device-preferences, models cache). Dir is 0o700 on POSIX; the dir
   * mode is ignored on Windows where ACLs are the right mechanism.
   */
  _persistSnapshotMetadata(tag, metadata) {
    mkdirSync(this._snapshotsDir, { recursive: true, mode: 0o700 })
    // Tag is `chroxy-byok-snap:<rand>-<ts>` — split on ':' to get the
    // filename-safe slug. Defensive replace in case a custom tag ever
    // surfaces here.
    const slug = tag.split(':').pop().replace(/[^a-zA-Z0-9_.-]/g, '_')
    const filePath = join(this._snapshotsDir, `${slug}.json`)
    writeFileRestricted(filePath, JSON.stringify(metadata, null, 2) + '\n')
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
   *
   * #5023 — when `_snapshotImage` is set the pool is BYPASSED. The
   * pool key derives from `_image`, not `_snapshotImage`, so a hit
   * would hand back a stock container and `_startContainer()` would
   * never run — the snapshot tag would be silently ignored. Worse,
   * the recycled container's writable layer (auth, scratch state) is
   * unrelated to the snapshot the caller asked to restore. Restored
   * containers are auto-soiled anyway so they can't return to the
   * pool — skipping the acquire path is the consistent move.
   *
   * #5080 — When `useDevcontainer: true`, parsing the
   * `.devcontainer/devcontainer.json` overlay happens BEFORE the pool
   * lookup, and the resolved overlay's SHA-1 fingerprint is folded into
   * the pool key. Concretely:
   *   - the resolved `image` and `remoteUser` are part of the key as
   *     first-class segments (they change which image is pulled / which
   *     user the container runs as), AND
   *   - the fingerprint covers `mounts`, `containerEnv`, `forwardPorts`,
   *     and `postCreateCommand` — these ARE applied to `docker run` (as
   *     `-v`, `-e`, `-p`) and the post-create exec, but they are NOT
   *     part of the base 5-segment key shape, so they need the
   *     fingerprint to invalidate a stale pooled container.
   * If any of those change, the next acquire misses and a fresh
   * container is launched. Non-devcontainer sessions pass a null
   * fingerprint and their pool key shape is unchanged.
   */
  async _acquireOrStartContainer() {
    // #5024: devcontainer parsing must happen BEFORE the compose +
    // pool branches because the resolved devcontainer overlay can ITSELF
    // declare a compose stack (#5078 `dockerComposeFile`) or a
    // build-from-Dockerfile image, and the resolved image/user are part
    // of the pool key. #5080: the same call also computes
    // `_devcontainerFingerprint`, folded into the pool key so a changed
    // devcontainer.json overlay invalidates any pooled container
    // provisioned against the old config.
    if (this._useDevcontainer) {
      this._resolveDevContainer()
    }
    // #5024 / #5078: compose mode short-circuits the entire pool +
    // bare-image path. The compose stack owns its own container;
    // destroy() unwinds it with `docker compose down`. `_composeFile`
    // may have been set by an explicit constructor opt OR by the
    // devcontainer.json `dockerComposeFile` field resolved just above.
    if (this._composeFile) {
      await this._startComposeStack()
      return
    }
    // #5078: build-from-Dockerfile. When the resolved devcontainer
    // overlay declares a `build` / `dockerFile`, shell `docker build`
    // against the project dir and use the resulting tag as the image.
    // Cached by tag so a repeat session with the same build inputs
    // reuses the already-built image. Runs BEFORE the pool lookup so the
    // built tag is the image segment of the pool key.
    if (this._dcBuild && !this._explicitImage) {
      await this._buildDevcontainerImage()
    }
    if (this._pool && !this._snapshotImage) {
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
    // #5078 — devcontainer.json may declare a build (Dockerfile) or a
    // compose stack. Resolve those onto session state here so
    // `_acquireOrStartContainer` can branch on them. Explicit constructor
    // opts (image / composeFile) always win — devcontainer.json is the
    // fallback, mirroring the image/remoteUser precedence above.
    this._resolveDevContainerBuild(config, cwd)
    this._resolveDevContainerCompose(config, cwd)
    // #5080: Compute the pool-key fingerprint from the FULLY-RESOLVED
    // overlay (after mount validation + env sanitisation), not the raw
    // parsed file. That way two devcontainer.json files that differ
    // only in rejected fields produce the same fingerprint (and reuse a
    // container) while any genuine config change cache-busts the key.
    // The fingerprint covers ONLY non-key overlay fields (mounts,
    // containerEnv, forwardPorts, postCreateCommand) — image and
    // remoteUser are already first-class segments of the pool key, so
    // including them in the fingerprint would cause spurious cache
    // misses when an explicit constructor opt has overridden them but
    // the devcontainer.json file value changed.
    this._devcontainerFingerprint = this._computeDevcontainerFingerprint(this._dcConfig)
  }

  /**
   * #5078 — Resolve a devcontainer.json `build` / `dockerFile` declaration
   * onto session state. Stores a normalised build spec in `this._dcBuild`
   * with absolute, contained paths:
   *   - `context`   absolute project-relative build context (defaults to
   *                 the devcontainer.json directory; honours `..`)
   *   - `dockerfile` path passed to `docker build -f`
   *   - `target`    multi-stage build target (→ `--target`)
   *   - `args`      validated `--build-arg KEY=VALUE` pairs
   *
   * The build context is resolved relative to the devcontainer.json
   * DIRECTORY (the spec), not the session cwd, then contained to the
   * project cwd — a `context: '../..'` that escapes the project tree is
   * rejected so a malicious devcontainer.json can't hand `docker build` a
   * context outside the workspace.
   *
   * No-op when the overlay declares no build, OR when an explicit
   * constructor `image` was passed (the operator's image wins — same
   * precedence the image overlay uses).
   */
  _resolveDevContainerBuild(config, cwd) {
    this._dcBuild = null
    if (!config || !config.build) return
    if (this._explicitImage) {
      log.info('devcontainer.json build ignored — explicit image opt wins')
      return
    }
    // The devcontainer spec treats `image` and `build` as mutually
    // exclusive. If both are present we honour `build` (it overwrites the
    // image overlay applied just above) — surface a warning so the
    // operator knows the declared `image` field was superseded.
    if (config.image) {
      log.warn(`devcontainer.json declares both "image" (${config.image}) and "build" — building from the Dockerfile; "image" is ignored`)
    }
    const dcDir = config.dir || cwd
    const absCwd = resolve(cwd)
    const cwdPrefix = absCwd.endsWith(sep) ? absCwd : absCwd + sep

    // Context defaults to the devcontainer.json dir per spec. Resolve it
    // relative to that dir so `..` walks up from there, then contain to
    // the project cwd.
    const contextResolved = resolve(dcDir, config.build.context || '.')
    if (contextResolved !== absCwd && !contextResolved.startsWith(cwdPrefix)) {
      log.warn(
        `devcontainer.json build.context "${config.build.context}" resolves outside the project dir (${contextResolved}) — ignoring build`,
      )
      return
    }

    // Dockerfile is resolved relative to the build context (docker's own
    // default) and must also stay inside the project tree.
    const dockerfileResolved = resolve(contextResolved, config.build.dockerfile)
    if (dockerfileResolved !== absCwd && !dockerfileResolved.startsWith(cwdPrefix)) {
      log.warn(
        `devcontainer.json build.dockerfile "${config.build.dockerfile}" resolves outside the project dir (${dockerfileResolved}) — ignoring build`,
      )
      return
    }

    this._dcBuild = {
      context: contextResolved,
      dockerfile: dockerfileResolved,
      target: typeof config.build.target === 'string' ? config.build.target : null,
      args: config.build.args && typeof config.build.args === 'object' ? config.build.args : null,
    }
  }

  /**
   * #5078 — Resolve a devcontainer.json `dockerComposeFile` declaration
   * into the session's compose opts. When present (and no explicit
   * `composeFile` constructor opt was passed), sets `_composeFile` to the
   * compose file(s) resolved relative to the devcontainer.json dir,
   * picks the primary service from devcontainer.json's `service` field,
   * and disables pooling (compose stacks own their container lifecycle).
   *
   * #5124 — The devcontainer spec allows an ARRAY of compose files (a base
   * file plus one or more overrides). Compose merges them via a repeated
   * `-f` flag in declared order, so we thread the FULL resolved array (each
   * entry resolved relative to the devcontainer.json dir) through to the
   * backend `_composeUp`/`_composeDown` rather than attaching only to the
   * first file. A single declared file resolves to a lone string for
   * backward compatibility.
   *
   * No-op when the overlay declares no compose file or an explicit
   * `composeFile` constructor opt already won.
   */
  _resolveDevContainerCompose(config, cwd) {
    if (!config || !Array.isArray(config.dockerComposeFile) || config.dockerComposeFile.length === 0) return
    if (this._composeFile) {
      log.info('devcontainer.json dockerComposeFile ignored — explicit composeFile opt wins')
      return
    }
    const dcDir = config.dir || cwd
    const files = config.dockerComposeFile.map((f) => resolve(dcDir, f))
    // Thread the full set so `_composeUp` emits `-f <base> -f <override>`
    // in declared order. A lone file stays a plain string so single-file
    // callers and persisted state are unaffected.
    this._composeFile = files.length === 1 ? files[0] : files
    // Primary service: devcontainer.json `service` field wins; otherwise
    // fall back to the first service the backend reports.
    if (!this._composeService && config.service) {
      this._composeService = config.service
    }
    // Compose stacks own their container — pooling is disabled (mirrors
    // the constructor's compose-mode pool guard).
    this._pool = null
  }

  /**
   * #5078 — Build a Docker image from a devcontainer.json `build` /
   * `dockerFile` declaration via `docker build`, then use the resulting
   * tag as `this._image`. Cached by tag: the tag is a deterministic
   * SHA-256 fingerprint of the build inputs (context, dockerfile, target,
   * args), so a repeat session with identical inputs produces the same
   * tag and `docker build`'s own layer cache makes the rebuild a fast
   * no-op (the image already exists locally).
   *
   * Security: every value is passed to `_execFile` as a discrete argv
   * entry — never string-interpolated into a shell. `--build-arg
   * KEY=VALUE` pairs use keys already constrained to POSIX env-var shape
   * by `parseBuild`; values are passed verbatim as a single argv token so
   * shell metacharacters in a value are inert.
   */
  _buildDevcontainerImage() {
    return new Promise((resolve, reject) => {
      const build = this._dcBuild
      const tag = this._computeBuildTag(build)
      const buildArgs = ['build', '-t', tag, '-f', build.dockerfile]
      if (build.target) buildArgs.push('--target', build.target)
      if (build.args) {
        for (const [key, value] of Object.entries(build.args)) {
          buildArgs.push('--build-arg', `${key}=${value}`)
        }
      }
      // Context is the final positional argument.
      buildArgs.push(build.context)

      log.info(`docker-byok building image ${tag} (context=${build.context} dockerfile=${build.dockerfile}${build.target ? ` target=${build.target}` : ''})`)
      this._execFile('docker', buildArgs, { encoding: 'utf-8', timeout: 600_000 }, (err, _stdout, stderr) => {
        if (err) {
          const classified = classifyDockerError(err, stderr)
          const error = new Error(`docker build failed: ${classified.message}`)
          error.code = classified.code || 'docker_build_failed'
          reject(error)
          return
        }
        this._image = tag
        log.info(`docker-byok built image ${tag}`)
        resolve()
      })
    })
  }

  /**
   * #5078 — Deterministic, lowercase, Docker-tag-safe image tag derived
   * from the build inputs. Same inputs → same tag → `docker build` hits
   * its local layer cache and the image is reused across sessions.
   */
  _computeBuildTag(build) {
    const fingerprint = createHash('sha256')
      .update(this._canonicalStringify({
        context: build.context,
        dockerfile: build.dockerfile,
        target: build.target,
        args: build.args,
      }))
      .digest('hex')
      .slice(0, 16)
    return `chroxy-byok-build:${fingerprint}`
  }

  /**
   * #5080: Compute a short, stable SHA-1 fingerprint of the resolved
   * devcontainer overlay. The full SHA-1 is overkill for a cache-bust
   * key and bloats logs — the first 16 hex chars are 64 bits of
   * entropy, which is enough to make accidental collisions effectively
   * impossible within a single host's pool.
   *
   * Fingerprinted fields are **only** the non-key overlay state —
   * `mounts`, `containerEnv`, `forwardPorts`, `postCreateCommand`. The
   * resolved `image` and `remoteUser` are NOT fingerprinted because
   * they're already first-class segments of the pool key (and because
   * an explicit constructor opt may have overridden the devcontainer.json
   * value, in which case a change to the file's `image` field doesn't
   * actually change the resolved launch shape).
   *
   * Note on stability: #5103 — the input is canonicalised via
   * `_canonicalStringify` (object keys sorted recursively) before
   * hashing, so semantically identical overlays produce the same
   * fingerprint regardless of source-side key order. Arrays are
   * preserved in declared order because devcontainer.json arrays
   * (mounts, forwardPorts) are order-sensitive.
   *
   * @param {object|null} resolved
   * @returns {string|null}
   */
  _computeDevcontainerFingerprint(resolved) {
    if (!resolved || typeof resolved !== 'object') return null
    // Project the resolved overlay down to only the fields that
    // affect container provisioning but are NOT already in the base
    // pool key. Key order here is irrelevant — _canonicalStringify
    // sorts before hashing.
    const fingerprintInput = {
      mounts: resolved.mounts,
      containerEnv: resolved.containerEnv,
      forwardPorts: resolved.forwardPorts,
      postCreateCommand: resolved.postCreateCommand,
    }
    return createHash('sha1').update(this._canonicalStringify(fingerprintInput)).digest('hex').slice(0, 16)
  }

  /**
   * #5103: Canonical (stable) JSON-shaped stringifier that sorts object
   * keys recursively. Arrays preserve their declared order because
   * devcontainer.json arrays (mounts, forwardPorts, runArgs) are
   * order-sensitive — the consuming tool may treat the first mount
   * differently from the last, and forwarded ports surface in the UI
   * in declared order.
   *
   * Used by `_computeDevcontainerFingerprint` so an editor that
   * alphabetises object keys (or a hand-edit that reorders them)
   * cannot bust the pool key for a semantically unchanged overlay.
   *
   * NOT a full JSON serialiser — this only handles values reachable
   * from a parsed devcontainer.json (object, array, string, number,
   * boolean, null, undefined). It deliberately omits exotic JSON.stringify
   * features (toJSON, replacer, BigInt) — the call site never sees them.
   *
   * Matches JSON.stringify's `undefined` semantics so an "empty overlay"
   * (where mounts/containerEnv/forwardPorts/postCreateCommand are all
   * absent) serialises to a clean `{}` rather than emitting non-JSON
   * `...:undefined` slots: object properties whose value is `undefined`
   * are dropped, and a top-level `undefined` yields the empty string —
   * exactly as `JSON.stringify` does.
   *
   * @param {unknown} value
   * @returns {string}
   */
  _canonicalStringify(value) {
    if (Array.isArray(value)) {
      // JSON.stringify renders an undefined array element as `null`.
      return '[' + value.map(v => (v === undefined ? 'null' : this._canonicalStringify(v))).join(',') + ']'
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value)
        .filter(k => value[k] !== undefined) // JSON.stringify omits undefined props
        .sort()
      return '{' + keys.map(k => JSON.stringify(k) + ':' + this._canonicalStringify(value[k])).join(',') + '}'
    }
    // JSON.stringify(undefined) === undefined (not a string); normalise to ''.
    return JSON.stringify(value) ?? ''
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
   *
   * #5079 — ANTHROPIC_API_KEY forwarding. The bare-image path forwards
   * the key via `docker run --env`; compose mode does the same job via
   * an `--env-file` tmpfile so the key is symmetric with the bare path
   * without being exposed in `ps` output. The tmpfile is written at
   * 0600 under os.tmpdir() and:
   *   - passed to `docker compose --env-file <path>` so a service that
   *     references `${ANTHROPIC_API_KEY}` in its compose file resolves
   *     the value during interpolation; and
   *   - reused on every `_execAsContainerUser` dispatch so a Bash command
   *     the model spawns inside the container (e.g. `curl
   *     api.anthropic.com` or a one-off `claude -p`) sees the key.
   * destroy() unlinks the file. When `ANTHROPIC_API_KEY` is not set in
   * the host env, no tmpfile is created — the path stays at `null` and
   * `_execAsContainerUser` skips the `--env-file` flag.
   */
  async _startComposeStack() {
    if (!this._composeProject) {
      this._composeProject = `chroxy-byok-${randomBytes(6).toString('hex')}`
    }
    const cwd = this.cwd || process.cwd()
    // #5079: write the ANTHROPIC_API_KEY tmpfile BEFORE compose up so
    // the file is on disk for both compose interpolation AND for the
    // exec dispatches that follow. Created at 0600 under os.tmpdir()
    // with a session-scoped random suffix to avoid collision between
    // parallel byok sessions on the same host.
    const apiKey = this._envForApiKey?.ANTHROPIC_API_KEY
    if (apiKey) {
      const envFilePath = join(tmpdir(), `chroxy-byok-${this._composeProject}.env`)
      try {
        this._writeEnvFile(envFilePath, `ANTHROPIC_API_KEY=${apiKey}\n`)
        this._composeEnvFile = envFilePath
      } catch (err) {
        // Non-fatal: log and proceed without the env file. The model
        // running inside the container won't see the key (matching the
        // pre-#5079 behaviour) but the host-side agent loop is what
        // actually authenticates to Anthropic, so the session still
        // functions for the common case.
        log.warn(`docker-byok compose: failed to write env-file ${envFilePath}: ${err.message}`)
        this._composeEnvFile = null
      }
    }
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
        envFile: this._composeEnvFile,
      })
    } catch (err) {
      // Compose up failed — unlink the tmpfile before re-throwing so a
      // start-failure path doesn't leak the key on disk.
      if (this._composeEnvFile) {
        this._unlinkEnvFile(this._composeEnvFile)
        this._composeEnvFile = null
      }
      const error = new Error(`docker compose start failed: ${err.message}`)
      error.code = err.code || 'compose_start_failed'
      throw error
    }
    this._containerId = result.containerId
    log.info(`docker-byok compose primary container: ${this._containerId.slice(0, 12)}`)
    // #5081 — only AFTER a successful `compose up` do we persist the project
    // id. Recording earlier would leave a phantom entry on disk for a stack
    // that never started; the boot sweep would then `compose down` a project
    // that was never up (harmless but noisy). record() is best-effort:
    // persistence failures must not fail an otherwise-healthy session.
    try {
      this._getComposeStateStore().record({
        projectId: this._composeProject,
        composeFile: this._composeFile,
        cwd,
      })
    } catch (err) {
      log.warn(`docker-byok compose: failed to persist project id: ${err.message}`)
    }
  }

  /**
   * #5081 — resolve the compose-state store for THIS session. Returns the
   * injected store when present (tests), otherwise the process-wide shared
   * singleton. Only ever called on the compose path, so non-compose sessions
   * never construct the default (and never touch the real ~/.chroxy state).
   */
  _getComposeStateStore() {
    if (!this._composeStateStore) {
      this._composeStateStore = getSharedComposeStateStore()
    }
    return this._composeStateStore
  }

  /**
   * Launch a long-lived container with the host cwd mounted at
   * /workspace and the standard chroxy hardening (cap-drop, pids
   * limit, no-new-privileges, non-root user). Mirrors the runArgs
   * shape used by docker-sdk-session.js so the security posture is
   * identical across the two providers.
   *
   * When `_snapshotImage` is set (#5023), the container is launched
   * from that image instead of `_image` and the `useradd` + `chown`
   * setup is SKIPPED — the snapshot already has the non-root user
   * baked in. Re-running useradd would fail with "user already exists"
   * and abort start. The restored container is auto-soiled by
   * `start()` after this resolves so the pool evicts on release.
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

      const imageToRun = this._snapshotImage || this._image
      runArgs.push(imageToRun, 'sleep', 'infinity')

      log.info(
        this._snapshotImage
          ? `restoring container from snapshot ${this._snapshotImage} (memory=${this._memoryLimit} cpus=${this._cpuLimit})`
          : `starting container (image=${imageToRun} memory=${this._memoryLimit} cpus=${this._cpuLimit})`,
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

        // Restore path: the snapshot has useradd + chown baked in, so
        // skip the setup step. Re-running useradd would fail
        // ("user already exists") and abort start.
        if (this._snapshotImage) {
          resolve()
          return
        }

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
   * Failure surface: any non-zero exit on the command itself (timeout,
   * backend reject, etc.) throws bare — the caller in `start()` converts
   * the throw into a `post_create_command_failed` error event and tears
   * the session down. A failure on the marker `touch` step throws an
   * error tagged with `code: 'post_create_marker_write_failed'` so the
   * caller can distinguish: the command DID succeed, only the cache
   * stamp didn't land, and the session is still functional (#5068).
   * The marker is only written on full success of the command, so a
   * half-applied state can never be cached as "already applied".
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
    //
    // #5069 — stream output to the session log surface as bytes arrive so
    // the operator gets progress during a multi-minute setup instead of a
    // silent dashboard. Each chunk becomes a transient `setup_log` event
    // (forwarded via DockerByokSession.customEvents). The backend STILL
    // accumulates stdout/stderr and attaches the last-N-KiB tail to the
    // rejected Error on failure (#5067), so the failure-event payload is
    // unchanged — streaming is purely additive.
    await this._execAsContainerUser({
      cmd: this._postCreateCommand,
      timeout: this._postCreateTimeoutMs,
      onData: (chunk, stream) => {
        // Defensive: never let a malformed chunk break the run loop.
        if (typeof chunk !== 'string' || chunk.length === 0) return
        this.emit('setup_log', { phase: 'post_create', stream, chunk })
      },
    })

    // Stamp the marker so the next session that lands on this container
    // skips the run. `mkdir -p` on the prefix would be wrong (the prefix
    // is /tmp, which always exists), so just `touch` the file. Failure
    // here is rethrown with a distinct `post_create_marker_write_failed`
    // tag (#5068) so the caller in start() can tell it apart from a
    // command failure — the command DID succeed for THIS session, but
    // without a marker write a future pool reuse will re-run setup,
    // which is wasteful for idempotent commands like `npm install` and
    // potentially incorrect for non-idempotent ones like `apt-get install`.
    try {
      await this._execAsContainerUser({
        cmd: `touch ${shellQuote(this._postCreateMarkerPath)}`,
        timeout: 10_000,
      })
    } catch (err) {
      const wrapped = new Error(err && err.message ? err.message : String(err))
      wrapped.code = 'post_create_marker_write_failed'
      wrapped.cause = err
      throw wrapped
    }
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
   *
   * #5079: in compose mode, when a tmpfile holding ANTHROPIC_API_KEY was
   * written at start time, forward it via `--env-file` so the model's
   * Bash commands inside the container see the key — without exposing
   * it on the host's `ps` output (`--env KEY=secret` would). Bare-image
   * sessions don't need this: their `docker run --env ANTHROPIC_API_KEY`
   * already attached the key to the container env at launch time.
   */
  _execAsContainerUser({ cmd, timeout = 30_000, onData } = {}) {
    return this._dockerBackend.execInEnvironment(this._containerId, {
      cmd,
      timeout,
      user: this._containerUser,
      envFile: this._composeEnvFile || undefined,
      // #5069: forward an optional streaming callback. When absent the
      // backend keeps the buffered `execFile` path, so every existing tool
      // dispatch (Read/Write/Bash/...) is unchanged.
      onData,
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
    // #5079: unlink the ANTHROPIC_API_KEY tmpfile created at compose-up
    // time. Snapshot the path BEFORE nulling so the finally-block has
    // it; unlink AFTER `compose down` runs (the tmpfile is referenced
    // by the down call indirectly via the project metadata, and we want
    // a clean teardown order — compose first, then secret material).
    const composeEnvFile = this._composeEnvFile
    const cwd = this.cwd || process.cwd()
    this._containerId = null
    this._containerReady = false
    this._acquiredFromPool = false
    this._composeEnvFile = null
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
          // #5081 — only drop the on-disk record after a clean teardown. If
          // `compose down` threw (daemon gone), the entry has to survive so
          // the next boot's sweep retries the teardown.
          try {
            this._getComposeStateStore().forget(composeProject)
          } catch (err) {
            log.warn(`docker-byok compose: failed to forget project id: ${err.message}`)
          }
        } catch (err) {
          log.warn(`compose destroy failed: ${err.message}`)
        }
        // Unlink the env-file last — best-effort, silent on missing.
        if (composeEnvFile) {
          this._unlinkEnvFile(composeEnvFile)
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

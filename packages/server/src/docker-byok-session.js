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
 *   - Per-session container reuse / pooling
 *   - Snapshot/restore (Docker commit-based snapshots already exist for
 *     docker-cli / docker-sdk — wiring them up for docker-byok belongs
 *     in a follow-up so docker-byok ships small)
 *   - DevContainer / Compose-driven environments
 *   - postCreateCommand hook
 *
 * Per `project_worktree_before_docker.md` in project memory: worktree
 * isolation happens BEFORE Docker. This class does not own worktree
 * setup — the SessionManager / environment-manager already worktree the
 * cwd before constructing the session, and we mount whatever cwd the
 * SessionManager hands us.
 */

import { execFile } from 'child_process'
import { ClaudeByokSession } from './byok-session.js'
import { DockerBackend } from './environments/backends/docker.js'
import { classifyDockerError } from './docker-session.js'
import { buildPoolKey, getSharedPool, isPoolEnabled } from './docker-byok-pool.js'
import { createLogger } from './logger.js'
import { isAbsolute, posix } from 'path'

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
    const poolEnv = opts._poolEnv || process.env
    if (opts._pool) {
      this._pool = opts._pool
    } else if (!opts.containerId && isPoolEnabled(poolEnv)) {
      this._pool = getSharedPool(poolEnv)
    } else {
      this._pool = null
    }
    // Set to `true` if the container picked up THIS session originated
    // from the pool — used at destroy() time to decide between pool
    // release and inline `docker rm -f`.
    this._acquiredFromPool = false
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
          resolve()
        })
      })
    })
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
    this._containerId = null
    this._containerReady = false
    this._acquiredFromPool = false
    try {
      await super.destroy()
    } finally {
      if (!containerId || !owned) {
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

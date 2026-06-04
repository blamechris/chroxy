/**
 * DevContainer config helpers (#5024, #5077).
 *
 * Pure functions used by BOTH the per-session DockerByokSession path
 * and the persistent EnvironmentManager.create() path to parse and
 * validate `.devcontainer/devcontainer.json`. Single source of truth
 * for devcontainer field handling — touch one place, not two.
 *
 * Exports:
 *   - `parseDevContainer(cwd, { logger })` — read + parse + filter
 *     unsupported fields. Returns `{}` when no file is present.
 *   - `validateMounts(mounts, cwd, { logger })` — keep only mounts
 *     whose source is inside `cwd` (after resolve()-normalising
 *     both sides). Defends against path traversal via `..`
 *     segments. Note: this is a containment filter, not an explicit
 *     denylist — `~/.ssh` and other host secrets are blocked
 *     transitively because they're not under the project cwd, not
 *     by a hard-coded denylist of paths.
 *   - `sanitizeContainerEnv(containerEnv, { logger })` — drop keys
 *     that don't match POSIX env-var name rules.
 *   - `extractMountSource(mount)` — pull the source path out of a
 *     short-form (`source:target`) or long-form
 *     (`source=...,target=...`) mount string. Handles Windows
 *     drive-letter colons.
 *
 * The `logger` arg is optional — when omitted, a no-op logger is
 * used. This keeps the module pure for tests that don't want to
 * thread a logger through every call.
 */

import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { homedir } from 'os'

const VALID_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const NOOP_LOG = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * Parse a `.devcontainer/devcontainer.json` (or `.devcontainer.json`
 * sidecar) from the given cwd.
 */
export function parseDevContainer(cwd, { logger = NOOP_LOG } = {}) {
  const candidates = [
    join(cwd, '.devcontainer', 'devcontainer.json'),
    join(cwd, '.devcontainer.json'),
  ]
  let filePath
  for (const candidate of candidates) {
    if (existsSync(candidate)) { filePath = candidate; break }
  }
  if (!filePath) {
    logger.info('No devcontainer.json found, using defaults')
    return {}
  }
  let raw
  try { raw = JSON.parse(readFileSync(filePath, 'utf-8')) }
  catch (err) { logger.warn(`Failed to parse ${filePath}: ${err.message}`); return {} }

  logger.info(`Parsed devcontainer.json from ${filePath}`)

  const SUPPORTED_FIELDS = new Set([
    'image', 'forwardPorts', 'containerEnv', 'mounts',
    'remoteUser', 'postCreateCommand',
    // #5078 — build-from-Dockerfile and compose-from-devcontainer.
    'build', 'dockerFile', 'dockerComposeFile', 'service',
  ])
  for (const key of Object.keys(raw)) {
    if (!SUPPORTED_FIELDS.has(key)) {
      logger.warn(`devcontainer.json: unsupported field "${key}" (ignored)`)
    }
  }

  const config = {}
  // `dir` is the directory the devcontainer.json lives in — `build.context`
  // and `dockerComposeFile` are resolved relative to THIS directory (the
  // devcontainer spec), not the session cwd. Surfaced so the consuming
  // session can compute the docker-build context / compose-file path
  // without re-deriving the file location.
  config.dir = dirname(filePath)
  if (typeof raw.image === 'string' && raw.image.trim()) config.image = raw.image.trim()
  if (typeof raw.remoteUser === 'string' && raw.remoteUser.trim()) config.remoteUser = raw.remoteUser.trim()
  if (typeof raw.postCreateCommand === 'string' && raw.postCreateCommand.trim()) config.postCreateCommand = raw.postCreateCommand.trim()
  if (raw.containerEnv && typeof raw.containerEnv === 'object' && !Array.isArray(raw.containerEnv)) config.containerEnv = raw.containerEnv
  if (Array.isArray(raw.forwardPorts)) config.forwardPorts = raw.forwardPorts.filter(p => typeof p === 'number' || typeof p === 'string')
  if (Array.isArray(raw.mounts)) config.mounts = raw.mounts.filter(m => typeof m === 'string')
  // #5078 — `service` is the official devcontainer spec name for the
  // primary compose service (used with `dockerComposeFile`). Kept as a
  // trimmed string so the session can pick the right service container.
  if (typeof raw.service === 'string' && raw.service.trim()) config.service = raw.service.trim()
  // #5078 — `dockerComposeFile` is a string or array of compose-file
  // paths relative to the devcontainer.json dir. Normalise to an array of
  // non-empty strings; drop the field entirely if nothing usable remains.
  const composeFiles = parseDockerComposeFile(raw.dockerComposeFile, { logger })
  if (composeFiles) config.dockerComposeFile = composeFiles
  // #5078 — `build` (object) and `dockerFile` (legacy string) both
  // declare a Dockerfile-driven image. Normalise to a single `build`
  // shape: { dockerfile, context, args, target }. The legacy `dockerFile`
  // string is sugar for `{ build: { dockerfile: <string> } }`. An explicit
  // `build` object wins when both are present.
  const build = parseBuild(raw.build, raw.dockerFile, { logger })
  if (build) config.build = build
  return config
}

/**
 * #5078 — Normalise `dockerComposeFile` (string | array) into an array of
 * non-empty path strings. Returns undefined when nothing usable remains so
 * the caller can `if (composeFiles)` cleanly.
 */
function parseDockerComposeFile(value, { logger = NOOP_LOG } = {}) {
  if (value == null) return undefined
  const list = Array.isArray(value) ? value : [value]
  const files = list.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim())
  if (files.length === 0) {
    if (value !== undefined) logger.warn('devcontainer.json: dockerComposeFile has no usable string paths (ignored)')
    return undefined
  }
  return files
}

/**
 * #5078 — Normalise `build` (object) + legacy `dockerFile` (string) into a
 * single `{ dockerfile, context, args, target }` shape. All fields are
 * optional except that SOME Dockerfile reference must exist. Returns
 * undefined when neither input declares a build.
 *
 * Strictness: `build.args` values must be primitive (string/number/bool) —
 * an object/array value is dropped with a warning, because these are
 * threaded into `docker build --build-arg KEY=VALUE` and a non-scalar
 * value has no safe textual form. `dockerfile` / `context` / `target`
 * must be strings; non-string values are dropped with a warning rather
 * than silently coerced.
 */
function parseBuild(rawBuild, rawDockerFile, { logger = NOOP_LOG } = {}) {
  let dockerfile
  let context
  let target
  let args

  if (rawBuild && typeof rawBuild === 'object' && !Array.isArray(rawBuild)) {
    if (typeof rawBuild.dockerfile === 'string' && rawBuild.dockerfile.trim()) {
      dockerfile = rawBuild.dockerfile.trim()
    }
    if (typeof rawBuild.context === 'string' && rawBuild.context.trim()) {
      context = rawBuild.context.trim()
    }
    if (typeof rawBuild.target === 'string' && rawBuild.target.trim()) {
      target = rawBuild.target.trim()
    }
    if (rawBuild.args && typeof rawBuild.args === 'object' && !Array.isArray(rawBuild.args)) {
      const out = {}
      let has = false
      for (const [key, value] of Object.entries(rawBuild.args)) {
        if (!VALID_ENV_KEY_RE.test(key)) {
          logger.warn(`devcontainer.json: build.args key rejected (invalid characters): ${key}`)
          continue
        }
        if (value == null || typeof value === 'object') {
          logger.warn(`devcontainer.json: build.args["${key}"] rejected (must be a scalar)`)
          continue
        }
        out[key] = String(value)
        has = true
      }
      if (has) args = out
    }
  }

  // Legacy `dockerFile` string is sugar for build.dockerfile. The explicit
  // build object wins when both name a Dockerfile.
  if (!dockerfile && typeof rawDockerFile === 'string' && rawDockerFile.trim()) {
    dockerfile = rawDockerFile.trim()
  }

  // A build with no Dockerfile and no context is meaningless — but the
  // devcontainer spec defaults the Dockerfile to `Dockerfile` relative to
  // the context. Only emit a build when at least one signal is present.
  if (!dockerfile && !context && !target && !args) return undefined

  const build = {}
  // Default the dockerfile to `Dockerfile` (the docker / devcontainer
  // default) when a build object was declared without naming one.
  build.dockerfile = dockerfile || 'Dockerfile'
  if (context) build.context = context
  if (target) build.target = target
  if (args) build.args = args
  return build
}

/**
 * Validate mount source paths. Only mounts whose source is inside the
 * project directory (cwd) are allowed.
 */
export function validateMounts(mounts, cwd, { logger = NOOP_LOG } = {}) {
  if (!Array.isArray(mounts) || mounts.length === 0) return undefined
  // Normalise the cwd through resolve() so a caller-supplied relative
  // path (or a Windows-style path with mixed separators) is compared
  // apples-to-apples against the normalised source path computed
  // below. The trailing separator is appended AFTER normalisation so
  // `/proj` vs `/projects/foo` can't false-positive as a containment
  // hit. Use posix.sep on POSIX and `\\` on Windows so the comparison
  // works on either host.
  const absCwd = resolve(cwd)
  const resolvedCwd = absCwd.endsWith(sep) ? absCwd : absCwd + sep
  const home = homedir()
  const allowed = []
  for (const mount of mounts) {
    const source = extractMountSource(mount)
    if (!source) {
      logger.warn(`devcontainer mount rejected (unparseable): ${mount}`)
      continue
    }
    const expandedSource = source.startsWith('~/')
      ? join(home, source.slice(2))
      : source.startsWith('~') ? home : source
    const normalizedSource = resolve(expandedSource)
    if (!normalizedSource.startsWith(resolvedCwd) && normalizedSource !== absCwd) {
      logger.warn(`devcontainer mount rejected (outside project dir): ${source}`)
      continue
    }
    allowed.push(mount)
  }
  return allowed.length > 0 ? allowed : undefined
}

/**
 * Extract the source path from a mount string.
 *
 * Long-form (`source=/proj,target=/workspace,type=bind`) is taken from
 * the `source=` k/v pair. Short-form (`<source>:<target>[:opts]`) is
 * split on `:` — but a Windows host can legitimately produce
 * `C:\proj:/workspace`, where the first colon is the drive-letter
 * separator and the second is the source/target boundary. Splitting on
 * every `:` in that case yields `"C"` as the source and tanks mount
 * validation. Detect the drive-letter prefix and skip past it before
 * splitting.
 */
export function extractMountSource(mount) {
  const sourceMatch = mount.match(/(?:^|,)source=([^,]+)/)
  if (sourceMatch) return sourceMatch[1]
  // Windows drive-letter shape: `C:\…` or `C:/…`. Take everything up to
  // the first colon AFTER the drive letter (index 2+) as the source.
  if (/^[A-Za-z]:[\\/]/.test(mount)) {
    const rest = mount.slice(2)
    const sepIdx = rest.indexOf(':')
    if (sepIdx === -1) return null
    return mount.slice(0, 2 + sepIdx)
  }
  const parts = mount.split(':')
  if (parts.length >= 2) return parts[0]
  return null
}

/** Sanitize containerEnv keys. */
export function sanitizeContainerEnv(containerEnv, { logger = NOOP_LOG } = {}) {
  if (!containerEnv || typeof containerEnv !== 'object') return undefined
  const sanitized = Object.create(null)
  let hasKeys = false
  for (const [key, value] of Object.entries(containerEnv)) {
    if (!VALID_ENV_KEY_RE.test(key)) {
      logger.warn(`devcontainer env key rejected (invalid characters): ${key}`)
      continue
    }
    sanitized[key] = value
    hasKeys = true
  }
  return hasKeys ? sanitized : undefined
}

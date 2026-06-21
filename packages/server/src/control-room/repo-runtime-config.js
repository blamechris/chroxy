/**
 * Per-repo runtime config survey (#6139, epic #5530) — READ-ONLY.
 *
 * For each managed repo (the same set host_status surveys), report what governs
 * its container runtimes WITHOUT running anything:
 *   - devcontainer config presence (`.devcontainer/devcontainer.json` or the
 *     `.devcontainer.json` sidecar),
 *   - compose config presence (a devcontainer `dockerComposeFile`, else a
 *     `docker-compose.yml` / `compose.yaml` in the repo root),
 *   - the image the repo WOULD run (devcontainer `image`, else the env default)
 *     and the docker-image-allowlist verdict for it,
 * plus host-level defaults that apply across all repos:
 *   - the effective environment backend (`docker` / `k8s` / `rancher`) and
 *     whether it came from config or the safe default,
 *   - the isolation order (worktree-before-docker — intrinsic, not config),
 *   - the effective docker-image allowlist (config override vs built-in default).
 *
 * Degradation-first, like the sibling surveys (containers.js / runners.js /
 * survey.js): one repo that can't be inspected (unreadable cwd, malformed
 * devcontainer.json) becomes a per-repo `error` entry, never a failed survey.
 * All filesystem + devcontainer-parse touches are injectable seams so tests
 * never touch a real working tree.
 *
 * #5144 note: backend selection IS config-driven as of #5144
 * (`resolveEnvironmentBackend`), so this surface reports the EFFECTIVE backend
 * and its source rather than flagging a hardcoded choice (the issue's original
 * "not yet config-driven" premise predates #5144).
 */
import { existsSync as fsExistsSync } from 'fs'
import { join } from 'path'
import { parseDevContainer as realParseDevContainer } from '../devcontainer-config.js'
import { DEFAULT_ALLOWED_DOCKER_IMAGES, imageMatchesAllowlist } from '../docker-image-allowlist.js'
import { resolveEnvironmentBackend } from '../config.js'
import { getErrorMessage } from '../utils/error-message.js'

/** Isolation order is intrinsic to SessionManager (worktree created, then the
 *  worktree cwd is mounted into Docker) — there is no config knob for it. */
export const ISOLATION_DEFAULT = 'worktree-before-docker'

/** Mirrors environment-manager.js's `DEFAULT_IMAGE` (the image an environment
 *  falls back to when neither the client nor the devcontainer specifies one).
 *  Kept local so this pure survey module doesn't pull in the docker backend;
 *  pinned by the survey test so the two can't drift silently. */
export const DEFAULT_ENV_IMAGE = 'node:22-slim'

/** devcontainer.json lookup order — same candidates parseDevContainer checks. */
const DEVCONTAINER_CANDIDATES = [join('.devcontainer', 'devcontainer.json'), '.devcontainer.json']

/** repo-root compose files to detect when a devcontainer doesn't name one. */
const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

/**
 * The docker-image allowlist actually in effect: a config override
 * (`allowedDockerImages`, including an explicit empty array → "deny all") or
 * the built-in default set.
 *
 * @param {object} config
 * @returns {{ source: 'config'|'default', patterns: string[] }}
 */
export function effectiveAllowlist(config = {}) {
  const configured = Array.isArray(config?.allowedDockerImages) ? config.allowedDockerImages : null
  return {
    source: configured ? 'config' : 'default',
    // Safe to expose the full pattern set HERE: this survey is host-authority
    // gated (a session-bound token gets FORBIDDEN), so the audience is the
    // operator who already has read access to the config these patterns come
    // from. That's a different trust boundary than docker-image-allowlist.js's
    // `validateDockerImage`, which deliberately withholds the patterns from
    // untrusted/session-scoped clients to stop allowlist-prefix enumeration.
    patterns: configured || DEFAULT_ALLOWED_DOCKER_IMAGES,
  }
}

/**
 * Inspect one repo's runtime config. Never throws — a failure becomes the
 * entry's `error` with the other fields nulled.
 *
 * @param {{ name: string, path: string }} repo
 * @param {object} opts
 * @param {string[]} opts.allowlistPatterns - effective allowlist for the verdict.
 * @param {Function} [opts._existsSync] - fs.existsSync seam.
 * @param {Function} [opts._parseDevContainer] - parseDevContainer seam.
 */
export function inspectRepo(repo, opts = {}) {
  const {
    allowlistPatterns = DEFAULT_ALLOWED_DOCKER_IMAGES,
    _existsSync = fsExistsSync,
    _parseDevContainer = realParseDevContainer,
  } = opts
  const name = repo && typeof repo.name === 'string' ? repo.name : ''
  const path = repo && typeof repo.path === 'string' ? repo.path : ''
  const blank = {
    name,
    path,
    devcontainer: { present: false, path: null },
    compose: { present: false, files: [] },
    image: null,
    imageSource: null,
    imageAllowed: null,
    error: null,
  }
  if (!path) return { ...blank, error: 'repo has no path' }
  try {
    // Devcontainer presence — detect the file ourselves (parseDevContainer
    // returns {} for BOTH "absent" and "empty", so it can't tell us presence).
    let devcontainerPath = null
    for (const rel of DEVCONTAINER_CANDIDATES) {
      const candidate = join(path, rel)
      if (_existsSync(candidate)) { devcontainerPath = candidate; break }
    }
    const dc = devcontainerPath ? (_parseDevContainer(path) || {}) : {}

    // The image this repo would run: devcontainer `image`, else the env default.
    const dcImage = typeof dc.image === 'string' && dc.image.trim() ? dc.image.trim() : null
    const image = dcImage || DEFAULT_ENV_IMAGE
    const imageSource = dcImage ? 'devcontainer' : 'default'
    // The docker-image allowlist gates only CLIENT-supplied images — the
    // create_environment handler runs validateDockerImage on the WS message's
    // `image`, while environment-manager.create() uses `image || dcConfig.image
    // || DEFAULT_IMAGE` WITHOUT re-validating. So the built-in default is used
    // unconditionally (never allowlist-checked) → its verdict is N/A (null), not
    // a deny. Only a devcontainer image gets a (would-be) verdict, which a
    // restrictive `allowedDockerImages` can usefully flag.
    const imageAllowed = dcImage ? imageMatchesAllowlist(image, allowlistPatterns) : null

    // Compose config: a devcontainer dockerComposeFile (array, already
    // normalised by parseDevContainer) wins; else look for a repo-root compose
    // file. Either way it's a presence signal, not a parse of the compose body.
    let composeFiles = []
    if (Array.isArray(dc.dockerComposeFile) && dc.dockerComposeFile.length > 0) {
      composeFiles = dc.dockerComposeFile.filter((f) => typeof f === 'string' && f.length > 0)
    } else {
      composeFiles = COMPOSE_CANDIDATES.filter((f) => _existsSync(join(path, f)))
    }

    return {
      name,
      path,
      devcontainer: { present: Boolean(devcontainerPath), path: devcontainerPath },
      compose: { present: composeFiles.length > 0, files: composeFiles },
      image,
      imageSource,
      imageAllowed,
      error: null,
    }
  } catch (err) {
    return { ...blank, error: getErrorMessage(err, 'repo inspection failed') }
  }
}

/**
 * Roll the per-repo entries into headline counts. Repos that failed inspection
 * (`error`) still count toward `total` but not the config-presence buckets.
 */
export function summarizeRepoRuntime(repos) {
  const list = Array.isArray(repos) ? repos : []
  let withDevcontainer = 0
  let withCompose = 0
  let imagesDenied = 0
  let errored = 0
  for (const r of list) {
    if (r?.error) { errored += 1; continue }
    if (r?.devcontainer?.present) withDevcontainer += 1
    if (r?.compose?.present) withCompose += 1
    if (r?.imageAllowed === false) imagesDenied += 1
  }
  return { total: list.length, withDevcontainer, withCompose, imagesDenied, errored }
}

/**
 * The host-level runtime defaults that apply across all repos, derived purely
 * from config (no filesystem touch): the effective backend + its source, the
 * isolation order, and the effective image allowlist. Shared by the survey and
 * by the handler's degraded snapshots so a SURVEY_FAILED/IN_PROGRESS reply
 * still reports the real host defaults instead of hardcoded placeholders.
 *
 * @param {object} [config]
 * @returns {{ backend: string, backendSource: 'config'|'default', isolation: string, allowlist: { source: string, patterns: string[] } }}
 */
export function hostRuntimeDefaults(config = {}) {
  const backend = resolveEnvironmentBackend(config)
  // backendSource is 'config' only when the effective backend came from a valid
  // explicit `environments.backend` (a typo falls back to docker → 'default').
  const explicit = config?.environments?.backend
  const backendSource = typeof explicit === 'string' && explicit === backend ? 'config' : 'default'
  return { backend, backendSource, isolation: ISOLATION_DEFAULT, allowlist: effectiveAllowlist(config) }
}

/**
 * Survey per-repo runtime config across the resolved repo set.
 *
 * @param {object} opts
 * @param {Array<{ name: string, path: string }>} [opts.repoSet] - resolved repos.
 * @param {object} [opts.config] - merged server config.
 * @param {Function} [opts._existsSync] - fs.existsSync seam.
 * @param {Function} [opts._parseDevContainer] - parseDevContainer seam.
 * @param {() => Date} [opts._now] - clock seam.
 * @returns {{ generatedAt: string, backend: string, backendSource: 'config'|'default',
 *   isolation: string, allowlist: { source: string, patterns: string[] },
 *   repos: object[], summary: object }}
 */
export function surveyRepoRuntimeConfig(opts = {}) {
  const {
    repoSet = [],
    config = {},
    _existsSync = fsExistsSync,
    _parseDevContainer = realParseDevContainer,
    _now = () => new Date(),
  } = opts

  const now = _now()
  const { backend, backendSource, isolation, allowlist } = hostRuntimeDefaults(config)

  let repos = []
  try {
    const set = Array.isArray(repoSet) ? repoSet : []
    repos = set.map((repo) =>
      inspectRepo(repo, {
        allowlistPatterns: allowlist.patterns,
        _existsSync,
        _parseDevContainer,
      }),
    )
  } catch {
    // A blow-up mapping the set (shouldn't happen — inspectRepo is total) still
    // returns a valid, empty-repos snapshot rather than failing the survey.
    repos = []
  }

  return {
    generatedAt: now.toISOString(),
    backend,
    backendSource,
    isolation,
    allowlist,
    repos,
    summary: summarizeRepoRuntime(repos),
  }
}

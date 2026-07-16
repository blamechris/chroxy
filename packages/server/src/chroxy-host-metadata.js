/**
 * chroxy-host-metadata — the identity of the Chroxy host that launched an agent
 * session (#6633).
 *
 * Agents (Claude, Codex, Gemini, …) previously could not answer "what Chroxy
 * build am I running in?" without guessing from screenshots or the checked-out
 * repo. This module computes a small, non-sensitive identity block and exposes
 * it as `CHROXY_HOST_*` environment variables, which are injected into every
 * agent's process environment (see `buildSpawnEnv` for subprocess providers and
 * the server startup `Object.assign(process.env, …)` for the in-process SDK). A
 * session can then read e.g. `$CHROXY_HOST_VERSION` from a Bash tool call.
 *
 * The values are COMPUTED here (version from this package's package.json, git
 * identity via `git`), never passed through from the operator's shell — so they
 * are authoritative and can't be spoofed by a stray `CHROXY_HOST_*` export.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Synchronous read at module scope is fine: the file is tiny and never changes
// mid-process (mirrors byok-mcp-client's readPackageVersion). Never block on a
// missing/unreadable package.json — fall back to a sentinel.
function readPackageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.version === 'string' && parsed.version.length > 0) {
      return parsed.version
    }
  } catch {
    // Fall through — identity should degrade gracefully, never crash a spawn.
  }
  return '0.0.0'
}

/**
 * Best-effort git identity for dev builds. A released npm/tarball install has no
 * `.git`, so this returns `{}` there. Guarded and time-boxed — computing host
 * identity must never block or fail a session spawn.
 *
 * @param {typeof execFileSync} [exec] - injectable for tests
 * @returns {{ sha?: string, branch?: string }}
 */
export function readGitIdentity(exec = execFileSync) {
  const cwd = dirname(fileURLToPath(import.meta.url))
  const run = (args) => String(exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })).trim()
  try {
    const sha = run(['rev-parse', '--short', 'HEAD'])
    if (!sha) return {}
    const out = { sha }
    try {
      const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
      // 'HEAD' means detached — no meaningful branch name to report.
      if (branch && branch !== 'HEAD') out.branch = branch
    } catch {
      // No branch is fine; the SHA alone still identifies the build.
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Build the `CHROXY_HOST_*` identity map. Pure — every source is either read
 * fresh or injected, so tests can pin each field without mocking modules.
 *
 * @param {object} [opts]
 * @param {string} [opts.version]  - override the package version
 * @param {{ sha?: string, branch?: string }} [opts.git] - override git identity
 * @param {string} [opts.platform] - override process.platform
 * @param {string} [opts.node]     - override the node version
 * @param {number|string} [opts.pid] - override the process id
 * @returns {Record<string, string>} string-valued env map (git keys omitted when absent)
 */
export function buildChroxyHostEnv({ version, git, platform, node, pid } = {}) {
  const g = git ?? readGitIdentity()
  const env = {
    CHROXY_HOST_APP: 'Chroxy',
    CHROXY_HOST_VERSION: version ?? readPackageVersion(),
    // A git SHA means we're running from a working tree → a dev/local build;
    // its absence means a packaged release.
    CHROXY_HOST_CHANNEL: g.sha ? 'dev' : 'release',
    CHROXY_HOST_PLATFORM: platform ?? process.platform,
    CHROXY_HOST_NODE: node ?? process.versions.node,
    CHROXY_HOST_PID: String(pid ?? process.pid),
  }
  if (g.sha) env.CHROXY_HOST_GIT_SHA = g.sha
  if (g.branch) env.CHROXY_HOST_GIT_BRANCH = g.branch
  return env
}

// Memoized per-process view. Git/version don't change mid-run, so compute once
// and reuse across every spawn.
let _cache = null

/**
 * The memoized `CHROXY_HOST_*` map for this process.
 * @returns {Record<string, string>}
 */
export function getChroxyHostEnv() {
  if (!_cache) _cache = buildChroxyHostEnv()
  return _cache
}

/** Test seam: drop the memoized value so a test can re-derive it. */
export function _resetChroxyHostEnvCacheForTest() {
  _cache = null
}

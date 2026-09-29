/**
 * Roster coverage for `stripInheritedChroxySecrets` (#7360).
 *
 * The fix for #7360 is a shared helper (`utils/spawn-env.js`'s
 * `stripInheritedChroxySecrets`) rather than a per-builder copy — the same
 * "wired to only some of its callers" shape `docs/false-safety-guards.md`
 * catalogues. A helper that exists but that a NEW builder can silently
 * forget to call is no safer than no helper at all, so this file enumerates
 * every source file under `src/` that copies the FULL parent env into an
 * object literal (`{ ...process.env }` or `{ ...process.env, ...extra }`) —
 * the shape that would otherwise forward an ambiently-inherited
 * CHROXY_PORT/CHROXY_HOOK_SECRET straight through — and requires each one to
 * either call the helper or carry a documented exemption below.
 *
 * Both directions are checked (the roster-diff lesson: a list checked only
 * one way lets stale entries silently rot in either direction):
 *   1. every DISCOVERED copier is covered (helper call OR exemption)
 *   2. every EXEMPT entry still corresponds to a real discovered copier
 *      (a fixed builder whose exemption was never removed would otherwise
 *      sit there unnoticed, no longer describing anything real)
 *
 * The discovery regex is intentionally narrow (an object-literal spread of
 * the full `process.env`), not a bare grep for the string "process.env" —
 * `process.env.SOME_KEY` reads of a single var are extremely common and are
 * not the leak shape this file guards; only a wholesale copy is.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(__dirname, '..', 'src')

// Files that copy the full parent env but are NOT required to route through
// stripInheritedChroxySecrets, with the reason each is safe as-is. Keyed by
// path relative to src/. A stale entry here (the file no longer matches the
// discovery pattern) fails test 2 below, so this list cannot silently rot.
const EXEMPT = {
  'supervisor.js':
    'the daemon forking ITSELF (server-cli-child.js) on auto-restart, not a ' +
    '"provider" spawn — the new process is a full chroxy daemon that ' +
    'generates its own per-session secrets independently, and the actual ' +
    'leak-prevention boundary is enforced at THAT daemon\'s own ' +
    '_buildChildEnv-style builders (this fix) when it goes on to spawn a ' +
    'provider, not at the self-fork step.',
  'ws-file-ops/git.js':
    'spawns the `git` binary only, for dashboard repo staging/diff ' +
    'operations — not an AI provider, an MCP server, or an arbitrary ' +
    'operator command, and not a permission-hook consumer.',
  'ws-file-ops/reader.js':
    'spawns `git rev-parse`/similar read-only repo-introspection calls only ' +
    '— same reasoning as ws-file-ops/git.js.',
}

// Matches an object literal that spreads the ENTIRE parent env — the shape
// that forwards whatever the daemon process itself inherited, ambient
// CHROXY_PORT/CHROXY_HOOK_SECRET included. Deliberately does NOT match a
// scoped read like `process.env.FOO` (extremely common and not this file's
// concern) or `Object.keys(process.env)` (enumeration, not a copy).
const FULL_ENV_COPY_RE = /\.\.\.\s*process\.env\b/
// Defensive secondary shape (not currently used anywhere in src/, per an
// #7360 audit grep) — kept so a future Object.assign-style copier is caught
// by the SAME discovery pass instead of needing a second pattern added later.
const OBJECT_ASSIGN_COPY_RE = /Object\.assign\(\s*\{\s*\}\s*,\s*process\.env\s*\)/

function stripComments(source) {
  // Block comments (incl. JSDoc) first, then line comments. Good enough for
  // this repo's own source (not a general-purpose parser) — the false
  // positive this exists to avoid is a JSDoc line that quotes the pattern in
  // prose (byok-mcp-trust.js references byok-mcp-client.js's shape in its
  // header comment without containing the code itself).
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function listJsFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

function discoverFullEnvCopiers() {
  const found = []
  for (const absPath of listJsFiles(SRC_DIR)) {
    const relPath = relative(SRC_DIR, absPath).split('\\').join('/') // POSIX-normalize for Windows
    const raw = readFileSync(absPath, 'utf8')
    const code = stripComments(raw)
    if (FULL_ENV_COPY_RE.test(code) || OBJECT_ASSIGN_COPY_RE.test(code)) {
      found.push({ relPath, code })
    }
  }
  return found
}

describe('spawn-env inherited-secrets roster (#7360)', () => {
  const copiers = discoverFullEnvCopiers()

  it('sanity: discovery actually finds the known copiers (the pattern still matches real code)', () => {
    const relPaths = copiers.map((c) => c.relPath).sort()
    // A minimum known set — if this shrinks unexpectedly, the discovery
    // regex broke (or comment-stripping over-matched) rather than every
    // builder having genuinely stopped copying the full env.
    for (const expected of [
      'utils/spawn-env.js',
      'claude-tui-session.js',
      'user-shell-session.js',
      'byok-mcp-client.js',
      'statusline.js',
      'supervisor.js',
      'ws-file-ops/git.js',
      'ws-file-ops/reader.js',
    ]) {
      assert.ok(relPaths.includes(expected), `expected ${expected} to be discovered as a full-env copier; got: ${relPaths.join(', ')}`)
    }
    // byok-mcp-trust.js only MENTIONS the pattern inside a doc comment quoting
    // byok-mcp-client.js — proves comment-stripping actually works, not just
    // that the regex is loose enough to match anything.
    assert.ok(!relPaths.includes('byok-mcp-trust.js'),
      'byok-mcp-trust.js only references the pattern in a comment; comment-stripping should exclude it')
  })

  it('direction 1: every discovered full-env copier calls stripInheritedChroxySecrets, or is EXEMPT with a reason', () => {
    const uncovered = copiers.filter(({ relPath, code }) => {
      if (Object.prototype.hasOwnProperty.call(EXEMPT, relPath)) return false
      return !/stripInheritedChroxySecrets\s*\(/.test(code)
    })
    assert.deepEqual(
      uncovered.map((c) => c.relPath),
      [],
      'every file that copies the full parent env into a child must call ' +
      'stripInheritedChroxySecrets(), or be added to EXEMPT in this test ' +
      'with a documented reason — a new builder cannot silently skip the strip',
    )
  })

  it('direction 2: every EXEMPT entry still names a real discovered copier (no stale exemptions)', () => {
    const discoveredPaths = new Set(copiers.map((c) => c.relPath))
    const stale = Object.keys(EXEMPT).filter((p) => !discoveredPaths.has(p))
    assert.deepEqual(
      stale,
      [],
      'these EXEMPT entries no longer match any discovered full-env copier ' +
      '(the file was fixed, renamed, or no longer copies the full env) — ' +
      'remove the stale exemption instead of leaving it describing nothing',
    )
  })
})

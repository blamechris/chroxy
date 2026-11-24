/**
 * Guard helper for node-pty-production-import.test.js (#8945).
 *
 * The property that harness cares about: the child process must not leave a
 * stray `.claude.json.chroxy.<uuid>.tmp` sibling (from `ensureCwdTrusted`)
 * in the developer's REAL home. The previous guard compared the real
 * `~/.claude.json` mtime, which any concurrently running Claude Code process
 * legitimately changes, so it went red on clean runs.
 *
 * Names are compared as a set before/after, so a stray file that already
 * existed is not blamed on this run, and the exact `.claude.json` itself
 * (which other processes rewrite) is never in the set. A new name only
 * fails if it STILL exists after a short wait: another chroxy process (the
 * daily daemon) creates the same sidecar for milliseconds, and the defect
 * is a sibling left behind, not one that was briefly present.
 *
 * Takes the directory as a parameter so tests can point it at a decoy.
 */
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// How long a freshly seen sibling gets to disappear on its own.
const SETTLE_MS = 250

// Chroxy's own atomic-write temp name:
// `${destPath}.chroxy.${randomUUID()}.tmp` (src/byok-mcp-config.js:1338,
// reached via claude-tui/pty-driver.js's ensureCwdTrusted). Deliberately NOT
// every `.claude.json.*`: Claude Code itself writes `.claude.json.backup` and
// atomic-write temps in the real home, and a concurrent one appearing mid-run
// must not fail this harness (same flake class as the mtime check it
// replaced).
const SIBLING_PREFIX = '.claude.json.chroxy.'

export function snapshotClaudeJsonSiblings(dir) {
  try {
    return new Set(readdirSync(dir).filter((n) => n.startsWith(SIBLING_PREFIX)))
  } catch (err) {
    // An unreadable directory means "cannot check" — never "nothing to check".
    throw new Error(`cannot snapshot ${dir} for stray .claude.json siblings: ${err.message}`)
  }
}

export function newClaudeJsonSiblings(before, dir) {
  const after = snapshotClaudeJsonSiblings(dir)
  return [...after].filter((n) => !before.has(n)).sort()
}

export async function assertNoNewClaudeJsonSiblings(before, dir, settleMs = SETTLE_MS) {
  const added = newClaudeJsonSiblings(before, dir)
  if (added.length === 0) return
  await sleep(settleMs)
  const stillThere = newClaudeJsonSiblings(before, dir).filter((n) => added.includes(n))
  assert.deepEqual(stillThere, [],
    `this harness left stray .claude.json.chroxy.* file(s) in ${dir}: ${stillThere.join(', ')}` +
    ' (if the file is fresh, another chroxy process may be the writer)')
}

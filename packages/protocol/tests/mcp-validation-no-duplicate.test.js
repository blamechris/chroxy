import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #7030 — no-duplicate guard.
 *
 * The MCP server-name regex, the reserved/unsafe key set, and the
 * cloud-metadata host blocklist now live in exactly one place:
 * `packages/protocol/src/mcp-validation.ts`. This test fails if a second copy
 * of any of those three constants reappears anywhere in
 * packages/server/src, packages/dashboard/src, packages/app/src, or
 * packages/store-core/src — the exact shape of duplication #7030 closes
 * (previously hand-duplicated between packages/server/src/byok-mcp-config.js
 * and packages/dashboard/src/lib/mcp-server-validation.ts, and the reason
 * #6986 / #7001 happened).
 *
 * Per docs/false-safety-guards.md ("every guard must be proven to fail"):
 * this guard is proven by re-adding a copy of the regex to the dashboard file
 * and confirming the guard goes RED (see the PR test plan for #7030 — the
 * proof run is not committed, since committing it would trip the very guard
 * it proves). The nonzero-file-count assertions below are proven the same
 * way: pointing a scan root at a wrong path and confirming THAT goes RED too
 * (a scan over an empty/missing directory must not pass vacuously).
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..') // packages/protocol/tests -> repo root

// The single source of truth. Excluded from the scan (it is where these
// constants are SUPPOSED to live) along with this test file itself and the
// parity test, which necessarily spell out the same literal values as data.
const CANONICAL_FILE = join(REPO_ROOT, 'packages/protocol/src/mcp-validation.ts')

const SCAN_ROOTS = [
  join(REPO_ROOT, 'packages/server/src'),
  join(REPO_ROOT, 'packages/dashboard/src'),
  join(REPO_ROOT, 'packages/app/src'),
  join(REPO_ROOT, 'packages/store-core/src'),
]

const SCANNABLE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])

function listFilesRecursive(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // missing/unreadable directory — NOT treated as "nothing to find" by the caller
  }
  const out = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...listFilesRecursive(full))
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      const ext = dot === -1 ? '' : entry.name.slice(dot)
      if (SCANNABLE_EXTENSIONS.has(ext)) out.push(full)
    }
  }
  return out
}

// Signatures of a RE-DECLARATION, not merely a reference to these values —
// deliberately narrow so a legitimate test enumeration like
// `for (const name of ['__proto__', 'constructor', 'prototype'])` (which
// exercises the imported behaviour, not a redefined copy of it) is not a
// false positive.
const NAME_REGEX_LITERAL = /\/\^\[a-z\]\[a-z0-9_-\]\{0,63\}\$\//
const UNSAFE_KEY_SET_LITERAL = /new\s+Set\(\s*\[\s*['"]__proto__['"]\s*,\s*['"]constructor['"]\s*,\s*['"]prototype['"]\s*\]\s*\)/
// The AWS IMDS IPv6 endpoint string is distinctive enough on its own to catch
// a re-implemented isBlockedMetadataHost without also matching unrelated code
// that merely mentions the 169.254 range in prose/comments.
const METADATA_BLOCKLIST_HOST_LITERAL = /['"]fd00:ec2::254['"]/

// Pre-existing, UNRELATED reserved-key guards that happen to share the same
// literal Set — the `__proto__`/`constructor`/`prototype` trio is a generic
// prototype-pollution guard, not unique to MCP validation, so a coincidental
// textual match here is not the #7030 duplication this test targets (that
// duplication was specifically the MCP server-name/config validation logic
// hand-copied between byok-mcp-config.js and mcp-server-validation.ts).
// `usage-normalize.js` guards a provider MODEL ID, an entirely different
// concern with its own single source (`UNSAFE_KEY` there) — consolidating
// IT with @chroxy/protocol/mcp-validation too may be worth doing, but is out
// of scope for #7030 and is tracked separately rather than silently widened
// into this guard.
const KNOWN_UNRELATED_MATCHES = {
  'unsafe/reserved key Set literal': new Set([join(REPO_ROOT, 'packages/server/src/usage-normalize.js')]),
}

const CHECKS = [
  { name: 'MCP_SERVER_NAME_RE charset regex', pattern: NAME_REGEX_LITERAL },
  { name: 'unsafe/reserved key Set literal', pattern: UNSAFE_KEY_SET_LITERAL },
  { name: 'metadata-host blocklist (fd00:ec2::254)', pattern: METADATA_BLOCKLIST_HOST_LITERAL },
]

describe('#7030 no second copy of the MCP validation constants', () => {
  it('sanity: the canonical module itself still contains all three (proves the patterns are not stale)', () => {
    const src = readFileSync(CANONICAL_FILE, 'utf8')
    for (const check of CHECKS) {
      assert.match(src, check.pattern, `${check.name} missing from the canonical module — patterns are stale`)
    }
  })

  for (const root of SCAN_ROOTS) {
    it(`scan root has files: ${relative(REPO_ROOT, root)}`, () => {
      // A scan over an empty/wrong directory must not pass vacuously — assert
      // a nonzero file count before trusting a clean scan of this root.
      assert.ok(statSync(root).isDirectory(), `${root} is not a directory`)
      const files = listFilesRecursive(root)
      assert.ok(files.length > 0, `scan root ${root} contained 0 files — the scan would pass vacuously`)
    })
  }

  for (const root of SCAN_ROOTS) {
    it(`no duplicate found under ${relative(REPO_ROOT, root)}`, () => {
      const files = listFilesRecursive(root).filter((f) => f !== CANONICAL_FILE)
      const offenders = []
      for (const file of files) {
        const src = readFileSync(file, 'utf8')
        for (const check of CHECKS) {
          if (KNOWN_UNRELATED_MATCHES[check.name]?.has(file)) continue
          if (check.pattern.test(src)) {
            offenders.push(`${relative(REPO_ROOT, file)}: ${check.name}`)
          }
        }
      }
      assert.deepEqual(offenders, [], `duplicate MCP validation constant(s) found:\n${offenders.join('\n')}`)
    })
  }
})

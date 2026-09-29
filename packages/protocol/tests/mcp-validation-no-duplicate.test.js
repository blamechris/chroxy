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
 *
 * TWO TIERS OF CHECK, after a #7030 review round-trip proved the first tier
 * insufficient on its own:
 *
 * 1. SYNTAX_CHECKS — exact source-shape signatures (a regex LITERAL, a
 *    `new Set([...])` CALL). Cheap and precise, but a reviewer's probe showed
 *    they are trivially evaded by reimplementing the same behaviour with
 *    different JS syntax: `new RegExp('^[a-z][a-z0-9_-]{0,63}$')` instead of
 *    a regex literal, a plain array instead of `new Set([...])`, and
 *    template-literal strings instead of quoted ones — all 9 subtests stayed
 *    green with a full duplicate sitting in packages/dashboard/src.
 *
 * 2. FRAGMENT_CHECKS — spelling-independent: a plain substring search for
 *    text that must appear verbatim in the canonical module NO MATTER how
 *    the surrounding code is shaped (regex literal, `new RegExp('...')`, a
 *    template literal, string concatenation — the characters still have to
 *    be spelled out somewhere to reproduce the behaviour). This is what
 *    catches the reviewer's probe.
 *
 *    Fragment choice matters: `169.254` was the reviewer's own suggested
 *    example, but it is NOT used here — a repo-wide grep found it already
 *    legitimately present, unrelated to this duplication, in
 *    `packages/server/src/ssrf-guard.js` (a different SSRF guard),
 *    `packages/app/src/utils/lan-scanner.ts` + its test (APIPA / LAN
 *    scanning, unrelated to MCP), `byok-mcp-config.js`'s OWN
 *    `classifyIpAddress` docstring (a different function, trust-prompt
 *    address classification, not the metadata blocklist), and a dashboard
 *    test fixture — six-plus unrelated files. A fragment needing that many
 *    exclusions is a false-positive-prone check by the same standard this
 *    file already applies to `constructor`/`prototype` — so it is left out
 *    rather than smothered in allowlist entries. `a9fe` and `fd00:ec2` are
 *    used instead: both are verbatim in the canonical module (the mapped-
 *    IPv6 regex and the AWS IMDS literals) and, per the same repo-wide grep,
 *    `a9fe` has zero pre-existing hits anywhere in the four scan roots and
 *    `fd00:ec2` has exactly one — a comment in `byok-mcp-oauth.js` explaining
 *    why it calls `isBlockedMetadataHost`, not a redefinition — narrowly
 *    excluded below by exact path. The name-charset fragment `[a-z0-9_-]{0,63}`
 *    (the regex body without its anchors) has zero pre-existing hits.
 *
 *    No fragment check is added for the reserved-key set: `__proto__`,
 *    `constructor`, and `prototype` are common enough as plain words
 *    elsewhere in the codebase that a bare substring match would be exactly
 *    the false-positive-prone check this file avoids for `169.254` — the
 *    SYNTAX_CHECKS `new Set([...])` signature is the only check for that one.
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

// --- Tier 1: SYNTAX_CHECKS — exact source-shape signatures -----------------
// Signatures of a RE-DECLARATION, not merely a reference to these values —
// deliberately narrow so a legitimate test enumeration like
// `for (const name of ['__proto__', 'constructor', 'prototype'])` (which
// exercises the imported behaviour, not a redefined copy of it) is not a
// false positive. Known-evadable by a structurally different reimplement-
// ation (see FRAGMENT_CHECKS below, which is what actually catches that).
const NAME_REGEX_LITERAL = /\/\^\[a-z\]\[a-z0-9_-\]\{0,63\}\$\//
const UNSAFE_KEY_SET_LITERAL = /new\s+Set\(\s*\[\s*['"]__proto__['"]\s*,\s*['"]constructor['"]\s*,\s*['"]prototype['"]\s*\]\s*\)/

const SYNTAX_CHECKS = [
  { name: 'MCP_SERVER_NAME_RE charset regex (literal)', pattern: NAME_REGEX_LITERAL },
  { name: 'unsafe/reserved key Set literal', pattern: UNSAFE_KEY_SET_LITERAL },
]

// --- Tier 2: FRAGMENT_CHECKS — spelling-independent plain substrings -------
// Each fragment is copied verbatim from packages/protocol/src/mcp-validation.ts
// and must not appear ANYWHERE outside it, regardless of the surrounding JS
// syntax (regex literal, `new RegExp('...')`, a template literal, string
// concatenation) — see the file-level doc comment above for why `169.254`
// is deliberately NOT one of these.
const FRAGMENT_CHECKS = [
  { name: 'metadata-host fragment "a9fe" (IPv4-mapped IPv6 form)', fragment: 'a9fe' },
  { name: 'metadata-host fragment "fd00:ec2" (AWS IMDS IPv6)', fragment: 'fd00:ec2' },
  { name: 'name-charset fragment "[a-z0-9_-]{0,63}"', fragment: '[a-z0-9_-]{0,63}' },
]

// Pre-existing, UNRELATED matches — narrow, keyed by exact file path + a
// stated reason, exactly like the pattern below asks for. Each entry is
// verified (repo-wide grep, #7030 review round) to be legitimate and
// unrelated to the MCP server-name/config validation duplication this test
// targets, never a redefinition of the constants themselves.
const KNOWN_UNRELATED_MATCHES = {
  // No 'unsafe/reserved key Set literal' entry: usage-normalize.js (the only
  // one there ever was) now imports UNSAFE_MCP_KEYS instead of carrying its
  // own copy, so that check scans every file with no exclusions.
  //
  // A comment explaining WHY this file calls `isBlockedMetadataHost`
  // ("... / fd00:ec2::254) to make the daemon fetch instance credentials on
  // its behalf.") — prose referencing the concept, not a redefinition.
  'metadata-host fragment "fd00:ec2" (AWS IMDS IPv6)': new Set([join(REPO_ROOT, 'packages/server/src/byok-mcp-oauth.js')]),
}

const CHECKS = [
  ...SYNTAX_CHECKS.map((c) => ({ name: c.name, test: (src) => c.pattern.test(src) })),
  ...FRAGMENT_CHECKS.map((c) => ({ name: c.name, test: (src) => src.includes(c.fragment) })),
]

describe('#7030 no second copy of the MCP validation constants', () => {
  it('sanity: the canonical module itself still contains every check (proves the patterns are not stale)', () => {
    const src = readFileSync(CANONICAL_FILE, 'utf8')
    for (const check of CHECKS) {
      assert.ok(check.test(src), `${check.name} missing from the canonical module — patterns are stale`)
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
          if (check.test(src)) {
            offenders.push(`${relative(REPO_ROOT, file)}: ${check.name}`)
          }
        }
      }
      assert.deepEqual(offenders, [], `duplicate MCP validation constant(s) found:\n${offenders.join('\n')}`)
    })
  }
})

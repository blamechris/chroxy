import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CLAUDE_SDK_MIN_CLI_VERSION } from '../src/utils/agent-sdk-version.js'
import { compareSemver } from '../src/utils/binary-version.js'

/**
 * Floor guard for every `ARG CLAUDE_CODE_VERSION=` pin in the repo (#8145).
 *
 * The sidecar Dockerfile shipped `ARG CLAUDE_CODE_VERSION=2.1.128` for months
 * — below `CLAUDE_SDK_MIN_CLI_VERSION` (2.1.141) — with nothing to notice: no
 * test read the Dockerfile, and Renovate's own regex manager only tracked the
 * version string for a bump PR, never compared it against the floor. Renovate
 * coverage is necessary but not sufficient (it can still be rate-limited
 * indefinitely, as this pin was); this test is the thing that actually
 * enforces the floor, on every `npm test` run, with no dependency on Renovate
 * having opened or merged anything.
 *
 * The Dockerfiles are DISCOVERED via `git ls-files '*Dockerfile*'`, not a
 * hardcoded pair — a hardcoded list beside a growing set of Dockerfiles is
 * exactly the first recurring cause in docs/false-safety-guards.md, and a
 * THIRD Dockerfile gaining its own `ARG CLAUDE_CODE_VERSION=` pin must be
 * caught by this same scan without an edit here.
 *
 * `CLAUDE_SDK_MIN_CLI_VERSION` is IMPORTED from
 * `packages/server/src/utils/agent-sdk-version.js`, never copied as a string
 * literal — a copy is the second implementation of the same fact, which is
 * how the pin and the floor drift apart in the first place.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Matches every occurrence in a file's text, not just the first. Case-
 * insensitive: Dockerfile instructions are case-insensitive per the spec
 * (`docker build` accepts `arg claude_code_version=...` exactly as it
 * accepts `ARG CLAUDE_CODE_VERSION=...`), and a pin spelled in a case this
 * regex did not expect must still be floored rather than silently skipped
 * (#8145 review).
 *
 * ANCHORED to the start of a line (only leading whitespace before `ARG`),
 * not a bare substring search — going case-insensitive without this anchor
 * makes `arg` inside prose match too: the sidecar Dockerfile's own usage
 * comment, `#   docker build --build-arg CLAUDE_CODE_VERSION=x.y.z .`,
 * contains the substring "arg CLAUDE_CODE_VERSION=x.y.z" (from
 * "--build-ARG"), which an unanchored case-insensitive `PIN_RE` reads as a
 * pin of literal version "x.y.z" — caught by this test itself going red
 * against the real tree the moment the `i` flag was added, before the anchor
 * was.
 */
const PIN_RE = /^\s*ARG\s+CLAUDE_CODE_VERSION=([^\s]+)/gim

/**
 * Every tracked path matching `*Dockerfile*`, via `git ls-files`. NUL-
 * separated so a path containing an unusual byte cannot forge or split an
 * entry.
 */
function trackedDockerfiles() {
  const raw = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '*Dockerfile*'], {
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
  })
  return raw
    .toString('utf8')
    .split('\0')
    .filter((s) => s !== '')
}

/** Every `ARG CLAUDE_CODE_VERSION=` pin's raw value in one file, in order. */
function pinsIn(repoRelativePath) {
  const text = readFileSync(`${REPO_ROOT}${repoRelativePath}`, 'utf8')
  const values = []
  let m
  PIN_RE.lastIndex = 0
  while ((m = PIN_RE.exec(text)) !== null) values.push(m[1])
  return values
}

/** Every `{file, version}` pin across every discovered Dockerfile. */
function allPins() {
  return trackedDockerfiles().flatMap((file) => pinsIn(file).map((version) => ({ file, version })))
}

describe('every ARG CLAUDE_CODE_VERSION pin meets CLAUDE_SDK_MIN_CLI_VERSION (#8145)', () => {
  it('discovers Dockerfiles from git, not a hardcoded pair', () => {
    const files = trackedDockerfiles()
    assert.ok(
      files.length >= 2,
      `expected at least 2 tracked '*Dockerfile*' paths (root + sidecar), found ${files.length}: ` +
        `${JSON.stringify(files)} — the enumeration is broken, not the tree`
    )
    // Positive control: the two Dockerfiles this test was written against must
    // still be among the discovered set, so a narrowed pathspec or a moved
    // file is caught here rather than by the length check alone.
    assert.ok(files.includes('Dockerfile'), `root Dockerfile missing from discovery: ${JSON.stringify(files)}`)
    assert.ok(
      files.includes('packages/server/sidecar/Dockerfile'),
      `sidecar Dockerfile missing from discovery: ${JSON.stringify(files)}`
    )
  })

  it('finds at least one ARG CLAUDE_CODE_VERSION= pin across all discovered Dockerfiles', () => {
    const pins = allPins()
    assert.ok(
      pins.length > 0,
      'found zero ARG CLAUDE_CODE_VERSION= pins across every tracked Dockerfile — the scan matched ' +
        'nothing, which proves nothing about any floor'
    )
  })

  it('each of the two known Dockerfiles carries >=1 pin, not just the total', () => {
    // A total-only assertion is satisfiable by ONE file losing its pin
    // entirely as long as another still has some — e.g. the root Dockerfile
    // dropping its `ARG CLAUDE_CODE_VERSION=` line (a rename, a refactor that
    // moves the version elsewhere) would leave the total at 1 (the sidecar's)
    // and this whole suite would stay green while the root image silently
    // stopped being floored (#8145 review).
    const pins = allPins()
    for (const file of ['Dockerfile', 'packages/server/sidecar/Dockerfile']) {
      const count = pins.filter((p) => p.file === file).length
      assert.ok(count >= 1, `${file} carries zero ARG CLAUDE_CODE_VERSION= pins (found: ${JSON.stringify(pins)})`)
    }
  })

  it('every discovered pin is >= CLAUDE_SDK_MIN_CLI_VERSION', () => {
    const pins = allPins()
    const below = pins.filter((p) => compareSemver(p.version, CLAUDE_SDK_MIN_CLI_VERSION) < 0)
    assert.deepEqual(
      below,
      [],
      `pin(s) below the ${CLAUDE_SDK_MIN_CLI_VERSION} floor: ${JSON.stringify(below)} — raise the ` +
        'ARG default in the named file(s), or raise CLAUDE_SDK_MIN_CLI_VERSION only after re-verifying ' +
        'the new floor against the current SDK pairing (see agent-sdk-version.js)'
    )
  })

  it('CONTROL: compareSemver actually orders these values the way this test relies on', () => {
    // Without this, a compareSemver regression (or a bad import) could make
    // the assertion above vacuously true for the wrong reason.
    assert.ok(compareSemver('2.1.140', '2.1.141') < 0)
    assert.ok(compareSemver('2.1.141', '2.1.141') === 0)
    assert.ok(compareSemver('2.1.280', '2.1.141') > 0)
    // Cross-width pairs: a naive string/lexical comparison (rather than a
    // real per-component numeric one) gets these backwards — "2.1.99" sorts
    // AFTER "2.1.141" lexically (9 > 1 at the first differing character),
    // and "2.1.1000" sorts BEFORE "2.1.999" the same way. Both directions are
    // exactly the shape a version floor must never get wrong (#8145 review).
    assert.ok(compareSemver('2.1.99', '2.1.141') < 0)
    assert.ok(compareSemver('2.1.1000', '2.1.999') > 0)
  })
})

import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync as fsExistsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { readWorkflows, assertReaderSane } from './helpers/workflow-reader.js'

/**
 * ci.yml's `changes` job's `publish_artifacts:` path filter must cover every
 * input `scripts/verify-publish-artifacts.mjs` actually reads — in BOTH
 * directions (#8167, following the #7639 "a roster checked in only one
 * direction" lesson and the #8150 shape in ci-docker-path-filter.test.js,
 * which does the same thing for `.dockerignore` vs the `docker:` filter).
 *
 * THE DEFECT THIS GUARDS AGAINST. The filter list in ci.yml is a hand-picked
 * mirror of what the verify script packs and imports; a package added to its
 * `PACKAGES` array, or a new `./lib/*.mjs` helper it imports, with no
 * matching filter entry means an edit to it never triggers
 * `Verify Publish Artifacts (PR)` on the PR that changes it — silently
 * reintroducing the #7189 defect class (a check that tests the source tree,
 * not the artifact) one level up: now the gate that exists specifically to
 * catch that doesn't even run on the change that would break it. The reverse
 * gap — a filter entry naming a file or package that no longer exists — wastes
 * CI attention on a stale path and reads as a considered decision when it
 * isn't one.
 *
 * UNLIKE `.dockerignore` (ci-docker-path-filter.test.js's other side), there
 * is no second authored whitelist to diff this filter against here. So
 * direction one is DERIVED directly from the verify script's own source — a
 * static regex read, not an import+execute (the script packs real tarballs
 * and shells out as a side effect of being loaded as a program, so running it
 * in a test is not an option) — rather than transcribed by hand into a
 * parallel list, which is exactly the "hardcoded list beside a growing set"
 * shape docs/false-safety-guards.md catalogues. Direction two is checked
 * against the real repo tree: a filter entry naming a path nothing ships.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Package short names (`protocol`, `store-core`, `server`) the verify
 * script's own `PACKAGES` array declares it packs, read statically off its
 * source text. Mirrors the script's own `pkg.name.split('/')[1]` derivation
 * (see `entryPointsFor` in verify-publish-artifacts.mjs) without executing
 * the module.
 *
 * @param {string} src verify-publish-artifacts.mjs's source text
 * @returns {string[]}
 */
export function extractPackedPackages(src) {
  return [...src.matchAll(/name:\s*'@chroxy\/([\w-]+)'/g)].map((m) => m[1])
}

/**
 * Every local `./lib/<file>` import the verify script makes, as the
 * `scripts/lib/<file>` path a path-filter entry would need to name to cover
 * it.
 *
 * @param {string} src verify-publish-artifacts.mjs's source text
 * @returns {string[]}
 */
export function extractLocalLibImports(src) {
  return [...src.matchAll(/from\s+'\.\/(lib\/[\w.-]+\.mjs)'/g)].map((m) => `scripts/${m[1]}`)
}

/**
 * The `changes` job's named filter category's raw entry list — parsed the
 * same way ci-docker-path-filter.test.js reads `docker:`: js-yaml over the
 * outer workflow document, then again over the nested `filters:` block-scalar
 * string (itself a YAML document held as a string).
 *
 * @param {object} ciDoc the js-yaml-parsed ci.yml document
 * @param {string} category
 * @returns {string[]}
 */
export function filterEntries(ciDoc, category) {
  const changesJob = ciDoc && ciDoc.jobs && ciDoc.jobs.changes
  assert.ok(changesJob, "expected a 'changes' job in ci.yml")
  const filterStep = (changesJob.steps || []).find(
    (s) => typeof s.uses === 'string' && s.uses.includes('dorny/paths-filter')
  )
  assert.ok(filterStep, "expected a dorny/paths-filter step in ci.yml's 'changes' job")
  const filtersText = filterStep.with && filterStep.with.filters
  assert.equal(typeof filtersText, 'string', "expected the paths-filter step's with.filters to be a string")
  const filters = yaml.load(filtersText)
  assert.ok(filters && typeof filters === 'object', 'expected filters: to parse to an object')
  assert.ok(Array.isArray(filters[category]), `expected a '${category}:' category in the filters document`)
  return filters[category]
}

/**
 * Every mismatch between what the verify script reads and what ci.yml's
 * `publish_artifacts` filter lists, checked in BOTH directions. `[]` means
 * they agree.
 *
 * @param {{packages: string[], libImports: string[], filter: string[], existsSync?: (p: string) => boolean}} args
 * @returns {string[]}
 */
export function publishArtifactsFilterIssues({ packages, libImports, filter, existsSync = fsExistsSync }) {
  const issues = []

  for (const pkg of packages) {
    if (!filter.includes(`packages/${pkg}/**`)) {
      issues.push(
        `verify-publish-artifacts.mjs packs @chroxy/${pkg} but ci.yml's publish_artifacts filter has no packages/${pkg}/** entry`
      )
    }
  }

  for (const lib of libImports) {
    if (!filter.includes(lib)) {
      issues.push(
        `verify-publish-artifacts.mjs imports ./${lib.replace(/^scripts\//, '')} but ci.yml's publish_artifacts filter has no '${lib}' entry`
      )
    }
  }

  if (!filter.includes('scripts/verify-publish-artifacts.mjs')) {
    issues.push(
      "ci.yml's publish_artifacts filter is missing a 'scripts/verify-publish-artifacts.mjs' entry — an edit to the script itself must re-run its own gate"
    )
  }

  for (const required of ['package.json', 'package-lock.json']) {
    if (!filter.includes(required)) {
      issues.push(
        `ci.yml's publish_artifacts filter is missing a '${required}' entry — a dependency bump changes what the packed artifact actually ships`
      )
    }
  }

  // #8191 review S1 — the job mirrors release.yml's verify-artifacts job and
  // runs from ci.yml itself, so an edit to either workflow must re-run it.
  for (const workflow of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
    if (!filter.includes(workflow)) {
      issues.push(
        `ci.yml's publish_artifacts filter is missing a '${workflow}' entry — a change to the job's own workflow (or to the release job it mirrors) must re-run the gate`
      )
    }
  }

  // Direction two: every filter entry names something that actually exists.
  // Any OTHER glob (not the `packages/<x>/**` shape) is outside this check's
  // scope, the same deliberate limitation ci-docker-path-filter.test.js's
  // parser carries for a non-package whitelist entry.
  for (const entry of filter) {
    const pkgMatch = /^packages\/([^/]+)\/\*\*$/.exec(entry)
    if (pkgMatch) {
      if (!existsSync(`packages/${pkgMatch[1]}`)) {
        issues.push(`ci.yml's publish_artifacts filter has packages/${pkgMatch[1]}/** but no such package directory exists`)
      }
      continue
    }
    if (/[*?[\]{}]/.test(entry)) continue
    if (!existsSync(entry)) {
      issues.push(`ci.yml's publish_artifacts filter names '${entry}' but no such file exists in the repo`)
    }
  }

  return issues
}

// ---- the rule, on the real tree --------------------------------------------

describe("ci.yml's publish_artifacts path filter covers what verify-publish-artifacts.mjs reads, in both directions (#8167)", () => {
  let packages
  let libImports
  let filter

  before(async () => {
    const scriptSrc = readFileSync(`${ROOT}scripts/verify-publish-artifacts.mjs`, 'utf8')
    packages = extractPackedPackages(scriptSrc)
    libImports = extractLocalLibImports(scriptSrc)

    const workflows = await readWorkflows()
    assertReaderSane(workflows)
    const ci = workflows.find((w) => w.name === 'ci.yml')
    assert.ok(ci, 'expected ci.yml among the scanned workflows')
    const ciDoc = yaml.load(ci.text)
    filter = filterEntries(ciDoc, 'publish_artifacts')
  })

  it('floor: the script derivation and the filter both parsed to something', () => {
    assert.ok(
      packages.length >= 2,
      `expected >=2 packed packages parsed from the script, found ${packages.length} — the regex is probably broken`
    )
    assert.ok(
      libImports.length >= 1,
      `expected >=1 local lib import parsed from the script, found ${libImports.length} — the regex is probably broken`
    )
    assert.ok(filter.length >= 5, `expected >=5 publish_artifacts filter entries, found ${filter.length}`)
  })

  it("CONTROL: 'server' and 'protocol' are packages the script declares (stable sentinels)", () => {
    assert.ok(packages.includes('server'), `expected 'server' among parsed packages: ${packages.join(', ')}`)
    assert.ok(packages.includes('protocol'), `expected 'protocol' among parsed packages: ${packages.join(', ')}`)
  })

  it('the filter agrees with the script in both directions, and every entry names something real', () => {
    const issues = publishArtifactsFilterIssues({
      packages,
      libImports,
      filter,
      existsSync: (p) => fsExistsSync(`${ROOT}${p}`),
    })
    assert.deepEqual(issues, [], `publish_artifacts path-filter mismatch:\n  ${issues.join('\n  ')}`)
  })
})

/**
 * Each branch of the pure rule proven to REPORT — on the real tree every
 * check passes, so without these a deleted or broken rule is invisible
 * (docs/false-safety-guards.md: a rule that returns empty because it is
 * broken looks identical to one that returns empty because the tree is
 * clean).
 */
describe('publishArtifactsFilterIssues reports each defect it exists to find (#8167)', () => {
  const sound = () => ({
    packages: ['server', 'protocol'],
    libImports: ['scripts/lib/classify-doctor-output.mjs'],
    filter: [
      'scripts/verify-publish-artifacts.mjs',
      'scripts/lib/classify-doctor-output.mjs',
      'package.json',
      'package-lock.json',
      '.github/workflows/release.yml',
      '.github/workflows/ci.yml',
      'packages/server/**',
      'packages/protocol/**',
    ],
    existsSync: () => true,
  })

  it('CONTROL: a sound roster reports nothing', () => {
    assert.deepEqual(publishArtifactsFilterIssues(sound()), [])
  })

  it('reports a packed package missing its filter entry', () => {
    const input = sound()
    input.packages = [...input.packages, 'store-core']
    const issues = publishArtifactsFilterIssues(input)
    assert.ok(
      issues.some((i) => /packs @chroxy\/store-core but.*no packages\/store-core\/\*\* entry/.test(i)),
      JSON.stringify(issues)
    )
  })

  it('reports a local lib import missing its filter entry', () => {
    const input = sound()
    input.libImports = [...input.libImports, 'scripts/lib/daemon-entry-modules.mjs']
    const issues = publishArtifactsFilterIssues(input)
    assert.ok(
      issues.some((i) =>
        /imports \.\/lib\/daemon-entry-modules\.mjs but.*no 'scripts\/lib\/daemon-entry-modules\.mjs' entry/.test(i)
      ),
      JSON.stringify(issues)
    )
  })

  it('reports a missing self-reference to the verify script', () => {
    const input = sound()
    input.filter = input.filter.filter((f) => f !== 'scripts/verify-publish-artifacts.mjs')
    const issues = publishArtifactsFilterIssues(input)
    assert.ok(
      issues.some((i) => /missing a 'scripts\/verify-publish-artifacts\.mjs' entry/.test(i)),
      JSON.stringify(issues)
    )
  })

  it('reports a missing package.json / package-lock.json entry', () => {
    const input = sound()
    input.filter = input.filter.filter((f) => f !== 'package-lock.json')
    const issues = publishArtifactsFilterIssues(input)
    assert.ok(issues.some((i) => /missing a 'package-lock\.json' entry/.test(i)), JSON.stringify(issues))
  })

  it('reports a missing workflow entry (release.yml or ci.yml) — #8191 review S1', () => {
    for (const wf of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
      const input = sound()
      input.filter = input.filter.filter((f) => f !== wf)
      const issues = publishArtifactsFilterIssues(input)
      const re = new RegExp(`missing a '${wf.replace(/[.]/g, '\\.')}' entry`)
      assert.ok(issues.some((i) => re.test(i)), JSON.stringify(issues))
    }
  })

  it('reports a filter package entry naming a directory that does not exist (the OTHER direction)', () => {
    const input = sound()
    input.filter = [...input.filter, 'packages/zz-mutant-not-a-package/**']
    input.existsSync = (p) => p !== 'packages/zz-mutant-not-a-package'
    const issues = publishArtifactsFilterIssues(input)
    assert.ok(
      issues.some((i) => /packages\/zz-mutant-not-a-package\/\*\* but no such package directory exists/.test(i)),
      JSON.stringify(issues)
    )
  })

  it('reports a literal filter path naming a file that does not exist', () => {
    const input = sound()
    input.filter = [...input.filter, 'scripts/zz-mutant-does-not-exist.mjs']
    input.existsSync = (p) => p !== 'scripts/zz-mutant-does-not-exist.mjs'
    const issues = publishArtifactsFilterIssues(input)
    assert.ok(
      issues.some((i) => /names 'scripts\/zz-mutant-does-not-exist\.mjs' but no such file exists/.test(i)),
      JSON.stringify(issues)
    )
  })

  it("ignores a non-'packages/<x>/**'-shaped glob entry — outside this check's scope, not a silent pass dressed up as one", () => {
    // 'packages/dashboard/**' itself IS checked (it matches the packages/<x>/**
    // shape this function understands) — this is a DIFFERENT glob shape
    // (a file-level wildcard) that the function deliberately does not parse,
    // the same deliberate limitation ci-docker-path-filter.test.js's own
    // GLOB_CHAR_RE carve-out documents for a non-package whitelist entry.
    const input = sound()
    input.filter = [...input.filter, 'scripts/lib/*.mjs']
    input.existsSync = (p) => p !== 'scripts/lib/*.mjs'
    const issues = publishArtifactsFilterIssues(input)
    assert.deepEqual(issues, [])
  })
})

/**
 * `extractPackedPackages` / `extractLocalLibImports` proven against
 * synthetic source shaped like the real file, decoupled from the real
 * workflow tree.
 */
describe('extractPackedPackages / extractLocalLibImports parse the real shapes (#8167)', () => {
  it('extractPackedPackages reads package short names off a PACKAGES-array-shaped source', () => {
    const src =
      "const PACKAGES = [\n" +
      "  { name: '@chroxy/protocol', packFrom: null },\n" +
      "  { name: '@chroxy/store-core', packFrom: 'packages/store-core/publish', build: 'build:publish' },\n" +
      "  { name: '@chroxy/server', packFrom: null },\n" +
      "]\n"
    assert.deepEqual(extractPackedPackages(src), ['protocol', 'store-core', 'server'])
  })

  it('extractLocalLibImports reads relative ./lib/*.mjs import paths', () => {
    const src =
      "import { classifyDoctorSpawnResult } from './lib/classify-doctor-output.mjs'\n" +
      "import { DAEMON_ENTRY_MODULES } from './lib/daemon-entry-modules.mjs'\n"
    assert.deepEqual(extractLocalLibImports(src), [
      'scripts/lib/classify-doctor-output.mjs',
      'scripts/lib/daemon-entry-modules.mjs',
    ])
  })

  it('extractLocalLibImports ignores a non-relative or non-lib import', () => {
    const src = "import { execFileSync } from 'node:child_process'\nimport { foo } from './helpers.mjs'\n"
    assert.deepEqual(extractLocalLibImports(src), [])
  })
})

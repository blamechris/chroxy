import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync as fsExistsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { readWorkflows, assertReaderSane } from './helpers/workflow-reader.js'
import { discoverPublishInputs, extractPackedPackages, VERIFY_SCRIPT } from './helpers/publish-artifacts-inputs.js'

// Read source, never import the verifier: loading it packs tarballs and shells
// out. The parser follows local modules and static filesystem content inputs,
// while package/filter parity catches a package dropped by discovery (#8195).
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

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
 * @param {{packages: string[], inputs: string[], filter: string[], existsSync?: (p: string) => boolean}} args
 * @returns {string[]}
 */
export function publishArtifactsFilterIssues({ packages, inputs, filter, existsSync = fsExistsSync }) {
  const issues = []

  for (const pkg of packages) {
    if (!filter.includes(`packages/${pkg}/**`)) {
      issues.push(
        `verify-publish-artifacts.mjs packs @chroxy/${pkg} but ci.yml's publish_artifacts filter has no packages/${pkg}/** entry`
      )
    }
  }

  for (const input of inputs) {
    if (!filter.includes(input) && !packages.some(pkg => input.startsWith(`packages/${pkg}/`) && filter.includes(`packages/${pkg}/**`))) {
      issues.push(
        `verify-publish-artifacts.mjs reads '${input}' but ci.yml's publish_artifacts filter has no '${input}' entry`
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
      if (!packages.includes(pkgMatch[1])) {
        issues.push(`ci.yml's publish_artifacts filter has packages/${pkgMatch[1]}/** but PACKAGES does not declare it`)
      }
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
  let inputs
  let filter

  before(async () => {
    const discovered = discoverPublishInputs({ readSource: p => readFileSync(`${ROOT}${p}`, 'utf8') })
    packages = discovered.packages
    inputs = discovered.inputs

    const workflows = await readWorkflows()
    assertReaderSane(workflows)
    const ci = workflows.find((w) => w.name === 'ci.yml')
    assert.ok(ci, 'expected ci.yml among the scanned workflows')
    const ciDoc = yaml.load(ci.text)
    filter = filterEntries(ciDoc, 'publish_artifacts')
  })

  it('CONTROL: discovery reaches the verifier and its current helper modules', () => {
    assert.ok(packages.length > 0, 'PACKAGES must not be empty')
    assert.ok(inputs.includes('scripts/lib/classify-doctor-output.mjs'))
    assert.ok(inputs.includes('scripts/lib/daemon-entry-modules.mjs'))
    assert.ok(filter.length > 0, 'publish_artifacts filter must not be empty')
  })

  it("CONTROL: 'server' and 'protocol' are packages the script declares (stable sentinels)", () => {
    assert.ok(packages.includes('server'), `expected 'server' among parsed packages: ${packages.join(', ')}`)
    assert.ok(packages.includes('protocol'), `expected 'protocol' among parsed packages: ${packages.join(', ')}`)
  })

  it('the filter agrees with the script in both directions, and every entry names something real', () => {
    const issues = publishArtifactsFilterIssues({
      packages,
      inputs,
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
    inputs: ['scripts/lib/classify-doctor-output.mjs'],
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
    input.inputs = [...input.inputs, 'scripts/lib/daemon-entry-modules.mjs']
    const issues = publishArtifactsFilterIssues(input)
    assert.ok(
      issues.some((i) =>
        /reads 'scripts\/lib\/daemon-entry-modules\.mjs' but.*no 'scripts\/lib\/daemon-entry-modules\.mjs' entry/.test(i)
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

const PACKAGE_SOURCE = `const PACKAGES = [
  { name: '@chroxy/protocol', packFrom: null },
  { name: '@chroxy/store-core', packFrom: 'packages/store-core/publish' },
  { name: '@chroxy/server', packFrom: null },
]`

function fixture(extra = '', files = {}) {
  const sources = { [VERIFY_SCRIPT]: `${PACKAGE_SOURCE}\n${extra}`, ...files }
  const reads = []
  const readSource = name => {
    reads.push(name)
    if (!(name in sources)) throw new Error(`missing fixture ${name}`)
    return sources[name]
  }
  return { sources, reads, discover: () => discoverPublishInputs({ readSource }) }
}

function fixtureIssues(discovered, filter = []) {
  return publishArtifactsFilterIssues({
    packages: discovered.packages,
    inputs: discovered.inputs,
    filter: [VERIFY_SCRIPT, 'package.json', 'package-lock.json', '.github/workflows/ci.yml', '.github/workflows/release.yml',
      ...discovered.packages.map(pkg => `packages/${pkg}/**`), ...filter],
    existsSync: () => true,
  })
}

describe('publish verification input discovery parses sources without executing them (#8195)', () => {
  const spellings = [
    ['M4 dynamic import', "await import('./lib/added.mjs')"],
    ['M5 double-quoted import', 'import { value } from "./lib/added.mjs"'],
    ['M6 side-effect import', "import './lib/added.mjs'"],
    ['M7 import outside lib', "import './added.mjs'", 'scripts/added.mjs'],
    ['static template import', 'await import(`./lib/added.mjs`)'],
    ['export-from', "export { value } from './lib/added.mjs'"],
    ['export-star', "export * from './lib/added.mjs'"],
    ['comment between tokens', "import /* from './fake.mjs' */ './lib/added.mjs'"],
    ['escaped specifier', "import './lib/\\u0061dded.mjs'"],
  ]
  for (const [label, source, target = 'scripts/lib/added.mjs'] of spellings) {
    it(`${label}: discovers the input and reports its missing filter`, () => {
      const discovered = fixture(source, { [target]: "export const value = 1; throw new Error('must never execute')" }).discover()
      assert.deepEqual(discovered.inputs, [target])
      assert.ok(fixtureIssues(discovered).some(issue => issue.includes(`no '${target}' entry`)))
      assert.deepEqual(fixtureIssues(discovered, [target]), [])
    })
  }

  const fsSpellings = [
    ['M10 literal fs read', "import { readFileSync } from 'node:fs'; readFileSync('scripts/input.json', 'utf8')"],
    ['M11 fs read through namespace', "import * as fs from 'node:fs'; fs.readFileSync(\"scripts/input.json\")"],
    ['named read alias', "import { readFileSync as read } from 'fs'; read('scripts/input.json')"],
    ['default fs import', "import fs from 'fs'; fs.readFileSync('scripts/input.json')"],
    ['fs/promises read alias', "import { readFile as read } from 'node:fs/promises'; await read('scripts/input.json')"],
    ['fs promises namespace', "import * as fs from 'node:fs/promises'; await fs.readFile('scripts/input.json')"],
    ['fs.promises.readFile', "import fs from 'node:fs'; await fs.promises.readFile('scripts/input.json')"],
    ['promises named alias', "import { promises as p } from 'node:fs'; await p.readFile('scripts/input.json')"],
    ['computed literal method', "import fs from 'node:fs'; fs['readFileSync']('scripts/input.json')"],
    ['stream read', "import { createReadStream } from 'node:fs'; createReadStream('scripts/input.json')"],
    ['static template path', "import { readFileSync } from 'node:fs'; readFileSync(`scripts/input.json`)"],
    ['URL relative to module', "import { readFileSync } from 'node:fs'; readFileSync(new URL('./input.json', import.meta.url))"],
    ['ROOT and const aliases', "import { readFileSync } from 'node:fs'; import { fileURLToPath as toPath } from 'node:url'; import { dirname as dir, resolve as resolvePath, join as joinPath } from 'node:path'; const ROOT = resolvePath(dir(toPath(import.meta.url)), '..'); const input = joinPath(ROOT, 'scripts', 'input.json'); readFileSync(input)"],
  ]
  for (const [label, source] of fsSpellings) {
    it(`${label}: discovers content reads and reports the missing filter`, () => {
      const discovered = fixture(source, { 'scripts/input.json': '{"not":"javascript"}' }).discover()
      assert.deepEqual(discovered.inputs, ['scripts/input.json'])
      assert.ok(fixtureIssues(discovered).some(issue => issue.includes("no 'scripts/input.json' entry")))
      assert.deepEqual(fixtureIssues(discovered, ['scripts/input.json']), [])
    })
  }

  it('follows transitive local imports, deduplicates diamonds and terminates cycles', () => {
    const input = fixture("import './lib/a.mjs'; import './lib/b.mjs'", {
      'scripts/lib/a.mjs': "import './shared.mjs'",
      'scripts/lib/b.mjs': "export * from './shared.mjs'",
      'scripts/lib/shared.mjs': "import './a.mjs'; import { readFileSync } from 'node:fs'; readFileSync('scripts/data.txt')",
      'scripts/data.txt': 'payload',
    })
    const discovered = input.discover()
    assert.deepEqual(discovered.inputs, ['scripts/data.txt', 'scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/lib/shared.mjs'])
    assert.equal(input.reads.filter(p => p === 'scripts/lib/shared.mjs').length, 1)
    assert.deepEqual(fixtureIssues(discovered, discovered.inputs), [])
    for (const missing of discovered.inputs) {
      assert.ok(fixtureIssues(discovered, discovered.inputs.filter(p => p !== missing)).some(issue => issue.includes(`no '${missing}' entry`)))
    }
  })

  it('ignores comments, strings and external imports rather than manufacturing local inputs', () => {
    const discovered = fixture(`
      // import './fake-line.mjs'; readFileSync('fake-line.txt')
      /* import './fake-block.mjs'; { name: '@chroxy/fake' } */
      const sample = "import './fake-string.mjs'"
      const template = \`readFileSync('fake-template.txt')\`
      import 'node:fs'; import 'acorn'; await import('external-package')
    `).discover()
    assert.deepEqual(discovered.inputs, [])
    assert.deepEqual(discovered.packages, ['protocol', 'store-core', 'server'])
  })

  for (const [label, source, files = {}, diagnostic] of [
    ['missing module', "import './lib/missing.mjs'", {}, /scripts\/lib\/missing\.mjs: cannot read/],
    ['missing content', "import { readFileSync } from 'node:fs'; readFileSync('scripts/missing.txt')", {}, /scripts\/missing\.txt: cannot read/],
    ['computed import', "await import('./lib/' + name)", {}, /import\(\) requires a literal/],
    ['computed template import', 'await import(`./lib/${name}.mjs`)', {}, /import\(\) requires a literal/],
    ['computed read', "import { readFileSync } from 'node:fs'; readFileSync(runtimePath)", {}, /filesystem content reads require a static/],
    ['mutable path alias', "import { readFileSync } from 'node:fs'; let input = 'scripts/a.txt'; input = 'scripts/b.txt'; readFileSync(input)", {}, /filesystem content reads require a static/],
    ['ambiguous path alias', "import { readFileSync } from 'node:fs'; const input = 'scripts/a.txt'; function f() { const input = 'scripts/b.txt' }; readFileSync(input)", {}, /filesystem content reads require a static/],
    ['encoded URL content', "import { readFileSync } from 'node:fs'; readFileSync(new URL('./%2e%2e/input.txt', import.meta.url))", {}, /filesystem content reads require a static/],
    ['read alias', "import fs from 'node:fs'; const read = fs.readFileSync; read('scripts/input.json')", {}, /filesystem bindings may not escape/],
    ['namespace alias', "import fs from 'node:fs'; const alias = fs", {}, /filesystem bindings may not escape/],
    ['destructured read', "import fs from 'node:fs'; const { readFileSync: read } = fs", {}, /filesystem bindings may not escape/],
    ['computed method', "import fs from 'node:fs'; fs[method]('scripts/input.json')", {}, /filesystem bindings may not escape/],
    ['dynamic fs namespace', "const fs = await import('node:fs'); fs.readFileSync('scripts/input.json')", {}, /dynamic filesystem bindings/],
    ['indirect call', "import { readFileSync } from 'node:fs'; readFileSync.call(null, 'scripts/input.json')", {}, /filesystem bindings may not escape/],
    ['require', "const fs = require('node:fs')", {}, /require\(\) needs explicit/],
    ['import query', "import './lib/helper.mjs?variant'", {}, /without URL suffixes/],
    ['escaping import', "import '../../outside.mjs'", {}, /escapes the repo/],
    ['absolute import', "import '/tmp/helper.mjs'", {}, /absolute or file URL imports/],
    ['unknown module type', "import './input.txt'", {}, /module imports must have/],
    ['escaping content', "import { readFileSync } from 'node:fs'; readFileSync('../outside.txt')", {}, /escapes the repo/],
    ['escaping URL content', "import { readFileSync } from 'node:fs'; readFileSync(new URL('../../../outside.txt', import.meta.url))", {}, /escapes the repo/],
    ['absolute content', "import { readFileSync } from 'node:fs'; readFileSync('/tmp/input.txt')", {}, /absolute filesystem paths/],
    ['malformed module', "import './lib/broken.mjs'", { 'scripts/lib/broken.mjs': 'const =' }, /cannot parse/],
  ]) {
    it(`fails clearly for ${label}`, () => {
      assert.throws(() => fixture(source, files).discover(), diagnostic)
    })
  }

  it('reports a missing root source clearly', () => {
    assert.throws(() => discoverPublishInputs({ readSource: () => { throw new Error('missing root') } }), /verify-publish-artifacts\.mjs: cannot read.*missing root/)
  })

  it('rejects readers that do not return source text', () => {
    assert.throws(() => discoverPublishInputs({ readSource: () => null }), /reader must return source text/)
  })

  it('accepts reads covered by a packed package filter, but not a lookalike package prefix', () => {
    const discovered = fixture("import { readFileSync } from 'node:fs'; readFileSync('packages/server/CONFIG.md')", { 'packages/server/CONFIG.md': 'text' }).discover()
    assert.deepEqual(fixtureIssues(discovered), [])
    discovered.inputs = ['packages/server-other/input.txt']
    assert.ok(fixtureIssues(discovered).some(issue => issue.includes("no 'packages/server-other/input.txt' entry")))
  })
})

describe('PACKAGES discovery has structural and independent roster controls (#8195)', () => {
  it('accepts quote/key spellings and ignores unrelated name properties', () => {
    assert.deepEqual(extractPackedPackages('const PACKAGES = [{ "name": "@chroxy/server" }, { name: `@chroxy/protocol` }]; const unrelated = { name: "@chroxy/fake" }'), ['server', 'protocol'])
  })

  for (const source of [
    'const PACKAGES = []',
    'const other = [{ name: "@chroxy/server" }]',
    'const PACKAGES = computed',
    'const PACKAGES = [...computed]',
    'const PACKAGES = [{ name: computed }]',
    'const PACKAGES = [{ ["name"]: "@chroxy/server" }]',
    'const PACKAGES = [{ name: "@chroxy/server", ...computed }]',
    'const PACKAGES = [{ name: "@chroxy/server", name: "@chroxy/protocol" }]',
    'const PACKAGES = [{ name: "@chroxy/server" }, { name: "@chroxy/server" }]',
    'const PACKAGES = [{ name: "@chroxy/server", packFrom: runtimePath }]',
    'const PACKAGES = [{ name: "@chroxy/server", packFrom: "packages/protocol/publish" }]',
    'const PACKAGES = [{ name: "@chroxy/server", packFrom: "packages/server/../../outside" }]',
  ]) {
    it(`rejects an unsupported or empty package roster: ${source}`, () => {
      assert.throws(() => extractPackedPackages(source), /PACKAGES/)
    })
  }

  it('detects dropping any discovered package against the independently authored filter', () => {
    const packages = extractPackedPackages(PACKAGE_SOURCE)
    // Retain the independent filter roster while mutating discovery.
    for (const missing of packages) {
      const input = { packages: packages.filter(p => p !== missing), inputs: [], filter: packages.map(p => `packages/${p}/**`), existsSync: () => true }
      assert.ok(publishArtifactsFilterIssues(input).some(issue => issue.includes(`packages/${missing}/** but PACKAGES does not declare it`)))
    }
  })

  it('accepts a two-sided package addition', () => {
    const discovered = fixture().discover()
    discovered.packages.push('new-package')
    assert.deepEqual(fixtureIssues(discovered), [])
  })

  it('rejects a missing publish_artifacts category instead of checking zero inputs', () => {
    assert.throws(() => filterEntries({ jobs: { changes: { steps: [{ uses: 'dorny/paths-filter@sha', with: { filters: 'other: []' } }] } } }, 'publish_artifacts'), /expected a 'publish_artifacts:' category/)
  })
})

describe('fs and require forms discovery cannot follow are refused, not ignored (#8195)', () => {
  const refused = /is not understood by input discovery/
  for (const [label, source] of [
    ['existsSync (named)', "import { existsSync } from 'node:fs'; existsSync('scripts/x.json')"],
    ['readdirSync (named)', "import { readdirSync } from 'node:fs'; readdirSync('scripts')"],
    ['openSync (named)', "import { openSync } from 'fs'; openSync('scripts/x.json')"],
    ['cpSync (namespace)', "import * as fs from 'node:fs'; fs.cpSync('scripts', 'out')"],
    ['statSync (default import)', "import fs from 'node:fs'; fs.statSync('scripts/x.json')"],
    ['fs.promises read-adjacent call', "import fs from 'node:fs'; await fs.promises.readdir('scripts')"],
    ['fs/promises access', "import { access } from 'node:fs/promises'; await access('scripts/x.json')"],
    ['fs/promises namespace opendir', "import * as fs from 'node:fs/promises'; await fs.opendir('scripts')"],
    ['aliased named import', "import { readdirSync as list } from 'node:fs'; list('scripts')"],
  ]) {
    it(`refuses ${label} in a followed module`, () => {
      assert.throws(() => fixture("import './lib/helper.mjs'", { 'scripts/lib/helper.mjs': source }).discover(), refused)
    })
    if (!source.includes('existsSync')) {
      it(`refuses ${label} in the verifier itself`, () => {
        assert.throws(() => fixture(source).discover(), refused)
      })
    }
  }

  it('names the call and the file in the message', () => {
    assert.throws(() => fixture("import { readdirSync } from 'node:fs'; readdirSync('scripts')").discover(), /verify-publish-artifacts\.mjs:\d+: .*'readdirSync'/)
  })

  it('refuses an fs re-export', () => {
    assert.throws(() => fixture("export { readdirSync } from 'node:fs'").discover(), /filesystem re-exports/)
  })

  for (const [label, source] of [
    ['createRequire', "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url)"],
    ['bare module specifier', "import { createRequire } from 'module'"],
    ['module namespace', "import * as m from 'node:module'"],
    ['dynamic node:module', "await import('node:module')"],
  ]) {
    it(`refuses ${label}`, () => {
      assert.throws(() => fixture(source).discover(), /node:module/)
    })
  }

  it('refuses the verifier-only tolerated calls outside the verifier, and beyond their known count inside it', () => {
    const outside = "import { existsSync } from 'node:fs'; existsSync(dynamicPath)"
    assert.throws(() => fixture("import './lib/helper.mjs'", { 'scripts/lib/helper.mjs': outside }).discover(), refused)
    const four = "import { existsSync } from 'node:fs'; existsSync(a); existsSync(b); existsSync(c); existsSync(d)"
    assert.throws(() => fixture(four).discover(), /new fs 'existsSync' call/)
    assert.throws(() => fixture("import { writeFileSync } from 'node:fs'; writeFileSync(a, b); writeFileSync(c, d)").discover(), /new fs 'writeFileSync' call/)
    assert.throws(() => fixture("import { rmSync } from 'node:fs'; const r = rmSync").discover(), /must be called directly/)
  })

  it('still tolerates the verifier known calls, and follows a literal existsSync path as an input', () => {
    const discovered = fixture("import { existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'; existsSync(dynamic); existsSync('scripts/known.json'); rmSync(a); mkdtempSync(b); writeFileSync(c, d)").discover()
    assert.deepEqual(discovered.inputs, ['scripts/known.json'])
  })
})

describe('independent review regression controls (#8195)', () => {
  const target = 'scripts/zz-review-unfiltered.json'
  for (const [label, source] of [
    ['named default fs alias', `import { default as fs } from 'node:fs'; fs.readFileSync('${target}')`],
    ['string-named fs read alias', `import { 'readFileSync' as read } from 'node:fs'; read('${target}')`],
  ]) {
    it(`${label} must discover the literal input and its missing filter`, () => {
      const result = fixture(source, { [target]: '{}' }).discover()
      assert.deepEqual(result.inputs, [target])
      assert.ok(fixtureIssues(result).some(issue => issue.includes(`no '${target}' entry`)))
      assert.deepEqual(fixtureIssues(result, [target]), [])
    })
  }

  it('rejects a function parameter shadowing a static path alias', () => {
    const source = `import { readFileSync } from 'node:fs'; const input = 'scripts/covered.json'; function readInput(input) { return readFileSync(input) }; readInput('${target}')`
    assert.throws(() => fixture(source, { [target]: '{}', 'scripts/covered.json': '{}' }).discover(), /unsupported publish-verification input/)
  })

  it('rejects a new entryPointsFor call outside the validated PACKAGES use', () => {
    const source = readFileSync(`${ROOT}${VERIFY_SCRIPT}`, 'utf8') + "\nentryPointsFor({ name: '@chroxy/server', packFrom: 'scripts/zz-review-extra' })\n"
    assert.throws(() => discoverPublishInputs({ readSource: p => p === VERIFY_SCRIPT ? source : p === 'scripts/zz-review-extra/package.json' ? '{}' : readFileSync(`${ROOT}${p}`, 'utf8') }), /unsupported publish-verification input/)
  })
})

describe('review correction keeps nearby static boundaries explicit (#8195)', () => {
  for (const [label, source] of [
    ['quoted default import', "import { 'default' as fs } from 'node:fs'; fs.readFileSync('scripts/input.json')"],
    ['named default fs/promises', "import { default as fs } from 'node:fs/promises'; await fs.readFile('scripts/input.json')"],
    ['quoted readFile import', "import { 'readFile' as read } from 'node:fs/promises'; await read('scripts/input.json')"],
    ['block-scoped const visible to its read', "import { readFileSync } from 'node:fs'; { const input = 'scripts/input.json'; readFileSync(input) }"],
    ['outer const visible without shadowing', "import { readFileSync } from 'node:fs'; const input = 'scripts/input.json'; function readInput(unused) { readFileSync(input) }"],
    ['named URL import', "import { readFileSync } from 'node:fs'; import { URL } from 'node:url'; readFileSync(new URL('./input.json', import.meta.url))"],
  ]) {
    it(`${label} still discovers the input`, () => {
      assert.deepEqual(fixture(source, { 'scripts/input.json': '{}' }).discover().inputs, ['scripts/input.json'])
    })
  }

  for (const [label, declaration] of [
    ['default parameter', "function f(input = 'scripts/unfiltered.json') { readFileSync(input) }"],
    ['rest parameter', 'function f(...input) { readFileSync(input) }'],
    ['object parameter pattern', 'function f({ input }) { readFileSync(input) }'],
    ['array parameter pattern', 'function f([input]) { readFileSync(input) }'],
    ['arrow parameter', 'const readInput = input => readFileSync(input)'],
    ['catch binding', 'try {} catch (input) { readFileSync(input) }'],
    ['destructured declaration', '{ const { input } = runtimeObject; readFileSync(input) }'],
  ]) {
    it(`rejects ${label} instead of borrowing an outer constant`, () => {
      assert.throws(() => fixture(`import { readFileSync } from 'node:fs'; const input = 'scripts/covered.json'; ${declaration}`, { 'scripts/covered.json': '{}' }).discover(), /filesystem content reads require a static/)
    })
  }

  for (const [label, source, expected] of [
    ['invisible sibling const', "import { readFileSync } from 'node:fs'; function f() { const input = 'scripts/covered.json' }; readFileSync(input)", /filesystem content reads require a static/],
    ['shadowed fs binding', "import fs from 'node:fs'; function f(fs) { fs.readFileSync('scripts/unfiltered.json') }", /shadowed built-in binding/],
    ['shadowed named read binding', "import { readFileSync } from 'node:fs'; function f(readFileSync) { readFileSync('scripts/unfiltered.json') }", /shadowed built-in binding/],
    ['shadowed path binding', "import { readFileSync } from 'node:fs'; import { join } from 'node:path'; function f(join) { readFileSync(join('scripts', 'unfiltered.json')) }", /shadowed built-in binding/],
    ['shadowed URL constructor', "import { readFileSync } from 'node:fs'; function f(URL) { readFileSync(new URL('./unfiltered.json', import.meta.url)) }", /filesystem content reads require a static/],
  ]) {
    it(`fails closed for ${label}`, () => assert.throws(() => fixture(source).discover(), expected))
  }

  const actual = readFileSync(`${ROOT}${VERIFY_SCRIPT}`, 'utf8')
  for (const [label, transform] of [
    ['aliased entryPointsFor', source => `${source}\nconst readOther = entryPointsFor`],
    ['indirect entryPointsFor call', source => `${source}\nentryPointsFor.call(null, { name: '@chroxy/server', packFrom: 'scripts/extra' })`],
    ['different callback source', source => source.replace('.flatMap(entryPointsFor)', '.flatMap((pkg) => entryPointsFor(pkg))')],
    ['additional package filter use', source => `${source}\nPACKAGES.filter((p) => p.build)`],
    ['package-array mutation', source => `${source}\nPACKAGES.push({ name: '@chroxy/server', packFrom: 'scripts/extra' })`],
    ['additional package loop', source => `${source}\nfor (const p of PACKAGES) { p.packFrom = 'scripts/extra' }`],
    ['changed package pack loop', source => source.replace('for (const p of PACKAGES) {', "for (const p of PACKAGES) { p.packFrom = 'scripts/extra'")],
    ['changed package build loop', source => source.replace('for (const p of PACKAGES.filter((p) => p.build)) {', "for (const p of PACKAGES.filter((p) => p.build)) { p.packFrom = 'scripts/extra'")],
    ['changed exempt function', source => source.replace('function entryPointsFor(pkg) {', "function entryPointsFor(pkg) { pkg.packFrom = 'scripts/extra'")],
  ]) {
    it(`rejects ${label} rather than granting unproven manifest coverage`, () => {
      const source = transform(actual)
      assert.notEqual(source, actual, 'mutation must change actual verifier source text')
      assert.throws(() => discoverPublishInputs({ readSource: p => p === VERIFY_SCRIPT ? source : readFileSync(`${ROOT}${p}`, 'utf8') }), /unsupported publish-verification input/)
    })
  }
})

describe('namespace-default review regressions (#8195)', () => {
  const target = 'scripts/zz-review-namespace-default.json'
  for (const [label, extra] of [
    ['fs namespace default', `import * as fs from 'node:fs'; fs.default.readFileSync('${target}')`],
    ['fs/promises namespace default', `import * as fs from 'node:fs/promises'; await fs.default.readFile('${target}')`],
  ]) {
    it(`${label} must not lose its literal content input against the real filter`, () => {
      const input = fixture(extra, { [target]: '{}' })
      let discovered
      assert.doesNotThrow(() => { discovered = input.discover() })
      const filter = filterEntries(yaml.load(readFileSync(`${ROOT}.github/workflows/ci.yml`, 'utf8')), 'publish_artifacts')
      const issues = publishArtifactsFilterIssues({ ...discovered, filter, existsSync: p => fsExistsSync(`${ROOT}${p}`) })
      assert.ok(discovered.inputs.includes(target) && issues.some(issue => issue.includes(target)))
      assert.ok(input.reads.includes(target), 'the injected reader must actually reach the content input')
    })
  }
})

describe('known namespace default projections remain bounded (#8195)', () => {
  for (const [label, source] of [
    ['computed-literal default read', "import * as fs from 'node:fs'; fs['default']['readFileSync']('scripts/input.json')"],
    ['optional default read', "import * as fs from 'node:fs'; fs?.default?.readFileSync?.('scripts/input.json')"],
    ['default promises read', "import * as fs from 'node:fs'; await fs.default.promises.readFile('scripts/input.json')"],
    ['default stream read', "import * as fs from 'node:fs'; fs.default.createReadStream('scripts/input.json')"],
    ['computed default promises read', "import * as fs from 'node:fs'; await fs['default']['promises']['readFile']('scripts/input.json')"],
    ['optional computed default read', "import * as fs from 'node:fs'; fs?.['default']?.['readFileSync']?.('scripts/input.json')"],
    ['optional fs/promises default read', "import * as fs from 'node:fs/promises'; await fs?.default?.readFile?.('scripts/input.json')"],
  ]) {
    it(`${label} discovers content and reports its missing filter`, () => {
      let discovered
      assert.doesNotThrow(() => { discovered = fixture(source, { 'scripts/input.json': '{}' }).discover() })
      assert.deepEqual(discovered.inputs, ['scripts/input.json'])
      assert.ok(fixtureIssues(discovered).some(issue => issue.includes("no 'scripts/input.json' entry")))
      assert.deepEqual(fixtureIssues(discovered, ['scripts/input.json']), [])
    })
  }

  for (const [label, source] of [
    ['computed projection', "import * as fs from 'node:fs'; fs[projection].readFileSync('scripts/input.json')"],
    ['computed default method', "import * as fs from 'node:fs'; fs.default[method]('scripts/input.json')"],
    ['computed default promises method', "import * as fs from 'node:fs'; fs.default.promises[method]('scripts/input.json')"],
    ['indirect default read', "import * as fs from 'node:fs'; fs.default.readFileSync.bind(null)('scripts/input.json')"],
    ['escaped default alias', "import * as fs from 'node:fs'; const alias = fs.default; alias.readFileSync('scripts/input.json')"],
    ['default on a default-imported object', "import fs from 'node:fs'; fs.default.readFileSync('scripts/input.json')"],
    ['repeated default projection', "import * as fs from 'node:fs'; fs.default.default.readFileSync('scripts/input.json')"],
    ['default on a promises object', "import { promises as fs } from 'node:fs'; fs.default.readFile('scripts/input.json')"],
    ['promises on an fs/promises default object', "import * as fs from 'node:fs/promises'; fs.default.promises.readFile('scripts/input.json')"],
  ]) {
    it(`rejects ${label} instead of silently losing a read`, () => {
      assert.throws(() => fixture(source, { 'scripts/input.json': '{}' }).discover(), /filesystem bindings may not escape/)
    })
  }
})

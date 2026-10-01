import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { readWorkflows } from './helpers/workflow-reader.js'

/**
 * ci.yml's `changes` job hand-mirrors `.dockerignore`'s whitelist in its
 * `docker:` dorny/paths-filter list (#7196's `renovate` roster problem,
 * #8150's review nit N5).
 *
 * THE DEFECT. `.dockerignore` is whitelist-based (`*` excludes everything,
 * then `!packages/<x>/...` re-includes exactly what the image needs), and
 * `ci.yml`'s `docker:` filter lists the same packages BY HAND to mirror it —
 * a comment says so, but nothing checked it. A package added to the image
 * with no matching filter entry means an edit to that new package's `src/`
 * never triggers `Docker Image Smoke` on the PR that changes it. The
 * reverse gap — a filter entry for a package `.dockerignore` never ships —
 * wastes CI on files that cannot affect the image.
 *
 * THE INVARIANT, checked in BOTH directions (#7639's "a roster checked in
 * only one direction" — the same defect class filed four times, once per
 * job, before anyone read it as a missing invariant, per this repo's own
 * memory): every package `.dockerignore` whitelists has a matching
 * `packages/<x>/**` filter entry, and every `packages/<x>/**` filter entry
 * names a package `.dockerignore` actually whitelists. Every OTHER
 * whitelisted path (`package.json`, `scripts/docker-entrypoint.sh`, ...) is
 * covered by some filter entry too, and `Dockerfile` / `.dockerignore`
 * themselves must be filter entries.
 *
 * PARSING (#8150 review, S4): the `filters: |` value is a YAML document
 * ITSELF, held as a string inside the outer workflow YAML — parsed with
 * `js-yaml`'s `yaml.load`, once for the outer document and once more for
 * the nested one, rather than a hand-rolled indentation scanner. A real
 * parser accepts every YAML spelling of a list entry (plain, single- or
 * double-quoted) without three copies of the same regex, and can't be
 * fooled by a comment that merely quotes a filter entry in prose.
 *
 * NORMALISATION (#8150 review, S4b): `.dockerignore` can whitelist a package
 * either with a trailing slash (`!packages/server/`) or without
 * (`!packages/server`) — both name the same package and must land in the
 * same bucket.
 *
 * FLOOR, NOT AN EXACT SET (#8150 review, S4d): the real package roster is
 * NOT pinned here. PR #8151 is adding several new packages to BOTH sides at
 * once, and a CONTROL that freezes today's three-package list would go red
 * for a correct two-sided addition — the opposite of what this file exists
 * to catch. `server` alone is pinned as a stable sentinel (the server
 * package is not going away), alongside a floor that neither side parses to
 * zero.
 */

// ---- the pure rule, over already-parsed YAML values ------------------------

/**
 * `.dockerignore`'s whitelist (`!`-prefixed re-include lines), split into
 * package directories (`!packages/<x>` or `!packages/<x>/...`, normalised to
 * the same bucket regardless of a trailing slash) and everything else.
 *
 * @param {string} text Raw `.dockerignore` contents.
 * @returns {{packages: Set<string>, paths: Set<string>}}
 */
// `.dockerignore` allows a glob whitelist entry (`!packages/*/dist/` is
// valid Docker syntax), but this parser understands only literal package
// paths. Left unguarded, `[^/]+` in the package regex below happily accepts
// `*` as if it were a literal package NAME, producing a spurious roster
// mismatch instead of a crash (#8150 review round 3, nitpick) — the "cannot
// check this treated as nothing to check" failure one level removed: here
// it is "cannot check this treated as a normal, checkable thing", which is
// worse, because the resulting mismatch looks like a real finding. Fail
// loudly instead: a glob character anywhere in a whitelist entry is a
// parser limitation, not a roster fact, and must say so.
const GLOB_CHAR_RE = /[*?[\]{}]/

export function parseDockerignoreWhitelist(text) {
  const packages = new Set()
  const paths = new Set()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!line.startsWith('!')) continue // only a re-include line is a WHITELIST entry
    const entry = line.slice(1)
    if (GLOB_CHAR_RE.test(entry)) {
      throw new Error(
        `glob whitelist entries are not supported by this roster test ('!${entry}') — ` +
          '.dockerignore allows a glob here, but parseDockerignoreWhitelist only understands literal ' +
          'package paths; extend the parser (or rewrite the .dockerignore entry as literal paths) before relying on this check'
      )
    }
    const pkgMatch = /^packages\/([^/]+)(?:\/.*)?$/.exec(entry)
    if (pkgMatch) {
      packages.add(pkgMatch[1])
    } else {
      paths.add(entry.replace(/\/$/, ''))
    }
  }
  return { packages, paths }
}

/**
 * ci.yml's `changes` job's `docker:` path-filter entries, split into package
 * globs (`packages/<x>/**`, or bare `packages/<x>`) and everything else — the
 * same two buckets `parseDockerignoreWhitelist` produces.
 *
 * @param {string[]} entries The parsed `docker:` filter array.
 * @returns {{packages: Set<string>, paths: Set<string>}}
 */
export function bucketDockerFilterEntries(entries) {
  const packages = new Set()
  const paths = new Set()
  for (const e of entries) {
    const m = /^packages\/([^/]+)(?:\/.*)?$/.exec(e)
    if (m) packages.add(m[1])
    else paths.add(e)
  }
  return { packages, paths }
}

/**
 * Parses ci.yml's `changes` job's dorny/paths-filter `filters:` value —
 * itself a YAML document held as a string — and returns its `docker:`
 * category's raw entry list.
 *
 * @param {object} ciDoc The js-yaml-parsed ci.yml document.
 * @returns {string[]}
 */
export function dockerFilterEntriesFromCiDoc(ciDoc) {
  const changesJob = ciDoc && ciDoc.jobs && ciDoc.jobs.changes
  assert.ok(changesJob, "expected a 'changes' job in ci.yml")
  const filterStep = (changesJob.steps || []).find((s) => typeof s.uses === 'string' && s.uses.includes('dorny/paths-filter'))
  assert.ok(filterStep, "expected a dorny/paths-filter step in ci.yml's 'changes' job")
  const filtersText = filterStep.with && filterStep.with.filters
  assert.equal(typeof filtersText, 'string', "expected the paths-filter step's with.filters to be a string")
  const filters = yaml.load(filtersText)
  assert.ok(filters && typeof filters === 'object', 'expected filters: to parse to an object')
  assert.ok(Array.isArray(filters.docker), "expected a 'docker:' category in the filters document")
  return filters.docker
}

/**
 * Every mismatch between `.dockerignore`'s whitelist and ci.yml's `docker:`
 * path filter, checked in BOTH directions (#7639). `[]` means the roster
 * agrees.
 *
 * @param {{packages: Set<string>, paths: Set<string>}} dockerignore
 * @param {{packages: Set<string>, paths: Set<string>}} filter
 * @returns {string[]}
 */
export function dockerPathFilterIssues(dockerignore, filter) {
  const issues = []

  for (const pkg of dockerignore.packages) {
    if (!filter.packages.has(pkg)) {
      issues.push(`.dockerignore whitelists packages/${pkg}/ but ci.yml's docker filter has no packages/${pkg}/** entry`)
    }
  }
  for (const pkg of filter.packages) {
    if (!dockerignore.packages.has(pkg)) {
      issues.push(`ci.yml's docker filter has packages/${pkg}/** but .dockerignore does not whitelist packages/${pkg}/`)
    }
  }

  for (const p of dockerignore.paths) {
    if (!filter.paths.has(p)) {
      issues.push(`.dockerignore whitelists '${p}' but ci.yml's docker filter has no matching entry`)
    }
  }

  for (const required of ['Dockerfile', '.dockerignore']) {
    if (!filter.paths.has(required)) {
      issues.push(`ci.yml's docker filter is missing a '${required}' entry — an edit to it changes what ships without touching any package tree`)
    }
  }

  return issues
}

/**
 * The shared floor: a parser that silently found zero packages on either
 * side would let `dockerPathFilterIssues` pass over an empty set. Asserted
 * directly rather than inferred from agreement alone (#7503).
 *
 * @param {{packages: Set<string>, paths: Set<string>}} dockerignore
 * @param {{packages: Set<string>, paths: Set<string>}} filter
 */
export function assertNeitherSideIsEmpty(dockerignore, filter) {
  assert.ok(dockerignore.packages.size > 0, 'expected .dockerignore to whitelist at least one package — the parser found none')
  assert.ok(filter.packages.size > 0, "expected ci.yml's docker filter to have at least one packages/<x>/** entry — the parser found none")
}

// ---- the rule, on the real tree --------------------------------------------

describe("ci.yml's docker path filter mirrors .dockerignore's whitelist, in both directions (#8150)", () => {
  let dockerignore
  let filter

  before(async () => {
    const dockerignoreText = readFileSync(fileURLToPath(new URL('../../../.dockerignore', import.meta.url)), 'utf8')
    dockerignore = parseDockerignoreWhitelist(dockerignoreText)

    const workflows = await readWorkflows()
    const ci = workflows.find((w) => w.name === 'ci.yml')
    assert.ok(ci, 'expected ci.yml among the scanned workflows')
    const ciDoc = yaml.load(ci.text)
    const entries = dockerFilterEntriesFromCiDoc(ciDoc)
    filter = bucketDockerFilterEntries(entries)
  })

  it('floor: neither side parses to zero packages', () => {
    assertNeitherSideIsEmpty(dockerignore, filter)
  })

  it("CONTROL: 'server' is present on both sides (a stable sentinel — NOT the full set, which #8151 is about to grow on both sides at once)", () => {
    assert.ok(dockerignore.packages.has('server'), '.dockerignore should whitelist packages/server/')
    assert.ok(filter.packages.has('server'), "ci.yml's docker filter should have a packages/server/** entry")
  })

  it('the roster agrees in both directions, plus every non-package whitelisted path', () => {
    const issues = dockerPathFilterIssues(dockerignore, filter)
    assert.deepEqual(issues, [], `docker path-filter roster mismatch: ${issues.join('; ')}`)
  })
})

/**
 * Each branch of the pure rule proven to REPORT — the real tree agrees, so
 * without these a deleted or broken rule is invisible.
 */
describe('dockerPathFilterIssues reports each shape it exists to find (#8150)', () => {
  const sound = () => ({
    dockerignore: { packages: new Set(['server', 'protocol']), paths: new Set(['package.json', 'scripts/docker-entrypoint.sh']) },
    filter: { packages: new Set(['server', 'protocol']), paths: new Set(['package.json', 'scripts/docker-entrypoint.sh', 'Dockerfile', '.dockerignore']) },
  })

  it('CONTROL: a sound roster reports nothing', () => {
    const { dockerignore, filter } = sound()
    assert.deepEqual(dockerPathFilterIssues(dockerignore, filter), [])
  })

  it('reports a package whitelisted in .dockerignore with no matching filter entry', () => {
    const { dockerignore, filter } = sound()
    dockerignore.packages.add('zz-mutant-not-a-package')
    const issues = dockerPathFilterIssues(dockerignore, filter)
    assert.ok(issues.some((i) => /whitelists packages\/zz-mutant-not-a-package\/ but.*no packages\/zz-mutant-not-a-package\/\*\* entry/.test(i)), JSON.stringify(issues))
  })

  it('reports a filter entry with no matching .dockerignore whitelist (the OTHER direction)', () => {
    const { dockerignore, filter } = sound()
    filter.packages.add('zz-mutant-not-a-package')
    const issues = dockerPathFilterIssues(dockerignore, filter)
    assert.ok(issues.some((i) => /docker filter has packages\/zz-mutant-not-a-package\/\*\* but \.dockerignore does not whitelist/.test(i)), JSON.stringify(issues))
  })

  it('reports a non-package whitelisted path with no filter coverage', () => {
    const { dockerignore, filter } = sound()
    dockerignore.paths.add('scripts/some-new-entrypoint.sh')
    const issues = dockerPathFilterIssues(dockerignore, filter)
    assert.ok(issues.some((i) => /whitelists 'scripts\/some-new-entrypoint\.sh' but.*no matching entry/.test(i)), JSON.stringify(issues))
  })

  it('reports a missing Dockerfile filter entry', () => {
    const { dockerignore, filter } = sound()
    filter.paths.delete('Dockerfile')
    const issues = dockerPathFilterIssues(dockerignore, filter)
    assert.ok(issues.some((i) => /missing a 'Dockerfile' entry/.test(i)), JSON.stringify(issues))
  })

  it('reports a missing .dockerignore filter entry', () => {
    const { dockerignore, filter } = sound()
    filter.paths.delete('.dockerignore')
    const issues = dockerPathFilterIssues(dockerignore, filter)
    assert.ok(issues.some((i) => /missing a '\.dockerignore' entry/.test(i)), JSON.stringify(issues))
  })
})

describe('parseDockerignoreWhitelist / bucketDockerFilterEntries parse the real shapes (#8150)', () => {
  // #8150 review round 3 nitpick: a glob whitelist entry must fail loudly,
  // not silently misparse into a bogus package named "*".
  it('parseDockerignoreWhitelist throws a clear error on a glob whitelist entry, rather than misparsing it', () => {
    const text = ['*', '!packages/*/dist/'].join('\n')
    assert.throws(() => parseDockerignoreWhitelist(text), /glob whitelist entries are not supported by this roster test/)
  })

  it('parseDockerignoreWhitelist ignores exclusion lines and comments, and strips a trailing slash', () => {
    const text = [
      '*',
      '# a comment mentioning !packages/should-not-count/ in prose',
      '!package.json',
      '!packages/server/',
      'packages/server/node_modules',
      '',
    ].join('\n')
    const { packages, paths } = parseDockerignoreWhitelist(text)
    assert.deepEqual([...packages], ['server'])
    assert.deepEqual([...paths], ['package.json'])
  })

  it('parseDockerignoreWhitelist normalises a package WITH and WITHOUT a trailing slash into the same bucket', () => {
    const text = ['*', '!packages/protocol', '!packages/protocol/dist/'].join('\n')
    const { packages } = parseDockerignoreWhitelist(text)
    assert.deepEqual([...packages], ['protocol'])
  })

  it('parseDockerignoreWhitelist counts each distinct package once even with multiple whitelist lines', () => {
    const text = ['*', '!packages/protocol/package.json', '!packages/protocol/dist/'].join('\n')
    const { packages } = parseDockerignoreWhitelist(text)
    assert.deepEqual([...packages], ['protocol'])
  })

  it('bucketDockerFilterEntries reads a bare packages/<x> entry (no glob suffix) into the package bucket', () => {
    const { packages, paths } = bucketDockerFilterEntries(['Dockerfile', 'packages/server'])
    assert.deepEqual([...packages], ['server'])
    assert.deepEqual([...paths], ['Dockerfile'])
  })

  // S4a: js-yaml must accept every spelling of a filter entry GitHub Actions
  // YAML allows — plain, single-quoted, and double-quoted.
  it('dockerFilterEntriesFromCiDoc reads plain, single-quoted, and double-quoted filter entries alike', () => {
    const ciDoc = {
      jobs: {
        changes: {
          steps: [
            {
              uses: 'dorny/paths-filter@v3',
              with: {
                filters: [
                  'docker:',
                  '  - Dockerfile',
                  "  - 'packages/server/**'",
                  '  - "packages/protocol/**"',
                ].join('\n'),
              },
            },
          ],
        },
      },
    }
    const entries = dockerFilterEntriesFromCiDoc(ciDoc)
    assert.deepEqual(entries.sort(), ['Dockerfile', 'packages/protocol/**', 'packages/server/**'].sort())
  })

  it('dockerFilterEntriesFromCiDoc does not read past the docker: category into a sibling category', () => {
    const ciDoc = {
      jobs: {
        changes: {
          steps: [
            {
              uses: 'dorny/paths-filter@v3',
              with: {
                filters: ['docker:', "  - 'packages/server/**'", 'renovate:', "  - 'packages/should-not-count/**'"].join('\n'),
              },
            },
          ],
        },
      },
    }
    const entries = dockerFilterEntriesFromCiDoc(ciDoc)
    assert.deepEqual(entries, ['packages/server/**'])
  })

  it('a comment inside the nested filters: document is not data (js-yaml strips it, unlike a regex scan)', () => {
    const ciDoc = {
      jobs: {
        changes: {
          steps: [
            {
              uses: 'dorny/paths-filter@v3',
              with: {
                filters: ['docker:', '  # a comment naming packages/should-not-count/**', "  - 'packages/server/**'"].join('\n'),
              },
            },
          ],
        },
      },
    }
    const entries = dockerFilterEntriesFromCiDoc(ciDoc)
    assert.deepEqual(entries, ['packages/server/**'])
  })
})

/**
 * The WIRING, proven against mutated COPIES of the real `.dockerignore` and
 * `ci.yml` — never the real files. Mutant names are OBVIOUSLY FICTIONAL
 * (`zz-mutant-not-a-package`), never a real-looking package name — #8151 is
 * adding real packages to this roster in the same window this PR lands in,
 * and a mutant using a name that could become real is a test that silently
 * changes meaning out from under itself (#8150 review, S4c).
 */
describe('the rule reads the real .dockerignore and ci.yml (mutation proof, #8150)', () => {
  const dirs = []
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  const REAL_WORKFLOWS = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url))
  const REAL_DOCKERIGNORE = fileURLToPath(new URL('../../../.dockerignore', import.meta.url))

  function freshCopy() {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-docker-path-filter-'))
    dirs.push(dir)
    cpSync(REAL_WORKFLOWS, join(dir, 'workflows'), { recursive: true })
    cpSync(REAL_DOCKERIGNORE, join(dir, '.dockerignore'))
    return dir
  }

  function mutate(target, find, replace) {
    const text = readFileSync(target, 'utf8')
    const occurrences = text.split(find).length - 1
    assert.equal(
      occurrences, 1,
      `expected exactly 1 occurrence of ${JSON.stringify(find.slice(0, 80))}, found ${occurrences} — the real file has drifted from what this mutant edits`
    )
    writeFileSync(target, text.replace(find, replace))
  }

  async function loadIssues(dir) {
    const dockerignoreText = readFileSync(join(dir, '.dockerignore'), 'utf8')
    const dockerignore = parseDockerignoreWhitelist(dockerignoreText)
    const workflows = await readWorkflows(pathToFileURL(`${join(dir, 'workflows')}/`))
    const ci = workflows.find((w) => w.name === 'ci.yml')
    assert.ok(ci, 'expected ci.yml among the scanned workflows in the mutated copy')
    const ciDoc = yaml.load(ci.text)
    const entries = dockerFilterEntriesFromCiDoc(ciDoc)
    const filter = bucketDockerFilterEntries(entries)
    return dockerPathFilterIssues(dockerignore, filter)
  }

  it('CONTROL: an unmutated copy agrees', async () => {
    const dir = freshCopy()
    assert.deepEqual(await loadIssues(dir), [])
  })

  it('goes RED when .dockerignore whitelists a new (fictional) package the filter does not know about', async () => {
    const dir = freshCopy()
    mutate(join(dir, '.dockerignore'), '!packages/store-core/dist/\n', '!packages/store-core/dist/\n!packages/zz-mutant-not-a-package/dist/\n')
    const issues = await loadIssues(dir)
    assert.ok(issues.some((i) => /whitelists packages\/zz-mutant-not-a-package\/ but.*no packages\/zz-mutant-not-a-package\/\*\* entry/.test(i)), JSON.stringify(issues))
  })

  it("goes RED when ci.yml's docker filter gains a (fictional) package .dockerignore does not whitelist", async () => {
    const dir = freshCopy()
    // Anchored on the trailing #8151 comment, not the bare store-core line:
    // #8167 added a SECOND `publish_artifacts:` filter category that lists
    // the same three packages (server/protocol/store-core) for an unrelated
    // reason, so the bare line now occurs twice in ci.yml. The comment
    // immediately after it is unique to the `docker:` category, which keeps
    // this mutation landing where it means to.
    mutate(
      join(dir, 'workflows', 'ci.yml'),
      "              - 'packages/store-core/**'\n              # #8151 — the dashboard-builder stage.",
      "              - 'packages/store-core/**'\n              - 'packages/zz-mutant-not-a-package/**'\n              # #8151 — the dashboard-builder stage."
    )
    const issues = await loadIssues(dir)
    assert.ok(issues.some((i) => /docker filter has packages\/zz-mutant-not-a-package\/\*\* but \.dockerignore does not whitelist/.test(i)), JSON.stringify(issues))
  })
})

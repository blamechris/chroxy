import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows } from './helpers/workflow-reader.js'

/**
 * ci.yml's `changes` job hand-mirrors `.dockerignore`'s whitelist in its
 * `docker:` dorny/paths-filter list (#7196's `renovate` roster problem, #8150's
 * review nit N5).
 *
 * THE DEFECT. `.dockerignore` is whitelist-based (`*` excludes everything,
 * then `!packages/<x>/...` re-includes exactly what the image needs), and
 * `ci.yml`'s `docker:` filter lists `packages/server/**`, `packages/protocol/**`
 * and `packages/store-core/**` BY HAND to mirror it — a comment says so, but
 * nothing checks it. A package added to the image (a new `!packages/<x>/`
 * whitelist entry) with no matching filter entry means an edit to that new
 * package's `src/` never triggers `Docker Image Smoke` on the PR that changes
 * it. The reverse gap — a filter entry for a package `.dockerignore` never
 * ships — wastes CI on files that cannot affect the image, and silently
 * masks the day the roster was supposed to shrink instead.
 *
 * THE INVARIANT, checked in BOTH directions (#7639's "a roster checked in
 * only one direction" — the same defect class four separate issues re-filed
 * before anyone read it as a missing invariant, this repo's own memory
 * records): every package `.dockerignore` whitelists has a matching
 * `packages/<x>/**` filter entry, and every `packages/<x>/**` filter entry
 * names a package `.dockerignore` actually whitelists. Every OTHER
 * whitelisted path (`package.json`, `package-lock.json`,
 * `scripts/docker-entrypoint.sh`) is covered by some filter entry too, and
 * `Dockerfile` / `.dockerignore` themselves must be filter entries — an edit
 * to either changes what ships without touching any package tree at all.
 *
 * FLOOR. A parser that silently found zero packages on either side would let
 * every rule below pass over an empty set (docs/false-safety-guards.md's
 * "filter whose terms match nothing" cause, #7503) — asserted directly,
 * never inferred from the real corpus alone.
 */

// ---- the pure rule, over already-parsed text -------------------------------

/**
 * `.dockerignore`'s whitelist (`!`-prefixed re-include lines), split into
 * package directories (`!packages/<x>/...`) and everything else.
 *
 * @param {string} text Raw `.dockerignore` contents.
 * @returns {{packages: Set<string>, paths: Set<string>}}
 */
export function parseDockerignoreWhitelist(text) {
  const packages = new Set()
  const paths = new Set()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!line.startsWith('!')) continue // only a re-include line is a WHITELIST entry
    const entry = line.slice(1)
    const pkgMatch = /^packages\/([^/]+)\//.exec(entry)
    if (pkgMatch) {
      packages.add(pkgMatch[1])
    } else {
      paths.add(entry.replace(/\/$/, ''))
    }
  }
  return { packages, paths }
}

/**
 * A `key:\n  <indent>...` YAML mapping key's block-scalar BODY lines — used
 * here for the dorny/paths-filter step's `filters: |` value, which is itself
 * a nested YAML document as a string. Not a general YAML parser: it collects
 * every line indented deeper than the key until the first line back at or
 * above the key's own indent, which is all a block scalar's body is.
 *
 * @param {string[]} bodyLines
 * @param {string} key
 * @returns {string[]}
 */
function blockScalarBody(bodyLines, key) {
  const keyRe = new RegExp(`^(\\s*)${key}:\\s*\\|\\s*(?:#.*)?$`)
  const at = bodyLines.findIndex((l) => keyRe.test(l))
  assert.notEqual(at, -1, `expected a '${key}: |' key`)
  const keyIndent = keyRe.exec(bodyLines[at])[1].length
  const lines = []
  for (let i = at + 1; i < bodyLines.length; i++) {
    const line = bodyLines[i]
    if (/^\s*$/.test(line)) {
      lines.push('')
      continue
    }
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= keyIndent) break
    lines.push(line)
  }
  return lines
}

/**
 * The `- '<entry>'` list items under one top-level category key (e.g.
 * `docker:`) inside a block-scalar body already extracted by
 * `blockScalarBody`.
 *
 * @param {string[]} blockLines
 * @param {string} category
 * @returns {string[]}
 */
function categoryEntries(blockLines, category) {
  const catRe = new RegExp(`^(\\s*)${category}:\\s*(?:#.*)?$`)
  const at = blockLines.findIndex((l) => catRe.test(l))
  assert.notEqual(at, -1, `expected a '${category}:' category in the filters block`)
  const catIndent = catRe.exec(blockLines[at])[1].length
  const entries = []
  for (let i = at + 1; i < blockLines.length; i++) {
    const line = blockLines[i]
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue // blank/comment: skip, don't end the category
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= catIndent) break
    const m = /^\s*-\s*'([^']*)'/.exec(line)
    if (m) entries.push(m[1])
  }
  return entries
}

/**
 * ci.yml's `changes` job's `docker:` path-filter entries, split into package
 * globs (`packages/<x>/**`) and everything else — the same two buckets
 * `parseDockerignoreWhitelist` produces, so the two sides can be compared
 * directly.
 *
 * @param {string[]} changesJobBody Raw body lines of the `changes` job.
 * @returns {{packages: Set<string>, paths: Set<string>}}
 */
export function parseCiDockerFilter(changesJobBody) {
  const filtersBlock = blockScalarBody(changesJobBody, 'filters')
  const entries = categoryEntries(filtersBlock, 'docker')
  const packages = new Set()
  const paths = new Set()
  for (const e of entries) {
    const m = /^packages\/([^/]+)\/\*\*$/.exec(e)
    if (m) packages.add(m[1])
    else paths.add(e)
  }
  return { packages, paths }
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
 * directly rather than inferred from agreement alone — agreement over two
 * empty sets is not evidence of anything (#7503).
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
    const changesJob = ci.jobs.find((j) => j.id === 'changes')
    assert.ok(changesJob, "expected a 'changes' job in ci.yml")
    filter = parseCiDockerFilter(changesJob.body)
  })

  it('floor: neither side parses to zero packages', () => {
    assertNeitherSideIsEmpty(dockerignore, filter)
  })

  it('CONTROL: the real roster is exactly {server, protocol, store-core} on both sides', () => {
    assert.deepEqual([...dockerignore.packages].sort(), ['protocol', 'server', 'store-core'])
    assert.deepEqual([...filter.packages].sort(), ['protocol', 'server', 'store-core'])
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
    dockerignore.packages.add('store-core')
    const issues = dockerPathFilterIssues(dockerignore, filter)
    assert.ok(issues.some((i) => /whitelists packages\/store-core\/ but.*no packages\/store-core\/\*\* entry/.test(i)), JSON.stringify(issues))
  })

  it('reports a filter entry with no matching .dockerignore whitelist (the OTHER direction)', () => {
    const { dockerignore, filter } = sound()
    filter.packages.add('foo')
    const issues = dockerPathFilterIssues(dockerignore, filter)
    assert.ok(issues.some((i) => /docker filter has packages\/foo\/\*\* but \.dockerignore does not whitelist/.test(i)), JSON.stringify(issues))
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

describe('parseDockerignoreWhitelist / parseCiDockerFilter parse the real shapes (#8150)', () => {
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

  it('parseDockerignoreWhitelist counts each distinct package once even with multiple whitelist lines', () => {
    const text = ['*', '!packages/protocol/package.json', '!packages/protocol/dist/'].join('\n')
    const { packages } = parseDockerignoreWhitelist(text)
    assert.deepEqual([...packages], ['protocol'])
  })

  it('parseCiDockerFilter reads entries past a comment between the category key and the list', () => {
    const body = [
      '        with:',
      '          filters: |',
      '            docker:',
      '              # a comment between the key and its items',
      "              - 'Dockerfile'",
      "              - 'packages/server/**'",
      '            renovate:',
      "              - 'renovate.json'",
    ]
    const { packages, paths } = parseCiDockerFilter(body)
    assert.deepEqual([...packages], ['server'])
    assert.deepEqual([...paths], ['Dockerfile'])
  })

  it('parseCiDockerFilter does not read past the docker: category into a sibling category', () => {
    const body = [
      '          filters: |',
      '            docker:',
      "              - 'packages/server/**'",
      '            renovate:',
      "              - 'packages/should-not-count/**'",
    ]
    const { packages } = parseCiDockerFilter(body)
    assert.deepEqual([...packages], ['server'])
  })
})

/**
 * The WIRING, proven against mutated COPIES of the real `.dockerignore` and
 * `ci.yml` — never the real files.
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
      `expected exactly 1 occurrence of ${JSON.stringify(find.slice(0, 80))}, found ${occurrences} — ` +
        'the real file has drifted from what this mutant edits'
    )
    writeFileSync(target, text.replace(find, replace))
  }

  async function loadIssues(dir) {
    const dockerignoreText = readFileSync(join(dir, '.dockerignore'), 'utf8')
    const dockerignore = parseDockerignoreWhitelist(dockerignoreText)
    const workflows = await readWorkflows(pathToFileURL(`${join(dir, 'workflows')}/`))
    const ci = workflows.find((w) => w.name === 'ci.yml')
    assert.ok(ci, 'expected ci.yml among the scanned workflows in the mutated copy')
    const changesJob = ci.jobs.find((j) => j.id === 'changes')
    assert.ok(changesJob, "expected a 'changes' job in the mutated copy")
    const filter = parseCiDockerFilter(changesJob.body)
    return dockerPathFilterIssues(dockerignore, filter)
  }

  it('CONTROL: an unmutated copy agrees', async () => {
    const dir = freshCopy()
    assert.deepEqual(await loadIssues(dir), [])
  })

  it('goes RED when .dockerignore whitelists a new package the filter does not know about', async () => {
    const dir = freshCopy()
    mutate(join(dir, '.dockerignore'), '!packages/store-core/dist/\n', '!packages/store-core/dist/\n!packages/dashboard/dist/\n')
    const issues = await loadIssues(dir)
    assert.ok(issues.some((i) => /whitelists packages\/dashboard\/ but.*no packages\/dashboard\/\*\* entry/.test(i)), JSON.stringify(issues))
  })

  it('goes RED when ci.yml\'s docker filter gains a package .dockerignore does not whitelist', async () => {
    const dir = freshCopy()
    mutate(
      join(dir, 'workflows', 'ci.yml'),
      "              - 'packages/store-core/**'\n",
      "              - 'packages/store-core/**'\n              - 'packages/foo/**'\n"
    )
    const issues = await loadIssues(dir)
    assert.ok(issues.some((i) => /docker filter has packages\/foo\/\*\* but \.dockerignore does not whitelist/.test(i)), JSON.stringify(issues))
  })
})

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readWorkflows, assertReaderSane } from './helpers/workflow-reader.js'

/**
 * release.yml: every publishing job transitively needs verify-artifacts (#8165).
 *
 * THE DEFECT. `verify-artifacts` packs the npm tarballs, installs them into a
 * throwaway prefix, and runs them — the only check that exercises the ARTIFACT
 * rather than the source tree (#7189). Before this fix, `docker` (which PUSHES
 * to GHCR and moves the floating `:{major}.{minor}` tag) and the two desktop
 * builds needed only `test`, so they ran — and `docker` published — in
 * parallel with verify-artifacts. `github-release` already needed
 * verify-artifacts directly, so a broken artifact still skipped the GitHub
 * Release — but by then the Docker image was already public. A tag push then
 * produces a HALF-shipped release: a new image with no matching release, and
 * nothing about that state gets reported anywhere.
 *
 * THE INVARIANT. Every job that performs an externally-visible, effectively
 * irreversible publish action must have `verify-artifacts` somewhere in its
 * `needs:` closure — directly, or via a job it depends on. "Publishing" is
 * matched STRUCTURALLY, by the action a job's steps actually invoke
 * (`docker/build-push-action`, `softprops/action-gh-release`), not by job id
 * or name — a rename must not silently drop a job out of the check the way a
 * hardcoded id list would (docs/false-safety-guards.md's recurring "a
 * hardcoded list beside a growing set" cause).
 *
 * WHY TRANSITIVE, NOT DIRECT. `github-release` reaches verify-artifacts two
 * ways after this fix — directly, and via `docker`/`desktop-macos`/
 * `desktop-windows`, each of which now also needs it — and the rule must
 * accept either path rather than demanding the gate be listed on every job by
 * name.
 */

// ---- the pure rule, over already-parsed job bodies -------------------------

/**
 * A job's `needs:` list, parsed from its raw body lines. GitHub Actions
 * accepts two spellings, and both must resolve the same way — the same
 * discipline `runsOnOf()` in workflow-reader.js applies to `runs-on:` after
 * the block-form gap in #7383 silently exempted every self-hosted job written
 * that way:
 *
 *     needs: test                    # flow, single job id
 *     needs: [test, verify-artifacts] # flow, list
 *     needs:                          # block
 *       - test
 *       - verify-artifacts
 *
 * @param {string[]} jobBody
 * @returns {string[]}
 */
export function jobNeeds(jobBody) {
  const at = jobBody.findIndex((l) => /^\s*needs:/.test(l))
  if (at === -1) return []
  const keyLine = jobBody[at]
  const inline = keyLine.replace(/^\s*needs:\s*/, '').trim()
  if (inline.length > 0) {
    return inline
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const keyIndent = /^(\s*)/.exec(keyLine)[1].length
  const ids = []
  for (let i = at + 1; i < jobBody.length; i++) {
    const line = jobBody[i]
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const indent = /^(\s*)/.exec(line)[1].length
    if (indent <= keyIndent) break
    const m = /^\s*-\s*(\S+)/.exec(line)
    if (m) ids.push(m[1])
  }
  return ids
}

/** Every job id reachable from `id` by following `needs:` edges, `id` included. */
export function transitiveNeeds(jobsById, id, seen = new Set()) {
  if (seen.has(id)) return seen
  seen.add(id)
  const job = jobsById.get(id)
  if (!job) return seen // a dangling reference is not this rule's subject
  for (const dep of jobNeeds(job.body)) transitiveNeeds(jobsById, dep, seen)
  return seen
}

// Matched by the ACTION a step invokes, not by job id/name — a job renamed
// away from "docker" is still caught, and a job merely named "docker-setup"
// that pushes nothing is not swept in by coincidence.
const PUBLISH_ACTION_RE = /docker\/build-push-action|softprops\/action-gh-release/

/** True when any step line in `job.body` invokes a publish-shaped action. */
export function isPublishingJob(job) {
  return job.body.some((l) => PUBLISH_ACTION_RE.test(l))
}

/**
 * Every publishing job in `jobs` whose `needs:` closure does NOT include
 * `gateId`.
 *
 * @param {{id: string, body: string[]}[]} jobs
 * @param {string} [gateId]
 * @returns {string[]} job ids, empty when the invariant holds
 */
export function publishingJobsMissingGate(jobs, gateId = 'verify-artifacts') {
  const byId = new Map(jobs.map((j) => [j.id, j]))
  return jobs
    .filter(isPublishingJob)
    .filter((j) => !transitiveNeeds(byId, j.id).has(gateId))
    .map((j) => j.id)
}

// ---- the rule, on the real tree --------------------------------------------

describe('release.yml: every publishing job transitively needs verify-artifacts (#8165)', () => {
  let release

  before(async () => {
    const workflows = await readWorkflows()
    // Shared positive control: a broken reader finds nothing, and nothing
    // satisfies every rule below over an empty set.
    assertReaderSane(workflows)
    release = workflows.find((w) => w.name === 'release.yml')
    assert.ok(release, 'expected release.yml among the scanned workflows')
  })

  it('finds a verify-artifacts job to gate against', () => {
    assert.ok(
      release.jobs.some((j) => j.id === 'verify-artifacts'),
      `expected a 'verify-artifacts' job id, found: ${release.jobs.map((j) => j.id).join(', ')}`
    )
  })

  it('CONTROL: isPublishingJob finds the docker and github-release jobs (not the others)', () => {
    const ids = release.jobs.filter(isPublishingJob).map((j) => j.id)
    assert.ok(ids.includes('docker'), `expected 'docker' among publishing jobs, found: ${ids.join(', ')}`)
    assert.ok(ids.includes('github-release'), `expected 'github-release' among publishing jobs, found: ${ids.join(', ')}`)
    assert.ok(!ids.includes('desktop-macos'), "desktop-macos only uploads a CI artifact — it doesn't itself publish")
    assert.ok(!ids.includes('test'), 'test does not publish anything')
  })

  it('every publishing job transitively needs verify-artifacts', () => {
    const missing = publishingJobsMissingGate(release.jobs)
    assert.deepEqual(
      missing,
      [],
      `these jobs publish (docker push / release upload) but do not transitively need ` +
        `verify-artifacts: ${missing.join(', ')} — a release could push/publish before ` +
        `the artifact gate has run (#8165)`
    )
  })
})

/**
 * Each branch of the pure rule proven to REPORT — on the real tree every
 * publishing job is gated, so without these a deleted or broken rule is
 * invisible (docs/false-safety-guards.md: a rule that returns empty because
 * it is broken looks identical to one that returns empty because the tree is
 * clean).
 */
describe('publishingJobsMissingGate reports each shape it exists to find (#8165)', () => {
  it('CONTROL: reports nothing when every publishing job needs the gate directly', () => {
    const jobs = [
      { id: 'test', body: ['    runs-on: ubuntu-24.04'] },
      { id: 'verify-artifacts', body: ['    needs: test'] },
      {
        id: 'docker',
        body: [
          '    needs: [test, verify-artifacts]',
          '      - uses: docker/build-push-action@x',
          '        with:',
          '          push: true',
        ],
      },
    ]
    assert.deepEqual(publishingJobsMissingGate(jobs), [])
  })

  it('reports a publishing job with no path to the gate at all', () => {
    const jobs = [
      { id: 'test', body: [] },
      { id: 'verify-artifacts', body: ['    needs: test'] },
      { id: 'docker', body: ['    needs: test', '      - uses: docker/build-push-action@x'] },
    ]
    assert.deepEqual(publishingJobsMissingGate(jobs), ['docker'])
  })

  it('accepts a TRANSITIVE path through another job (github-release\'s real shape)', () => {
    const jobs = [
      { id: 'test', body: [] },
      { id: 'verify-artifacts', body: ['    needs: test'] },
      { id: 'docker', body: ['    needs: [test, verify-artifacts]'] },
      {
        id: 'github-release',
        body: [
          '    needs: [validate, docker, verify-artifacts]',
          '      - uses: softprops/action-gh-release@x',
        ],
      },
    ]
    assert.deepEqual(publishingJobsMissingGate(jobs), [])
  })

  it('a non-publishing job with no needs at all is never flagged', () => {
    assert.deepEqual(publishingJobsMissingGate([{ id: 'lint', body: ['    runs-on: ubuntu-24.04'] }]), [])
  })

  it('a dangling needs: reference does not throw and still reports the gap', () => {
    const jobs = [{ id: 'docker', body: ['    needs: some-deleted-job', '      - uses: docker/build-push-action@x'] }]
    assert.deepEqual(publishingJobsMissingGate(jobs), ['docker'])
  })
})

describe('jobNeeds parses every needs: spelling GitHub Actions accepts (#8165)', () => {
  it('flow list', () => {
    assert.deepEqual(jobNeeds(['    needs: [test, verify-artifacts]']), ['test', 'verify-artifacts'])
  })
  it('flow single value', () => {
    assert.deepEqual(jobNeeds(['    needs: test']), ['test'])
  })
  it('block sequence', () => {
    assert.deepEqual(
      jobNeeds(['    needs:', '      - test', '      - verify-artifacts']),
      ['test', 'verify-artifacts']
    )
  })
  it('no needs: key at all', () => {
    assert.deepEqual(jobNeeds(['    runs-on: ubuntu-24.04']), [])
  })
  it('a comment between the key and the block items is skipped, not treated as the end', () => {
    assert.deepEqual(
      jobNeeds(['    needs:', '      # kept in dependency order', '      - test', '      - verify-artifacts']),
      ['test', 'verify-artifacts']
    )
  })
})

/**
 * The WIRING, proven against a mutated COPY of the real workflow tree — never
 * the real file. Synthetic cases above prove the rule reports; this proves it
 * is fed the real file and actually goes red on the real regression this
 * issue describes (removing verify-artifacts from docker's needs).
 */
describe('the rule reads the real release.yml (mutation proof, #8165)', () => {
  const dirs = []
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  const REAL = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url))

  it('CONTROL: an unmutated copy is clean', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-release-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    assert.deepEqual(publishingJobsMissingGate(release.jobs), [])
  })

  it('goes RED if verify-artifacts is removed from docker\'s needs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-release-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const target = join(dir, 'release.yml')
    const text = readFileSync(target, 'utf8')
    const find = '    needs: [test, verify-artifacts]\n    runs-on: ubuntu-24.04'
    const occurrences = text.split(find).length - 1
    assert.equal(
      occurrences, 1,
      `expected exactly 1 occurrence of docker's needs+runs-on line, found ${occurrences} — ` +
        "release.yml has drifted from what this case edits and would pass for the wrong reason"
    )
    writeFileSync(target, text.replace(find, '    needs: test\n    runs-on: ubuntu-24.04'))
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    assert.deepEqual(publishingJobsMissingGate(release.jobs), ['docker'])
  })

  it('goes RED on a full reversion to the pre-#8165 graph (both docker and github-release orphaned)', async () => {
    // github-release reaches verify-artifacts two ways after this fix —
    // directly, and transitively via docker/desktop-macos/desktop-windows —
    // so removing just ONE of those edges is not a regression this rule
    // should flag (that redundancy is the point of "transitively"). The real
    // regression this issue describes is the WHOLE pre-fix graph: nobody
    // gated on verify-artifacts except github-release's own direct edge, and
    // docker/desktop-* raced it. Reproduce exactly that shape.
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-release-gate-'))
    dirs.push(dir)
    cpSync(REAL, dir, { recursive: true })
    const target = join(dir, 'release.yml')
    let text = readFileSync(target, 'utf8')
    const edits = [
      ['    needs: [test, verify-artifacts]\n    runs-on: ubuntu-24.04', '    needs: test\n    runs-on: ubuntu-24.04'],
      ['    needs: [test, verify-artifacts]\n    runs-on: macos-latest', '    needs: test\n    runs-on: macos-latest'],
      ['    needs: [test, verify-artifacts]\n    runs-on: windows-latest', '    needs: test\n    runs-on: windows-latest'],
      ['    needs: [validate, docker, desktop-macos, desktop-windows, verify-artifacts]', '    needs: [validate, docker, desktop-macos, desktop-windows]'],
    ]
    for (const [find, replace] of edits) {
      const occurrences = text.split(find).length - 1
      assert.equal(occurrences, 1, `expected exactly 1 occurrence of ${JSON.stringify(find.slice(0, 60))}, found ${occurrences} — release.yml has drifted from what this case edits`)
      text = text.replace(find, replace)
    }
    writeFileSync(target, text)
    const workflows = await readWorkflows(pathToFileURL(`${dir}/`))
    const release = workflows.find((w) => w.name === 'release.yml')
    assert.deepEqual(publishingJobsMissingGate(release.jobs).sort(), ['docker', 'github-release'])
  })
})

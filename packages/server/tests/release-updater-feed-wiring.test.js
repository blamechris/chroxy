import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readWorkflows, stepInput, stepRun } from './helpers/workflow-reader.js'

/**
 * release.yml: the updater feed is built, re-signed and verified in the ORDER
 * that makes it correct (#8906, #8917).
 *
 * The scripts have their own tests (scripts/__tests__/updater-feed.test.mjs);
 * what nothing else pins is the WIRING, which is where this class of bug lives:
 *   - the MSI is Authenticode-signed AFTER the build minisigned it, so the
 *     updater re-sign must come after `Sign MSI` and before the feed is built
 *     from it, and the feed before the artifact upload;
 *   - the merged feed is verified before the release is created, and the
 *     release gate must carry the platform / version requirements.
 * Reordering any of these, or dropping a gate flag, leaves every other check
 * green while the shipped feed is wrong.
 */

const STEP_NAMES = {
  sign: 'Sign MSI (Azure Trusted Signing)',
  resign: 'Re-sign MSI for the updater (after Authenticode)',
  winFeed: 'Write and verify updater feed (Windows)',
  macFeed: 'Write and verify updater feed (macOS)',
  upload: 'Upload artifact',
  merge: 'Merge Tauri updater feeds',
  verify: 'Verify merged updater feed',
  release: 'Create GitHub Release',
}

const names = (job) => job.steps.map((s) => stepInput(s, 'name'))

/** Index of the step called `name` in `job`, or -1. */
const at = (job, name) => names(job).indexOf(name)

/** Pure rule over parsed release jobs: returns a list of problems (empty = wired correctly). */
export function wiringIssues(jobs) {
  const issues = []
  const job = (id) => jobs.find((j) => j.id === id)
  const win = job('desktop-windows')
  const mac = job('desktop-macos')
  const rel = job('github-release')
  for (const [id, j] of [['desktop-windows', win], ['desktop-macos', mac], ['github-release', rel]]) {
    if (!j) issues.push(`job ${id} not found`)
  }
  if (issues.length) return issues

  const order = (j, label, ...stepNames) => {
    const idx = stepNames.map((n) => at(j, n))
    stepNames.forEach((n, i) => { if (idx[i] === -1) issues.push(`${label}: step "${n}" not found`) })
    if (idx.includes(-1)) return
    for (let i = 1; i < idx.length; i++) {
      if (!(idx[i - 1] < idx[i])) issues.push(`${label}: "${stepNames[i - 1]}" must come before "${stepNames[i]}"`)
    }
  }
  order(win, 'desktop-windows', STEP_NAMES.sign, STEP_NAMES.resign, STEP_NAMES.winFeed, STEP_NAMES.upload)
  order(mac, 'desktop-macos', STEP_NAMES.macFeed, STEP_NAMES.upload)
  order(rel, 'github-release', STEP_NAMES.merge, STEP_NAMES.verify, STEP_NAMES.release)

  const verifyAt = at(rel, STEP_NAMES.verify)
  if (verifyAt !== -1) {
    const run = stepRun(rel.steps[verifyAt]) || ''
    for (const needle of ['verify-updater-feed.mjs', '--expect-version', '--require-platform', '--expect-url-prefix']) {
      if (!run.includes(needle)) issues.push(`github-release verify step does not use ${needle}`)
    }
  }
  for (const [label, j, n] of [['desktop-windows', win, STEP_NAMES.winFeed], ['desktop-macos', mac, STEP_NAMES.macFeed]]) {
    const i = at(j, n)
    if (i === -1) continue
    const run = stepRun(j.steps[i]) || ''
    for (const needle of ['build-updater-feed.mjs', 'verify-updater-feed.mjs', '--expect-url-prefix', '--require-signed-version']) {
      if (!run.includes(needle)) issues.push(`${label} feed step does not use ${needle}`)
    }
  }
  return issues
}

describe('release.yml updater feed wiring (#8906, #8917)', () => {
  let jobs
  let yml
  before(async () => {
    const release = (await readWorkflows()).find((w) => w.name === 'release.yml')
    assert.ok(release, 'release.yml should exist')
    jobs = release.jobs
    yml = release.text
  })

  it('is wired in the right order with the gate flags present', () => {
    assert.deepEqual(wiringIssues(jobs), [])
  })

  const mutateAndRead = async (mutate) => {
    const dir = mkdtempSync(join(tmpdir(), 'release-wiring-'))
    try {
      const out = mutate(yml)
      assert.notEqual(out, yml, 'mutation must change the workflow')
      writeFileSync(join(dir, 'release.yml'), out)
      const wf = (await readWorkflows(pathToFileURL(`${dir}/`))).find((w) => w.name === 'release.yml')
      return wiringIssues(wf.jobs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // Swap two whole steps by moving the first block after the second.
  const swapSteps = (text, nameA, nameB) => {
    const lines = text.split('\n')
    const startOf = (n, from = 0) => {
      const i = lines.slice(from).findIndex((l) => l.includes(`- name: ${n}`))
      return i === -1 ? -1 : i + from
    }
    const a = startOf(nameA)
    const b = a === -1 ? -1 : startOf(nameB, a + 1)
    assert.ok(a !== -1 && b !== -1 && a < b, 'steps to swap exist in order')
    const nextStep = (from) => {
      const indent = /^(\s*)/.exec(lines[from])[1].length
      for (let i = from + 1; i < lines.length; i++) {
        const m = /^(\s*)- /.exec(lines[i])
        if (m && m[1].length === indent) return i
        // end of this job: the next job id (2-space) or top-level key
        if (/^ {0,2}\S/.test(lines[i])) return i
      }
      return lines.length
    }
    const aEnd = nextStep(a)
    const bEnd = nextStep(b)
    const blockA = lines.slice(a, aEnd)
    const blockB = lines.slice(b, bEnd)
    return [...lines.slice(0, a), ...blockB, ...lines.slice(aEnd, b), ...blockA, ...lines.slice(bEnd)].join('\n')
  }

  it('goes red when the updater re-sign is moved before Sign MSI', async () => {
    const issues = await mutateAndRead((t) => swapSteps(t, STEP_NAMES.sign, STEP_NAMES.resign))
    assert.ok(issues.some((i) => /must come before/.test(i)), issues.join('\n'))
  })

  it('goes red when the feed is written after the artifact upload', async () => {
    const issues = await mutateAndRead((t) => swapSteps(t, STEP_NAMES.winFeed, `${STEP_NAMES.upload}`))
    assert.ok(issues.some((i) => /must come before/.test(i)), issues.join('\n'))
  })

  it('goes red when the release is created before the merged feed is verified', async () => {
    const issues = await mutateAndRead((t) => swapSteps(t, STEP_NAMES.verify, STEP_NAMES.release))
    assert.ok(issues.some((i) => /github-release/.test(i) && /must come before/.test(i)), issues.join('\n'))
  })

  it('goes red when the release gate drops --require-platform or --expect-version', async () => {
    const noPlatform = await mutateAndRead((t) => t.replaceAll('--require-platform', '--no-such-flag'))
    assert.ok(noPlatform.some((i) => /--require-platform/.test(i)), noPlatform.join('\n'))
    const noVersion = await mutateAndRead((t) => t.replace('--expect-version "${GITHUB_REF_NAME#v}"', ''))
    assert.ok(noVersion.some((i) => /--expect-version/.test(i)), noVersion.join('\n'))
  })

  it('goes red when a desktop feed step stops requiring the url prefix', async () => {
    const issues = await mutateAndRead((t) => t.replaceAll('--expect-url-prefix "${BASE_URL}/"', ''))
    assert.ok(issues.some((i) => /feed step does not use --expect-url-prefix/.test(i)), issues.join('\n'))
  })

  it('goes red when a step is renamed away (not found, never silently skipped)', async () => {
    const issues = await mutateAndRead((t) => t.replace(`- name: ${STEP_NAMES.resign}`, '- name: Something else'))
    assert.ok(issues.some((i) => /not found/.test(i)), issues.join('\n'))
  })
})

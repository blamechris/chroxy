#!/usr/bin/env node
// Tests for scripts/check-release-pr-subject.mjs (#7184).
//
// The cases that matter are the two real incidents: 0.10.0 merged as
// `chore(release): 0.10.0 — …` (no `cut v`, so auto-tag never fired, which is
// the 463-commit untagged gap in #7176), and the near-miss on #7180 titled
// `chore(cli): cut the 0.11.0 release`. Both are pinned below as fixtures.
//
// The negative cases matter just as much: a guard that fires on ordinary PRs
// gets disabled, and one that cannot fire on a release PR is decoration.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-release-pr-subject.mjs')

let passed = 0
let failed = 0
const results = []

function check(name, cond) {
  if (cond) { passed++; results.push(`  PASS  ${name}`) }
  else { failed++; results.push(`  FAIL  ${name}`) }
}

// Build a throwaway repo with a base commit and a head commit whose diff we
// control, so the content-detection half is exercised for real rather than
// stubbed.
function makeRepo({ rootVersionFrom, rootVersionTo, changelogHeading, otherChange, headSubject, extraCommit }) {
  const dir = mkdtempSync(join(tmpdir(), 'relsubj-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'chroxy', version: rootVersionFrom }, null, 2) + '\n')
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- stuff\n')
  writeFileSync(join(dir, 'src.js'), 'export const a = 1\n')
  git('add', 'package.json', 'CHANGELOG.md', 'src.js')
  git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD').trim()

  if (rootVersionTo) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'chroxy', version: rootVersionTo }, null, 2) + '\n')
    git('add', 'package.json')
  }
  if (changelogHeading) {
    writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n## [${changelogHeading}] - 2026-08-15\n\n- stuff\n`)
    git('add', 'CHANGELOG.md')
  }
  if (otherChange) {
    writeFileSync(join(dir, 'src.js'), 'export const a = 2\n')
    git('add', 'src.js')
  }
  // --allow-empty: some fixtures deliberately change nothing (the "ordinary PR"
  // cases), and a fixture builder that throws on those would silently remove
  // the negative controls.
  git('commit', '-q', '--allow-empty', '-m', headSubject || 'head')
  // A second commit flips GitHub from the commit subject to the PR title.
  if (extraCommit) git('commit', '-q', '--allow-empty', '-m', extraCommit)
  return { dir, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function runGuard({ dir, base }, title, number) {
  const args = [SCRIPT, '--title', title, '--base', base, '--head', 'HEAD']
  if (number) args.push('--number', String(number))
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// --- release PRs -------------------------------------------------------------
//
// Each case gets its own repo with the commit subject matching the title under
// test. That models a real single-commit release PR — #7180 was exactly this —
// where GitHub squashes under the COMMIT subject, so both places carry the same
// text and either one being wrong is the failure.
const releaseRepo = (subject) => makeRepo({
  rootVersionFrom: '0.10.0', rootVersionTo: '0.11.0', changelogHeading: '0.11.0',
  headSubject: subject,
})

{
  const repo = releaseRepo('chore(release): cut v0.11.0')
  const good = runGuard(repo, 'chore(release): cut v0.11.0', 7180)
  check('release PR with the correct subject passes', good.code === 0)
  check('  …and says the tag will fire', /will fire and push v0\.11\.0/.test(good.out))
  check('the checked subject includes the (#N) squash suffix', /cut v0\.11\.0 \(#7180\)/.test(good.out))
  repo.cleanup()
}

{
  // The real 0.10.0 subject. This is the regression this guard exists for.
  const repo = releaseRepo('chore(release): 0.10.0 — codex controllable like Claude by default')
  const lost = runGuard(repo, 'chore(release): 0.10.0 — codex controllable like Claude by default', 6619)
  check('release PR with the real 0.10.0 subject FAILS', lost.code === 1)
  check('  …and names the auto-tag workflow', /auto-tag-on-release\.yml/.test(lost.out))
  repo.cleanup()
}

{
  // The near-miss from #7180 before it was retitled.
  const repo = releaseRepo('chore(cli): cut the 0.11.0 release')
  check('release PR titled chore(cli) FAILS',
    runGuard(repo, 'chore(cli): cut the 0.11.0 release', 7180).code === 1)
  repo.cleanup()
}

{
  // Right shape, wrong anchoring — `cut v` is present but not at line start, so
  // auto-tag's anchored parser will not match.
  const repo = releaseRepo('fix: revert chore(release): cut v0.11.0')
  check('subject where the pattern is not at line start FAILS',
    runGuard(repo, 'fix: revert chore(release): cut v0.11.0', 7180).code === 1)
  repo.cleanup()
}

// A version bump with no CHANGELOG promotion is still a release PR.
{
  const repo = makeRepo({ rootVersionFrom: '0.11.0', rootVersionTo: '0.12.0' })
  check('version bump alone is detected as a release PR',
    runGuard(repo, 'chore: bump deps', 1).code === 1)
  repo.cleanup()
}

// A CHANGELOG promotion with no version bump is still a release PR.
{
  const repo = makeRepo({ rootVersionFrom: '0.11.0', changelogHeading: '0.11.0' })
  check('CHANGELOG version heading alone is detected as a release PR',
    runGuard(repo, 'docs: changelog', 1).code === 1)
  repo.cleanup()
}

// --- non-release PRs (the guard must stay quiet) -----------------------------

{
  const repo = makeRepo({ rootVersionFrom: '0.11.0', otherChange: true })
  const r = runGuard(repo, 'fix(server): something unrelated', 1234)
  check('ordinary PR passes untouched', r.code === 0)
  check('  …and says so explicitly', /not a release PR/.test(r.out))
  repo.cleanup()
}

// An [Unreleased] heading is not a version heading — adding one must not trip
// the guard, or every changelog edit becomes a release PR.
{
  const repo = makeRepo({ rootVersionFrom: '0.11.0' })
  const git = (...a) => execFileSync('git', a, { cwd: repo.dir, encoding: 'utf8' })
  writeFileSync(join(repo.dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- a new entry\n- another\n')
  git('add', 'CHANGELOG.md')
  git('commit', '-q', '-m', 'changelog entry')
  check('adding entries under [Unreleased] is not a release PR',
    runGuard(repo, 'docs: add changelog entry', 42).code === 0)
  repo.cleanup()
}

// --- fail-closed on a broken base ref ---------------------------------------
//
// A shallow clone must not silently turn the guard into a no-op.
{
  const repo = makeRepo({ rootVersionFrom: '0.10.0', rootVersionTo: '0.11.0' })
  const r = runGuard({ dir: repo.dir, base: 'refs/does-not-exist' }, 'anything', 1)
  check('an unreachable base ref errors instead of passing', r.code === 2)
  repo.cleanup()
}


// --- argument validation (fail-closed) ---------------------------------------
//
// A flag with a missing value must not read as "provided". Treating it as an
// empty title would let the guard pass a release PR it never checked.
{
  const repo = makeRepo({ rootVersionFrom: '0.10.0', rootVersionTo: '0.11.0' })
  const raw = (extra) => spawnSync(process.execPath, [SCRIPT, ...extra], { cwd: repo.dir, encoding: 'utf8' })

  check('--title with no value exits 2', raw(['--title']).status === 2)
  check('--title followed by another flag exits 2', raw(['--title', '--number', '5']).status === 2)
  check('an empty --title exits 2', raw(['--title', '   ']).status === 2)
  check('a missing --title exits 2', raw(['--base', 'HEAD~1']).status === 2)
  repo.cleanup()
}


// --- squash subject source: commit vs PR title (#7193 review, Critical 1) -----
//
// This repo sets squash_merge_commit_title = COMMIT_OR_PR_TITLE, which GitHub
// resolves to the COMMIT's subject for a single-commit PR and the PR title only
// when there are 2+. #7180 — the real v0.11.0 release — was single-commit, so
// this is the repo's actual pattern. Predicting from the PR title alone made
// the guard pass a release that would not have tagged.
{
  // Single commit, PR title right, commit subject WRONG -> must FAIL.
  const repo = makeRepo({
    rootVersionFrom: '0.10.0', rootVersionTo: '0.11.0',
    headSubject: 'wip: bump some versions',
  })
  const r = runGuard(repo, 'chore(release): cut v0.11.0', 7180)
  check('single-commit PR with a good title but bad COMMIT subject FAILS', r.code === 1)
  check('  …and checks the commit subject, not the title', /from the sole commit's subject/.test(r.out))
  check('  …and says to amend the commit, not retitle', /amend the COMMIT message/.test(r.out))
  repo.cleanup()
}

{
  // Single commit, commit subject right, PR title wrong -> must PASS (the
  // commit is what GitHub uses) but say the two differ.
  const repo = makeRepo({
    rootVersionFrom: '0.10.0', rootVersionTo: '0.11.0',
    headSubject: 'chore(release): cut v0.11.0',
  })
  const r = runGuard(repo, 'some unrelated PR title', 7180)
  check('single-commit PR with a good COMMIT subject passes', r.code === 0)
  check('  …and flags that the title and commit differ', /the PR title and the commit subject differ/.test(r.out))
  repo.cleanup()
}

{
  // Two commits -> GitHub uses the PR title, so a bad commit subject is fine.
  const repo = makeRepo({
    rootVersionFrom: '0.10.0', rootVersionTo: '0.11.0',
    headSubject: 'wip', extraCommit: 'fixup',
  })
  const r = runGuard(repo, 'chore(release): cut v0.11.0', 7180)
  check('multi-commit PR is checked against the PR title', r.code === 0 && /from the PR title \(2 commits\)/.test(r.out))
  repo.cleanup()
}

console.log('\ncheck-release-pr-subject.mjs')
console.log(results.join('\n'))
console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)

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
function makeRepo({ rootVersionFrom, rootVersionTo, changelogHeading, otherChange }) {
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
  git('commit', '-q', '--allow-empty', '-m', 'head')
  return { dir, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function runGuard({ dir, base }, title, number) {
  const args = [SCRIPT, '--title', title, '--base', base, '--head', 'HEAD']
  if (number) args.push('--number', String(number))
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// --- release PRs -------------------------------------------------------------

{
  const repo = makeRepo({ rootVersionFrom: '0.10.0', rootVersionTo: '0.11.0', changelogHeading: '0.11.0' })

  const good = runGuard(repo, 'chore(release): cut v0.11.0', 7180)
  check('release PR with the correct subject passes', good.code === 0)
  check('  …and says the tag will fire', /will fire and push v0\.11\.0/.test(good.out))

  // The real 0.10.0 subject. This is the regression this guard exists for.
  const lost = runGuard(repo, 'chore(release): 0.10.0 — codex controllable like Claude by default', 6619)
  check('release PR with the real 0.10.0 subject FAILS', lost.code === 1)
  check('  …and names the auto-tag workflow', /auto-tag-on-release\.yml/.test(lost.out))

  // The near-miss from #7180 before it was retitled.
  const nearMiss = runGuard(repo, 'chore(cli): cut the 0.11.0 release', 7180)
  check('release PR titled chore(cli) FAILS', nearMiss.code === 1)

  // Right shape, wrong scope — `cut v` is present but the subject does not
  // start with it, so auto-tag's anchored parser will not match.
  const notAnchored = runGuard(repo, 'fix: revert chore(release): cut v0.11.0', 7180)
  check('subject where the pattern is not at line start FAILS', notAnchored.code === 1)

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

// --- the (#N) suffix ---------------------------------------------------------
//
// The squash subject carries ` (#N)`. A guard that checks the bare title would
// pass a subject the real merge then fails on, so the suffix is asserted.
{
  const repo = makeRepo({ rootVersionFrom: '0.10.0', rootVersionTo: '0.11.0' })
  const r = runGuard(repo, 'chore(release): cut v0.11.0', 7180)
  check('the checked subject includes the (#N) squash suffix', /cut v0\.11\.0 \(#7180\)/.test(r.out))
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

console.log('\ncheck-release-pr-subject.mjs')
console.log(results.join('\n'))
console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
process.exit(failed ? 1 : 0)

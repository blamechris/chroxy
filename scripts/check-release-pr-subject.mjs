#!/usr/bin/env node
// check-release-pr-subject.mjs — fail a release PR whose subject would not fire
// the auto-tag workflow (#7184).
//
// `.github/workflows/auto-tag-on-release.yml` pushes the release tag on merge
// and then dispatches release.yml. It fires only when the merge commit message
// carries a line matching `^chore\(release\): cut vX.Y.Z`. If a release PR is
// merged under any other subject, the job's `if:` is false, the job never runs,
// and NOTHING reports a problem — no tag, no GitHub release, no artifacts, and
// a green check mark on the PR.
//
// That has now cost two releases:
//   - #4627: v0.9.13-v0.9.19 merged, tags never pushed by hand. This workflow
//     was built to fix that.
//   - 0.10.0: merged as `chore(release): 0.10.0 — codex controllable like
//     Claude by default`. No `cut v`, so the guard never matched. That is the
//     origin of the 463-commit untagged gap in #7176.
//
// The check is deliberately CONTENT-triggered, not subject-triggered. Keying it
// to the subject would be circular: the exact failure is a release PR whose
// subject is wrong, so a subject-keyed check cannot fire on the case it exists
// to catch. Instead it asks "does this diff look like a release?" and only then
// demands the subject.
//
// Usage:
//   node scripts/check-release-pr-subject.mjs --title "<pr title>" --number <n> \
//        [--base origin/main] [--head HEAD]
//
// Exit 0 = not a release PR, or a release PR with a subject that will tag.
// Exit 1 = a release PR whose subject will NOT tag.

import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const title = arg('title')
const number = arg('number')
const base = arg('base', 'origin/main')
const head = arg('head', 'HEAD')

if (title === null) {
  console.error('Error: --title is required')
  process.exit(2)
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' })

// --- 1. Is this a release PR? ------------------------------------------------
//
// Two independent signals, either of which is sufficient. Two rather than one
// because a release could in principle be split, and a check that misses the
// release is worse than one that occasionally asks a non-release PR to explain
// itself (that case is a one-line title fix, not a wrong tag).

const reasons = []

// (a) the root package.json's `version` field changed. scripts/bump-version.sh
//     always touches it, so this is the most reliable marker.
let rootDiff = ''
try {
  rootDiff = git('diff', `${base}...${head}`, '--unified=0', '--', 'package.json')
} catch {
  // A missing base ref (shallow clone) must not silently disable the guard.
  console.error(`Error: could not diff ${base}...${head} — cannot determine whether this is a release PR.`)
  console.error('       Fetch the base ref (fetch-depth: 0) so this check can run.')
  process.exit(2)
}
const versionLine = /^[+-]\s*"version":\s*"(\d+\.\d+\.\d+)"/gm
const bumped = [...rootDiff.matchAll(versionLine)].map((m) => m[1])
if (bumped.length) reasons.push(`root package.json version changed (${[...new Set(bumped)].join(' -> ')})`)

// (b) CHANGELOG.md gained a dated version heading — the promotion of
//     [Unreleased] that every release does.
let changelogDiff = ''
try {
  changelogDiff = git('diff', `${base}...${head}`, '--unified=0', '--', 'CHANGELOG.md')
} catch { /* CHANGELOG may legitimately be untouched */ }
const heading = /^\+##\s*\[(\d+\.\d+\.\d+)\]/gm
const promoted = [...changelogDiff.matchAll(heading)].map((m) => m[1])
if (promoted.length) reasons.push(`CHANGELOG.md promoted a version heading ([${promoted.join('], [')}])`)

if (!reasons.length) {
  console.log('not a release PR (no root version bump, no CHANGELOG version heading) — nothing to check')
  process.exit(0)
}

console.log('This looks like a release PR:')
for (const r of reasons) console.log(`  - ${r}`)

// --- 2. Would the merge commit fire the auto-tag job? ------------------------
//
// Checked against the message a SQUASH merge actually produces — the PR title
// with a ` (#N)` suffix — not the bare title. Getting that suffix wrong is how
// a check like this passes while the real merge does not match.

const AUTO_TAG_RE = /^chore\(release\): cut v\d+\.\d+\.\d+(\s|$)/
const GUARD_SUBSTRING = 'chore(release): cut v' // auto-tag's `if:` contains() test

const squashSubject = number ? `${title} (#${number})` : title
console.log(`\nSquash-merge subject would be:\n  ${squashSubject}`)

const matchesParser = AUTO_TAG_RE.test(squashSubject)
const matchesGuard = squashSubject.includes(GUARD_SUBSTRING)

if (matchesParser && matchesGuard) {
  const version = squashSubject.match(/v(\d+\.\d+\.\d+)/)[1]
  console.log(`\nOK — auto-tag-on-release.yml will fire and push v${version}.`)
  process.exit(0)
}

console.error(`
FAIL — this release PR's subject will NOT trigger auto-tag-on-release.yml.

  .github/workflows/auto-tag-on-release.yml gates on:
    if:  contains(github.event.head_commit.message, '${GUARD_SUBSTRING}')   -> ${matchesGuard}
    parser: ${AUTO_TAG_RE}   -> ${matchesParser}

If this merges as-is, the tag job silently does not run: no tag, no GitHub
release, no Docker or desktop artifacts — and a green check mark. That is
exactly how 0.10.0 was lost (#7176) and #4627 before it.

Fix: retitle the PR to

  chore(release): cut vX.Y.Z

If this is genuinely NOT a release PR, it changed the root package.json version
or promoted a CHANGELOG version heading, which is what release PRs do — say so
in the PR and adjust the diff, or the tag automation cannot be trusted.
`)
process.exit(1)

#!/usr/bin/env node
// verify-publish-artifacts.mjs — pack the npm-published packages, install them
// into a throwaway prefix, and prove they actually run before anyone publishes.
//
// Why this exists (#7189, after #7187).
//
// Three separate defects shipped or nearly shipped through every existing
// check, because every existing check tests the SOURCE TREE and none of them
// test the ARTIFACT:
//
//   1. @chroxy/server declared its siblings "*", which resolves to the latest
//      PUBLISHED version — so a current server paired with a two-month-old
//      protocol and died at ESM link time on a missing export.
//   2. @chroxy/protocol shipped no dist/*.js at all: it has no `files` field
//      and no .npmignore, so npm fell back to .gitignore, which ignores dist/.
//      31 built files were silently dropped from the tarball.
//   3. @chroxy/store-core shipped 59 raw *.test.ts files and a root export
//      pointing at src/index.ts, which Node refuses to load from node_modules.
//
// Every one of them installed fine and failed on first import. Unit tests,
// lint, typecheck, and CI were all green throughout. The only thing that
// catches this class is packing the tarball and running it, which is what this
// script does.
//
// npm publishes are irreversible (no republish of a version, no unpublish
// after 72h), so this runs BEFORE the publish, not after.
//
// Usage:
//   node scripts/verify-publish-artifacts.mjs           # pack from the working tree
//   node scripts/verify-publish-artifacts.mjs --keep    # leave the temp dir for inspection
//
// Exit code 0 = the artifacts are safe to publish. Non-zero = do not publish.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyDoctorOutput } from './lib/classify-doctor-output.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP = process.argv.includes('--keep')

// The three packages that go to npm, in dependency order. store-core publishes
// from a staging dir (see packages/store-core/scripts/build-publish-dir.mjs):
// its in-repo manifest points `.` at src/index.ts for the ~148 app/dashboard
// files that import it as TypeScript, which is not publishable as-is.
const PACKAGES = [
  { name: '@chroxy/protocol', packFrom: null },
  { name: '@chroxy/store-core', packFrom: 'packages/store-core/publish', build: 'build:publish' },
  { name: '@chroxy/server', packFrom: null },
]

// Every entry point the published manifests promise, DERIVED from the manifests
// rather than listed here. A hardcoded list is the same defect class this script
// exists to catch: it silently stops covering an export the moment someone adds
// one, so the gate keeps reporting full coverage it no longer has. (The first
// draft of this file hardcoded four and missed @chroxy/protocol/schemas and
// /handler-coverage — caught in review, hence this.)
//
// `packFrom` matters here: store-core's PUBLISHED manifest lives in its staging
// dir and differs from the in-repo one, so the exports are read from whichever
// manifest actually ships.
function entryPointsFor(pkg) {
  const manifestDir = pkg.packFrom ? join(ROOT, pkg.packFrom) : join(ROOT, 'packages', pkg.name.split('/')[1])
  const manifest = JSON.parse(readFileSync(join(manifestDir, 'package.json'), 'utf8'))
  const exportsField = manifest.exports
  // No exports map means the single `main` entry, addressed by bare name.
  if (!exportsField || typeof exportsField === 'string') return [pkg.name]
  return Object.keys(exportsField)
    .filter((k) => k.startsWith('.'))
    .map((k) => (k === '.' ? pkg.name : `${pkg.name}/${k.replace(/^\.\//, '')}`))
}

const log = (m) => console.log(m)
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts })

let failures = 0
const fail = (msg) => { failures++; console.error(`  FAIL  ${msg}`) }
const pass = (msg) => log(`  ok    ${msg}`)

const work = mkdtempSync(join(tmpdir(), 'chroxy-publish-verify-'))
const prefix = join(work, 'prefix')
const home = join(work, 'home')
const consumer = join(work, 'consumer')
for (const d of [prefix, home, consumer]) run('mkdir', ['-p', d])

// A clean HOME matters: `chroxy doctor` reads ~/.chroxy, and a developer's real
// config can mask a packaging problem by supplying something the tarball failed
// to ship.
const env = { ...process.env, npm_config_prefix: prefix, HOME: home }

try {
  log(`\nverify-publish-artifacts — staging in ${work}\n`)

  log('1. building publishable trees')
  run('npm', ['run', 'build', '-w', '@chroxy/protocol'], { cwd: ROOT, stdio: 'inherit' })
  for (const p of PACKAGES.filter((p) => p.build)) {
    run('npm', ['run', p.build, '-w', p.name], { cwd: ROOT, stdio: 'inherit' })
  }

  log('\n2. packing tarballs')
  const tarballs = []
  for (const p of PACKAGES) {
    const cwd = p.packFrom ? join(ROOT, p.packFrom) : ROOT
    const args = p.packFrom ? ['pack', '--pack-destination', work] : ['pack', '-w', p.name, '--pack-destination', work]
    const out = run('npm', args, { cwd }).trim().split('\n').pop().trim()
    const tgz = join(work, out)
    if (!existsSync(tgz)) throw new Error(`npm pack did not produce ${tgz} for ${p.name}`)
    tarballs.push(tgz)
    log(`  packed ${p.name} -> ${out}`)
  }

  // A tarball that ships the test suite is not a break, but it is a signal the
  // `files` allowlist has drifted — which is how defect (2) above started.
  log('\n3. tarball hygiene')
  for (const tgz of tarballs) {
    const listing = run('tar', ['tzf', tgz]).split('\n')
    const tests = listing.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))
    const name = tgz.split('/').pop()
    if (tests.length) fail(`${name} ships ${tests.length} test file(s) — check the "files" allowlist`)
    else pass(`${name} ships no test files (${listing.filter(Boolean).length} files)`)
  }

  log('\n4. installing into a clean prefix')
  run('npm', ['install', '-g', ...tarballs], { cwd: work, env, stdio: 'inherit' })

  log('\n5. the CLI runs')
  const bin = join(prefix, 'bin', 'chroxy')
  if (!existsSync(bin)) {
    fail('chroxy binary was not linked into the prefix')
  } else {
    try {
      const v = run(bin, ['--version'], { env }).trim()
      const expected = JSON.parse(run('node', ['-p', "JSON.stringify(require('./packages/server/package.json'))"], { cwd: ROOT })).version
      if (v === expected) pass(`chroxy --version reports ${v}`)
      else fail(`chroxy --version reported "${v}", expected "${expected}"`)
    } catch (err) {
      fail(`chroxy --version did not run: ${String(err.stderr || err.message).split('\n')[0]}`)
    }
    // #8165: `chroxy doctor` ALWAYS fails two required binary checks on the
    // hosted release runner (ubuntu-24.04 has neither `cloudflared` nor the
    // default claude-tui provider's `claude`), so requiring doctor's own
    // "All checks passed" line made this gate permanently red for a reason
    // unrelated to whether the package we just installed actually works.
    // spawnSync (not execFileSync/run) so a nonzero exit is data, not a
    // throw — doctor's real output is what tells us whether the failure is
    // one of those two known-missing binaries or something that actually
    // matters. See classify-doctor-output.mjs for the pass/fail contract.
    const doctorResult = spawnSync(bin, ['doctor'], { env, encoding: 'utf8' })
    // `.error` is set when the process never launched at all (e.g. ENOENT) —
    // stdout/stderr are then empty, so fold it in or the diagnostic below
    // would print nothing useful about why.
    const doctorOutput = `${doctorResult.stdout || ''}${doctorResult.stderr || ''}${doctorResult.error ? `\n${doctorResult.error}` : ''}`
    const verdict = classifyDoctorOutput(doctorOutput)
    if (verdict.ok) {
      pass('chroxy doctor came up clean (Node.js + Dependencies OK; any other FAIL was a binary this runner never installs)')
    } else {
      fail(`chroxy doctor: ${verdict.reasons.join('; ')}`)
      console.error(`\n  ----- chroxy doctor output -----\n${doctorOutput.split('\n').map((l) => `  ${l}`).join('\n')}\n  --------------------------------\n`)
    }
  }

  // The CLI starting does NOT prove the library entry points resolve — the
  // server only imports a subset. Defect (3) left @chroxy/store-core's root
  // export unloadable while `chroxy doctor` passed, so each one is imported
  // from a from-scratch consumer project.
  log('\n6. every declared entry point imports')
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'verify-consumer', version: '1.0.0', private: true, type: 'module' }, null, 2))
  const libs = tarballs.filter((t) => !t.includes('chroxy-server-'))
  run('npm', ['install', ...libs], { cwd: consumer, env, stdio: 'ignore' })
  const entryPoints = PACKAGES
    .filter((p) => p.name !== '@chroxy/server') // a bin, not a library — covered by step 5
    .flatMap(entryPointsFor)
  log(`  (derived from the published manifests: ${entryPoints.join(', ')})`)
  for (const spec of entryPoints) {
    try {
      const n = run('node', ['--input-type=module', '-e',
        `import(${JSON.stringify(spec)}).then(m => console.log(Object.keys(m).length))`,
      ], { cwd: consumer, env }).trim()
      if (Number(n) > 0) pass(`import("${spec}") → ${n} exports`)
      else fail(`import("${spec}") resolved but exported nothing`)
    } catch (err) {
      fail(`import("${spec}") threw: ${String(err.stderr || err.message).split('\n').find((l) => /Error|error:/.test(l)) || 'unknown'}`)
    }
  }

  log('')
  if (failures) {
    console.error(`verify-publish-artifacts: ${failures} check(s) FAILED — do not publish\n`)
    process.exitCode = 1
  } else {
    log('verify-publish-artifacts: all checks passed — artifacts are safe to publish\n')
  }
} finally {
  if (KEEP) log(`(--keep) staging left at ${work}`)
  else rmSync(work, { recursive: true, force: true })
}

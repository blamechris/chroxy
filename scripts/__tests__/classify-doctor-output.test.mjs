#!/usr/bin/env node
// Tests for scripts/lib/classify-doctor-output.mjs (#8165).
//
// `verify-publish-artifacts.mjs` used to require `chroxy doctor`'s own "All
// checks passed" line and let a nonzero exit throw, which meant the release
// gate could never pass on the hosted runner: ubuntu-24.04 has neither
// `cloudflared` nor the default claude-tui provider's `claude` binary, so
// doctor always reports two FAILs there. `classifyDoctorOutput` is the pure
// classifier that replaces that all-or-nothing check — these are its cases.
//
// Every case below must run. A harness whose cases stop executing reports
// "N passed, 0 failed" and looks identical to a genuinely clean run — the
// same defect class as #7653/#7400 in docs/false-safety-guards.md — so
// EXPECTED_CASES is asserted equal, not >=, the same guard
// check-release-pr-subject.test.mjs uses.

import { classifyDoctorOutput } from '../lib/classify-doctor-output.mjs'

const EXPECTED_CASES = 16

let passed = 0
let failed = 0
const results = []

function check(name, cond) {
  if (cond) { passed++; results.push(`  PASS  ${name}`) }
  else { failed++; results.push(`  FAIL  ${name}`) }
}

// doctor-cmd.js's own status badges (STATUS_ICONS) and row template
// (`  [${icon}] ${name.padEnd(18)} ${message}`) — reproduced here so every
// synthetic fixture below is generated the same way doctor-cmd.js prints a
// real row, rather than a hand-typed guess at the format.
const ICONS = { pass: '\x1b[32m OK \x1b[0m', warn: '\x1b[33mWARN\x1b[0m', fail: '\x1b[31mFAIL\x1b[0m' }
const row = (status, name, message) => `  [${ICONS[status]}] ${name.padEnd(18)} ${message}`
const providerRow = (status, name, message) => `    [${ICONS[status]}] ${name.padEnd(18)} ${message}`

const HEADER = '\nChroxy Doctor\n'

function doc(...lines) {
  return `${HEADER}\n${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Vacuous-input guard — a classifier that can be fed nothing and still
// report "ok" is worse than no guard at all (docs/false-safety-guards.md,
// "a check that denies nothing" is the FALSE-PASS mirror of that entry).
// ---------------------------------------------------------------------------

check('empty string is not ok', classifyDoctorOutput('').ok === false)
check('whitespace-only output is not ok', classifyDoctorOutput('   \n  \n').ok === false)
check('non-string input is not ok', classifyDoctorOutput(undefined).ok === false)
check('non-string input (null) is not ok', classifyDoctorOutput(null).ok === false)

// ---------------------------------------------------------------------------
// The header requirement — doctor must have demonstrably run.
// ---------------------------------------------------------------------------

{
  const crash = 'node:internal/modules/cjs/loader:1433\n  throw err;\nError: Cannot find module\n'
  const r = classifyDoctorOutput(crash)
  check('output missing the "Chroxy Doctor" header is not ok', r.ok === false)
  check('  …and says so (not just "some row missing")', r.reasons.some((m) => /Chroxy Doctor/.test(m)))
}

// ---------------------------------------------------------------------------
// The real case this script exists for: Node.js + Dependencies OK, and the
// ONLY FAILs are the two binaries that are never on the hosted runner
// (cloudflared, and the default claude-tui provider's claude) — must pass.
// This stands in for "good tarball plus missing binaries passes": once the
// tarball installed cleanly, doctor's own binary checks are the only thing
// standing between this gate and green on ubuntu-24.04.
// ---------------------------------------------------------------------------

{
  const output = doc(
    row('pass', 'Node.js', 'v22.9.0'),
    row('fail', 'cloudflared', 'Not found — see https://pkg.cloudflare.com/ for installation'),
    row('warn', 'Config', "Not found — run 'chroxy init' to create"),
    row('pass', 'Config/state root', '/root/.chroxy'),
    row('pass', 'Billing', "Default provider 'claude-tui' — Included (subscription)"),
    row('pass', 'Dependencies', 'resolved via /work/node_modules/commander/index.js'),
    row('pass', 'Port', '8765 is available'),
    '',
    '  Provider: claude-tui',
    providerRow('fail', 'claude', 'Not found — install Claude Code CLI'),
  )
  const r = classifyDoctorOutput(output)
  check('missing-binaries-only run (cloudflared + provider claude) is ok', r.ok === true)
  check('  …with no reasons reported', r.reasons.length === 0)
}

// A byte-for-byte capture from `node packages/server/src/cli.js doctor` run
// inside a `node:22` container with no cloudflared/claude on PATH (#8165
// reproduction) — proves the classifier against doctor's REAL output, not
// just a hand-built approximation of its format.
const REAL_CAPTURED_OUTPUT = "\nChroxy Doctor\n\n  [\u001b[32m OK \u001b[0m] Node.js            v22.23.2\n  [\u001b[31mFAIL\u001b[0m] cloudflared        Not found — see https://pkg.cloudflare.com/ for installation\n  [\u001b[33mWARN\u001b[0m] Config             Not found — run 'chroxy init' to create\n  [\u001b[32m OK \u001b[0m] Config/state root  /root/.chroxy\n  [\u001b[33mWARN\u001b[0m] Credential storage file fallback — Linux secret service (secret-tool/libsecret) is unavailable — credentials fell back to the 0600 file — fix: ensure libsecret/`secret-tool` and a running secret service (e.g. gnome-keyring) are available, then re-store with `chroxy init`\n  [\u001b[32m OK \u001b[0m] Billing            Default provider 'claude-tui' — Included (subscription) — no per-turn dollar charge. Programmatic-credit cutover: 2026-06-15.\n  [\u001b[32m OK \u001b[0m] Dependencies       resolved via /work/node_modules/commander/index.js\n  [\u001b[32m OK \u001b[0m] Port               8765 is available\n\n  Provider: claude-tui\n    [\u001b[31mFAIL\u001b[0m] claude             Not found — install Claude Code CLI\n\nSome checks failed. Fix the issues above and try again.\n\n"

{
  const r = classifyDoctorOutput(REAL_CAPTURED_OUTPUT)
  check('real captured hosted-runner-shaped doctor output is ok', r.ok === true)
}

// ---------------------------------------------------------------------------
// Any FAIL that is NOT a "binary not installed" row must still fail the
// gate — this is the whole point of the fix (a permissive fallback that
// tolerates any FAIL would defeat the gate entirely).
// ---------------------------------------------------------------------------

{
  const output = doc(
    row('pass', 'Node.js', 'v22.9.0'),
    row('pass', 'Dependencies', 'resolved via /work/node_modules/commander/index.js'),
    row('fail', 'Port', '8765 is in use and could not be freed'),
  )
  const r = classifyDoctorOutput(output)
  check('a non-binary FAIL row (Port) fails the gate', r.ok === false)
  check('  …and names the offending row', r.reasons.some((m) => /Port/.test(m)))
}

// The disambiguation this classifier exists to get right: the Config/state
// root drift check (doctor.js #7240) ALSO starts its message with
// "Not found" — "Not found at <path> — it is still at <source>" — but with
// a different shape (no em dash right after "found") than a missing-binary
// row's "Not found — <installHint>". A naive substring match on "Not found"
// would wrongly tolerate a stranded config directory, which is a real defect
// having nothing to do with a runner missing an optional binary.
{
  const output = doc(
    row('pass', 'Node.js', 'v22.9.0'),
    row('pass', 'Dependencies', 'resolved via /work/node_modules/commander/index.js'),
    row('fail', 'Config/state root', 'Not found at /root/.chroxy/config.json — it is still at /home/user/.chroxy/config.json'),
  )
  const r = classifyDoctorOutput(output)
  check('a "Not found at <path>" config-drift FAIL is NOT tolerated as a binary miss', r.ok === false)
}

// ---------------------------------------------------------------------------
// The two required-OK rows are each independently enforced.
// ---------------------------------------------------------------------------

{
  const output = doc(
    row('warn', 'Node.js', 'v24.1.0 — Node 22 is recommended'),
    row('pass', 'Dependencies', 'resolved via /work/node_modules/commander/index.js'),
  )
  const r = classifyDoctorOutput(output)
  check('Node.js WARN (not OK) fails the gate even with nothing else wrong', r.ok === false)
}

{
  const output = doc(
    row('pass', 'Node.js', 'v22.9.0'),
    row('fail', 'Dependencies', 'node_modules not found — run npm install'),
  )
  const r = classifyDoctorOutput(output)
  check('Dependencies FAIL fails the gate (not a binary-miss shape)', r.ok === false)
}

{
  const output = doc(row('pass', 'Node.js', 'v22.9.0'))
  const r = classifyDoctorOutput(output)
  check('a missing Dependencies row entirely fails the gate', r.ok === false)
  check('  …and says which required row is missing', r.reasons.some((m) => /Dependencies/.test(m)))
}

console.log('\nclassify-doctor-output.mjs')
console.log(results.join('\n'))
console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
const ran = passed + failed
if (ran !== EXPECTED_CASES) {
  console.log(`HARNESS BROKEN: ran ${ran} cases, expected ${EXPECTED_CASES} — a case stopped executing`)
  process.exit(1)
}
process.exit(failed ? 1 : 0)

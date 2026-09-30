// classify-doctor-output.mjs — decide whether a captured `chroxy doctor` run
// is a pass for release-gate purposes, without requiring "All checks passed"
// (#8165).
//
// Why this exists: `verify-publish-artifacts.mjs` used to require doctor's
// own summary line and let a nonzero exit throw via execFileSync, discarding
// doctor's real output. On the hosted release runner (ubuntu-24.04), doctor
// ALWAYS fails two required binary checks — `cloudflared` and the default
// claude-tui provider's `claude` — because the runner image has neither. That
// makes the gate permanently red for a reason that has nothing to do with
// whether the published artifact actually works, and the `did not run`
// message actively hides the real doctor output that would show that.
//
// This module is the pure classifier: given doctor's captured stdout+stderr,
// decide pass/fail against a narrower, artifact-relevant contract:
//   - doctor must have actually run (the "Chroxy Doctor" header must appear —
//     "cannot verify this ran" and "it ran and passed" must not look alike,
//     see docs/false-safety-guards.md).
//   - the Node.js and Dependencies rows — the two checks that speak to
//     whether THIS package installed correctly — must be OK.
//   - every other FAIL row is tolerated ONLY when it is a missing-binary row
//     (cloudflared, or a provider CLI) — `checkBinary()` in
//     packages/server/src/doctor.js reports that shape as
//     `Not found — <installHint>` (note the em dash) for every required
//     binary it cannot resolve. Any other FAIL — a bad Node version, a
//     genuinely broken Dependencies row, a provenance refusal, a shell-shim
//     mismatch, a malformed config — still fails the gate.
//
// No spawning here — this only classifies a string. Kept pure and exported so
// it is unit-testable without a container. See
// scripts/__tests__/classify-doctor-output.test.mjs.

// Strips ANSI SGR sequences (`\x1b[32m`, `\x1b[0m`, ...) — doctor-cmd.js
// colors every `[ OK ]`/`[WARN]`/`[FAIL]` badge, and a captured child-process
// stdout keeps those escapes even though this isn't a TTY.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g

// The exact row names doctor-cmd.js prints for the two checks that speak to
// whether the package we just installed is itself healthy. Every other row
// (Config, Billing, Port, Credential storage, provider binaries, ...) is
// either advisory or is allowed to fail for the "binary not installed on
// this runner" reason handled separately below.
const REQUIRED_OK_ROWS = ['Node.js', 'Dependencies']

// `checkBinary()` (packages/server/src/doctor.js) reports a missing required
// binary as `Not found — ${installHint}` — literally that text, with an em
// dash (U+2014) on both sides of "found". This is deliberately NOT a loose
// substring match on "Not found": the Config/state-root drift check
// (doctor.js) reports a DIFFERENT condition as `Not found at ${path} — ...`,
// which must NOT be tolerated here — a stranded config directory is a real
// defect, not a "binary isn't installed on this runner" case.
const BINARY_NOT_FOUND_MARK = 'Not found — '

function stripAnsi(input) {
  return input.replace(ANSI_ESCAPE_RE, '')
}

// Matches one printed check row, general or per-provider (doctor-cmd.js
// indents provider rows two spaces deeper under a "Provider: <name>"
// heading; both are handled since we trim leading whitespace first):
//   [ OK ] Node.js            v22.9.0
//   [FAIL] claude             Not found — install claude
// Group 1 is the 4-character badge, trimmed to OK/WARN/FAIL. Group 2 is
// EVERYTHING after the badge — `name.padEnd(18)` + ' ' + message — left
// intact rather than split, because a name at or past the 18-column pad
// (e.g. "claude-tui driving", "Tunnel routability") collapses to a single
// separating space indistinguishable from a space inside the message. Every
// check below only needs "does this row's remainder start with/contain X",
// which doesn't require that split.
const ROW_RE = /^\[( OK |WARN|FAIL)\]\s+(.*)$/

/**
 * Classify a captured `chroxy doctor` run for the publish-verification gate.
 *
 * @param {string} rawOutput - doctor's captured stdout (+ stderr, if any),
 *   exactly as spawned — ANSI codes and all.
 * @returns {{ ok: boolean, reasons: string[], rows: {status: string, rest: string}[] }}
 *   `ok` is true only when doctor demonstrably ran and nothing outside the
 *   tolerated "binary not installed on this runner" shape failed. `reasons`
 *   is empty iff `ok`. `rows` is the parsed check list, mostly for callers
 *   that want to print doctor's own detail on failure.
 */
export function classifyDoctorOutput(rawOutput) {
  if (typeof rawOutput !== 'string' || stripAnsi(rawOutput).trim().length === 0) {
    return { ok: false, reasons: ['doctor produced no output (empty or non-string) — it did not demonstrably run'], rows: [] }
  }

  const clean = stripAnsi(rawOutput)

  if (!/Chroxy Doctor/.test(clean)) {
    return {
      ok: false,
      reasons: ['doctor output is missing the "Chroxy Doctor" header — the command likely did not run (crashed, wrong binary, etc.)'],
      rows: [],
    }
  }

  const rows = []
  for (const line of clean.split('\n')) {
    const m = line.trimStart().match(ROW_RE)
    if (m) rows.push({ status: m[1].trim(), rest: m[2] })
  }

  const reasons = []

  for (const name of REQUIRED_OK_ROWS) {
    const row = rows.find((r) => r.rest === name || r.rest.startsWith(`${name} `))
    if (!row) {
      reasons.push(`missing required "${name}" row in doctor output`)
    } else if (row.status !== 'OK') {
      reasons.push(`"${name}" row is ${row.status}, not OK: ${row.rest}`)
    }
  }

  for (const row of rows) {
    if (row.status !== 'FAIL') continue
    if (row.rest.includes(BINARY_NOT_FOUND_MARK)) continue // tolerated: a missing binary (cloudflared / a provider CLI)
    reasons.push(`unexpected FAIL row: ${row.rest}`)
  }

  return { ok: reasons.length === 0, reasons, rows }
}

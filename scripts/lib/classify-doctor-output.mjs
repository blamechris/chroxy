// classify-doctor-output.mjs — decide whether a captured `chroxy doctor` run
// is a pass for release-gate purposes, without requiring "All checks passed"
// (#8165, hardened by the #8166 review).
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
//   - doctor must have actually run to completion (the "Chroxy Doctor" header
//     must appear, every printed check row must actually PARSE, and the
//     closing summary line must appear — "cannot verify this ran/finished"
//     and "it ran, finished, and passed" must not look alike, see
//     docs/false-safety-guards.md).
//   - the Node.js and Dependencies rows must be OK. NOTE what this does and
//     does not prove: it proves the CLI PROCESS itself (the thing that just
//     printed a doctor report) resolved its own direct deps and runs on a
//     supported Node — it does NOT prove `chroxy start`'s separate daemon
//     module graph (server-cli.js / supervisor.js) links, since
//     `checkDependencies()` only probes a small fixed set of names and those
//     two files are only ever `import()`-ed lazily, at the moment a user runs
//     `start`/`dev` (server-cmd.js). A packed install missing e.g. `ws` can
//     still print a clean doctor report and still fail `chroxy start` on
//     first import. verify-publish-artifacts.mjs's separate "chroxy start's
//     module graph links" step (added in the same review) is what actually
//     proves that, by directly `import()`-ing those two files out of the
//     installed package — this classifier has no visibility into that at
//     all, and its `ok: true` says nothing about it either way.
//   - every other FAIL row is tolerated ONLY when it is a missing-binary row
//     (cloudflared, or a provider CLI) — `checkBinary()` in
//     packages/server/src/doctor.js reports that shape as
//     `Not found — <installHint>` (note the em dash), ANCHORED to the start
//     of the row's message. Any other FAIL — a bad Node version, a genuinely
//     broken Dependencies row, a provenance refusal, a shell-shim mismatch, a
//     malformed config, or a message that merely CONTAINS that text further
//     in — still fails the gate.
//
// No spawning here — this only classifies a string. Kept pure and exported so
// it is unit-testable without a container. See
// scripts/__tests__/classify-doctor-output.test.mjs.

// Strips ANSI SGR sequences (`\x1b[32m`, `\x1b[0m`, ...) — doctor-cmd.js
// colors every `[ OK ]`/`[WARN]`/`[FAIL]` badge, and a captured child-process
// stdout keeps those escapes even though this isn't a TTY.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g

// The exact row names doctor-cmd.js prints for the two checks whose scope is
// documented above. Every other row (Config, Billing, Port, Credential
// storage, provider binaries, ...) is either advisory or is allowed to fail
// for the "binary not installed on this runner" reason handled separately
// below.
const REQUIRED_OK_ROWS = ['Node.js', 'Dependencies']

// doctor-cmd.js's closing line (the ONLY two spellings it ever prints —
// see registerDoctorCommand in packages/server/src/cli/doctor-cmd.js). Its
// presence is what tells us the run reached its end rather than being
// truncated (killed mid-write, buffer cut off, etc.) — a clean-looking
// header and a run of clean-looking rows prove nothing about what came
// after them if the process never got there.
const DOCTOR_SUMMARY_RE = /All checks passed\. Ready to start\.|Some checks failed\. Fix the issues above and try again\./

// Matches one printed check row's OPENING badge only — general or
// per-provider (doctor-cmd.js indents provider rows two spaces deeper under
// a "Provider: <name>" heading; both are handled since we trim leading
// whitespace first). Deliberately separate from ROW_RE below: this is used
// to recognize "this line IS a status row" independent of whether the rest
// of it actually parses, so a row that merely LOOKS like one but doesn't
// fully match isn't silently dropped (see ROW_RE's own comment).
const ROW_START_RE = /^\[( OK |WARN|FAIL)\]/

// The full row shape:
//   [ OK ] Node.js            v22.9.0
//   [FAIL] claude             Not found — install claude
// Group 1 is the 4-character badge, trimmed to OK/WARN/FAIL. Group 2 is
// EVERYTHING after the badge — `name.padEnd(18)` + ' ' + message.
//
// `.` (with no `/s` flag) does not match ANY ECMAScript LineTerminator —
// not just `\n`, but also a bare `\r`, U+2028 (LINE SEPARATOR) and U+2029
// (PARAGRAPH SEPARATOR) — so a row whose message embeds one of those
// (a stray `\r` not part of a `\r\n` pair the caller failed to normalize, or
// one of the two Unicode separators, neither of which `split('\n')` breaks
// on) makes `(.*)$` unable to reach end-of-string and the WHOLE match fails,
// silently, for that line. Silently dropping a row is exactly the
// "cannot check this treated as nothing to check" failure in
// docs/false-safety-guards.md — a genuinely FAILing row with such a
// character in its message would vanish from `rows` and never reach the
// FAIL-tolerance loop below. `classifyDoctorOutput` checks `ROW_START_RE`
// first and treats "looks like a row, does not fully parse" as a hard
// failure rather than silently skipping the line — see `unparseableRows`.
const ROW_RE = /^\[( OK |WARN|FAIL)\]\s+(.*)$/

// `checkBinary()` (packages/server/src/doctor.js) reports a missing required
// binary as `<name> Not found — ${installHint}` — the row's NAME (a single
// token: a binary name never contains whitespace) followed by whitespace and
// literally `Not found — ` (em dash, U+2014). Matched directly against
// `row.rest` this way (#8166 second review), rather than by first slicing
// out a fixed-width name column: doctor-cmd.js pads every name to AT LEAST
// 18 columns, but that padding is purely cosmetic — doctor.js has never
// promised any row name stays under it, and a column-width split silently
// breaks the moment one doesn't. "One token, then whitespace, then the exact
// tolerated phrase" needs no assumption about column widths at all, so it
// survives doctor-cmd.js's padding changing (verified: real captured output
// padded to 18, and a hand-built padEnd(20) transcript, both classify
// identically).
//
// This is deliberately anchored, not a loose substring match: (1) the
// 'Config' row's stranded-state drift check (doctor.js, ~line 620) reports
// an unrelated condition that ALSO starts with the word "Not found" —
// `Not found at ${path} — it is still at ...` — which must NOT be tolerated
// here, a stranded config directory is a real defect, not a "binary isn't
// installed on this runner" case; (2) an unrelated FAIL row whose message
// happens to CONTAIN the exact tolerated phrase later in its text (e.g.
// "... see docs — Not found — retry") must also not be tolerated; and (3) a
// row whose name is actually MULTIPLE words (e.g. a hypothetical
// 'Credential storage' FAIL) can never match: the single-token capture group
// can only ever consume the FIRST word, and the literal text immediately
// after it would then have to be "Not found — " with nothing in between —
// which a second name-word occupies instead.
const BINARY_FAIL_RE = /^(\S+) +Not found — /

function stripAnsi(input) {
  return input.replace(ANSI_ESCAPE_RE, '')
}

/**
 * Classify a captured `chroxy doctor` run for the publish-verification gate.
 *
 * @param {string} rawOutput - doctor's captured stdout (+ stderr, if any),
 *   exactly as spawned — ANSI codes and all.
 * @returns {{ ok: boolean, reasons: string[], rows: {status: string, rest: string}[], tolerated: string[] }}
 *   `ok` is true only when doctor demonstrably ran to completion and nothing
 *   outside the tolerated "binary not installed on this runner" shape
 *   failed. `reasons` is empty iff `ok`. `rows` is the parsed check list,
 *   mostly for callers that want to print doctor's own detail on failure.
 *   `tolerated` names the binaries whose missing-binary FAIL was waived.
 */
export function classifyDoctorOutput(rawOutput) {
  if (typeof rawOutput !== 'string') {
    return { ok: false, reasons: ['doctor produced no output (non-string) — it did not demonstrably run'], rows: [], tolerated: [] }
  }

  // Normalize CRLF FIRST — a real captured Windows-style transcript would
  // otherwise trip the "looks like a row but doesn't parse" check on every
  // single line (see ROW_RE's comment on line terminators), which is a false
  // positive this classifier should not report. A LONE `\r` not part of a
  // `\r\n` pair is left alone on purpose: that is the genuinely-anomalous
  // case (an embedded control character inside a message) this hardening
  // exists to catch.
  const normalized = rawOutput.replace(/\r\n/g, '\n')
  const clean = stripAnsi(normalized)

  if (clean.trim().length === 0) {
    return { ok: false, reasons: ['doctor produced no output (empty) — it did not demonstrably run'], rows: [], tolerated: [] }
  }

  if (!/Chroxy Doctor/.test(clean)) {
    return {
      ok: false,
      reasons: ['doctor output is missing the "Chroxy Doctor" header — the command likely did not run (crashed, wrong binary, etc.)'],
      rows: [],
      tolerated: [],
    }
  }

  const rows = []
  const unparseableRows = []
  for (const rawLine of clean.split('\n')) {
    const line = rawLine.trimStart()
    if (!ROW_START_RE.test(line)) continue
    const m = line.match(ROW_RE)
    if (m) rows.push({ status: m[1].trim(), rest: m[2] })
    else unparseableRows.push(line)
  }

  const reasons = []

  if (unparseableRows.length > 0) {
    reasons.push(
      `doctor printed ${unparseableRows.length} check row(s) that looked like a status row but did not ` +
        `fully parse (an embedded CR, U+2028, or U+2029?) — failing closed rather than silently dropping ` +
        `a row that may have been a FAIL: ${unparseableRows.map((l) => JSON.stringify(l)).join('; ')}`
    )
  }

  if (!DOCTOR_SUMMARY_RE.test(clean)) {
    reasons.push(
      'doctor output has no closing summary line ("All checks passed. Ready to start." or "Some checks ' +
        'failed. Fix the issues above and try again.") — the run may have been truncated or killed mid-way'
    )
  }

  for (const name of REQUIRED_OK_ROWS) {
    const row = rows.find((r) => r.rest === name || r.rest.startsWith(`${name} `))
    if (!row) {
      reasons.push(`missing required "${name}" row in doctor output`)
    } else if (row.status !== 'OK') {
      reasons.push(`"${name}" row is ${row.status}, not OK: ${row.rest}`)
    }
  }

  const tolerated = []
  for (const row of rows) {
    if (row.status !== 'FAIL') continue
    const m = row.rest.match(BINARY_FAIL_RE)
    if (m) {
      tolerated.push(m[1])
      continue
    }
    reasons.push(`unexpected FAIL row: ${row.rest}`)
  }

  return { ok: reasons.length === 0, reasons, rows, tolerated }
}

/**
 * Wraps `classifyDoctorOutput` with the two signals a bare stdout/stderr
 * STRING can never carry: the child process never launching at all (ENOENT,
 * EACCES, ...) and being killed by a signal partway through (a timeout, OOM,
 * a supervisor SIGTERM). Either means doctor did NOT run to completion, and
 * whatever it managed to print before that — however clean-looking — must
 * not be trusted as if it were the whole run. Pure and injectable so the
 * caller's post-spawn decision is testable without actually spawning or
 * killing a real process (#8166 review).
 *
 * @param {{stdout?: string, stderr?: string, signal?: string|null, error?: (Error|null)}} [spawnResult]
 *   Shaped exactly like Node's `spawnSync()` return value — pass it directly.
 * @returns {{ ok: boolean, reasons: string[], rows: object[], tolerated: string[] }}
 */
export function classifyDoctorSpawnResult({ stdout = '', stderr = '', signal = null, error = null } = {}) {
  if (error) {
    return { ok: false, reasons: [`chroxy doctor failed to launch: ${error.message || String(error)}`], rows: [], tolerated: [] }
  }
  if (signal) {
    return { ok: false, reasons: [`chroxy doctor was killed by signal ${signal} — it did not run to completion`], rows: [], tolerated: [] }
  }
  return classifyDoctorOutput(`${stdout || ''}${stderr || ''}`)
}

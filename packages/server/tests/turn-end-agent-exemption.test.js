import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * #7340 — the turn-end subagent exemption is OPT-IN, and this file guards the
 * opt-in list itself.
 *
 * `BaseSession._clearMessageState({ turnEndedCleanly: true })` is what lets a
 * confirmed-backgrounded subagent outlive its turn. Fourteen call sites reach
 * that method and all but two are a provider that DIED — Stop/SIGINT, a child
 * crash, `_killAndRespawn`, the SDK hard timeout, stream-stall recovery,
 * `interrupt()`, `destroy()`, a failed stdin write. On any of those,
 * `task_notification` can never arrive, so an exempted agent is stranded and
 * the session claims to be working for the rest of the daemon's life — the
 * failure #7340 itself names as the worse of the two.
 *
 * The behavioural tests in `base-session.test.js` / `cli-session-events.test.js`
 * prove the flag does what it says at the sites that pass it. They cannot prove
 * the converse — that no OTHER site starts passing it — because a test only
 * sees the paths it drives, and a future death path bolted on with
 * `{ turnEndedCleanly: true }` copied from its neighbour would be invisible to
 * every one of them. That is the guard here: the roster is the whole file set,
 * so a new site anywhere in the server goes red on the count.
 *
 * The SDK's dispatch lives inside the `_callQuery` async-iterator loop and
 * cannot be driven in isolation, so its half is a source contract — the same
 * technique `sdk-session-cancel-activity.test.js` uses for the `task_started`
 * branch, and anchored the same way: sliced to the branch and asserted WITHIN
 * the slice, because a file-wide `assert.match` is satisfiable by any unrelated
 * line carrying the same tokens (docs/false-safety-guards.md).
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))

function readSource(name) {
  return readFileSync(join(SRC_DIR, name), 'utf8')
}

/**
 * Assert a pattern against a source slice WITHOUT handing the slice to assert.
 *
 * `assert.match(bigString, re)` carries the whole subject as the failure's
 * `actual`, and the runner's TAP serialisation of a multi-kilobyte multi-line
 * string wedges the process — emitting no output at all, so a guard that is
 * doing its job reads as a HUNG suite rather than a red one. Measured here:
 * mutating cli-session.js's `result` branch hung `node --test` past two minutes
 * with an empty TAP stream; the identical mutation reports in about a second
 * once the subject stops riding on the assertion.
 *
 * Collapsing to a boolean first keeps `actual` at `false` and puts the
 * diagnosis in the message, where it is readable.
 */
function assertSliceMatches(re, slice, message) {
  assert.ok(re.test(slice), message)
}

function assertSliceOmits(re, slice, message) {
  assert.ok(!re.test(slice), message)
}

/** Every .js under src/, recursively — the roster must not miss a subdirectory. */
function allServerSources(dir = SRC_DIR, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) allServerSources(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

describe('#7340 — turn-end exemption opt-in roster', () => {
  // A positive control for the scan itself. A roster built by walking the
  // filesystem is worthless if the walk silently returns nothing (or misses
  // subdirectories) — it would then report "no unexpected call sites" for the
  // same reason it reports everything else: it looked at nothing.
  it('the source scan actually finds the server tree', () => {
    const files = allServerSources()
    assert.ok(files.length > 50, `expected the whole src tree, got ${files.length} files`)
    assert.ok(files.some((f) => f.endsWith('base-session.js')))
    assert.ok(files.some((f) => f.includes('handlers/')), 'the walk must recurse into subdirectories')
  })

  it('exactly two call sites opt in, and they are the two provider `result` paths', () => {
    const sites = []
    for (const file of allServerSources()) {
      const src = readFileSync(file, 'utf8')
      for (const line of src.split('\n')) {
        // Match a CALL, not the prose and not the DEFINITION. The receiver
        // (`this.` / `super.`) is what distinguishes them: base-session.js
        // both documents the contract at length and declares
        // `_clearMessageState({ turnEndedCleanly = false } = {})`, and an
        // un-anchored pattern counts its own definition as a call site.
        if (/[.]_clearMessageState\(\s*\{[^}]*turnEndedCleanly/.test(line)) sites.push(file)
      }
    }
    assert.deepEqual(
      sites.map((f) => f.slice(SRC_DIR.length)).sort(),
      ['cli-session.js', 'sdk-session.js'],
      'a new opt-in site must be justified on #7340 before it is added here: the flag is only safe where the provider is still ALIVE and can still deliver task_notification',
    )
  })

  it('the CLI opts in from its `result` branch and nowhere else', () => {
    const src = readSource('cli-session.js')
    const start = src.indexOf("case 'result': {")
    assert.ok(start > 0, "the CLI's result branch must be present")
    // The branch ends at the next sibling `case` label at the same nesting.
    const end = src.indexOf('\n      }\n', start)
    assert.ok(end > start, 'result branch must be delimited')
    const branch = src.slice(start, end)
    assertSliceMatches(/_clearMessageState\(\{ turnEndedCleanly: true \}\)/, branch,
      "the CLI's result branch must opt in — it is the only CLI site where the child is still alive")
    // Negative control for the slice: every assertion above would pass on the
    // whole file, so prove the slice is genuinely one branch.
    assert.ok(branch.length < src.length * 0.1,
      `slice should be one branch, got ${branch.length} of ${src.length} chars`)
    assertSliceOmits(/_handleChildClose/, branch, 'the slice must not reach the death paths')
  })

  it('the SDK opts in from its `result` branch and nowhere else', () => {
    const src = readSource('sdk-session.js')
    const start = src.indexOf("case 'result': {")
    assert.ok(start > 0, "the SDK's result branch must be present")
    const end = src.indexOf("\n        }\n", start)
    assert.ok(end > start, 'result branch must be delimited')
    const branch = src.slice(start, end)
    assertSliceMatches(/_clearMessageState\(\{ turnEndedCleanly: true \}\)/, branch,
      "the SDK's result branch must opt in — it is the only SDK site where the query is still alive")
    assert.ok(branch.length < src.length * 0.1,
      `slice should be one branch, got ${branch.length} of ${src.length} chars`)
    assertSliceOmits(/_handleStreamStall/, branch, 'the slice must not reach the death paths')
  })

  // #7340: only the provider's OWN `task_started` may confirm a backgrounding,
  // because that same event is the evidence a terminal `task_notification` can
  // arrive at all. A producer that starts passing `authoritative: true` off the
  // tool input would exempt agents that have no finalizer.
  it('only the two task_started producers claim authority over the flag', () => {
    const sites = []
    for (const file of allServerSources()) {
      const src = readFileSync(file, 'utf8')
      for (const line of src.split('\n')) {
        if (/^\s*authoritative: true,?\s*$/.test(line)) sites.push(file)
      }
    }
    assert.deepEqual(
      sites.map((f) => f.slice(SRC_DIR.length)).sort(),
      ['cli-session.js', 'sdk-session.js'],
    )
  })

  it("the SDK's authoritative flag sits inside the task_started branch", () => {
    const src = readSource('sdk-session.js')
    const start = src.indexOf("subtype === 'task_started'")
    const end = src.indexOf("subtype === 'task_notification'")
    assert.ok(start > 0 && end > start, 'both branches present and in order')
    const branch = src.slice(start, end)
    assertSliceMatches(/authoritative: true/, branch,
      "the SDK's task_started branch must claim authority — it is the provider's own account of what it did")
    assert.ok(branch.length < src.length * 0.05,
      `slice should be one branch, got ${branch.length} of ${src.length} chars`)
  })

  // #7340: the re-seed pairs with the client-side `activeAgents` wipe that
  // `history_replay_start` triggers. There are three producers of that frame
  // today and each has its own repair; a FOURTH added later would reintroduce
  // the bug in a new place while every existing test stayed green. This is the
  // "hardcoded list next to a set that grows" shape from
  // docs/false-safety-guards.md, so the list is derived rather than written.
  it('every file that starts a history replay also re-seeds activeAgents', () => {
    const producers = []
    for (const file of allServerSources()) {
      const src = readFileSync(file, 'utf8')
      // The frame is built as an object literal; a comment or a doc roster
      // mentioning the type must not count as a producer.
      if (/send\(ws, \{ type: '(?:history_replay_start)'/.test(src)) producers.push(file)
    }
    assert.ok(producers.length >= 2, `expected to find the replay producers, got ${producers.length}`)
    // `assert.ok` on a computed boolean, NOT `assert.match` against the file
    // text. A failing `assert.match` carries the WHOLE source file as its
    // `actual`, and the runner's TAP serialisation of a 15KB multi-line string
    // wedges the process with no output at all — a "failing" guard that reads
    // as a hung suite instead of a red one.
    const missing = producers.filter((f) => !readFileSync(f, 'utf8').includes('reseedActiveAgents'))
    assert.deepEqual(
      missing.map((f) => f.slice(SRC_DIR.length)),
      [],
      'these files send history_replay_start (which makes both clients WIPE activeAgents) but never re-seed it — a confirmed-backgrounded subagent would silently vanish from the badge list while still running (#7340)',
    )
  })

  it("the CLI's authoritative flag sits inside the task_started branch", () => {
    const src = readSource('cli-session.js')
    const start = src.indexOf("if (data.subtype === 'task_started') {")
    assert.ok(start > 0, 'the CLI task_started branch must be present')
    const end = src.indexOf('} else {', start)
    assert.ok(end > start, 'branch must be delimited')
    const branch = src.slice(start, end)
    assertSliceMatches(/authoritative: true/, branch,
      "the CLI's task_started branch must claim authority — it is the provider's own account of what it did")
    assert.ok(branch.length < src.length * 0.05,
      `slice should be one branch, got ${branch.length} of ${src.length} chars`)
  })
})

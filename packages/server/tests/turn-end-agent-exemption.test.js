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
 * that method and exactly ONE may pass it: `CliSession`'s `result` branch,
 * where a PERSISTENT stream-json child is still alive to deliver the
 * `task_notification` that eventually clears the agent.
 *
 * Every other site is a provider that died — Stop/SIGINT, a child crash,
 * `_killAndRespawn`, the SDK hard timeout, stream-stall recovery, `interrupt()`,
 * `destroy()`, a failed stdin write. On any of those `task_notification` can
 * never arrive, so an exempted agent is stranded and the session claims to be
 * working for the rest of the daemon's life — the failure #7340 itself names as
 * the worse of the two.
 *
 * `SdkSession`'s `result` branch READS like CliSession's and is not eligible:
 * the SDK creates one `query()` per turn and nulls it one statement after
 * `result`, so nothing is left reading the stream. Review caught that after it
 * had already shipped into this roster, which is why it is asserted by name
 * below rather than left to a count.
 *
 * The behavioural tests in `base-session.test.js` / `cli-session-events.test.js`
 * prove the flag does what it says at the site that passes it. They cannot prove
 * the converse — that no OTHER site starts passing it — because a test only sees
 * the paths it drives, and a future death path bolted on with
 * `{ turnEndedCleanly: true }` copied from its neighbour would be invisible to
 * every one of them. That is the guard here: the roster is the whole file set,
 * so a new site anywhere in the server goes red.
 */

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url))

function readSource(name) {
  return readFileSync(join(SRC_DIR, name), 'utf8')
}

/**
 * A file's path relative to src/, ALWAYS with `/` separators.
 *
 * `join()` yields `handlers\\foo.js` on Windows, so every comparison against a
 * literal containing `/` — including this file's own positive control for the
 * directory walk — silently fails there while passing on macOS and Linux. This
 * file's first version did exactly that and went red only on Server Windows
 * Tests.
 *
 * Splits on BOTH separators rather than `path.sep`. `sep` is the separator of
 * the machine RUNNING the test, so on macOS/Linux it is `/` and the Windows
 * branch is never executed — the fix would ship untested against the only input
 * it exists to handle. A both-separators split is exercised by every run, and
 * the unit test below can feed it a Windows path this repo never produces here.
 */
function relPath(file) {
  return file.slice(SRC_DIR.length).split(/[\\/]/).join('/')
}

/**
 * Source with comment-only lines removed, so a roster scan counts CODE and not
 * the prose describing it. Every file in this contract also *documents* it:
 * `base-session.js` explains the flag at length and declares the parameter,
 * `sdk-session.js` carries a comment on why it must NOT opt in, and
 * `codex-app-server-session.js` names the flag while making no call. Counting
 * those would report call sites that do not exist.
 *
 * Deliberately crude (drops comment-only lines, not inline trailing comments):
 * it only has to stop prose masquerading as code, and anything it fails to
 * strip over-collects, which fails CLOSED.
 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

/**
 * The `case '<label>'` a source offset sits inside, found by scanning BACKWARDS
 * for the nearest label.
 *
 * Deliberately not a forward brace-match. The first version of this file sliced
 * the branch with `src.indexOf('\n      }\n', start)`, which review flagged as
 * brittle — it depends on exact indentation and on the branch ending before any
 * other block at the same depth. Searching forward for the next sibling `case`
 * is no better here: `cli-session.js`'s `result` branch is followed by a
 * DIFFERENT switch (`semantics.kind`) 60 lines later, so the next `case` label
 * in the file is not a sibling at all.
 *
 * Scanning backwards needs neither: whatever the formatting, the nearest
 * preceding label is the branch you are in.
 */
function enclosingCaseLabel(src, offset) {
  const matches = [...src.slice(0, offset).matchAll(/case\s+'([^']+)'\s*:/g)]
  return matches.length ? matches[matches.length - 1][1] : null
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

/**
 * Files that override `_clearMessageState`, identified by the `super.` call —
 * which every override must contain regardless of how it declares its
 * parameter. Keying off the DECLARATION instead would skip a no-parameter
 * override, and a no-parameter override is precisely the broken case.
 */
function overrideFiles() {
  return allServerSources()
    .filter((f) => /\bsuper\._clearMessageState\s*\(/.test(codeOnly(readFileSync(f, 'utf8'))))
    .sort()
}

/** Files whose CODE matches `re`, as `/`-separated paths relative to src/. */
function sourcesMatching(re) {
  return allServerSources()
    .filter((f) => re.test(codeOnly(readFileSync(f, 'utf8'))))
    .map(relPath)
    .sort()
}

describe('#7340 — turn-end exemption opt-in roster', () => {
  // Entry 16 of docs/false-safety-guards.md: a reader that only ever sees the
  // inputs the repo currently produces is untested against the inputs it exists
  // to catch. On this machine `path.sep` is `/`, so nothing else in this file
  // exercises the Windows shape.
  it('relPath normalises a Windows path this platform never produces', () => {
    assert.equal(relPath(`${SRC_DIR}handlers\\conversation-handlers.js`), 'handlers/conversation-handlers.js')
    assert.equal(relPath(`${SRC_DIR}handlers/conversation-handlers.js`), 'handlers/conversation-handlers.js')
    assert.equal(relPath(`${SRC_DIR}base-session.js`), 'base-session.js')
  })

  // A positive control for the scan itself. A roster built by walking the
  // filesystem is worthless if the walk silently returns nothing (or misses
  // subdirectories) — it would then report "no unexpected call sites" for the
  // same reason it reports everything else: it looked at nothing.
  it('the source scan actually finds the server tree', () => {
    const files = allServerSources()
    // The floor is meaningful, not decorative: src/ holds ~300 .js files but
    // ~180 of them are at the TOP level, so a `> 50` floor passed with
    // recursion entirely broken. Several distinct subtrees are pinned for the
    // same reason — one directory is not evidence that the walk recurses.
    assert.ok(files.length > 250, `expected the whole src tree, got ${files.length} files`)
    assert.ok(files.some((f) => f.endsWith('base-session.js')))
    for (const dir of ['handlers/', 'orchestration/', 'channels/']) {
      assert.ok(files.some((f) => relPath(f).includes(dir)), `the walk must recurse into ${dir}`)
    }
  })

  it('codeOnly strips prose so a comment cannot masquerade as a call site', () => {
    assert.equal(codeOnly('// turnEndedCleanly\n * turnEndedCleanly\nreal()'), 'real()')
  })

  // Matches the TOKEN anywhere in the file's code, not a call shape on one
  // line. Review defeated the first version with two ordinary rewrites of a
  // death-path opt-in — a multi-line object literal, and a hoisted
  // `const opts = { turnEndedCleanly: true }` — both of which sailed past a
  // per-line `_clearMessageState({...})` pattern. There is no way to pass this
  // flag without naming it, so the token is the thing to look for.
  //
  // `base-session.js` is expected: it declares the parameter and consumes it.
  // Anything else is a call site.
  it('exactly ONE provider opts in, and it is the CLI', () => {
    assert.deepEqual(
      sourcesMatching(/\bturnEndedCleanly\b/),
      ['base-session.js', 'cli-session.js'],
      'a new opt-in site must be justified on #7340 before it is added: the flag is only safe where the provider is still ALIVE and can still deliver task_notification',
    )
  })

  it('the CLI opt-in sits inside the `result` branch', () => {
    const src = readSource('cli-session.js')
    const idx = src.search(/\bturnEndedCleanly\b/)
    assert.ok(idx > 0, 'the CLI must opt in somewhere')
    assert.equal(
      enclosingCaseLabel(src, idx),
      'result',
      'the exemption belongs to the turn the provider itself ended, not to any other branch',
    )
  })

  // #7340 (review): the SDK creates one `query()` per turn and nulls it one
  // statement after `result`, so an agent spared there can never receive the
  // `task_notification` that would clear it — and `interrupt()`,
  // `cancelActivity`, the hard timeout and the stall timer are all disarmed or
  // early-return by then. Asserted BY NAME, not left to the count above: "the
  // SDK's result looks identical to the CLI's" is exactly the mistake a future
  // reader repeats, and it is the one that already happened here.
  it('the SDK `result` branch does NOT opt in', () => {
    assert.ok(
      !/turnEndedCleanly/.test(codeOnly(readSource('sdk-session.js'))),
      'SdkSession must not exempt any agent: its query dies at the `break` after `result`, so no terminal signal can follow',
    )
  })

  // #7340: only the provider's OWN `task_started` may confirm a backgrounding,
  // because that same event is the evidence a terminal `task_notification` can
  // arrive at all. A producer that starts passing `authoritative: true` off the
  // tool input would exempt agents that have no finalizer.
  // Matched anywhere in the code, not as a standalone line. Review defeated the
  // line-anchored version by adding `authoritative: true` INLINE to
  // `byok-session.js`'s real `_trackAgent` call — a third producer whose Task
  // tool awaits its child in-process and never emits `task_notification`, so an
  // agent confirmed there would be stranded forever.
  it('only the two task_started producers claim authority over the flag', () => {
    assert.deepEqual(
      sourcesMatching(/\bauthoritative:\s*true\b/),
      ['cli-session.js', 'sdk-session.js'],
    )
  })

  it("the SDK's authoritative flag sits inside the task_started branch", () => {
    const src = readSource('sdk-session.js')
    const start = src.indexOf("subtype === 'task_started'")
    const end = src.indexOf("subtype === 'task_notification'")
    assert.ok(start > 0 && end > start, 'both branches present and in order')
    const branch = src.slice(start, end)
    // `assert.ok` on a computed boolean, NOT `assert.match` against the slice.
    // A failing `assert.match` carries the whole subject as its `actual`, and
    // serialising kilobytes of source into the TAP YAML block is what turned a
    // red guard into a two-minute hang with an empty stream (entry 17 of
    // docs/false-safety-guards.md).
    assert.ok(
      /authoritative: true/.test(branch),
      "the SDK's task_started branch must claim authority — it is the provider's own account of what it did",
    )
    // Absolute, not a fraction of a 100 KB file: 5% is 5 KB, which would let
    // these ~1-2 KB slices more than double before the control complained.
    assert.ok(branch.length < 6000,
      `slice should be one branch, got ${branch.length} chars`)
  })

  it("the CLI's authoritative flag sits inside the task_started branch", () => {
    const src = readSource('cli-session.js')
    const start = src.indexOf("if (data.subtype === 'task_started') {")
    assert.ok(start > 0, 'the CLI task_started branch must be present')
    const end = src.indexOf('} else {', start)
    assert.ok(end > start, 'branch must be delimited')
    const branch = src.slice(start, end)
    assert.ok(
      /authoritative: true/.test(branch),
      "the CLI's task_started branch must claim authority — it is the provider's own account of what it did",
    )
    // Absolute, not a fraction of a 100 KB file: 5% is 5 KB, which would let
    // these ~1-2 KB slices more than double before the control complained.
    assert.ok(branch.length < 6000,
      `slice should be one branch, got ${branch.length} chars`)
  })

  // #7340: every subclass override must forward its opts to `super`. One that
  // drops them fails SAFE (it sweeps), so this is a correctness nicety rather
  // than a hazard — but it is silent, and it disables the exemption for that
  // provider entirely. Derived from the walk, so a fourth provider goes red.
  it('every _clearMessageState override forwards its opts to super', () => {
    const broken = []
    for (const file of overrideFiles()) {
      const code = codeOnly(readFileSync(file, 'utf8'))
      const decl = code.match(/^\s*_clearMessageState\s*\(([^)]*)\)\s*\{/m)
      const param = decl && decl[1].trim()
      // A no-parameter override is a violation on its own: it has nothing to
      // forward, so it silently discards whatever the caller passed. That is
      // the shape review used to defeat the first version of this guard, which
      // only looked at overrides that DID declare a parameter and skipped the
      // rest — i.e. it was blind to exactly the broken case.
      if (!param) { broken.push(`${relPath(file)} (override takes no parameter)`); continue }
      if (!new RegExp(`super\\._clearMessageState\\s*\\(\\s*${param}\\s*\\)`).test(code)) {
        broken.push(`${relPath(file)} (does not forward \`${param}\`)`)
      }
    }
    assert.deepEqual(broken, [], 'an override that drops its opts silently disables the #7340 exemption for that provider')
  })

  // Positive control for the override scan: prove it finds the overrides that
  // DO exist, or "none broken" would be reported by a scan that matched nothing.
  it('the override scan finds the three known subclass overrides', () => {
    assert.deepEqual(overrideFiles().map(relPath), ['cli-session.js', 'codex-app-server-session.js', 'sdk-session.js'])
  })

  // #7340: the re-seed pairs with the client-side `activeAgents` wipe that
  // `history_replay_start` triggers. Counts SITES, not files — a file-level
  // containment check is satisfied for the whole file by the repairs already in
  // it, so a THIRD producer added to `conversation-handlers.js` passed green.
  // Review inserted exactly that and every test stayed green.
  //
  // Socket-binding agnostic too: the repo already emits replay frames on
  // `otherWs` (checkpoint-handlers) and `clientWs` (session-handlers), so
  // hardcoding `send(ws, {` would make the next producer invisible.
  it('every history-replay site is paired with an activeAgents re-seed', () => {
    const unpaired = []
    for (const file of allServerSources()) {
      const code = codeOnly(readFileSync(file, 'utf8'))
      const frames = (code.match(/\btype\s*:\s*['"`]history_replay_start['"`]/g) || []).length
      if (frames === 0) continue
      const reseeds = (code.match(/\breseedActiveAgents\s*\(/g) || []).length
      if (reseeds < frames) unpaired.push(`${relPath(file)} (${frames} frame(s), ${reseeds} re-seed(s))`)
    }
    assert.deepEqual(
      unpaired,
      [],
      "each history_replay_start makes both clients WIPE the replayed session's activeAgents; every one needs a matching reseedActiveAgents or a confirmed-backgrounded subagent silently vanishes from the badge list while still running (#7340)",
    )
  })

  // Positive control for the pairing scan: if the frame pattern stopped
  // matching, the loop would `continue` past every file and report no
  // violations for the same reason it reports everything else.
  it('the replay-frame scan actually finds the known producers', () => {
    assert.deepEqual(
      sourcesMatching(/\btype\s*:\s*['"`]history_replay_start['"`]/),
      ['handlers/conversation-handlers.js', 'ws-history.js'],
    )
  })
})

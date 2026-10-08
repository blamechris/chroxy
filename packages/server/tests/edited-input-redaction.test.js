import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { PermissionManager, wirePermissionManager, mergeEditedInput } from '../src/permission-manager.js'
import { createPermissionResolver } from '../src/permission-resolver.js'
import { ClaudeByokSession } from '../src/byok-session.js'
import { EditedInputRefusedError, DROPPED_HUNKS_KEY, KEPT_HUNKS_KEY } from '../src/edited-input.js'
import { sanitizeToolInput, PULL_MAX_INPUT_CHARS } from '../src/redaction.js'
import { createSpy, nsCtx } from './test-helpers.js'

/**
 * #8446 — a pre-write review that drops a hunk must write the RAW content minus
 * that hunk, never the redacted copy the client reviewed.
 *
 * Every case drives the production path: PermissionManager.handlePermission raises
 * the prompt, `get_permission_input` hands the client its redacted view, the client's
 * decision goes through `permission_response` -> the real permission resolver ->
 * PermissionManager.respondToPermission, and the `updatedInput` the tool executor
 * would receive is applied to a real file.
 *
 * The line ranges below are what the client's differ (store-core `computeHunks` +
 * `droppedHunkRanges`) emits for this fixture over the REDACTED text. The same
 * fixture and numbers are pinned in store-core's hunk-diff.test.ts, so a change to
 * either side fails there.
 */

// Synthetic, secret-SHAPED (matches the `sk-` provider-key pattern); not a real key.
const SECRET = 'sk-' + 'Ab12'.repeat(12)
const ROTATED = 'sk-' + 'Zy98'.repeat(12)

const HUNK_A = { oldStart: 1, oldCount: 5, newStart: 1, newCount: 5 }   // lines 00-04
const HUNK_B = { oldStart: 25, oldCount: 6, newStart: 25, newCount: 6 } // lines 24-29

/** What the client sends: every hunk it was shown, split into the ones it dropped and the ones it kept. */
const decide = (dropped, all = [HUNK_A, HUNK_B]) => ({
  [DROPPED_HUNKS_KEY]: dropped,
  [KEPT_HUNKS_KEY]: all.filter((h) => !dropped.includes(h)),
})

/** 30 lines; the secret on `secretAt`; `line01` and `line27` change in the proposal. */
function fixture({ secretAt = 12, rotate = false, pad = 0 } = {}) {
  const tail = ' //'.padEnd(pad, '.')
  const oldLines = Array.from({ length: 30 }, (_, i) => `line${String(i).padStart(2, '0')}${tail}`)
  oldLines[secretAt] = `const apiKey = "${SECRET}"${tail}`
  const newLines = [...oldLines]
  if (rotate) newLines[secretAt] = `const apiKey = "${ROTATED}"${tail}`
  newLines[1] = `line01 CHANGED${tail}`
  newLines[27] = `line27 CHANGED${tail}`
  return { oldLines, newLines, old_string: oldLines.join('\n'), new_string: newLines.join('\n') }
}

const quiet = { info() {}, warn() {}, error() {} }
const dirs = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }) })

/** The prompt, a stand-in for the owning SDK session, and the WS handler ctx. */
function harness(tool, rawInput, { mode = 'default', cwd, audit = null } = {}) {
  const dir = cwd ?? mkdtempSync(join(tmpdir(), 'chroxy-8446-'))
  if (!cwd) dirs.push(dir)
  const pm = new PermissionManager({ log: quiet, cwd: dir, timeoutMs: 60_000 })
  const session = new EventEmitter()
  session.cwd = dir
  session.respondToPermission = (...args) => pm.respondToPermission(...args)
  wirePermissionManager(session, pm)

  let requestId = null
  session.on('permission_request', (d) => { requestId = d.requestId })
  const outcome = pm.handlePermission(tool, rawInput, null, mode)
  assert.ok(requestId, 'the tool call raised a prompt')

  const permissionSessionMap = new Map([[requestId, 's1']])
  const ctx = nsCtx({
    send: createSpy(),
    sessionManager: { getSession: (id) => (id === 's1' ? { session } : undefined) },
    permissionSessionMap,
    pendingPermissions: new Map(),
    permissionAudit: audit,
    unregisterPermissionRoute: (id) => permissionSessionMap.delete(id),
  })
  const client = { id: 'c1', activeSessionId: 's1' }
  const ws = { readyState: 1, send() {} }
  const sent = () => ctx.transport.send.calls.map((c) => c[1])

  return {
    dir, requestId, outcome, sent, pm,
    /** What the reviewing client is shown. */
    pull() {
      settingsHandlers.get_permission_input(ws, client, { type: 'get_permission_input', requestId }, ctx)
      return sent().filter((m) => m.type === 'permission_input').pop()
    },
    respond(editedInput, decision = 'allow') {
      settingsHandlers.permission_response(ws, client, { type: 'permission_response', requestId, decision, ...(editedInput ? { editedInput } : {}) }, ctx)
    },
  }
}

/** Apply an Edit the way the tool does: replace old_string with new_string in the file. */
function applyEdit(dir, fileContent, updatedInput) {
  const file = join(dir, 'target.js')
  writeFileSync(file, fileContent)
  const before = readFileSync(file, 'utf8')
  assert.ok(before.includes(updatedInput.old_string), 'old_string is the anchor and must still match the file')
  writeFileSync(file, before.replace(updatedInput.old_string, () => updatedInput.new_string))
  return readFileSync(file, 'utf8')
}

describe('#8446 hunk-reviewed Edit is rebuilt from the raw input', () => {
  it('the client is shown a redacted copy (the premise of the defect)', async () => {
    const f = fixture()
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    const shown = h.pull()
    assert.equal(shown.found, true)
    assert.ok(!shown.input.old_string.includes(SECRET), 'the secret is not on the wire')
    assert.ok(shown.input.old_string.includes('[REDACTED]'), 'a placeholder stands in for it')
    h.respond(null, 'deny')
    await h.outcome
  })

  it('drops a hunk; the secret sits in the untouched gap: the file is the raw proposal minus that hunk', async () => {
    const f = fixture({ secretAt: 12 })
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    h.pull()
    h.respond({ ...decide([HUNK_B]) })
    const result = await h.outcome
    assert.equal(result.behavior, 'allow')

    const expected = [...f.newLines]
    expected[27] = f.oldLines[27] // hunk B dropped, hunk A kept
    const written = applyEdit(h.dir, `// header\n${f.old_string}\n// footer\n`, result.updatedInput)
    assert.equal(written, `// header\n${expected.join('\n')}\n// footer\n`)
    assert.ok(!written.includes('[REDACTED'), 'no placeholder reached the file')
    assert.ok(written.includes(SECRET), 'the secret line is the original text')
    assert.equal(result.updatedInput.file_path, '/repo/target.js')
    assert.equal(result.updatedInput.old_string, f.old_string, 'the match anchor is untouched')
  })

  it('drops the hunk whose context holds the secret: the secret line comes back as the original text', async () => {
    const f = fixture({ secretAt: 3 }) // inside hunk A's context
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    h.pull()
    h.respond({ ...decide([HUNK_A]) })
    const result = await h.outcome

    const expected = [...f.newLines]
    expected[1] = f.oldLines[1] // hunk A dropped, hunk B kept
    assert.equal(result.updatedInput.new_string, expected.join('\n'))
    assert.ok(!result.updatedInput.new_string.includes('[REDACTED'))
    assert.ok(result.updatedInput.new_string.includes(SECRET))
  })

  it('keeps the hunk whose context holds the secret, drops the other', async () => {
    const f = fixture({ secretAt: 3 })
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    h.pull()
    h.respond({ ...decide([HUNK_B]) })
    const result = await h.outcome
    const expected = [...f.newLines]
    expected[27] = f.oldLines[27]
    assert.equal(result.updatedInput.new_string, expected.join('\n'))
    assert.ok(!result.updatedInput.new_string.includes('[REDACTED'))
  })

  it('a key rotated between old and new (both redact to the same text) keeps the PROPOSED line', async () => {
    const f = fixture({ secretAt: 12, rotate: true })
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    const shown = h.pull()
    // The client cannot see the rotation: both sides read the same to it.
    assert.equal(shown.input.old_string.split('\n')[12], shown.input.new_string.split('\n')[12])
    h.respond({ ...decide([HUNK_B]) })
    const result = await h.outcome
    const expected = [...f.newLines]
    expected[27] = f.oldLines[27]
    assert.equal(result.updatedInput.new_string, expected.join('\n'))
    assert.ok(result.updatedInput.new_string.includes(ROTATED))
    assert.ok(!result.updatedInput.new_string.includes('[REDACTED'))
  })

  it('an input past the 10K broadcast cap is still narrowed: the review is drawn over the larger pull cap', async () => {
    const f = fixture({ pad: 500 }) // ~15K per side, under the 512K pull cap
    assert.ok(f.old_string.length > 10_240)
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    assert.equal(h.pull().found, true)
    h.respond({ ...decide([HUNK_B]) })
    const result = await h.outcome
    assert.equal(result.behavior, 'allow')
    const expected = [...f.newLines]
    expected[27] = f.oldLines[27]
    assert.equal(result.updatedInput.new_string, expected.join('\n'))
  })

  describe('hunks that change the line count (later ranges shift if reverted in the wrong order)', () => {
    // 1 line -> 3 at the top (hunk A), one line deleted near the end (hunk B).
    const A = { oldStart: 1, oldCount: 5, newStart: 1, newCount: 7 }
    const B = { oldStart: 25, oldCount: 6, newStart: 27, newCount: 5 }
    const grown = () => {
      const f = fixture()
      const newLines = [...f.oldLines]
      newLines.splice(27, 1)
      newLines.splice(1, 1, 'line01 CHANGED', 'extra1', 'extra2')
      return { ...f, newLines, new_string: newLines.join('\n') }
    }
    const run = async (dropped) => {
      const f = grown()
      const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
      h.pull()
      h.respond({ ...decide(dropped, [A, B]) })
      return { f, result: await h.outcome }
    }

    it('drop the growing hunk', async () => {
      const { f, result } = await run([A])
      assert.equal(result.updatedInput.new_string, [...f.oldLines.slice(0, 5), ...f.newLines.slice(7)].join('\n'))
    })

    it('drop the shrinking hunk', async () => {
      const { f, result } = await run([B])
      assert.equal(result.updatedInput.new_string, [...f.newLines.slice(0, 26), ...f.oldLines.slice(24)].join('\n'))
    })

    it('drop both: the original text, and no placeholder', async () => {
      const { f, result } = await run([A, B])
      assert.equal(result.updatedInput.new_string, f.old_string)
      assert.ok(!result.updatedInput.new_string.includes('[REDACTED'))
    })
  })

  it('dropping every hunk yields the original text', async () => {
    const f = fixture()
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    h.pull()
    h.respond({ ...decide([HUNK_B, HUNK_A]) }) // order on the wire does not matter
    const result = await h.outcome
    assert.equal(result.updatedInput.new_string, f.old_string)
  })

  it('content the client also sends for the field is ignored: the server derives it', async () => {
    const f = fixture()
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    h.pull()
    h.respond({ new_string: 'attacker text [REDACTED]', ...decide([HUNK_B]) })
    const result = await h.outcome
    const expected = [...f.newLines]
    expected[27] = f.oldLines[27]
    assert.equal(result.updatedInput.new_string, expected.join('\n'))
  })

  it('a path in the response never redirects the write', async () => {
    const f = fixture()
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    h.pull()
    h.respond({ file_path: '/etc/passwd', old_string: 'x', ...decide([HUNK_B]) })
    const result = await h.outcome
    assert.equal(result.updatedInput.file_path, '/repo/target.js')
    assert.equal(result.updatedInput.old_string, f.old_string)
  })
})

describe('#8446 Write', () => {
  const content = (extra = []) => ['const a = 1', `const apiKey = "${SECRET}"`, 'const b = 2', ...extra].join('\n')

  it('drops its one hunk: an empty file, not a file of placeholders', async () => {
    const raw = content()
    const h = harness('Write', { file_path: '/repo/new.js', content: raw })
    h.pull()
    const only = { oldStart: 0, oldCount: 0, newStart: 1, newCount: 3 }
    h.respond({ ...decide([only], [only]) })
    const result = await h.outcome
    assert.equal(result.updatedInput.content, '')
    assert.equal(result.updatedInput.file_path, '/repo/new.js')
  })

  it('a Write with no dropped hunks is the unedited input', async () => {
    const raw = content()
    const h = harness('Write', { file_path: '/repo/new.js', content: raw })
    h.pull()
    h.respond({ [DROPPED_HUNKS_KEY]: [] })
    const result = await h.outcome
    assert.equal(result.updatedInput.content, raw)
  })
})

describe('#8446 text a client sends is refused wherever redaction changed what it was shown', () => {
  const REFUSED = /redacted before you saw it/

  it('an older client\'s narrowed content built from the redacted copy: denied, nothing written, the client is told why', async () => {
    const f = fixture()
    const h = harness('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string })
    const shown = h.pull()
    // What the pre-#8446 client sent: the narrowed text, assembled from the redacted view.
    const redactedNarrowed = shown.input.new_string.replace('line27 CHANGED', 'line27')
    assert.ok(redactedNarrowed.includes('[REDACTED]'))
    h.respond({ new_string: redactedNarrowed })
    const result = await h.outcome

    assert.equal(result.behavior, 'deny', 'fail closed: nothing may run')
    assert.equal(result.updatedInput, undefined)
    assert.ok(REFUSED.test(result.message), 'the agent is told why')
    const err = h.sent().find((m) => m.type === 'error')
    assert.equal(err.code, 'PERMISSION_EDIT_REFUSED')
    assert.equal(err.requestId, h.requestId)
    assert.ok(REFUSED.test(err.message))
    assert.ok(!err.message.includes(SECRET) && !result.message.includes(SECRET), 'the refusal leaks nothing')
  })

  it('a placeholder that was already in the text cannot launder one that moved: an old client dropping every hunk', () => {
    // The text really contains `[REDACTED]` (line 1) and a secret the redactor replaced (line 2).
    const raw = {
      file_path: '/a',
      old_string: 'docs: [REDACTED]\nsecret=abcdefgh\nx',
      new_string: 'docs: [REDACTED]\nsecret=abcdefgh\ny',
    }
    const shown = sanitizeToolInput(raw)
    assert.equal(shown.old_string, 'docs: [REDACTED]\nsecret= [REDACTED]\nx')
    // An old client that dropped the only hunk sends the redacted old text back.
    assert.throws(() => mergeEditedInput(raw, { new_string: shown.old_string }, 'Edit'), EditedInputRefusedError)
  })

  it('a Bash command whose literal placeholder hides a redacted secret is refused', () => {
    const raw = { command: "printf '[REDACTED]'; export TOKEN=abcdefgh" }
    const shown = sanitizeToolInput(raw).command
    assert.equal(shown, "printf '[REDACTED]'; export TOKEN= [REDACTED]")
    assert.throws(() => mergeEditedInput(raw, { command: shown }, 'Bash'), EditedInputRefusedError)
    // Even text with no placeholder at all: the client was shown a copy, so it is not the base of an edit.
    assert.throws(() => mergeEditedInput(raw, { command: "printf 'x'" }, 'Bash'), EditedInputRefusedError)
  })

  it('a field redaction did not change takes the client\'s text, a literal placeholder included', () => {
    const raw = { file_path: '/a', old_string: 'docs: [REDACTED] here', new_string: 'docs: [REDACTED] here\nmore' }
    assert.deepEqual(sanitizeToolInput(raw), raw, 'nothing was redacted')
    assert.equal(mergeEditedInput(raw, { new_string: 'docs: [REDACTED] here' }, 'Edit').new_string, 'docs: [REDACTED] here')
    assert.equal(mergeEditedInput({ command: 'ls' }, { command: 'ls -la' }, 'Bash').command, 'ls -la')
  })

  it('an Edit whose replaced text was redacted refuses client text for new_string too', () => {
    // new_string is clean, but the text an old client narrows from includes old_string.
    const raw = { file_path: '/a', old_string: 'secret=abcdefgh', new_string: 'ok' }
    assert.throws(() => mergeEditedInput(raw, { new_string: 'ok' }, 'Edit'), EditedInputRefusedError)
  })

  it('an input too large to have been shown whole refuses client text', () => {
    const raw = { file_path: '/a', old_string: 'a', new_string: 'x'.repeat(PULL_MAX_INPUT_CHARS) }
    assert.throws(() => mergeEditedInput(raw, { new_string: 'x' }, 'Edit'), EditedInputRefusedError)
  })
})

describe('#8446 a decision the server cannot map back to the raw text is refused, never guessed', () => {
  const edit = () => {
    const f = fixture()
    return { f, raw: { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string } }
  }
  const refused = (raw, dropped, kept = []) => assert.throws(
    () => mergeEditedInput(raw, { [DROPPED_HUNKS_KEY]: dropped, [KEPT_HUNKS_KEY]: kept }, 'Edit'),
    EditedInputRefusedError,
  )

  it('malformed ranges', () => {
    const { raw } = edit()
    refused(raw, 'all')
    refused(raw, [null])
    refused(raw, [{ oldStart: 1, oldCount: 5, newStart: 1 }])
    refused(raw, [{ ...HUNK_A, newCount: -1 }])
    refused(raw, [{ ...HUNK_A, oldStart: 1.5 }])
    refused(raw, [{ ...HUNK_A, newCount: '5' }])
    refused(raw, Array.from({ length: 1001 }, () => HUNK_A))
  })

  it('ranges outside the content, or overlapping each other', () => {
    const { raw } = edit()
    refused(raw, [{ oldStart: 28, oldCount: 9, newStart: 28, newCount: 9 }])
    refused(raw, [{ oldStart: 1, oldCount: 5, newStart: 2, newCount: 5 }, HUNK_A])
    refused(raw, [HUNK_A, HUNK_A])
  })

  it('redaction that removes a line break: the client\'s line numbers no longer match the raw text', () => {
    // The key and its value on separate lines read as one redacted line.
    const raw = {
      file_path: '/repo/c.txt',
      old_string: 'a\npassword:\n  hunter2hunter2\nb',
      new_string: 'a\npassword:\n  hunter2hunter2\nB',
    }
    assert.notEqual(sanitizeToolInput(raw).old_string.split('\n').length, raw.old_string.split('\n').length)
    refused(raw, [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }])
  })

  it('an input too large to have been shown whole', () => {
    const big = 'x'.repeat(PULL_MAX_INPUT_CHARS)
    refused({ file_path: '/a', old_string: 'a', new_string: big }, [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }])
  })

  it('a range that is not a real hunk: the lines outside the ranges must agree between original and proposal', () => {
    // The reviewed diff of A,B,C -> A,X,C has one hunk (1,3,1,3 or just B->X). This range
    // skips line 1 on one side only, and would write A,A,C.
    const raw = { file_path: '/a', old_string: 'A\nB\nC', new_string: 'A\nX\nC' }
    refused(raw, [{ oldStart: 1, oldCount: 1, newStart: 2, newCount: 1 }])
    // A real range for the same change is fine.
    assert.equal(mergeEditedInput(raw, { [DROPPED_HUNKS_KEY]: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }], [KEPT_HUNKS_KEY]: [] }, 'Edit').new_string, 'A\nB\nC')
  })

  it('a zero-count side cannot fabricate an insertion or a deletion', () => {
    const same = { file_path: '/a', old_string: 'A\nB\nC', new_string: 'A\nB\nC' }
    refused(same, [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }]) // invent a deletion of B
    refused(same, [{ oldStart: 2, oldCount: 1, newStart: 1, newCount: 0 }]) // invent an insertion of B
    const changed = { file_path: '/a', old_string: 'A\nC', new_string: 'A\nB\nC' }
    // The real hunk: B was inserted after line 1. Dropping it restores A,C.
    assert.equal(mergeEditedInput(changed, { [DROPPED_HUNKS_KEY]: [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }], [KEPT_HUNKS_KEY]: [] }, 'Edit').new_string, 'A\nC')
    // The same insertion claimed one line late.
    refused(changed, [{ oldStart: 2, oldCount: 0, newStart: 2, newCount: 1 }])
  })

  it('lines outside every listed hunk that differ are refused; listing the hunk that changed them makes it valid', () => {
    const raw = { file_path: '/a', old_string: 'A\nB\nC\nD', new_string: 'A\nX\nC\nY' }
    const drop = [{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 }]
    const keep = [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }]
    refused(raw, drop) // line 2 differs and is not listed
    const out = mergeEditedInput(raw, { [DROPPED_HUNKS_KEY]: drop, [KEPT_HUNKS_KEY]: keep }, 'Edit')
    assert.equal(out.new_string, 'A\nX\nC\nD')
  })

  it('a kept range that is not a real hunk is refused just like a dropped one', () => {
    const raw = { file_path: '/a', old_string: 'A\nB\nC', new_string: 'A\nX\nC' }
    refused(raw, [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }], [{ oldStart: 1, oldCount: 1, newStart: 2, newCount: 1 }])
  })

  it('droppedHunks without keptHunks cannot be checked and is refused', () => {
    const raw = { file_path: '/a', old_string: 'A\nB\nC', new_string: 'A\nX\nC' }
    assert.throws(
      () => mergeEditedInput(raw, { [DROPPED_HUNKS_KEY]: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }] }, 'Edit'),
      EditedInputRefusedError,
    )
  })

  it('a droppedHunks key that is present, empty included, puts the field in hunk mode: client text is ignored', () => {
    const raw = { file_path: '/a', old_string: 'A\nB', new_string: 'A\nX' }
    assert.equal(mergeEditedInput(raw, { [DROPPED_HUNKS_KEY]: [], new_string: 'UNRELATED' }, 'Edit').new_string, 'A\nX')
    assert.equal(mergeEditedInput({ file_path: '/a', content: 'raw' }, { [DROPPED_HUNKS_KEY]: [], content: 'UNRELATED' }, 'Write').content, 'raw')
    refused(raw, null)
  })

  it('a 150001-line hunk is restored without a stack-size failure', () => {
    // 300K characters as JSON: under the pull cap, over V8's argument limit for a spread.
    const lines = 150_001
    const raw = { file_path: '/a', old_string: '\n'.repeat(lines - 1), new_string: 'x' }
    const out = mergeEditedInput(raw, { [DROPPED_HUNKS_KEY]: [{ oldStart: 1, oldCount: lines, newStart: 1, newCount: 1 }], [KEPT_HUNKS_KEY]: [] }, 'Edit')
    assert.equal(out.new_string, raw.old_string)
  })

  it('any unexpected failure while applying an edit denies the request instead of leaving it pending', async () => {
    const { raw } = edit()
    const h = harness('Edit', raw)
    h.pull()
    // Make reading the input throw something that is not a refusal.
    h.pm._pendingPermissions.get(h.requestId).input = {
      file_path: '/repo/target.js',
      get old_string() { throw new Error('boom') },
      new_string: 'x',
    }
    h.respond({ ...decide([HUNK_B]) })
    const result = await Promise.race([h.outcome, new Promise((r) => setTimeout(() => r('PENDING'), 500))])
    assert.notEqual(result, 'PENDING', 'the request must not be left pending')
    assert.equal(result.behavior, 'deny')
    assert.equal(h.sent().filter((m) => m.type === 'error' && m.code === 'PERMISSION_EDIT_REFUSED').length, 1)
  })

  it('a refusal is a deny at the resolver, is audited as one, and the answering client gets an error', async () => {
    const { raw } = edit()
    const audit = { logDecision: createSpy() }
    const h = harness('Edit', raw, { audit })
    h.pull()
    h.respond({ [DROPPED_HUNKS_KEY]: [{ oldStart: 28, oldCount: 9, newStart: 28, newCount: 9 }] })
    const result = await h.outcome
    assert.equal(result.behavior, 'deny')
    assert.equal(h.sent().filter((m) => m.type === 'error' && m.code === 'PERMISSION_EDIT_REFUSED').length, 1)
    assert.equal(audit.logDecision.callCount, 1)
    const entry = audit.logDecision.lastCall[0]
    assert.equal(entry.decision, 'deny')
    assert.equal(entry.reason, 'edit_refused')
    assert.equal(entry.tool, 'Edit')
  })

  it('a deny never reads the edit at all', async () => {
    const { raw } = edit()
    const h = harness('Edit', raw)
    h.pull()
    h.respond({ [DROPPED_HUNKS_KEY]: 'garbage', new_string: '[REDACTED]' }, 'deny')
    const result = await h.outcome
    assert.equal(result.behavior, 'deny')
    assert.equal(result.message, 'User denied')
    assert.equal(h.sent().filter((m) => m.type === 'error').length, 0)
  })
})

describe('#8446 both pipelines', () => {
  it('permission floor: a floored target still prompts under auto, and the narrowed edit cannot move the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-8446-floor-'))
    dirs.push(dir)
    const envPath = join(dir, '.env')
    const f = fixture()
    const h = harness('Edit', { file_path: envPath, old_string: f.old_string, new_string: f.new_string }, { mode: 'auto', cwd: dir })
    // 'auto' would have allowed it outright: a prompt is the floor holding.
    assert.ok(h.requestId, 'raised a prompt although the mode is auto')
    h.pull()
    h.respond({ file_path: join(dir, 'elsewhere'), ...decide([HUNK_B]) })
    const result = await h.outcome
    assert.equal(result.behavior, 'allow')
    assert.equal(result.updatedInput.file_path, envPath)
    assert.ok(!result.updatedInput.new_string.includes('[REDACTED'))
  })

  it('BYOK subagent: a refused edit denies the request in the CHILD manager that holds it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-8446-byok-'))
    dirs.push(dir)
    const f = fixture()
    const childPm = new PermissionManager({ log: quiet, cwd: dir, timeoutMs: 60_000 })
    const child = new EventEmitter()
    child.respondToPermission = (...a) => childPm.respondToPermission(...a)
    wirePermissionManager(child, childPm)
    let requestId = null
    child.on('permission_request', (d) => { requestId = d.requestId })
    const outcome = childPm.handlePermission('Edit', { file_path: '/repo/target.js', old_string: f.old_string, new_string: f.new_string }, null, 'default')

    const parent = new ClaudeByokSession({ cwd: dir })
    parent._subagentPermissionRouting.set(requestId, child)
    const permissionSessionMap = new Map([[requestId, 's1']])
    const audit = { logDecision: createSpy() }
    const ctx = nsCtx({
      send: createSpy(),
      sessionManager: { getSession: (id) => (id === 's1' ? { session: parent } : undefined) },
      permissionSessionMap,
      pendingPermissions: new Map(),
      permissionAudit: audit,
      unregisterPermissionRoute: (id) => permissionSessionMap.delete(id),
    })
    const ws = { readyState: 1, send() {} }
    // An edit the server refuses (client text over redacted content).
    settingsHandlers.permission_response(ws, { id: 'c1', activeSessionId: 's1' }, {
      type: 'permission_response', requestId, decision: 'allow', editedInput: { new_string: 'anything' },
    }, ctx)

    const result = await Promise.race([outcome, new Promise((r) => setTimeout(() => r('PENDING'), 500))])
    assert.notEqual(result, 'PENDING', 'the child must not be left waiting for its timeout')
    assert.equal(result.behavior, 'deny')
    assert.equal(audit.logDecision.callCount, 1)
    assert.equal(audit.logDecision.lastCall[0].reason, 'edit_refused')
    assert.equal(childPm._pendingPermissions.size, 0)
    assert.equal(parent._subagentPermissionRouting.has(requestId), false, 'the route is gone once the child resolved')
    await parent.destroy()
  })

  it('a refusal whose deny reaches no pending request is not audited as a deny', () => {
    const session = {
      _lastPermissionData: new Map(),
      respondToPermission: createSpy((id, decision) => {
        if (decision === 'allow') throw new EditedInputRefusedError('nope')
        return false // the deny found nothing to resolve
      }),
    }
    const audit = { logDecision: createSpy() }
    const resolver = createPermissionResolver({
      permissionSessionMap: new Map([['r1', 's1']]),
      pendingPermissions: new Map(),
      getSessionManager: () => ({ getSession: () => ({ session }) }),
      resolveLegacyPermission: createSpy(),
      getPermissionAudit: () => audit,
    })
    const result = resolver.resolve('r1', 'allow', null, { clientId: 'c1', editedInput: { content: 'x' } })
    assert.equal(result.kind, 'expired')
    assert.equal(audit.logDecision.callCount, 0)
  })

  it('hook-routed prompts carry no edit: the resolver hands the legacy store only the decision', () => {
    const resolveLegacyPermission = createSpy()
    const resolver = createPermissionResolver({
      permissionSessionMap: new Map([['hook-1', 's-hook']]),
      pendingPermissions: new Map([['hook-1', { data: { tool: 'Edit' } }]]),
      getSessionManager: () => ({ getSession: () => ({ session: { /* claude-tui: no respondToPermission */ } }) }),
      resolveLegacyPermission,
      getPermissionAudit: () => null,
    })
    const result = resolver.resolve('hook-1', 'allow', null, { editedInput: { [DROPPED_HUNKS_KEY]: [HUNK_A], new_string: '[REDACTED]' } })
    assert.equal(result.kind, 'resolved')
    assert.equal(result.via, 'legacy')
    assert.deepEqual(resolveLegacyPermission.calls, [['hook-1', 'allow']], 'no edit reaches the hook-routed path')
  })

  it('hook-routed prompts offer no pre-write review: there is no pending input to pull', () => {
    const ctx = nsCtx({
      send: createSpy(),
      permissionSessionMap: new Map([['hook-1', 's-hook']]),
      sessionManager: { getSession: () => ({ session: { /* no _pendingPermissions */ } }) },
    })
    settingsHandlers.get_permission_input({}, { id: 'c1', activeSessionId: 's-hook' }, { type: 'get_permission_input', requestId: 'hook-1' }, ctx)
    const reply = ctx.transport.send.lastCall[1]
    assert.equal(reply.found, false)
  })
})

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { CliSession } from '../src/cli-session.js'
import { BaseSession } from '../src/base-session.js'

/**
 * #7382 — the pending-permission bookkeeping must belong to every HOOK-ROUTED
 * provider, not just the one it was written for.
 *
 * #7375 gave `claude-cli` the ability to expire the permission prompts a dying
 * turn leaves behind, and #7379/#7381 made that expiry release the daemon's own
 * pending entry so a reconnect cannot resurrect a dead prompt.
 *
 * None of it reached `claude-tui` — which is DEFAULT_PROVIDER. It mints a
 * `_hookSecret` and its prompts land in the same `pendingPermissions` map via
 * the same `permission-hook.sh`, but it had no `_pendingPermissionIds`, no
 * `notifyPermissionPending`/`Resolved`, and never emitted `permission_expired`.
 * `ws-permissions` guards its call with
 * `typeof ownerSession.notifyPermissionPending === 'function'`, so a TUI prompt
 * was simply never tracked and never expired: a PTY respawn, a Stop or a crash
 * stranded it exactly as claude-cli used to.
 *
 * The bookkeeping now lives on `BaseSession`, so a third hook-routed provider
 * inherits it instead of re-implementing it — a third copy is how this defect
 * class propagates, and the last one took three PRs to find.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

function makeTui() {
  const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-'))
  const session = new ClaudeTuiSession({ cwd: tmpdir(), skillsDir, repoSkillsDir: null })
  session.on('error', () => {})
  return { session, skillsDir }
}

describe('#7382 — claude-tui tracks and expires its permission prompts', () => {
  let session
  let skillsDir
  let expired

  beforeEach(() => {
    ;({ session, skillsDir } = makeTui())
    expired = []
    session.on('permission_expired', (d) => expired.push(d))
    session._activeTurn = { messageId: 'msg-1', startedAt: Date.now(), aborted: false, synthSeq: 0 }
    session._isBusy = true
    session._currentMessageId = 'msg-1'
  })

  afterEach(async () => {
    try { await session?.destroy() } catch { /* ignore */ }
    if (skillsDir) rmSync(skillsDir, { recursive: true, force: true })
    session = null
  })

  it('THE GAP: it exposes the notify API ws-permissions probes for', () => {
    // ws-permissions.js guards with `typeof ownerSession.notifyPermissionPending
    // === 'function'` — so a missing method is not an error, it is a silent
    // skip. Success and not-checking, same observable outcome.
    assert.equal(typeof session.notifyPermissionPending, 'function')
    assert.equal(typeof session.notifyPermissionResolved, 'function')
    assert.equal(typeof session._expirePendingPermissions, 'function')
  })

  it('THE BUG: a turn ending expires the prompt it was blocked on', () => {
    session.notifyPermissionPending('perm-tui-1')
    assert.equal(session._pendingPermissionIds.size, 1, 'precondition: tracked')

    session._clearTurnEndState()

    assert.deepEqual(expired.map((e) => e.requestId), ['perm-tui-1'])
    assert.equal(session._pendingPermissionIds.size, 0, 'bookkeeping drained')
  })

  it('expires every pending prompt, not just the first', () => {
    session.notifyPermissionPending('a')
    session.notifyPermissionPending('b')
    session.notifyPermissionPending('c')

    session._clearTurnEndState()

    assert.deepEqual(expired.map((e) => e.requestId).sort(), ['a', 'b', 'c'])
  })

  // #7382 review: `_clearTurnEndState` is NOT the funnel. It has exactly two
  // call sites (the success path and `_finishTurnError`). Three more death
  // paths route through the SIBLING helper `_teardownTurn`, and two end the
  // turn by hand-nulling the busy triple. Wiring only the first and calling it
  // "the funnel" is the same defect #7375 hit — a comment claiming a stronger
  // guarantee than the code delivers. Every path below genuinely ends the turn
  // (each sets `_isBusy = false`), so every one must expire.
  const DEATH_PATHS = [
    ['_handleHardTimeout', (s) => s._handleHardTimeout()],
    ['_handleStreamStall', (s) => s._handleStreamStall()],
    ['_handleFirstOutputTimeout', (s) => s._handleFirstOutputTimeout()],
    ['_onPtyGone (PTY exit/crash)', (s) => s._onPtyGone('exit')],
  ]

  for (const [name, drive] of DEATH_PATHS) {
    it(`THE GAP: ${name} ends the turn, so it must expire the prompt`, () => {
      session.notifyPermissionPending('perm-path')
      drive(session)
      assert.equal(session._isBusy, false, `${name} really ended the turn`)
      assert.deepEqual(
        expired.map((e) => e.requestId),
        ['perm-path'],
        `${name} ended the turn without expiring — the card stays live and the daemon entry is never released`,
      )
    })
  }

  it('THE GAP: destroy() expires too', async () => {
    session.notifyPermissionPending('perm-destroy')
    await session.destroy()
    assert.deepEqual(expired.map((e) => e.requestId), ['perm-destroy'])
  })

  it('POSITIVE CONTROL: a turn ending with nothing pending emits nothing', () => {
    session._clearTurnEndState()
    assert.equal(expired.length, 0, 'not fired unconditionally')
  })

  it('POSITIVE CONTROL: a resolved prompt is not expired afterwards', () => {
    session.notifyPermissionPending('perm-answered')
    session.notifyPermissionResolved('perm-answered')

    session._clearTurnEndState()

    assert.equal(expired.length, 0, 'an answered prompt is not reported as expired')
  })

  it('an empty or missing reason is coerced, never emitted as-is', () => {
    // ServerPermissionExpiredSchema declares `message: z.string()`, so an empty
    // one fails validation at the client. The doc claimed this was required and
    // the code did not enforce it — comment stronger than code, the same class
    // this change is about.
    session.notifyPermissionPending('perm-empty')
    session._expirePendingPermissions('')
    assert.equal(expired.length, 1)
    assert.equal(typeof expired[0].message, 'string')
    assert.ok(expired[0].message.length > 0, 'empty reason coerced to a generic one')

    expired.length = 0
    session.notifyPermissionPending('perm-undef')
    session._expirePendingPermissions(undefined)
    assert.ok(expired[0].message.length > 0, 'missing reason coerced too')
  })

  it('POSITIVE CONTROL: a real reason is passed through verbatim, not overwritten', () => {
    session.notifyPermissionPending('perm-real')
    session._expirePendingPermissions('a specific reason')
    assert.equal(expired[0].message, 'a specific reason')
  })

  it('every expiry carries a non-empty message (the wire schema requires it)', () => {
    session.notifyPermissionPending('perm-msg')
    session._clearTurnEndState()
    assert.equal(expired.length, 1)
    assert.equal(typeof expired[0].message, 'string')
    assert.ok(expired[0].message.length > 0)
  })
})

describe('#7382 — the bookkeeping lives on BaseSession, so it cannot be forgotten again', () => {
  it('BaseSession itself provides the API', () => {
    assert.equal(typeof BaseSession.prototype.notifyPermissionPending, 'function')
    assert.equal(typeof BaseSession.prototype.notifyPermissionResolved, 'function')
    assert.equal(typeof BaseSession.prototype._expirePendingPermissions, 'function')
  })

  it('claude-cli still has it (inherited, not lost in the hoist)', () => {
    assert.equal(typeof CliSession.prototype.notifyPermissionPending, 'function')
    assert.equal(typeof CliSession.prototype._expirePendingPermissions, 'function')
  })

  it('THE GUARD: every hook-routed session EXPIRES on turn death, not merely has the methods', async () => {
    // The roster is DERIVED, not hardcoded: any src/*-session.js that uses
    // `this._hookSecret` is hook-routed and must qualify. A hardcoded list beside
    // a growing set is the first cause in docs/false-safety-guards.md.
    //
    // And this asserts BEHAVIOUR, not method presence. The first version checked
    // `typeof cls.prototype.notifyPermissionPending === 'function'` — which, once
    // the methods moved onto BaseSession, was guaranteed by inheritance for every
    // candidate the loop could ever see. Proven tautological in review: a fake
    // BaseSession subclass that minted a _hookSecret and wired NOTHING passed,
    // and deleting claude-tui's expiry left it green too. A check that passes for
    // everything is #7273's shape, and it was sitting in the test that cites the
    // catalogue.
    //
    // destroy() is the probe because every session has one and it must end the
    // turn. A provider that overrides it without reaching _clearMessageState —
    // which is exactly how claude-tui's _teardownTurn escaped — fails here.
    const srcDir = join(HERE, '../src')
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(srcDir).filter((f) => f.endsWith('-session.js') && f !== 'base-session.js')
    // `this._hookSecret`, not a bare `_hookSecret`: the loose form matches any
    // PROSE mention, and it immediately did — a comment added to base-session.js
    // while writing this fix put the base class itself on the roster. A detector
    // a comment can move is not measuring what it claims to.
    const hookRouted = files.filter((f) => readFileSync(join(srcDir, f), 'utf-8').includes('this._hookSecret'))

    assert.ok(hookRouted.length >= 2, `expected at least cli + tui, got ${JSON.stringify(hookRouted)}`)
    // The detector must DISCRIMINATE, not match everything.
    assert.ok(files.includes('sdk-session.js'), 'control: sdk-session.js is in the scanned set')
    assert.ok(!hookRouted.includes('sdk-session.js'), 'control: the in-process provider is excluded')
    assert.ok(hookRouted.length < files.length, 'control: the roster is a strict subset')

    const tmpDirs = []
    for (const file of hookRouted) {
      // pathToFileURL, not a bare path: the CI runner's checkout is on A:\, and
      // Node's ESM loader rejects a Windows absolute path outright
      // (ERR_UNSUPPORTED_ESM_URL_SCHEME — "Received protocol 'a:'"). Caught by
      // Server Windows Tests, which is the only job that runs this on Windows.
      const mod = await import(pathToFileURL(join(srcDir, file)).href)
      const cls = Object.values(mod).find(
        (v) => typeof v === 'function' && v.prototype instanceof BaseSession,
      )
      assert.ok(
        cls,
        `${file} is hook-routed but exports no BaseSession subclass. Config-driven providers ` +
        `export a factory instead — extend this guard to construct it rather than deleting the check.`,
      )

      // Construction failure is a FAILURE, not a skip: "cannot check" silently
      // becoming "nothing to check" is the second cause in the catalogue.
      const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-guard-'))
      tmpDirs.push(skillsDir)
      let probe
      try {
        probe = new cls({ cwd: tmpdir(), skillsDir, repoSkillsDir: null })
      } catch (err) {
        assert.fail(`${file}: could not construct for the behavioural probe (${err?.message}). Add the opts it needs — do not skip it.`)
      }
      probe.on('error', () => {})
      const seen = []
      probe.on('permission_expired', (d) => seen.push(d))

      // Assert the probe exists rather than letting a missing method surface as
      // a TypeError: an unclear failure reason is how a real finding gets
      // dismissed as "the test is broken".
      assert.equal(
        typeof probe.destroy,
        'function',
        `${file} exposes no destroy() — every session must have one, and it is the probe this guard drives`,
      )

      probe.notifyPermissionPending('guard-probe')
      assert.equal(probe._pendingPermissionIds.size, 1, `${file}: precondition — the prompt is tracked`)

      await probe.destroy()

      assert.deepEqual(
        seen.map((d) => d.requestId),
        ['guard-probe'],
        `${file} ended its session without expiring a pending prompt — the client card stays live ` +
        `and the daemon entry is never released (#7379/#7382)`,
      )
    }
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
  })
})

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'

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
  const session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
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

  it('THE GUARD: every hook-routed session class has the bookkeeping', async () => {
    // The roster is DERIVED, not hardcoded: any src/*-session.js that mints a
    // _hookSecret is hook-routed and must qualify. A hardcoded list beside a
    // growing set is the first cause in docs/false-safety-guards.md, and a new
    // provider is exactly the thing that would be added without updating it.
    const srcDir = join(HERE, '../src')
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(srcDir).filter((f) => f.endsWith('-session.js') && f !== 'base-session.js')
    // `this._hookSecret`, not a bare `_hookSecret`: the loose form matches any
    // PROSE mention, and it immediately did — a comment added to base-session.js
    // while writing this fix put the base class itself on the roster. A detector
    // that a comment can move is not measuring what it claims to.
    const hookRouted = files.filter((f) => readFileSync(join(srcDir, f), 'utf-8').includes('this._hookSecret'))

    assert.ok(hookRouted.length >= 2, `expected at least cli + tui, got ${JSON.stringify(hookRouted)}`)
    // The detector must DISCRIMINATE, not match everything: a predicate that is
    // true for every file would satisfy the loop below for the wrong reason and
    // keep passing when a genuinely hook-routed provider is added without the
    // bookkeeping. sdk-session.js routes permissions in-process through
    // PermissionManager and must NOT be on this roster.
    assert.ok(files.includes('sdk-session.js'), 'control: sdk-session.js is in the scanned set')
    assert.ok(
      !hookRouted.includes('sdk-session.js'),
      'control: the detector excludes the in-process (non-hook-routed) provider',
    )
    assert.ok(hookRouted.length < files.length, 'control: the roster is a strict subset')

    for (const file of hookRouted) {
      const mod = await import(join(srcDir, file))
      const cls = Object.values(mod).find(
        (v) => typeof v === 'function' && v.prototype instanceof BaseSession,
      )
      assert.ok(cls, `no BaseSession subclass exported from ${file}`)
      assert.equal(
        typeof cls.prototype.notifyPermissionPending,
        'function',
        `${file} is hook-routed but has no notifyPermissionPending — ws-permissions will silently skip it`,
      )
      assert.equal(
        typeof cls.prototype._expirePendingPermissions,
        'function',
        `${file} is hook-routed but cannot expire its prompts on turn death`,
      )
    }
  })
})

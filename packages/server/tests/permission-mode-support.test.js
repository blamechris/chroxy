import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SdkSession } from '../src/sdk-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { SessionManager } from '../src/session-manager.js'
import { getPermissionModes } from '../src/handler-utils.js'

const tempDir = mkdtempSync(join(tmpdir(), 'permission-mode-support-'))

after(() => rmSync(tempDir, { recursive: true, force: true }))

function manager(providerType, defaultPermissionMode = 'approve') {
  return new SessionManager({
    providerType,
    defaultPermissionMode,
    defaultCwd: tempDir,
    stateFilePath: join(tempDir, `${providerType}-${defaultPermissionMode}-${Math.random()}.json`),
    skipPreflight: true,
  })
}

describe('permission-mode adapter support (#7825)', () => {
  describe('codex app-server', () => {
    const ProviderClass = CodexAppServerSession

    it('rejects Auto at direct construction, before a turn can start', () => {
      assert.throws(
        () => new ProviderClass({ cwd: tempDir, permissionMode: 'auto' }),
        /Auto permission mode.*unsupported.*protected-path/i,
      )
    })

    it('rejects explicit Auto in the SessionManager create plan', () => {
      const mgr = manager('codex')
      assert.throws(
        () => mgr._resolveCreateSessionPlan({
          provider: 'codex',
          permissionMode: 'auto',
        }),
        /Auto permission mode.*unsupported.*protected-path/i,
      )
    })

    it('rejects a configured Auto default before provider construction', () => {
      const mgr = manager('codex', 'auto')
      assert.throws(
        () => mgr._resolveCreateSessionPlan({ provider: 'codex' }),
        /Auto permission mode.*unsupported.*protected-path/i,
      )
    })

    it('rejects a persisted Auto session during restore before provider construction', () => {
      const mgr = manager('codex')
      // Exercise _attemptRestoreOne's production option forwarding while
      // stopping after the shared create-plan validation. If the guard is
      // removed, this throws a distinct sentinel instead of starting codex.
      mgr.createSession = (args) => {
        mgr._resolveCreateSessionPlan(args)
        throw new Error('provider construction reached')
      }
      assert.throws(
        () => mgr._attemptRestoreOne({
          id: '0123456789abcdef0123456789abcdef',
          name: 'Restored Codex Auto',
          cwd: tempDir,
          provider: 'codex',
          permissionMode: 'auto',
          history: [],
        }, true),
        /Auto permission mode.*unsupported.*protected-path/i,
      )
      assert.equal(mgr.listSessions().length, 0)
    })

    it('keeps Approve, Accept Edits, and Plan available', () => {
      for (const permissionMode of ['approve', 'acceptEdits', 'plan']) {
        const session = new ProviderClass({ cwd: tempDir, permissionMode })
        assert.equal(session.permissionMode, permissionMode)
        session.destroy()
      }
    })

    it('cannot switch an existing session to Auto', () => {
      const session = new ProviderClass({ cwd: tempDir, permissionMode: 'approve' })
      assert.equal(session.setPermissionMode('auto'), false)
      assert.equal(session.permissionMode, 'approve')
      session.destroy()
    })

    it('advertises Auto as unsupported and the remaining modes as Chroxy-enforced', () => {
      const modes = getPermissionModes('codex', ProviderClass)
      const auto = modes.find((mode) => mode.id === 'auto')
      assert.deepEqual(
        { supported: auto?.supported, enforcement: auto?.enforcement },
        { supported: false, enforcement: 'unsupported' },
      )
      assert.match(auto?.label || '', /unavailable/i)
      assert.match(auto?.description || '', /cannot intercept.*before execution/i)
      for (const id of ['approve', 'acceptEdits', 'plan']) {
        const mode = modes.find((candidate) => candidate.id === id)
        assert.deepEqual(
          { supported: mode?.supported, enforcement: mode?.enforcement },
          { supported: true, enforcement: 'chroxy' },
        )
      }
    })
  })

  it('Claude SDK advertises Auto as supported through its Chroxy PreToolUse bridge', () => {
    const auto = getPermissionModes('claude-sdk', SdkSession).find((mode) => mode.id === 'auto')
    assert.deepEqual(
      { supported: auto?.supported, enforcement: auto?.enforcement },
      { supported: true, enforcement: 'chroxy' },
    )
  })

  it('older/unknown provider capability data is labelled unknown without disabling modes', () => {
    const modes = getPermissionModes('future-provider', class {})
    assert.equal(modes.every((mode) => mode.supported === true), true)
    assert.equal(modes.every((mode) => mode.enforcement === 'unknown'), true)
  })
})

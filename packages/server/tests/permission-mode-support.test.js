import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SdkSession } from '../src/sdk-session.js'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { CodexSession } from '../src/codex-session.js'
import { JsonlSubprocessSession } from '../src/jsonl-subprocess-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { SessionManager } from '../src/session-manager.js'
import { getPermissionModes } from '../src/handler-utils.js'
import { getProviderPermissionModeSupport } from '../src/permission-mode-support.js'

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
  it('keeps legacy default construction usable while rejecting explicitly requested Auto', () => {
    const session = new CodexSession({ cwd: tempDir })
    assert.equal(session.permissionMode, 'approve')
    session.destroy()
    assert.throws(
      () => new CodexSession({ cwd: tempDir, permissionMode: 'auto' }),
      (error) => error.code === 'PERMISSION_MODE_UNSUPPORTED',
    )
  })

  it('does not evaluate an abstract provider label for a supported mode', () => {
    const session = new JsonlSubprocessSession({ cwd: tempDir, permissionMode: 'approve' })
    assert.equal(session.permissionMode, 'approve')
    session.destroy()
  })

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

    it('advertises Auto as unsupported and leaves other modes unverified by Chroxy', () => {
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
          { supported: true, enforcement: 'unknown' },
        )
        assert.equal(mode.description.includes('always require a Chroxy prompt'), false)
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

// #8090: claude-tui declares `capabilities.planMode: false` (claude-tui-session.js)
// but getProviderPermissionModeSupport() never checked it, so the advertised
// `available_permission_modes` list (and therefore the mobile SettingsBar chip
// row + any other client that trusts the server flag) reported `plan` as fully
// supported on a provider whose PreToolUse hook does NOT route plan-mode tool
// calls through Chroxy's protected-path floor the way approve/acceptEdits/auto
// all do (see hooks/permission-hook.sh's PERM_MODE branches: plan returns
// `{"permissionDecision":"ask"}` unconditionally, with no floor_forces_prompt
// check at all — the raw claude TUI process's own PTY-embedded prompt is the
// only thing left standing between a tool call and execution).
//
// The fix is scoped to the ADVERTISED list only (getPermissionModes /
// handler-utils.js), not to `getProviderPermissionModeSupport()` itself, which
// still feeds `assertProviderPermissionModeSupported` (session-manager.js's
// create/restore chokepoint, BaseSession's constructor) and
// `BaseSession.setPermissionMode()`. Those three call sites must keep
// accepting `plan` on EVERY provider, including claude-tui itself: see the
// "keeps Approve, Accept Edits, and Plan available" test above (codex
// app-server also declares `planMode: false` yet must stay constructible with
// `permissionMode: 'plan'`) and claude-tui-session.test.js's "setPermissionMode
// no-ops cleanly when sidecar path is null" test (asserts a direct
// `setPermissionMode('plan')` call still updates state on claude-tui). A
// blanket `capabilities.planMode === false` branch in the shared function
// would throw on THOSE, and would also throw during boot restore of any
// already-persisted claude-tui session that happens to be in `plan` mode
// today (nothing has ever gated `plan` at create/restore time) — turning a
// live, resumable PTY session into a "needs attention" failed-restore
// placeholder over what is really just an advertising correction. So
// `getProviderPermissionModeSupport` is left completely unchanged (see the
// "hard-gate call sites stay unaffected" tests below), and the override lives
// only in `getPermissionModes`, scoped to `provider === 'claude-tui'` — codex
// (MODE_DESCRIPTIONS.codex.plan: "Not a distinct codex mode — behaves like
// Approve") already documents the identical `planMode: false` situation as a
// deliberate, harmless alias and is intentionally left advertised as
// supported (see the existing "advertises Auto as unsupported..." test
// above), so this fix does not touch it.
describe('plan permission mode advertising (#8090)', () => {
  it('reports plan unsupported for claude-tui, mirroring the auto/autoPermissionMode shape', () => {
    const modes = getPermissionModes('claude-tui', ClaudeTuiSession)
    const plan = modes.find((mode) => mode.id === 'plan')
    assert.deepEqual(
      { supported: plan?.supported, enforcement: plan?.enforcement },
      { supported: false, enforcement: 'unsupported' },
    )
    assert.match(plan?.label || '', /unavailable/i)
    assert.match(plan?.description || '', /no plan mode/i)
    for (const id of ['approve', 'acceptEdits', 'auto']) {
      const mode = modes.find((candidate) => candidate.id === id)
      assert.equal(mode?.supported, true, `${id} must stay supported`)
    }
  })

  it('still reports plan supported for a provider that does not declare planMode (absence is not unsupported)', () => {
    // Deliberately provider === 'claude-tui' with a stub class that has NO
    // capabilities getter at all — proves the check keys off the actual
    // declared capability, not just the provider name, and that a missing
    // declaration is treated as supported (same convention `auto` already
    // uses for autoPermissionMode absence).
    const modes = getPermissionModes('claude-tui', class {})
    const plan = modes.find((mode) => mode.id === 'plan')
    assert.equal(plan?.supported, true)
  })

  it('leaves codex advertised as plan-supported (documented alias for Approve, unrelated to this gap)', () => {
    const modes = getPermissionModes('codex', CodexAppServerSession)
    const plan = modes.find((mode) => mode.id === 'plan')
    assert.equal(plan?.supported, true, 'codex plan mode is a deliberate, pre-existing exception — see MODE_DESCRIPTIONS.codex.plan')
  })

  describe('hard-gate call sites stay unaffected (restore/construct/setPermissionMode)', () => {
    it('getProviderPermissionModeSupport itself still reports plan as supported for claude-tui', () => {
      // The raw function — used by assertProviderPermissionModeSupported and
      // BaseSession.setPermissionMode — must NOT change; only the advertised
      // list built by getPermissionModes() does.
      const support = getProviderPermissionModeSupport(ClaudeTuiSession, 'plan')
      assert.equal(support.supported, true)
    })

    it('constructs a claude-tui session with permissionMode: "plan" without throwing', () => {
      const session = new ClaudeTuiSession({ cwd: tempDir, permissionMode: 'plan' })
      assert.equal(session.permissionMode, 'plan')
      session.destroy()
    })

    it('does not throw when resolving a create/restore plan for a claude-tui session requesting plan mode', () => {
      const mgr = manager('claude-tui')
      const plan = mgr._resolveCreateSessionPlan({ provider: 'claude-tui', permissionMode: 'plan' })
      assert.equal(plan.resolvedPermissionMode, 'plan')
    })

    it('restores a persisted claude-tui session that is already in plan mode instead of failing the restore', () => {
      const mgr = manager('claude-tui')
      mgr.createSession = (args) => {
        mgr._resolveCreateSessionPlan(args)
        throw new Error('provider construction reached — this test only exercises the shared create-plan validation')
      }
      // If this throws, boot restore would drop the session into the
      // "needs attention" failed-restore bucket over an advertising-only
      // capability correction — exactly the regression this fix must avoid.
      assert.throws(
        () => mgr._attemptRestoreOne({
          id: '0123456789abcdef0123456789abcdef',
          name: 'Restored TUI Plan',
          cwd: tempDir,
          provider: 'claude-tui',
          permissionMode: 'plan',
          history: [],
        }, true),
        /provider construction reached/,
      )
    })
  })
})

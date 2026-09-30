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
import { GeminiSession } from '../src/gemini-session.js'
import { CliSession } from '../src/cli-session.js'
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
      // #8090: `plan` moved out of this "stays supported" loop, alongside
      // `auto` — codex-app-server ALSO declares `capabilities.planMode:
      // false`, and the advertised list now follows that capability
      // directly for every provider (parity with the dashboard's #8087/
      // #8084 client-side gate: `showPlanMode: caps?.planMode !== false`),
      // rather than special-casing claude-tui by name. The "keeps Approve,
      // Accept Edits, and Plan available" test above proves `plan` still
      // stays constructible/settable at the hard-gate layer on this same
      // provider — only the advertised flag changed.
      const plan = modes.find((mode) => mode.id === 'plan')
      assert.deepEqual(
        { supported: plan?.supported, enforcement: plan?.enforcement },
        { supported: false, enforcement: 'unsupported' },
      )
      assert.match(plan?.label || '', /unavailable/i)
      for (const id of ['approve', 'acceptEdits']) {
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

// #8090: any provider that declares `capabilities.planMode: false`
// (claude-tui, codex app-server/-exec, byok, sdk-session, gemini, ...) had
// its PreToolUse-hook-level reality (plan mode gives no genuine, chroxy-
// guaranteed read-only restriction — see claude-tui's hooks/permission-hook.sh:
// unlike approve/acceptEdits/auto, its `PERM_MODE=plan` branch skips the
// floor_forces_prompt check entirely and just returns
// `{"permissionDecision":"ask"}`, leaving the raw claude TUI process's own
// PTY-embedded prompt — invisible to the structured chat UI — as the only
// thing standing between a tool call and execution) disagree with what
// getProviderPermissionModeSupport() advertised: `plan` came back fully
// `supported: true` regardless of the capability.
//
// The dashboard has applied the correct, capability-only rule since
// #8087/#8084 (`packages/dashboard/src/App.tsx`'s
// `showPlanMode: caps?.planMode !== false`, `CreateSessionModal.tsx`): ANY
// provider with `planMode: false` has "Plan" hidden, not just claude-tui. So
// the server-side fix here follows the exact same capability-only rule —
// `modeId === 'plan' && ProviderClass?.capabilities?.planMode === false` —
// with no provider-name special-casing, so every client that trusts the
// server flag (mobile, dashboard, any future client) agrees with the
// dashboard instead of disagreeing per provider. A provider-name-keyed
// version of this check would also be the "hardcoded list beside a growing
// set" shape docs/false-safety-guards.md catalogues as a recurring defect
// class — the set of `planMode: false` providers already has six members
// today and is not enumerable up front.
//
// This is intentionally NOT folded into `getProviderPermissionModeSupport()`
// itself, which also feeds `assertProviderPermissionModeSupported`
// (session-manager.js's create/restore chokepoint, BaseSession's
// constructor) and `BaseSession.setPermissionMode()`. Those three
// deliberately keep accepting `plan` on every provider regardless of
// `planMode` — see "keeps Approve, Accept Edits, and Plan available" above
// (codex app-server stays constructible with `permissionMode: 'plan'`) and
// claude-tui-session.test.js's "setPermissionMode no-ops cleanly when
// sidecar path is null" (asserts a direct `setPermissionMode('plan')` call
// still updates state on claude-tui) — so a blanket capability check in the
// shared function would throw on THOSE, and would also throw during boot
// restore of any already-persisted `plan`-mode session on any of these
// providers (nothing has ever gated `plan` at create/restore time), turning
// a live, resumable session into a "needs attention" failed-restore
// placeholder over what is really just an advertising correction. So
// `getProviderPermissionModeSupport` is left completely unchanged (see the
// "hard-gate call sites stay unaffected" tests below), and the capability
// check lives only in `getPermissionModes()`.
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

  it('reports plan unsupported for a NON-claude-tui provider that declares planMode: false (gemini)', () => {
    // The check is capability-only, not keyed on the provider name — gemini
    // declares `capabilities.planMode: false` (gemini-session.js) just like
    // claude-tui does, and must get the identical treatment.
    const modes = getPermissionModes('gemini', GeminiSession)
    const plan = modes.find((mode) => mode.id === 'plan')
    assert.deepEqual(
      { supported: plan?.supported, enforcement: plan?.enforcement },
      { supported: false, enforcement: 'unsupported' },
    )
    assert.match(plan?.label || '', /unavailable/i)
  })

  it('reports plan unsupported for codex too — the check no longer exempts it by name', () => {
    const modes = getPermissionModes('codex', CodexAppServerSession)
    const plan = modes.find((mode) => mode.id === 'plan')
    assert.equal(plan?.supported, false, 'codex declares capabilities.planMode: false and gets the same capability-only treatment as every other provider')
  })

  it('still reports plan supported for a provider that does not declare planMode at all (absence is not unsupported)', () => {
    // A bare stub class with NO capabilities getter — proves a missing
    // declaration is treated as supported, same convention `auto` already
    // uses for autoPermissionMode absence.
    const modes = getPermissionModes('future-provider', class {})
    const plan = modes.find((mode) => mode.id === 'plan')
    assert.equal(plan?.supported, true)
  })

  it('reports plan supported for cli-session, the one provider that declares planMode: true', () => {
    const modes = getPermissionModes('cli', CliSession)
    const plan = modes.find((mode) => mode.id === 'plan')
    assert.equal(plan?.supported, true)
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

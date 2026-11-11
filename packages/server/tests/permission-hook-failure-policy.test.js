import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { countUserLevelChroxyHooks, createPermissionHookManager, userLevelHookCommand } from '../src/permission-hook.js'
import { SdkSession } from '../src/sdk-session.js'

/**
 * What happens when a permission hook itself fails: the script cannot be run,
 * Claude Code cancels it, or the in-process check behind it throws. In each
 * case the hook has produced no decision, and a missing decision must not be
 * read as permission.
 *
 * Three places register something that decides a tool call:
 *
 *   1. the claude-tui per-session `--settings` entry (covered in
 *      permission-deadline-chain.test.js);
 *   2. the claude-cli entry in the user's own Claude settings — here;
 *   3. the Agent SDK's PreToolUse callback on an Auto turn — here.
 *
 * WHAT THIS FILE DOES NOT PROVE. Claude Code is never run. The tests show what
 * chroxy writes and what the written command does under a real shell (its exit
 * status and output); that Claude Code turns a failed hook carrying
 * `onFailure: "block"` into a blocked tool call is its behaviour, not ours.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const realHookScript = join(__dirname, '../hooks/permission-hook.sh')
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'runs the registered command through /bin/sh' : false }

// Written out, not built by calling the subject.
const GUARD = '[ -n "$CHROXY_PORT" ] && [ "$CHROXY_TUI_CHILD" != 1 ] || exit 0; exec '

let scratch
before(() => { scratch = mkdtempSync(join(tmpdir(), 'chroxy-hook-failure-policy-')) })
after(() => { rmSync(scratch, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// 1. The user-level (claude-cli) registration
// ---------------------------------------------------------------------------

async function registerInto(settingsPath, hookScript) {
  const manager = createPermissionHookManager(new EventEmitter(), { settingsPath, hookScript })
  await manager.register()
  return manager
}

describe('user-level permission hook registration: what it writes', () => {
  it('guards the command, exec-s the script, and blocks on failure', async () => {
    const dir = mkdtempSync(join(scratch, 'reg-'))
    const settingsPath = join(dir, 'settings.json')
    const script = '/opt/chroxy/packages/server/hooks/permission-hook.sh'
    const manager = await registerInto(settingsPath, script)
    try {
      const entry = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0]
      assert.equal(entry._chroxy, true)
      assert.equal(entry.hooks.length, 1)
      assert.deepEqual(entry.hooks[0], {
        type: 'command',
        command: `${GUARD}${script}`,
        timeout: 330,
        onFailure: 'block',
      })
    } finally {
      await manager.destroy()
    }
  })

  it('shell-quotes a script path that needs it, inside the guarded command', () => {
    assert.equal(
      userLevelHookCommand('/Applications/My Apps/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh'),
      `${GUARD}'/Applications/My Apps/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh'`,
    )
    assert.equal(
      userLevelHookCommand("/tmp/it's here/chroxy/packages/server/hooks/permission-hook.sh"),
      `${GUARD}'/tmp/it'\\''s here/chroxy/packages/server/hooks/permission-hook.sh'`,
    )
  })

  it('an entry with the guarded command is still recognised as chroxy\'s without its marker', () => {
    const dir = mkdtempSync(join(scratch, 'orphan-'))
    const settingsPath = join(dir, 'settings.json')
    for (const script of [
      '/Users/x/Projects/chroxy/packages/server/hooks/permission-hook.sh',
      '/Applications/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh',
      '/Users/x y/Projects/chroxy/packages/server/hooks/permission-hook.sh',
    ]) {
      writeFileSync(settingsPath, JSON.stringify({
        hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: userLevelHookCommand(script), timeout: 330, onFailure: 'block' }] }] },
      }))
      assert.equal(countUserLevelChroxyHooks({ settingsPath }).found, 1, script)
    }
  })

  it('registering again replaces an entry written in the older, unguarded form', async () => {
    const dir = mkdtempSync(join(scratch, 'replace-'))
    const settingsPath = join(dir, 'settings.json')
    const script = '/opt/chroxy/packages/server/hooks/permission-hook.sh'
    writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [
        { _chroxy: true, matcher: '', hooks: [{ type: 'command', command: script, timeout: 300 }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] },
      ] },
    }))
    const manager = await registerInto(settingsPath, script)
    try {
      const entries = JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PreToolUse
      assert.equal(entries.length, 2)
      const mine = entries.find((e) => e.matcher === 'Bash')
      assert.deepEqual(mine.hooks, [{ type: 'command', command: 'echo mine' }], 'the user\'s own hook is untouched')
      const ours = entries.find((e) => e._chroxy)
      assert.equal(ours.hooks[0].command, `${GUARD}${script}`)
      assert.equal(ours.hooks[0].onFailure, 'block')
    } finally {
      await manager.destroy()
    }
  })
})

/** Run a command string the way Claude Code runs a hook: through a shell, with stdin. */
function runThroughShell(shell, command, { env = {}, stdin = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', command], { env: { PATH: process.env.PATH, ...env } })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.stdin.on('error', () => {})
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }) })
    child.stdin.end(stdin)
  })
}

describe('user-level permission hook registration: what the command does under a real shell', POSIX_ONLY, () => {
  let stubScript
  let missingScript
  let notExecutable
  before(() => {
    const dir = mkdtempSync(join(scratch, 'scripts-'))
    // Path segments chosen so the command also exercises quoting.
    mkdirSync(join(dir, 'with space'))
    stubScript = join(dir, 'with space', 'permission-hook.sh')
    writeFileSync(stubScript, '#!/bin/sh\nprintf \'ran:\'\ncat -\nexit 7\n')
    chmodSync(stubScript, 0o755)
    missingScript = join(dir, 'gone', 'permission-hook.sh')
    notExecutable = join(dir, 'with space', 'not-executable.sh')
    writeFileSync(notExecutable, '#!/bin/sh\necho should-not-run\n')
    chmodSync(notExecutable, 0o644)
  })

  for (const shell of ['/bin/sh', '/bin/bash']) {
    describe(shell, () => {
      // A leftover entry in a session that is not Chroxy's: nothing happens,
      // whether or not the script it points at still exists.
      for (const [label, env] of [
        ['no CHROXY_PORT', {}],
        ['an empty CHROXY_PORT', { CHROXY_PORT: '' }],
        ['a claude-tui child', { CHROXY_PORT: '8765', CHROXY_TUI_CHILD: '1' }],
      ]) {
        it(`${label}: exits 0 and prints nothing, even when the script is gone`, async () => {
          for (const script of [missingScript, stubScript, notExecutable]) {
            const r = await runThroughShell(shell, userLevelHookCommand(script), { env })
            assert.equal(r.status, 0, `${script}: ${r.stderr}`)
            assert.equal(r.stdout, '', script)
          }
        })
      }

      it('a claude-cli session: the script runs, gets the hook input on stdin, and its exit status is the command\'s', async () => {
        const r = await runThroughShell(shell, userLevelHookCommand(stubScript), { env: { CHROXY_PORT: '8765' }, stdin: '{"tool_name":"Bash"}' })
        assert.equal(r.stdout, 'ran:{"tool_name":"Bash"}')
        assert.equal(r.status, 7, 'exec: the script\'s own status, not the shell\'s')
      })

      it('a claude-cli session whose script is gone: the command FAILS (non-zero), it does not exit 0', async () => {
        const r = await runThroughShell(shell, userLevelHookCommand(missingScript), { env: { CHROXY_PORT: '8765' } })
        assert.notEqual(r.status, 0, 'a hook that could not run must not look like a hook that ran and had nothing to say')
        assert.equal(r.stdout, '')
      })

      it('a claude-cli session whose script is not executable: the command FAILS', async () => {
        const r = await runThroughShell(shell, userLevelHookCommand(notExecutable), { env: { CHROXY_PORT: '8765' } })
        assert.notEqual(r.status, 0)
        assert.equal(r.stdout, '', 'and the script did not run')
      })

      it('CHROXY_TUI_CHILD set to anything but 1 does not switch the hook off', async () => {
        const r = await runThroughShell(shell, userLevelHookCommand(stubScript), { env: { CHROXY_PORT: '8765', CHROXY_TUI_CHILD: '0' } })
        assert.equal(r.status, 7)
      })
    })
  }

  it('end to end with the REAL script: a claude-cli session with nothing listening gets the script\'s own deny', async () => {
    const srv = createServer()
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const port = srv.address().port
    await new Promise((r) => srv.close(r))
    const r = await runThroughShell('/bin/sh', userLevelHookCommand(realHookScript), {
      env: { CHROXY_PORT: String(port), CHROXY_HOOK_SECRET: 's', CHROXY_PERMISSION_MODE: 'approve' },
      stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout.trim()).hookSpecificOutput
    assert.equal(out.permissionDecision, 'deny')
    assert.ok(/could not reach the daemon/.test(out.permissionDecisionReason), out.permissionDecisionReason)
  })

  it('end to end with the REAL script outside a Chroxy session: nothing', async () => {
    const r = await runThroughShell('/bin/sh', userLevelHookCommand(realHookScript), {
      stdin: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  })
})

// ---------------------------------------------------------------------------
// 2. The Agent SDK's PreToolUse callback on an Auto turn
// ---------------------------------------------------------------------------

describe('SDK Auto-turn PreToolUse callback: a permission check that fails is a deny', () => {
  const READ = { tool_name: 'Read', tool_input: { file_path: '/tmp/project/.env' } }
  const signal = () => new AbortController().signal

  function makeSession(handlePermission) {
    const session = new SdkSession({ cwd: '/tmp' })
    session._permissions.handlePermission = handlePermission
    return session
  }

  function assertDeny(out) {
    assert.equal(out?.continue, true)
    assert.equal(out?.hookSpecificOutput?.hookEventName, 'PreToolUse')
    assert.equal(out?.hookSpecificOutput?.permissionDecision, 'deny')
    assert.equal(typeof out.hookSpecificOutput.permissionDecisionReason, 'string')
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0)
    assert.equal('updatedInput' in out.hookSpecificOutput, false)
  }

  it('a check whose promise rejects resolves to a deny, it does not reject', async () => {
    const session = makeSession(() => Promise.reject(new Error('manager failed')))
    try {
      assertDeny(await session._handleAutoPreToolUse(READ, signal(), 'tu-1'))
    } finally {
      await session.destroy()
    }
  })

  it('a check that throws synchronously resolves to a deny', async () => {
    const session = makeSession(() => { throw new Error('manager threw') })
    try {
      assertDeny(await session._handleAutoPreToolUse(READ, signal(), 'tu-1'))
    } finally {
      await session.destroy()
    }
  })

  it('a check that rejects with a non-Error value resolves to a deny', async () => {
    const session = makeSession(() => Promise.reject('nope'))
    try {
      assertDeny(await session._handleAutoPreToolUse(READ, signal(), 'tu-1'))
    } finally {
      await session.destroy()
    }
  })

  it('an allow is still an allow, and a deny keeps its own reason', async () => {
    const allowing = makeSession(async () => ({ behavior: 'allow' }))
    const denying = makeSession(async () => ({ behavior: 'deny', message: 'User denied' }))
    try {
      const allowed = await allowing._handleAutoPreToolUse(READ, signal(), 'tu-1')
      assert.equal(allowed.hookSpecificOutput.permissionDecision, 'allow')
      const denied = await denying._handleAutoPreToolUse(READ, signal(), 'tu-2')
      assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
      assert.equal(denied.hookSpecificOutput.permissionDecisionReason, 'User denied')
    } finally {
      await allowing.destroy()
      await denying.destroy()
    }
  })
})

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

import { createPermissionHandler } from '../src/ws-permissions.js'
import { createPermissionHookManager, countUserLevelChroxyHooks } from '../src/permission-hook.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { writeHookSettings, sessionPermissionHookCommand, SESSION_SETTINGS_HOOK_MARKER } from '../src/claude-tui/pty-driver.js'
import { buildSpawnEnv } from '../src/utils/spawn-env.js'
import { shellQuotePath } from '../src/utils/verify-binary.js'

/**
 * #8263 — an orphaned user-level chroxy permission hook doubled every
 * claude-tui permission prompt and refused AskUserQuestion answers.
 *
 * A claude-tui child loads ~/.claude/settings.json AND its per-session
 * --settings file, so a chroxy entry stranded in the user-level file fires
 * permission-hook.sh a second time per tool call. The fix: inside a TUI child
 * (CHROXY_TUI_CHILD=1) only the copy invoked with `--session-settings` — the one
 * writeHookSettings registers — may decide; an unmarked copy exits silently.
 *
 * What is pinned here:
 *   1. the env flag / marker are produced by the real builders
 *   2. the REAL script, driven by the command string writeHookSettings WROTE
 *   3. THE FLOOR: the marked copy still enforces it (it is the only copy left
 *      that does, so an early exit in the wrong copy would un-floor every tool)
 *   4. the claude-cli path (user-level, no env flag) is unchanged
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dirname, '../hooks/permission-hook.sh')

const CWD = '/work/project'
const HOOK_SECRET = 'test-hook-secret'

function runCommand({ file, args, shellCommand, env, payload, timeout = 15000 }) {
  return new Promise((resolve, reject) => {
    const child = shellCommand
      ? spawn('/bin/sh', ['-c', shellCommand], { env })
      : spawn(file, args, { env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.stdout.on('data', (c) => { stdout += c.toString() })
    child.stderr.on('data', (c) => { stderr += c.toString() })
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

/** Real createPermissionHandler behind an http server serving both hook routes. */
async function startRealDaemon({ promptDecision = 'allow' } = {}) {
  const stats = { floorRequests: 0, permissionRequests: 0, prompts: [] }
  const pendingPermissions = new Map()
  let handler
  handler = createPermissionHandler({
    sendFn: () => {},
    broadcastFn: (msg) => {
      if (msg?.type !== 'permission_request') return
      stats.prompts.push(msg)
      setTimeout(() => handler.resolvePermission(msg.requestId, promptDecision), 0)
    },
    validateBearerAuth: () => true,
    validateHookAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap: new Map(),
    getSessionManager: () => null,
    pairingManager: null,
    findSessionByHookSecret: (secret) => (
      secret === HOOK_SECRET ? { session: { cwd: CWD }, sessionId: 'sess-1' } : null
    ),
  })
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/permission-floor') {
      stats.floorRequests++
      handler.handlePermissionFloorCheck(req, res)
      return
    }
    if (req.method === 'POST' && req.url === '/permission') {
      stats.permissionRequests++
      handler.handlePermissionRequest(req, res)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, r))
  return {
    port: server.address().port,
    stats,
    close: async () => {
      handler.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

const bash = (payload) => ({ tool_name: 'Bash', tool_input: { command: 'echo hookcheck' }, cwd: CWD, ...payload })
const read = (file_path) => ({ tool_name: 'Read', tool_input: { file_path }, cwd: CWD })
const ask = () => ({
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'red or blue?', header: 'c', multiSelect: false, options: [{ label: 'red' }, { label: 'blue' }] }] },
  cwd: CWD,
})
const decisionOf = (stdout) => JSON.parse(stdout.trim()).hookSpecificOutput

describe('claude-tui env + settings carry the #8263 flag and marker', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-8263-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writeHookSettings registers the permission hook WITH the marker', () => {
    const settings = JSON.parse(readFileSync(writeHookSettings(dir, { permissionsEnabled: true }), 'utf-8'))
    const hooks = settings.hooks.PreToolUse[0].hooks
    const permission = hooks.filter((h) => h.command.includes('permission-hook.sh'))
    assert.equal(permission.length, 1)
    assert.ok(permission[0].command.endsWith(` ${SESSION_SETTINGS_HOOK_MARKER}`), `got: ${permission[0].command}`)
  })

  it('_buildPtyEnv sets CHROXY_TUI_CHILD only when permissions are enabled', () => {
    const session = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: dir, repoSkillsDir: null })
    try {
      assert.equal(session._buildPtyEnv(true).CHROXY_TUI_CHILD, '1')
      assert.equal(session._buildPtyEnv(false).CHROXY_TUI_CHILD, undefined)
    } finally {
      session.destroy()
    }
  })

  it('an AMBIENT CHROXY_TUI_CHILD never reaches a TUI child that has no hook, or a claude-cli child', () => {
    const prev = process.env.CHROXY_TUI_CHILD
    process.env.CHROXY_TUI_CHILD = '1'
    const session = new ClaudeTuiSession({ cwd: '/tmp', port: 12345, skillsDir: dir, repoSkillsDir: null })
    try {
      assert.equal(session._buildPtyEnv(false).CHROXY_TUI_CHILD, undefined)
      // cli-session builds its child env through buildSpawnEnv('claude', extras):
      // an inherited flag there would make its legitimate user-level hook inert.
      assert.equal(buildSpawnEnv('claude', { CHROXY_PORT: '1' }).CHROXY_TUI_CHILD, undefined)
    } finally {
      session.destroy()
      if (prev === undefined) delete process.env.CHROXY_TUI_CHILD
      else process.env.CHROXY_TUI_CHILD = prev
    }
  })

  it('the claude-cli registration (user-level) carries no marker and is still recognised as ours', async () => {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, '{}')
    const mgr = createPermissionHookManager(new EventEmitter(), { settingsPath })
    await mgr.register()
    const entry = JSON.parse(readFileSync(settingsPath, 'utf-8')).hooks.PreToolUse[0]
    assert.equal(entry._chroxy, true)
    assert.ok(!entry.hooks[0].command.includes(SESSION_SETTINGS_HOOK_MARKER))
    // The registration quotes the script path only when it needs it, so compare
    // against the expected form for THIS checkout rather than a fixed suffix (a
    // checkout path with a space would otherwise fail on the closing quote).
    assert.equal(entry.hooks[0].command, shellQuotePath(resolve(hookPath)))
    await mgr.destroy()
  })
})

describe('permission-hook.sh in a claude-tui child (#8263)', () => {
  let daemon
  let dir
  let markedCommand
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8263-sh-'))
    // The command string EXACTLY as the session writes it for claude to run —
    // so a drift between the JS marker and the script's token fails here.
    const settings = JSON.parse(readFileSync(writeHookSettings(dir, { permissionsEnabled: true }), 'utf-8'))
    markedCommand = settings.hooks.PreToolUse[0].hooks.find((h) => h.command.includes('permission-hook.sh')).command
  })
  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
    rmSync(dir, { recursive: true, force: true })
  })

  const tuiEnv = (port, mode, extra = {}) => ({
    PATH: process.env.PATH,
    CHROXY_PORT: String(port),
    CHROXY_HOOK_SECRET: HOOK_SECRET,
    CHROXY_PERMISSION_MODE: mode,
    CHROXY_TUI_CHILD: '1',
    ...extra,
  })
  const runUnmarked = (env, payload) => runCommand({ file: '/bin/bash', args: [hookPath], env, payload })
  const runMarked = (env, payload) => runCommand({ shellCommand: markedCommand, env, payload })

  it('an UNMARKED copy (user-level orphan) makes no request and prints no decision', async () => {
    daemon = await startRealDaemon()
    for (const mode of ['approve', 'auto', 'acceptEdits']) {
      for (const payload of [bash(), read('.env')]) {
        const r = await runUnmarked(tuiEnv(daemon.port, mode), payload)
        assert.equal(r.status, 0, `${mode}/${payload.tool_name} exit`)
        assert.equal(r.stdout, '', `${mode}/${payload.tool_name} must print no decision`)
      }
    }
    assert.equal(daemon.stats.permissionRequests, 0, 'no /permission request from the orphan')
    assert.equal(daemon.stats.floorRequests, 0, 'no /permission-floor request from the orphan')
  })

  it('the MARKED copy still raises the permission request and returns the server decision', async () => {
    daemon = await startRealDaemon({ promptDecision: 'deny' })
    const r = await runMarked(tuiEnv(daemon.port, 'approve'), bash())
    assert.equal(r.status, 0)
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(r.stdout).permissionDecision, 'deny')
  })

  it('exactly ONE prompt per tool call when both copies run (the issue\'s step 2)', async () => {
    daemon = await startRealDaemon({ promptDecision: 'allow' })
    const env = tuiEnv(daemon.port, 'approve')
    const [orphan, session] = await Promise.all([runUnmarked(env, bash()), runMarked(env, bash())])
    assert.equal(orphan.stdout, '')
    assert.equal(decisionOf(session.stdout).permissionDecision, 'allow')
    assert.equal(daemon.stats.prompts.length, 1, 'one permission_request frame, not two')
  })

  it('AskUserQuestion: the orphan does not take the sibling lock the session copy needs (the issue\'s step 3)', async () => {
    daemon = await startRealDaemon()
    const env = tuiEnv(daemon.port, 'auto', { CHROXY_SINK_DIR: dir })
    // Worst-case ordering: the orphan runs FIRST, as it would if it won the race.
    const orphan = await runUnmarked(env, ask())
    const session = await runMarked(env, ask())
    assert.equal(orphan.stdout, '')
    const decision = decisionOf(session.stdout)
    assert.equal(decision.permissionDecision, 'allow', `session copy was refused: ${decision.permissionDecisionReason}`)
  })

  // ---- THE FLOOR: the marked copy is the only one left that enforces it ----

  it('FLOOR: the marked copy still consults /permission-floor and routes a protected path to a prompt', async () => {
    daemon = await startRealDaemon({ promptDecision: 'deny' })
    const r = await runMarked(tuiEnv(daemon.port, 'auto'), read('.env'))
    assert.equal(daemon.stats.floorRequests, 1, 'floor probed')
    assert.equal(daemon.stats.permissionRequests, 1, 'floored target raised a real prompt')
    assert.equal(decisionOf(r.stdout).permissionDecision, 'deny', 'the user\'s deny is honoured, not auto-allowed')
  })

  it('FLOOR: acceptEdits + a write into .git is still floored through the marked copy', async () => {
    daemon = await startRealDaemon({ promptDecision: 'deny' })
    const r = await runMarked(tuiEnv(daemon.port, 'acceptEdits'), {
      tool_name: 'Write', tool_input: { file_path: '.git/hooks/pre-commit', content: 'x' }, cwd: CWD,
    })
    assert.equal(daemon.stats.floorRequests, 1)
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(r.stdout).permissionDecision, 'deny')
  })

  it('FLOOR: an ordinary file under auto is still auto-allowed by the marked copy (no new friction)', async () => {
    daemon = await startRealDaemon({ promptDecision: 'deny' })
    const r = await runMarked(tuiEnv(daemon.port, 'auto'), read('src/index.js'))
    assert.equal(daemon.stats.floorRequests, 1)
    assert.equal(daemon.stats.permissionRequests, 0)
    assert.equal(decisionOf(r.stdout).permissionDecision, 'allow')
  })

  it('FLOOR: a daemon that cannot be reached fails closed through the marked copy', async () => {
    const srv = createServer()
    await new Promise((r) => srv.listen(0, r))
    const closedPort = srv.address().port
    await new Promise((r) => srv.close(r))
    const r = await runMarked(tuiEnv(closedPort, 'auto'), read('.env'))
    assert.equal(decisionOf(r.stdout).permissionDecision, 'deny')
  })

  // ---- outside a TUI child nothing changes ----

  it('claude-cli case: no CHROXY_TUI_CHILD, unmarked copy behaves exactly as before', async () => {
    daemon = await startRealDaemon({ promptDecision: 'allow' })
    const { CHROXY_TUI_CHILD, ...cliEnv } = tuiEnv(daemon.port, 'approve')
    assert.equal(CHROXY_TUI_CHILD, '1')
    const r = await runUnmarked(cliEnv, bash())
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(r.stdout).permissionDecision, 'allow')
  })

  it('claude-cli case: auto mode still floors an unmarked copy', async () => {
    daemon = await startRealDaemon({ promptDecision: 'deny' })
    const { CHROXY_TUI_CHILD: _unused, ...cliEnv } = tuiEnv(daemon.port, 'auto')
    const r = await runUnmarked(cliEnv, read('.env'))
    assert.equal(daemon.stats.floorRequests, 1)
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(r.stdout).permissionDecision, 'deny')
  })

  it('a stale env value other than "1" does not silence the hook (only the exact flag does)', async () => {
    daemon = await startRealDaemon({ promptDecision: 'allow' })
    const r = await runUnmarked(tuiEnv(daemon.port, 'approve', { CHROXY_TUI_CHILD: '0' }), bash())
    assert.equal(daemon.stats.permissionRequests, 1)
    assert.equal(decisionOf(r.stdout).permissionDecision, 'allow')
  })
})

describe('the per-session hook command survives an install path with shell metacharacters (#8263)', () => {
  // Claude runs a hook's `command` through a shell, and treats a hook that fails
  // to START (exit 127) as a NON-blocking error. An unquoted path containing a
  // space split into words, the hook never ran, and the one copy that enforces
  // the floor inside a TUI child was silently skipped. The path below holds a
  // space, a single quote and a `$`, which exercises the quoting end to end.
  let dir
  let daemon
  let quotedScript
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8263-quote-'))
    const scriptDir = join(dir, "it's a dir $HOME", 'hooks')
    mkdirSync(scriptDir, { recursive: true })
    quotedScript = join(scriptDir, 'permission-hook.sh')
    copyFileSync(hookPath, quotedScript)
    chmodSync(quotedScript, 0o755)
  })
  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
    rmSync(dir, { recursive: true, force: true })
  })

  const commandFor = (permissionHookScript) => {
    const settings = JSON.parse(readFileSync(writeHookSettings(dir, { permissionsEnabled: true, permissionHookScript }), 'utf-8'))
    return settings.hooks.PreToolUse[0].hooks.find((h) => h.command.includes('permission-hook.sh')).command
  }

  it('the written command is one shell word for the path, then the marker', () => {
    const command = commandFor(quotedScript)
    assert.ok(command.startsWith("'"), `path must be quoted: ${command}`)
    assert.ok(command.endsWith(`' ${SESSION_SETTINGS_HOOK_MARKER}`), `got: ${command}`)
    assert.equal(sessionPermissionHookCommand(quotedScript), command)
  })

  it('a plain path is written exactly as before (no quotes, existing entries unchanged)', () => {
    assert.equal(sessionPermissionHookCommand('/opt/chroxy/hooks/permission-hook.sh'), `/opt/chroxy/hooks/permission-hook.sh ${SESSION_SETTINGS_HOOK_MARKER}`)
  })

  it('run through sh -c it still reaches /permission-floor and /permission', async () => {
    daemon = await startRealDaemon({ promptDecision: 'deny' })
    const env = {
      PATH: process.env.PATH,
      CHROXY_PORT: String(daemon.port),
      CHROXY_HOOK_SECRET: HOOK_SECRET,
      CHROXY_PERMISSION_MODE: 'auto',
      CHROXY_TUI_CHILD: '1',
    }
    const r = await runCommand({ shellCommand: commandFor(quotedScript), env, payload: read('.env') })
    assert.equal(r.status, 0, `hook must start and exit 0, got ${r.status}: ${r.stderr}`)
    assert.equal(daemon.stats.floorRequests, 1, 'floor probed')
    assert.equal(daemon.stats.permissionRequests, 1, 'floored target raised a real prompt')
    assert.equal(decisionOf(r.stdout).permissionDecision, 'deny')
  })
})

describe('the claude-cli (user-level) registration shell-quotes the script path (#8263)', () => {
  // register() writes the command Claude runs through a shell. An install path
  // with a space split into words, the hook failed to start (exit 127, a
  // NON-blocking error) and the permission check was silently skipped.
  let dir
  let daemon
  let quotedScript
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8263-cli-quote-'))
    // `chroxy/packages/server` in the path so _isChroxyHookEntry's path arm applies.
    const scriptDir = join(dir, "it's a dir $HOME", 'chroxy', 'packages', 'server', 'hooks')
    mkdirSync(scriptDir, { recursive: true })
    quotedScript = join(scriptDir, 'permission-hook.sh')
    copyFileSync(hookPath, quotedScript)
    chmodSync(quotedScript, 0o755)
  })
  afterEach(async () => {
    if (daemon) await daemon.close()
    daemon = null
    rmSync(dir, { recursive: true, force: true })
  })

  const registerAndRead = async () => {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, '{}')
    const mgr = createPermissionHookManager(new EventEmitter(), { settingsPath, hookScript: quotedScript })
    await mgr.register()
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    await mgr.destroy()
    return { settingsPath, settings }
  }

  it('writes the quoted form, and the entry is still recognised as ours without its flag', async () => {
    const { settingsPath, settings } = await registerAndRead()
    const entry = settings.hooks.PreToolUse[0]
    assert.equal(entry.hooks[0].command, shellQuotePath(quotedScript))
    assert.ok(entry.hooks[0].command.startsWith("'") && entry.hooks[0].command.endsWith("'"), entry.hooks[0].command)
    // Drop the canonical flag so only the path-match arm can recognise it.
    delete entry._chroxy
    writeFileSync(settingsPath, JSON.stringify(settings))
    assert.equal(countUserLevelChroxyHooks({ settingsPath }).found, 1)
  })

  it('run through sh -c the written command starts, reaches /permission-floor and /permission', async () => {
    const { settings } = await registerAndRead()
    const command = settings.hooks.PreToolUse[0].hooks[0].command
    daemon = await startRealDaemon({ promptDecision: 'deny' })
    // No CHROXY_TUI_CHILD: this is the claude-cli path, where the copy always decides.
    const env = {
      PATH: process.env.PATH,
      CHROXY_PORT: String(daemon.port),
      CHROXY_HOOK_SECRET: HOOK_SECRET,
      CHROXY_PERMISSION_MODE: 'auto',
    }
    const r = await runCommand({ shellCommand: command, env, payload: read('.env') })
    assert.equal(r.status, 0, `hook must start and exit 0, got ${r.status}: ${r.stderr}`)
    assert.equal(daemon.stats.floorRequests, 1, 'floor probed')
    assert.equal(daemon.stats.permissionRequests, 1, 'floored target raised a real prompt')
    assert.equal(decisionOf(r.stdout).permissionDecision, 'deny')
  })
})

import { describe, it, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  claudeSettingSourcesFor,
  claudeSettingSourcesValueFor,
  projectSettingsAllowedAsync,
  projectSettingsDecidedWithoutScan,
} from '../src/claude-setting-sources.js'
import { SdkSession } from '../src/sdk-session.js'
import { buildClaudeCliArgs, CliSession } from '../src/cli-session.js'
import { defaultRunOneShot } from '../src/summarize-session.js'
import { SessionManager } from '../src/session-manager.js'
import { WebTaskManager, buildRemoteTaskArgs } from '../src/web-task-manager.js'
import { StatusLineManager, statusLineSettingsPaths } from '../src/statusline.js'
import {
  getFolderTrustStateForDisplay,
  invalidateFolderTrustCache,
  scanCountForTest,
  setWorkerForTest,
  untrustFolder,
  workerScanCountForTest,
} from '../src/folder-trust.js'
import { trustReviewed } from './helpers/trust-folder.js'
import { writeHookSettings } from '../src/claude-tui-session.js'
import { isFlooredTarget } from '../src/permission-floor.js'

/**
 * Every Claude launch path, and the status-line reader, go through
 * src/claude-setting-sources.js: user scope always, project scope only for a
 * folder with no command-bearing files or one the owner trusted. These tests
 * pin each call site to it. (The claude-tui spawn argv is pinned in
 * claude-tui-session.test.js.)
 */

// The trust store and the user's Claude dir are temp, never the real home.
let savedChroxy
let savedClaude
beforeEach(() => {
  savedChroxy = process.env.CHROXY_CONFIG_DIR
  savedClaude = process.env.CLAUDE_CONFIG_DIR
  process.env.CHROXY_CONFIG_DIR = join(tmp('setting-sources-chroxy-'), 'chroxy')
  process.env.CLAUDE_CONFIG_DIR = tmp('setting-sources-claude-')
  invalidateFolderTrustCache()
})
afterEach(() => {
  if (savedChroxy === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = savedChroxy
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedClaude
  invalidateFolderTrustCache()
})

/** A folder whose .mcp.json makes it command-bearing: untrusted until trusted. */
function projectWithMcp(prefix) {
  const dir = tmp(prefix)
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'x' } } }))
  return dir
}

const hangOnly = (ms) => (cwd) => (cwd.includes('hang') ? ms : 30_000)
const CRASH_WORKER = new URL('./fixtures/folder-trust-crash-worker.mjs', import.meta.url)
const HANG_WORKER = new URL('./fixtures/folder-trust-hang-worker.mjs', import.meta.url)

const tmpDirs = []
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

describe('claude-setting-sources helper', () => {
  it('decides an untrusted folder without scanning it', async () => {
    const dir = projectWithMcp('setting-sources-noscan-')
    const before = scanCountForTest()
    const workerBefore = workerScanCountForTest()
    assert.equal(projectSettingsDecidedWithoutScan(dir), false)
    assert.equal(await projectSettingsAllowedAsync(dir), false)
    assert.deepEqual(claudeSettingSourcesFor(await projectSettingsAllowedAsync(dir)), ['user'])
    assert.equal(scanCountForTest(), before, 'no record for the folder, so no scan')
    assert.equal(workerScanCountForTest(), workerBefore, 'and no worker scan either')
  })

  it('still scans a folder that has a record, and a changed folder is untrusted', async () => {
    const dir = projectWithMcp('setting-sources-scan-')
    await trustReviewed(dir)
    assert.equal(projectSettingsDecidedWithoutScan(dir), null, 'a recorded folder needs a scan')
    const before = workerScanCountForTest()
    assert.equal(await projectSettingsAllowedAsync(dir), true)
    assert.ok(workerScanCountForTest() > before, 'a recorded folder is verified by a scan')
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'y' } } }))
    assert.equal(await projectSettingsAllowedAsync(dir), false)
  })

  it('an untrusted folder gets only the user scope', async () => {
    const dir = projectWithMcp('setting-sources-helper-')
    assert.deepEqual(claudeSettingSourcesFor(await projectSettingsAllowedAsync(dir)), ['user'])
    assert.equal(claudeSettingSourcesValueFor(await projectSettingsAllowedAsync(dir)), 'user')
    assert.equal(await projectSettingsAllowedAsync(dir), false)
  })

  it('a trusted folder gets user and project, never local', async () => {
    const dir = projectWithMcp('setting-sources-helper-trusted-')
    await trustReviewed(dir)
    const sources = claudeSettingSourcesFor(await projectSettingsAllowedAsync(dir))
    assert.deepEqual(sources, ['user', 'project'])
    assert.equal(claudeSettingSourcesValueFor(await projectSettingsAllowedAsync(dir)), 'user,project')
  })

  it('a launch decision is not answered from a display scan that is still cached', async () => {
    const dir = projectWithMcp('setting-sources-nocache-')
    await trustReviewed(dir)
    assert.equal((await getFolderTrustStateForDisplay(dir)).status, 'trusted') // warms the display cache
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'edited' } } }))
    assert.equal((await getFolderTrustStateForDisplay(dir)).status, 'trusted', 'display may be stale')
    assert.equal(await projectSettingsAllowedAsync(dir), false, 'the launch decision sees the edit')
  })

  it('a launch decision runs off the main thread (a timer fires while it runs) and still sees an edit', async () => {
    const dir = projectWithMcp('setting-sources-offthread-')
    // A large trusted tree: enough directories that the walk takes a visible time.
    for (let i = 0; i < 400; i++) {
      mkdirSync(join(dir, 'big', `d${i}`), { recursive: true })
      for (let j = 0; j < 5; j++) writeFileSync(join(dir, 'big', `d${i}`, `f${j}`), '')
    }
    await trustReviewed(dir)
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { s: { command: 'edited' } } }))
    const before = workerScanCountForTest()
    const inThreadBefore = scanCountForTest()
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 1)
    try {
      assert.equal(await projectSettingsAllowedAsync(dir), false)
    } finally {
      clearInterval(timer)
    }
    assert.equal(workerScanCountForTest(), before + 1, 'the scan ran in the worker')
    assert.equal(scanCountForTest(), inThreadBefore, 'and not in this thread')
    assert.ok(ticks > 0, 'the main thread stayed responsive during the decision')
  })

  it('a launch decision whose scan times out is not allowed', async () => {
    const dir = projectWithMcp('setting-sources-hang-')
    await trustReviewed(dir)
    try {
      setWorkerForTest({ url: HANG_WORKER, timeoutMs: hangOnly(100) })
      const inThread = scanCountForTest()
      assert.equal(await projectSettingsAllowedAsync(dir), false, 'timeout fails closed')
      assert.equal(scanCountForTest(), inThread, 'and no in-thread scan was run instead')
    } finally {
      setWorkerForTest()
    }
  })

  it('a worker that exits or throws mid-scan fails closed: not allowed, and no in-thread scan', async () => {
    for (const name of ['exit', 'throw']) {
      const dir = projectWithMcp(`setting-sources-${name}-`)
      await trustReviewed(dir)
      try {
        setWorkerForTest({ url: CRASH_WORKER })
        const inThread = scanCountForTest()
        assert.equal(await projectSettingsAllowedAsync(dir), false, `${name}: not allowed`)
        assert.equal(scanCountForTest(), inThread, `${name}: not scanned in this thread`)
        setWorkerForTest()
        assert.equal(await projectSettingsAllowedAsync(dir), true, 'a fresh worker decides the next request')
      } finally {
        setWorkerForTest()
      }
    }
  })

  it('a worker that cannot be created falls back to a bounded in-thread scan', async () => {
    const dir = projectWithMcp('setting-sources-nocreate-')
    await trustReviewed(dir)
    try {
      setWorkerForTest({ factory: () => { throw new Error('no threads here') } })
      const inThread = scanCountForTest()
      assert.equal(await projectSettingsAllowedAsync(dir), true, 'the in-thread scan decides')
      assert.equal(scanCountForTest(), inThread + 1)
      // With the display budget: a walk that outruns it is incomplete, so not allowed.
      for (let i = 0; i < 600; i++) mkdirSync(join(dir, 'tree', `d${i}`), { recursive: true })
      const real = Date.now
      let t = real()
      mock.method(Date, 'now', () => { t += 50; return t })
      try {
        assert.equal(await projectSettingsAllowedAsync(dir), false)
      } finally {
        mock.restoreAll()
      }
    } finally {
      setWorkerForTest()
    }
  })

  it('a worker script that cannot be loaded counts as one that cannot be created', async () => {
    const dir = projectWithMcp('setting-sources-noload-')
    await trustReviewed(dir)
    try {
      setWorkerForTest({ url: new URL('./fixtures/does-not-exist-worker.mjs', import.meta.url) })
      assert.equal(await projectSettingsAllowedAsync(dir), true)
    } finally {
      setWorkerForTest()
    }
  })
})

describe('SDK session options', () => {
  async function settingSourcesFor(cwd) {
    const session = new SdkSession({ cwd, stateFilePath: join(tmp('setting-sources-sdk-'), 'state.json') })
    session._fetchSupportedModels = () => {}
    const captured = []
    session._callQuery = (args) => {
      captured.push(args.options)
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-x', tools: [] }
        yield { type: 'result', session_id: 'sdk-1', total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: {} }
      })()
    }
    try {
      await session.sendMessage('hi')
    } finally {
      session.destroy()
    }
    assert.equal(captured.length, 1)
    return captured[0].settingSources
  }

  it('passes settingSources user-only to query() for an untrusted folder', async () => {
    assert.deepEqual(await settingSourcesFor(projectWithMcp('setting-sources-sdk-untrusted-')), ['user'])
  })

  it('passes user and project for a trusted folder', async () => {
    const dir = projectWithMcp('setting-sources-sdk-trusted-')
    await trustReviewed(dir)
    assert.deepEqual(await settingSourcesFor(dir), ['user', 'project'])
  })
})

describe('SDK turn stopped while the folder is being verified', () => {
  it('a real interrupt() during the decision means the query never starts, busy clears, and stopped is emitted', async () => {
    const dir = projectWithMcp('setting-sources-sdk-stopped-')
    await trustReviewed(dir)
    const session = new SdkSession({ cwd: dir, stateFilePath: join(tmp('setting-sources-sdk-'), 'state.json') })
    session._fetchSupportedModels = () => {}
    let queries = 0
    session._callQuery = () => { queries += 1; return (async function* () {})() }
    const events = []
    session.on('stopped', () => events.push('stopped'))
    try {
      const turn = session.sendMessage('hi') // busy; the trusted folder is verified first
      assert.equal(session._isBusy, true)
      await session.interrupt()
      await turn
      assert.equal(queries, 0)
      assert.equal(session._isBusy, false)
      assert.deepEqual(events, ['stopped'])
    } finally {
      session.destroy()
    }
  })
})

describe('SDK send queued during a stopped decision', () => {
  it('a prompt sent while the folder is being verified, after a Stop, is delivered when the stopped turn ends', async () => {
    const dir = projectWithMcp('setting-sources-sdk-queued-')
    await trustReviewed(dir)
    const session = new SdkSession({ cwd: dir, stateFilePath: join(tmp('setting-sources-sdk-'), 'state.json') })
    session._fetchSupportedModels = () => {}
    const prompts = []
    session._callQuery = (args) => {
      prompts.push(typeof args.prompt === 'string' ? args.prompt : 'streamed')
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'sdk-q', model: 'claude-x', tools: [] }
        yield { type: 'result', session_id: 'sdk-q', total_cost_usd: 0, duration_ms: 1, num_turns: 1, usage: {} }
      })()
    }
    try {
      const first = session.sendMessage('first')
      await session.interrupt() // the Stop
      await session.sendMessage('after the stop') // busy: queued
      assert.equal(session._outgoingQueue.length, 1)
      await first
      for (let i = 0; i < 200 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
      assert.equal(prompts.length, 1, 'the queued prompt ran')
      assert.equal(session._outgoingQueue.length, 0)
    } finally {
      session.destroy()
    }
  })
})

describe('CLI session argv', () => {
  const base = { model: null, permissionMode: 'approve', allowedTools: [], skillsText: '', resumeSessionId: null }
  const sourcesOf = (args) => {
    const i = args.indexOf('--setting-sources')
    assert.notEqual(i, -1)
    assert.equal(args.filter((a) => a === '--setting-sources').length, 1)
    return args[i + 1]
  }

  it('buildClaudeCliArgs carries --setting-sources user unless the decision passed in allows the project', () => {
    assert.equal(sourcesOf(buildClaudeCliArgs({ ...base, projectAllowed: false })), 'user')
    assert.equal(sourcesOf(buildClaudeCliArgs({ ...base, projectAllowed: true })), 'user,project')
  })

  // The session threads ITS OWN cwd into the helper, so a trusted folder is what gets user,project.
  async function startedArgs(cwd) {
    const session = new CliSession({ cwd, stateFilePath: join(tmp('setting-sources-cli-state-'), 'state.json') })
    let spawned = null
    session._spawnPersistentProcess = (args) => { spawned = args }
    try {
      session.start()
      // A trusted folder is verified by a scan off the main thread first.
      for (let i = 0; i < 200 && !spawned; i++) await new Promise((r) => setTimeout(r, 10))
    } finally {
      session.destroy()
    }
    assert.ok(spawned, 'start() spawned the persistent process')
    return spawned
  }

  it('CliSession.start passes the session cwd: user for an untrusted folder, user,project for a trusted one', async () => {
    const dir = projectWithMcp('setting-sources-cli-start-')
    assert.equal(sourcesOf(await startedArgs(dir)), 'user')
    await trustReviewed(dir)
    assert.equal(sourcesOf(await startedArgs(dir)), 'user,project')
  })

  it('a started CliSession records what its process was launched with (launchedWithProject)', async () => {
    const dir = projectWithMcp('setting-sources-cli-launched-')
    const launch = async () => {
      const session = new CliSession({ cwd: dir, stateFilePath: join(tmp('setting-sources-cli-state-'), 'state.json') })
      session._spawnPersistentProcess = () => {}
      try {
        assert.equal(session.launchedWithProject, undefined, 'unknown before launch')
        session.start()
        for (let i = 0; i < 200 && session.launchedWithProject === undefined; i++) await new Promise((r) => setTimeout(r, 10))
        return session.launchedWithProject
      } finally {
        session.destroy()
      }
    }
    assert.equal(await launch(), false)
    await trustReviewed(dir)
    assert.equal(await launch(), true)
  })

  // A CliSession whose process start is counted, with its folder trusted (so the start verifies it first).
  async function trustedCli(prefix) {
    const dir = projectWithMcp(prefix)
    await trustReviewed(dir)
    const session = new CliSession({ cwd: dir, stateFilePath: join(tmp('setting-sources-cli-state-'), 'state.json') })
    const spawns = []
    session._spawnPersistentProcess = (args) => { spawns.push(args); session._child = { kill() {}, stdin: { end() {} }, on() {} } }
    return { dir, session, spawns }
  }

  it('a CliSession destroyed while its trusted folder is being verified never launches', async () => {
    const { session, spawns } = await trustedCli('setting-sources-cli-destroyed-')
    session.start()
    session.destroy()
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(spawns.length, 0)
  })

  it('a second start while one is verifying launches exactly one process', async () => {
    const { session, spawns } = await trustedCli('setting-sources-cli-twice-')
    try {
      session.start()
      session.start()
      await new Promise((r) => setTimeout(r, 400))
      assert.equal(spawns.length, 1)
    } finally {
      session.destroy()
    }
  })

  it('a Stop (interrupt) while the folder is being verified means no launch, and the session revives on the next send', async () => {
    const { session, spawns } = await trustedCli('setting-sources-cli-stopped-')
    try {
      session.start()
      session.interrupt()
      await new Promise((r) => setTimeout(r, 300))
      assert.equal(spawns.length, 0, 'the stopped start did not launch')
      assert.equal(session._stoppedByUser, true, 'left as a Stop leaves it')
      session._restartAfterStop() // what the next sendMessage does
      for (let i = 0; i < 100 && spawns.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
      assert.equal(spawns.length, 1, 'the next send revives it')
    } finally {
      session.destroy()
    }
  })

  it('trust revoked while a start is verifying, then another start: one process, not two', async () => {
    const { dir, session, spawns } = await trustedCli('setting-sources-cli-revoked-')
    try {
      session.start() // a recorded folder: verification pending
      await untrustFolder(dir) // no record any more
      session.start() // e.g. a respawn: takes the no-record path and launches at once
      assert.equal(spawns.length, 1)
      await new Promise((r) => setTimeout(r, 400))
      assert.equal(spawns.length, 1, 'the earlier start did not launch a second process')
      assert.equal(sourcesOf(spawns[0]), 'user')
    } finally {
      session.destroy()
    }
  })

  it('buildClaudeCliArgs without a decision is untrusted', () => {
    assert.equal(sourcesOf(buildClaudeCliArgs(base)), 'user')
  })
})

describe('summarize one-shot options', () => {
  it('passes settingSources: [] to query()', async () => {
    const captured = []
    const queryFn = (args) => {
      captured.push(args)
      return (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'brief' }] } }
      })()
    }
    await defaultRunOneShot({ prompt: 'p', queryFn, resolveExecutable: () => '/fake/claude' })
    assert.deepEqual(captured[0].options.settingSources, [])
  })
})

describe('web task argv', () => {
  it('buildRemoteTaskArgs carries --setting-sources user before the -- separator for an untrusted folder', () => {
    assert.deepEqual(buildRemoteTaskArgs('do it', false), ['--setting-sources', 'user', '--remote', '--', 'do it'])
    assert.deepEqual(buildRemoteTaskArgs('do it'), ['--setting-sources', 'user', '--remote', '--', 'do it'])
  })

  it('buildRemoteTaskArgs carries user,project when the decision allows the project', () => {
    assert.deepEqual(buildRemoteTaskArgs('do it', true), ['--setting-sources', 'user,project', '--remote', '--', 'do it'])
  })

  // The real launch calls execFile on the resolved binary, so a recording
  // shim proves the argv that is actually spawned.
  const skip = process.platform === 'win32' ? 'shebang shim is not executable via execFile on Windows' : false

  function recordingShim() {
    // The folder the tasks run in carries a .mcp.json, so it is untrusted until a test trusts it.
    const dir = projectWithMcp('setting-sources-shim-')
    const argvPath = join(dir, 'argv.json')
    const shim = join(dir, 'shim.mjs')
    writeFileSync(shim, [
      '#!/usr/bin/env node',
      `import { writeFileSync } from 'node:fs'`,
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))`,
      'console.log("ok")',
    ].join('\n'))
    chmodSync(shim, 0o755)
    return { shim, argvPath, dir }
  }

  function managerFor(shim, dir) {
    class ShimProvider {
      static get resolvedBinary() { return shim }
      static get preflight() { return { label: 'Shim Claude', binary: { name: 'claude', candidates: [] } } }
    }
    const sessionManager = new SessionManager({ maxSessions: 1, stateFilePath: join(dir, 'state.json'), defaultCwd: dir })
    const manager = new WebTaskManager({ cwd: dir, sessionManager, providerClass: ShimProvider })
    manager._teleportAvailable = true
    manager._remoteAvailable = true
    return manager
  }

  it('teleport launch passes --setting-sources user', { skip }, async () => {
    const { shim, argvPath, dir } = recordingShim()
    const manager = managerFor(shim, dir)
    try {
      manager._tasks.set('t1', { taskId: 't1', cwd: dir })
      await manager.teleportTask('t1')
      assert.deepEqual(JSON.parse(readFileSync(argvPath, 'utf8')).slice(0, 2), ['--setting-sources', 'user'])
    } finally {
      manager.destroy()
    }
  })

  it('teleport launch passes user,project once the folder is trusted', { skip }, async () => {
    const { shim, argvPath, dir } = recordingShim()
    await trustReviewed(dir)
    const manager = managerFor(shim, dir)
    try {
      manager._tasks.set('t1', { taskId: 't1', cwd: dir })
      await manager.teleportTask('t1')
      assert.deepEqual(JSON.parse(readFileSync(argvPath, 'utf8')).slice(0, 2), ['--setting-sources', 'user,project'])
    } finally {
      manager.destroy()
    }
  })

  it('teleport: a manager destroyed while the folder is being verified never spawns', { skip }, async () => {
    const { shim, argvPath, dir } = recordingShim()
    await trustReviewed(dir)
    const manager = managerFor(shim, dir)
    manager._tasks.set('t1', { taskId: 't1', cwd: dir })
    const teleport = manager.teleportTask('t1')
    manager.destroy()
    await assert.rejects(teleport, /Teleport failed/)
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(existsSync(argvPath), false)
  })

  it('teleport: the spawned child is tracked so destroy() can stop it', { skip }, async () => {
    const { shim, dir } = recordingShim()
    const manager = managerFor(shim, dir)
    try {
      manager._tasks.set('t1', { taskId: 't1', cwd: dir })
      const teleport = manager.teleportTask('t1')
      await new Promise((r) => setImmediate(r)) // past the project-settings decision, into the spawn
      assert.equal(manager._childProcesses.size, 1)
      await teleport
      assert.equal(manager._childProcesses.size, 0, 'released when it exits')
    } finally {
      manager.destroy()
    }
  })

  it('remote launch: a task removed or a manager destroyed while the folder is being verified never spawns', { skip }, async () => {
    const { shim, argvPath, dir } = recordingShim()
    await trustReviewed(dir)
    const removed = managerFor(shim, dir)
    try {
      const { taskId } = removed.launchTask('removed')
      removed._tasks.delete(taskId)
      await new Promise((r) => setTimeout(r, 400))
      assert.equal(existsSync(argvPath), false, 'a task that is gone is not launched')
    } finally {
      removed.destroy()
    }
    const destroyed = managerFor(shim, dir)
    destroyed.launchTask('destroyed')
    destroyed.destroy()
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(existsSync(argvPath), false, 'a destroyed manager does not launch')
  })

  it('remote launch: a failure after the decision is reported as a task error', { skip }, async () => {
    const { shim, dir } = recordingShim()
    await trustReviewed(dir)
    const manager = managerFor(shim, dir)
    manager._execRemoteTask = () => { throw new Error('spawn blew up') }
    const errors = []
    manager.on('task_error', (e) => errors.push(e.message))
    try {
      const { taskId } = manager.launchTask('boom')
      for (let i = 0; i < 100 && errors.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
      assert.deepEqual(errors, ['spawn blew up'])
      assert.equal(manager.getTask?.(taskId)?.status ?? manager._tasks.get(taskId).status, 'failed')
    } finally {
      manager.destroy()
    }
  })

  it('remote launch passes --setting-sources user', { skip }, async () => {
    const { shim, argvPath, dir } = recordingShim()
    const manager = managerFor(shim, dir)
    try {
      manager.launchTask('remote me')
      for (let i = 0; i < 100 && !existsSync(argvPath); i++) await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(JSON.parse(readFileSync(argvPath, 'utf8')), ['--setting-sources', 'user', '--remote', '--', 'remote me'])
    } finally {
      manager.destroy()
    }
  })
})

describe('status line settings sources', () => {
  it('statusLineSettingsPaths lists only user-level files for an untrusted folder', () => {
    const claudeDir = join(tmpdir(), 'u', '.claude')
    assert.deepEqual(statusLineSettingsPaths(projectWithMcp('setting-sources-sl-paths-'), claudeDir), [
      join(claudeDir, 'project-settings.json'),
      join(claudeDir, 'settings.json'),
    ])
  })

  it('statusLineSettingsPaths never lists the folder file: it goes through the verified reader', async () => {
    const dir = projectWithMcp('setting-sources-sl-trusted-')
    await trustReviewed(dir)
    assert.deepEqual(statusLineSettingsPaths(dir, '/home/u/.claude'), [
      join('/home/u/.claude', 'project-settings.json'),
      join('/home/u/.claude', 'settings.json'),
    ])
  })

  it('does not read or run a statusLine from the session working directory', async () => {
    const cwd = tmp('setting-sources-statusline-cwd-')
    const claudeDir = tmp('setting-sources-statusline-home-')
    const marker = join(cwd, 'marker.txt')
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: `echo ran >> ${JSON.stringify(marker)}` },
    }))

    const reads = []
    const spawned = []
    const mgr = new StatusLineManager({
      claudeDir,
      readFileFn: async (path, enc) => {
        reads.push(path)
        return readFileSync(path, enc)
      },
      spawnFn: (...a) => { spawned.push(a); throw new Error('no command should be spawned') },
      buildEnv: () => ({}),
    })
    assert.equal(await mgr.resolveConfig(cwd), null)
    assert.equal(reads.some((p) => p.startsWith(cwd)), false, 'no file under the cwd is read')
    assert.equal(reads.includes(join(claudeDir, 'settings.json')), true, 'user-level settings are still read')
    assert.equal(spawned.length, 0)
    assert.equal(existsSync(marker), false, 'the project statusLine command never ran')
  })

  it('still resolves a user-level statusLine for a session in that directory', async () => {
    const cwd = tmp('setting-sources-statusline-cwd2-')
    const claudeDir = tmp('setting-sources-statusline-home2-')
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      statusLine: { type: 'command', command: 'user.sh' },
    }))
    const mgr = new StatusLineManager({ claudeDir })
    assert.equal((await mgr.resolveConfig(cwd)).command, 'user.sh')
  })
})

describe('.mcp.json permission floor', () => {
  const cwd = '/work/project'
  it('floors a write or edit of <cwd>/.mcp.json', () => {
    assert.equal(isFlooredTarget('Write', { file_path: join(cwd, '.mcp.json') }, cwd), true)
    assert.equal(isFlooredTarget('Edit', { file_path: '.mcp.json' }, cwd), true)
    assert.equal(isFlooredTarget('Write', { file_path: join(cwd, 'sub', '.mcp.json') }, cwd), true)
  })
  it('does not floor a read of it', () => {
    assert.equal(isFlooredTarget('Read', { file_path: join(cwd, '.mcp.json') }, cwd), false)
  })
  it('does not floor an ordinary file', () => {
    assert.equal(isFlooredTarget('Write', { file_path: join(cwd, 'mcp.json') }, cwd), false)
  })
})

// Every Agent SDK query() call site must choose its setting sources through
// claude-setting-sources.js, or load none. A new call site that leaves
// settingSources unset would get the SDK default (user, project and local).
describe('Agent SDK call sites choose setting sources explicitly', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.js')) files.push(p)
    }
  }
  walk(srcDir)
  const callsQuery = (text) => /from '@anthropic-ai\/claude-agent-sdk'/.test(text) &&
    text.split('\n').some((l) => !/^\s*(\*|\/\/)/.test(l) && /\b(query|queryFn|sdkQuery)\(/.test(l))

  it('finds the known call sites (the sweep is not vacuous)', () => {
    const names = files.filter((p) => callsQuery(readFileSync(p, 'utf8'))).map((p) => p.slice(srcDir.length + 1))
    for (const known of ['sdk-session.js', 'summarize-session.js', 'claude-model-refresh.js']) {
      assert.ok(names.includes(known), `${known} should be detected as an SDK query() call site`)
    }
  })

  // A coarse sweep: per file, every settingSources value must come from the
  // helper or be [], and there must be at least one per query() call. It does
  // not tie each value to its own call's options object.
  it('each call site sets settingSources from the helper or to []', () => {
    for (const p of files) {
      const text = readFileSync(p, 'utf8')
      if (!callsQuery(text)) continue
      const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l))
      const lines = code.filter((l) => /\bsettingSources\s*:/.test(l))
      const calls = code.filter((l) => /\b(query|queryFn|sdkQuery)\(/.test(l) && !/\bfunction\b/.test(l))
      assert.ok(lines.length > 0, `${p} calls query() without setting settingSources`)
      assert.ok(lines.length >= calls.length, `${p} has ${calls.length} query() calls but ${lines.length} settingSources values`)
      for (const l of lines) {
        assert.match(l, /settingSources\s*:\s*(claudeSettingSourcesFor\(|\[\])/, `${p}: ${l.trim()}`)
      }
      // A decision built from anything but the launch decision would defeat the point.
      if (lines.some((l) => /claudeSettingSourcesFor\(/.test(l))) {
        assert.match(text, /projectSettingsAllowedAsync\(/, `${p} must take its decision from projectSettingsAllowedAsync`)
      }
    }
  })
})

describe('claude-tui per-session settings file', () => {
  it('writeHookSettings adds enableAllProjectMcpServers only when asked', () => {
    const on = JSON.parse(readFileSync(writeHookSettings(tmp('setting-sources-hooks-on-'), { permissionsEnabled: false, enableAllProjectMcpServers: true }), 'utf8'))
    assert.equal(on.enableAllProjectMcpServers, true)
    const off = JSON.parse(readFileSync(writeHookSettings(tmp('setting-sources-hooks-off-'), { permissionsEnabled: false }), 'utf8'))
    assert.equal('enableAllProjectMcpServers' in off, false)
  })
})

import { describe, it, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  claudeSettingSources,
  claudeSettingSourcesArgs,
  projectSettingsAllowed,
} from '../src/claude-setting-sources.js'
import { SdkSession } from '../src/sdk-session.js'
import { buildClaudeCliArgs, CliSession } from '../src/cli-session.js'
import { defaultRunOneShot } from '../src/summarize-session.js'
import { SessionManager } from '../src/session-manager.js'
import { WebTaskManager, buildRemoteTaskArgs } from '../src/web-task-manager.js'
import { StatusLineManager, statusLineSettingsPaths } from '../src/statusline.js'
import { trustFolder, invalidateFolderTrustCache } from '../src/folder-trust.js'
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
  it('an untrusted folder gets only the user scope', () => {
    const dir = projectWithMcp('setting-sources-helper-')
    assert.deepEqual(claudeSettingSources(dir), ['user'])
    assert.deepEqual(claudeSettingSourcesArgs(dir), ['--setting-sources', 'user'])
    assert.equal(projectSettingsAllowed(dir), false)
  })

  it('a trusted folder gets user and project, never local', async () => {
    const dir = projectWithMcp('setting-sources-helper-trusted-')
    await trustFolder(dir)
    assert.deepEqual(claudeSettingSources(dir), ['user', 'project'])
    assert.deepEqual(claudeSettingSourcesArgs(dir), ['--setting-sources', 'user,project'])
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
    await trustFolder(dir)
    assert.deepEqual(await settingSourcesFor(dir), ['user', 'project'])
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

  it('buildClaudeCliArgs carries --setting-sources user for an untrusted folder', () => {
    assert.equal(sourcesOf(buildClaudeCliArgs({ ...base, cwd: projectWithMcp('setting-sources-cli-untrusted-') })), 'user')
  })

  it('buildClaudeCliArgs carries user,project for a trusted folder', async () => {
    const dir = projectWithMcp('setting-sources-cli-trusted-')
    await trustFolder(dir)
    assert.equal(sourcesOf(buildClaudeCliArgs({ ...base, cwd: dir })), 'user,project')
  })

  // The session threads ITS OWN cwd into the helper, so a trusted folder is what gets user,project.
  async function startedArgs(cwd) {
    const session = new CliSession({ cwd, stateFilePath: join(tmp('setting-sources-cli-state-'), 'state.json') })
    let spawned = null
    session._spawnPersistentProcess = (args) => { spawned = args }
    try {
      session.start()
    } finally {
      session.destroy()
    }
    assert.ok(spawned, 'start() spawned the persistent process')
    return spawned
  }

  it('CliSession.start passes the session cwd: user for an untrusted folder, user,project for a trusted one', async () => {
    const dir = projectWithMcp('setting-sources-cli-start-')
    assert.equal(sourcesOf(await startedArgs(dir)), 'user')
    await trustFolder(dir)
    assert.equal(sourcesOf(await startedArgs(dir)), 'user,project')
  })

  it('buildClaudeCliArgs without a cwd is untrusted', () => {
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
    const args = buildRemoteTaskArgs('do it', projectWithMcp('setting-sources-web-'))
    assert.deepEqual(args, ['--setting-sources', 'user', '--remote', '--', 'do it'])
  })

  it('buildRemoteTaskArgs carries user,project for a trusted folder', async () => {
    const dir = projectWithMcp('setting-sources-web-trusted-')
    await trustFolder(dir)
    assert.deepEqual(buildRemoteTaskArgs('do it', dir), ['--setting-sources', 'user,project', '--remote', '--', 'do it'])
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
    await trustFolder(dir)
    const manager = managerFor(shim, dir)
    try {
      manager._tasks.set('t1', { taskId: 't1', cwd: dir })
      await manager.teleportTask('t1')
      assert.deepEqual(JSON.parse(readFileSync(argvPath, 'utf8')).slice(0, 2), ['--setting-sources', 'user,project'])
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

  it('statusLineSettingsPaths puts the project file first for a trusted folder', async () => {
    const dir = projectWithMcp('setting-sources-sl-trusted-')
    await trustFolder(dir)
    assert.deepEqual(statusLineSettingsPaths(dir, '/home/u/.claude'), [
      join(dir, '.claude', 'settings.json'),
      '/home/u/.claude/project-settings.json',
      '/home/u/.claude/settings.json',
    ])
  })

  it('statusLineSettingsPaths includes the project file when the folder has no command-bearing files', () => {
    const dir = tmp('setting-sources-sl-none-')
    assert.equal(statusLineSettingsPaths(dir, '/home/u/.claude')[0], join(dir, '.claude', 'settings.json'))
  })

  it('reads and runs the project statusLine once the folder is trusted', async () => {
    const cwd = tmp('setting-sources-statusline-trusted-')
    const claudeDir = tmp('setting-sources-statusline-trusted-home-')
    mkdirSync(join(cwd, '.claude'))
    writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'project.sh' } }))
    const mgr = new StatusLineManager({ claudeDir })
    assert.equal(await mgr.resolveConfig(cwd), null, 'untrusted: the project file is not read')
    await trustFolder(cwd)
    const fresh = new StatusLineManager({ claudeDir })
    assert.equal((await fresh.resolveConfig(cwd)).command, 'project.sh')
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
        assert.match(l, /settingSources\s*:\s*(claudeSettingSources\(|\[\])/, `${p}: ${l.trim()}`)
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

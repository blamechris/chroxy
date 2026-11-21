import { describe, it, after } from 'node:test'
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
import { buildClaudeCliArgs } from '../src/cli-session.js'
import { defaultRunOneShot } from '../src/summarize-session.js'
import { SessionManager } from '../src/session-manager.js'
import { WebTaskManager, buildRemoteTaskArgs } from '../src/web-task-manager.js'
import { StatusLineManager, statusLineSettingsPaths } from '../src/statusline.js'
import { isFlooredTarget } from '../src/permission-floor.js'

/**
 * Every Claude launch path, and the status-line reader, loads only user-scope
 * settings. The decision lives in src/claude-setting-sources.js; these tests
 * pin each call site to it. (The claude-tui spawn argv is pinned in
 * claude-tui-session.test.js.)
 */

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
  it('returns only the user scope, never project or local', () => {
    assert.deepEqual(claudeSettingSources('/some/project'), ['user'])
    assert.deepEqual(claudeSettingSourcesArgs('/some/project'), ['--setting-sources', 'user'])
    assert.equal(projectSettingsAllowed('/some/project'), false)
  })
})

describe('SDK session options', () => {
  it('passes settingSources user-only to query()', async () => {
    const session = new SdkSession({ cwd: '/tmp', stateFilePath: join(tmp('setting-sources-sdk-'), 'state.json') })
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
    assert.deepEqual(captured[0].settingSources, ['user'])
  })
})

describe('CLI session argv', () => {
  it('buildClaudeCliArgs carries --setting-sources user', () => {
    const args = buildClaudeCliArgs({ model: null, permissionMode: 'approve', allowedTools: [], skillsText: '', resumeSessionId: null })
    const i = args.indexOf('--setting-sources')
    assert.notEqual(i, -1)
    assert.equal(args[i + 1], 'user')
    assert.equal(args.filter((a) => a === '--setting-sources').length, 1)
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
  it('buildRemoteTaskArgs carries --setting-sources user before the -- separator', () => {
    const args = buildRemoteTaskArgs('do it', '/proj')
    assert.deepEqual(args, ['--setting-sources', 'user', '--remote', '--', 'do it'])
  })

  // The real launch calls execFile on the resolved binary, so a recording
  // shim proves the argv that is actually spawned.
  const skip = process.platform === 'win32' ? 'shebang shim is not executable via execFile on Windows' : false

  function recordingShim() {
    const dir = tmp('setting-sources-shim-')
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
  it('statusLineSettingsPaths lists only user-level files', () => {
    const claudeDir = join(tmpdir(), 'u', '.claude')
    assert.deepEqual(statusLineSettingsPaths(join(tmpdir(), 'proj'), claudeDir), [
      join(claudeDir, 'project-settings.json'),
      join(claudeDir, 'settings.json'),
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

  it('each call site sets settingSources from the helper or to []', () => {
    for (const p of files) {
      const text = readFileSync(p, 'utf8')
      if (!callsQuery(text)) continue
      const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l))
      const lines = code.filter((l) => /\bsettingSources\s*:/.test(l))
      assert.ok(lines.length > 0, `${p} calls query() without setting settingSources`)
      for (const l of lines) {
        assert.match(l, /settingSources\s*:\s*(claudeSettingSources\(|\[\])/, `${p}: ${l.trim()}`)
      }
    }
  })
})

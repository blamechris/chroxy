/**
 * #8262 — every host-side place that launches (or hands a shell to) `claude`
 * must drop the parent Claude Code session's markers, so a chroxy-launched
 * claude is a top-level session. Each case sets the markers in the parent env
 * and captures what the site actually passes on, asserting against the
 * independent literal list in test-helpers.js (never the production roster).
 *
 * Not covered here: the claude-cli / claude-sdk / claude-tui builders
 * (spawn-env.test.js, claude-tui-session.test.js).
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { defaultRunOneShot } from '../src/summarize-session.js'
import { WebTaskManager } from '../src/web-task-manager.js'
import { SessionManager } from '../src/session-manager.js'
import { runSessionResume, resolveVerifiedClaudeBinary } from '../src/cli/session-cmd.js'
import { checkClaudeLogin } from '../src/doctor.js'
import { probeBinaryVersion, _resetProbeCacheForTest } from '../src/utils/binary-version.js'
import { buildSafeBashEnv } from '../src/byok-tool-executor.js'
import { defaultBuildEnv } from '../src/statusline.js'
import { executeBash } from '../src/built-in-tools/bash-exec.js'
import { UserShellSession } from '../src/user-shell-session.js'
import { MCPClient } from '../src/byok-mcp-client.js'
import { withParentClaudeSessionEnv, assertParentMarkersStripped, waitFor } from './test-helpers.js'

// The test harness repoints CLAUDE_CONFIG_DIR for every real child spawn.
const SPAWNED = { notKept: ['CLAUDE_CONFIG_DIR'] }
const WINDOWS_SKIP = process.platform === 'win32' ? 'shebang shim is not directly executable on Windows' : false

const roots = []
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  roots.push(d)
  return d
}
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }) })

/** A real executable that dumps its own environment to a JSON file, then prints `stdout`. */
function makeEnvShim(stdout = 'task: abc-123') {
  const dir = tmp('parent-env-shim-')
  const shimPath = join(dir, 'shim.mjs')
  const envPath = join(dir, 'env.json')
  writeFileSync(shimPath, [
    '#!/usr/bin/env node',
    `import { writeFileSync } from 'node:fs'`,
    `writeFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env))`,
    `console.log(${JSON.stringify(stdout)})`,
  ].join('\n'))
  chmodSync(shimPath, 0o755)
  return { shimPath, readEnv: () => JSON.parse(readFileSync(envPath, 'utf-8')), envPath }
}

class FixtureClaudeProvider {
  static resolvedOverride = null
  static get resolvedBinary() { return FixtureClaudeProvider.resolvedOverride || process.execPath }
  static get displayLabel() { return 'Fixture Claude' }
  static get preflight() { return { label: 'Fixture Claude', binary: { name: 'claude', candidates: [] } } }
}

function makeManager() {
  const sessionManager = new SessionManager({
    maxSessions: 5,
    stateFilePath: join(tmp('parent-env-state-'), 'session-state.json'),
    defaultCwd: tmpdir(),
  })
  return new WebTaskManager({ sessionManager, providerClass: FixtureClaudeProvider })
}

describe('summarize-session one-shot query (#8262)', () => {
  it('passes a sanitized env to the SDK query()', async () => {
    await withParentClaudeSessionEnv(async () => {
      let captured
      const queryFn = (args) => {
        captured = args
        return (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }
        })()
      }
      await defaultRunOneShot({ prompt: 'p', queryFn, resolveExecutable: () => '/fake/claude' })
      assert.ok(captured.options.env, 'options.env must be set — without it the SDK copies process.env')
      assertParentMarkersStripped(assert, captured.options.env, 'the summarize query() child')
    })
  })
})

describe('web-task-manager claude launches (#8262)', () => {
  it('feature detection (--help) runs with a sanitized env', async () => {
    await withParentClaudeSessionEnv(async () => {
      const manager = makeManager()
      try {
        let opts
        await manager.detectFeatures({ exec: async (_bin, _args, o) => { opts = o; return 'Usage: claude' } })
        assert.ok(opts?.env, 'detectFeatures must pass env')
        assertParentMarkersStripped(assert, opts.env, 'the --help probe')
      } finally { manager.destroy() }
    })
  })

  it('claude --remote launch runs with a sanitized env', { skip: WINDOWS_SKIP }, async () => {
    const shim = makeEnvShim()
    FixtureClaudeProvider.resolvedOverride = shim.shimPath
    const manager = makeManager()
    try {
      await withParentClaudeSessionEnv(async () => {
        manager._remoteAvailable = true
        const { taskId } = manager.launchTask('test')
        const task = manager._tasks.get(taskId)
        await waitFor(() => task.status !== 'pending', { label: 'launch callback' })
        assertParentMarkersStripped(assert, shim.readEnv(), 'the --remote child', SPAWNED)
      })
    } finally {
      FixtureClaudeProvider.resolvedOverride = null
      manager.destroy()
    }
  })

  it('claude --teleport runs with a sanitized env', { skip: WINDOWS_SKIP }, async () => {
    const shim = makeEnvShim()
    FixtureClaudeProvider.resolvedOverride = shim.shimPath
    const manager = makeManager()
    try {
      await withParentClaudeSessionEnv(async () => {
        manager._remoteAvailable = true
        manager._teleportAvailable = true
        const { taskId } = manager.launchTask('test')
        const task = manager._tasks.get(taskId)
        await waitFor(() => task.status !== 'pending', { label: 'launch callback' })
        rmSync(shim.envPath, { force: true })
        await manager.teleportTask(taskId)
        assert.ok(existsSync(shim.envPath), 'the teleport child must have run')
        assertParentMarkersStripped(assert, shim.readEnv(), 'the --teleport child', SPAWNED)
      })
    } finally {
      FixtureClaudeProvider.resolvedOverride = null
      manager.destroy()
    }
  })
})

describe('chroxy resume (#8262)', () => {
  it('execs claude with a sanitized env', { skip: WINDOWS_SKIP }, async () => {
    const shim = makeEnvShim()
    FixtureClaudeProvider.resolvedOverride = shim.shimPath
    const stateFile = join(tmp('parent-env-resume-'), 'session-state.json')
    writeFileSync(stateFile, JSON.stringify({
      sessions: [{ name: 'work', cwd: tmpdir(), conversationId: 'conv-8262' }],
      timestamp: Date.now(),
    }))
    const sha256 = createHash('sha256').update(readFileSync(shim.shimPath)).digest('hex')
    const ledger = { getRecord: () => ({ sha256 }), approve: () => true }
    try {
      await withParentClaudeSessionEnv(async () => {
        await runSessionResume('1', {}, {
          stateFile,
          resolveBinary: () => resolveVerifiedClaudeBinary({
            ProviderClass: FixtureClaudeProvider,
            ledger,
            readConfig: () => ({ binaryProvenance: { mode: 'off' } }),
          }),
        })
        assertParentMarkersStripped(assert, shim.readEnv(), 'the resumed claude', SPAWNED)
      })
    } finally {
      FixtureClaudeProvider.resolvedOverride = null
    }
  })
})

describe('doctor / version probes (#8262)', () => {
  it('claude auth status probe env is sanitized', () => {
    withParentClaudeSessionEnv(() => {
      let probeEnv
      checkClaudeLogin({
        candidates: [],
        resolveBinary: () => '/x/claude',
        env: process.env,
        exec: (_bin, _args, { env }) => { probeEnv = env; return JSON.stringify({ loggedIn: true }) },
      })
      assertParentMarkersStripped(assert, probeEnv, 'the auth status probe')
    })
  })

  it('probeBinaryVersion spawns with a sanitized env', () => {
    _resetProbeCacheForTest()
    withParentClaudeSessionEnv(() => {
      let opts
      probeBinaryVersion('/x/never-cached-8262', ['--version'], {
        spawnSync: (_p, _a, o) => { opts = o; return { status: 0, stdout: 'claude 1.2.3' } },
        statSync: () => { throw new Error('no stat') },
      })
      assert.ok(opts?.env, 'the probe must pass env')
      assertParentMarkersStripped(assert, opts.env, 'the --version probe')
    })
  })
})

describe('shells chroxy starts (#8262)', () => {
  it('buildSafeBashEnv (BYOK Bash/Grep tools)', () => {
    withParentClaudeSessionEnv(() => assertParentMarkersStripped(assert, buildSafeBashEnv(), 'a BYOK tool shell', { notKept: ['CLAUDE_CODE_OAUTH_TOKEN'] }))
  })

  it('statusline defaultBuildEnv', () => {
    withParentClaudeSessionEnv(() => assertParentMarkersStripped(assert, defaultBuildEnv(), 'the statusline command'))
  })

  it('executeBash with no explicit env', { skip: WINDOWS_SKIP }, async () => {
    await withParentClaudeSessionEnv(async () => {
      const res = await executeBash({ command: 'env' })
      const seen = new Map(String(res.stdout).split('\n').filter(Boolean).map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i), l.slice(i + 1)]
      }))
      assertParentMarkersStripped(assert, Object.fromEntries(seen), 'the built-in bash tool', SPAWNED)
    })
  })

  it('UserShellSession._buildShellEnv', () => {
    withParentClaudeSessionEnv(() => {
      const s = new UserShellSession({ cwd: '/tmp' })
      assertParentMarkersStripped(assert, s._buildShellEnv(), 'the user shell')
    })
  })

  it('MCPClient._buildChildEnv', () => {
    withParentClaudeSessionEnv(() => {
      const log = { info() {}, warn() {}, debug() {}, error() {} }
      const client = new MCPClient({ name: 'x', command: process.execPath, args: [], env: {} }, { log })
      assertParentMarkersStripped(assert, client._buildChildEnv(), 'an MCP server child')
    })
  })
})

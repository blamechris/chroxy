import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { runDoctorChecks } from '../src/doctor.js'
import { registerDoctorCommand } from '../src/cli/doctor-cmd.js'
import { loadAndMergeConfig } from '../src/cli/shared.js'

/**
 * `chroxy doctor` must check the port `chroxy start` would bind: flag, then
 * env (PORT), then config.json `port`, then the 8765 default. The merge is
 * mergeConfig's — the same one start runs — so these tests pin the OUTCOME of
 * that shared precedence at doctor's port row, and one test compares doctor
 * against start's own loader so the two cannot drift.
 *
 * Every test runs in its own CHROXY_CONFIG_DIR and with PORT controlled, so
 * nothing reads or writes the real ~/.chroxy.
 */

const CONFIG_PORT = 51871
const ENV_PORT = 51872
const FLAG_PORT = 51873

const PORT_ENV_KEYS = ['CHROXY_CONFIG_DIR', 'PORT', 'HOME', 'USERPROFILE']

describe('doctor port resolution', () => {
  let saved = {}
  let tmpDirs = []

  const isolate = ({ env = {}, fileConfig = null } = {}) => {
    saved = {}
    for (const k of PORT_ENV_KEYS) saved[k] = process.env[k]
    const configDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-port-'))
    const homeDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-port-home-'))
    tmpDirs.push(configDir, homeDir)
    process.env.CHROXY_CONFIG_DIR = configDir
    // doctor-cmd opts in to reading ~/.claude/settings.json; point HOME at an
    // empty dir so the CLI-level tests never read the operator's real one.
    process.env.HOME = homeDir
    process.env.USERPROFILE = homeDir
    delete process.env.PORT
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (fileConfig) writeFileSync(join(configDir, 'config.json'), JSON.stringify(fileConfig))
    return join(configDir, 'config.json')
  }

  afterEach(() => {
    for (const k of PORT_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
    tmpDirs = []
    saved = {}
  })

  const portMessage = (checks) => {
    const row = checks.find((c) => c.name === 'Port')
    assert.ok(row, 'doctor must emit a Port check')
    return row.message
  }
  const checksPort = (checks, port) => portMessage(checks).startsWith(`${port} `)

  describe('runDoctorChecks', () => {
    it('checks the port from config.json when no port option is passed', async () => {
      isolate({ fileConfig: { port: CONFIG_PORT } })
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
      assert.ok(checksPort(checks, CONFIG_PORT), `expected ${CONFIG_PORT}, got: ${portMessage(checks)}`)
    })

    it('an explicit port option (the --port flag) beats the config file port', async () => {
      isolate({ fileConfig: { port: CONFIG_PORT } })
      const { checks } = await runDoctorChecks({ port: FLAG_PORT, providers: ['claude-sdk'] })
      assert.ok(checksPort(checks, FLAG_PORT), `expected ${FLAG_PORT}, got: ${portMessage(checks)}`)
    })

    it('the PORT env var beats the config file port, exactly as in start', async () => {
      isolate({ env: { PORT: String(ENV_PORT) }, fileConfig: { port: CONFIG_PORT } })
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
      assert.ok(checksPort(checks, ENV_PORT), `expected ${ENV_PORT}, got: ${portMessage(checks)}`)
    })

    it('an explicit port option beats the PORT env var', async () => {
      isolate({ env: { PORT: String(ENV_PORT) }, fileConfig: { port: CONFIG_PORT } })
      const { checks } = await runDoctorChecks({ port: FLAG_PORT, providers: ['claude-sdk'] })
      assert.ok(checksPort(checks, FLAG_PORT), `expected ${FLAG_PORT}, got: ${portMessage(checks)}`)
    })

    it('falls back to the 8765 default with no option, env or config port', async () => {
      isolate({ fileConfig: { provider: 'claude-sdk' } })
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
      assert.ok(checksPort(checks, 8765), `expected 8765, got: ${portMessage(checks)}`)
    })

    it('falls back to the 8765 default when there is no config file at all', async () => {
      isolate()
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
      assert.ok(checksPort(checks, 8765), `expected 8765, got: ${portMessage(checks)}`)
    })

    it('checks the same port start would bind for the same config and env', async () => {
      const cfgPath = isolate({ env: { PORT: String(ENV_PORT) }, fileConfig: { port: CONFIG_PORT } })
      const startPort = loadAndMergeConfig({ config: cfgPath }).port
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
      assert.ok(checksPort(checks, startPort), `start binds ${startPort}, doctor said: ${portMessage(checks)}`)
    })
  })

  describe('malformed merged port', () => {
    // `start` refuses a non-integer / out-of-range port; doctor must not report
    // it OK, and must not hand it to listen() — Node treats a non-numeric
    // listen argument as a unix socket path and would bind a file in cwd.
    const withTempCwd = async (fn) => {
      const cwd = process.cwd()
      const dir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-port-cwd-'))
      tmpDirs.push(dir)
      process.chdir(dir)
      try {
        return await fn(dir)
      } finally {
        process.chdir(cwd)
      }
    }
    const cases = [
      ['PORT=abc', { env: { PORT: 'abc' } }, 'abc', 'PORT'],
      ['PORT=8800.7', { env: { PORT: '8800.7' } }, '8800.7', 'PORT'],
      ['PORT=99999', { env: { PORT: '99999' } }, '99999', 'PORT'],
      ['config port "abc"', { fileConfig: { port: 'abc' } }, 'abc', 'config'],
    ]
    for (const [name, setup, bad, source] of cases) {
      it(`${name} is a failing Port row and is never probed`, async () => {
        isolate(setup)
        await withTempCwd(async (dir) => {
          const { checks, passed } = await runDoctorChecks({ providers: ['claude-sdk'] })
          const row = checks.find((c) => c.name === 'Port')
          assert.ok(row, 'doctor must emit a Port check')
          assert.equal(row.status, 'fail', row.message)
          assert.ok(row.message.includes(bad), row.message)
          assert.ok(row.message.includes(source), row.message)
          assert.ok(!/available|in use/.test(row.message), row.message)
          assert.equal(passed, false)
          assert.deepEqual(readdirSync(dir), [], 'a malformed port must not be handed to listen()')
        })
      })
    }

    it('an explicit port option still beats a malformed env port', async () => {
      isolate({ env: { PORT: 'abc' } })
      const { checks } = await runDoctorChecks({ port: FLAG_PORT, providers: ['claude-sdk'] })
      assert.ok(checksPort(checks, FLAG_PORT), portMessage(checks))
    })
  })

  describe('chroxy doctor command', () => {
    const runDoctorCommand = async (args) => {
      const lines = []
      const origLog = console.log
      const origExitCode = process.exitCode
      console.log = (...a) => { lines.push(a.join(' ')) }
      try {
        const program = new Command()
        program.exitOverride()
        registerDoctorCommand(program)
        await program.parseAsync(['node', 'chroxy', 'doctor', '--provider', 'claude-sdk', ...args])
      } finally {
        console.log = origLog
        process.exitCode = origExitCode
      }
      return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    }
    const portLine = (lines) => {
      const line = lines.find((l) => /\bPort\b/.test(l))
      assert.ok(line, 'doctor output must include a Port row')
      return line
    }

    it('reports the config.json port when no -p flag is given', async () => {
      isolate({ fileConfig: { port: CONFIG_PORT } })
      const line = portLine(await runDoctorCommand([]))
      assert.ok(line.includes(`${CONFIG_PORT} `), line)
      assert.ok(!line.includes('8765'), line)
    })

    it('-p beats the config.json port', async () => {
      isolate({ fileConfig: { port: CONFIG_PORT } })
      const line = portLine(await runDoctorCommand(['-p', String(FLAG_PORT)]))
      assert.ok(line.includes(`${FLAG_PORT} `), line)
    })

    it('reports 8765 with no flag, env or config port', async () => {
      isolate({ fileConfig: { provider: 'claude-sdk' } })
      const line = portLine(await runDoctorCommand([]))
      assert.ok(line.includes('8765 '), line)
    })
  })
})

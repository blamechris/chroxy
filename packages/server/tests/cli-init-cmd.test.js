import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runInitCmd, parseProviderSelection } from '../src/cli/init-cmd.js'

/**
 * Build a prompt function that returns the provided answers in order.
 * If more prompts are issued than answers, throws.
 */
function makePrompt(answers) {
  const queue = [...answers]
  const asked = []
  return {
    fn: async (question) => {
      asked.push(question)
      if (queue.length === 0) {
        throw new Error(`No mock answer for prompt: ${question}`)
      }
      return queue.shift()
    },
    asked,
    remaining: () => queue.length,
  }
}

function makeEnv() {
  const writes = []
  const logs = []
  let written = null
  return {
    writeFile: (path, contents) => {
      written = { path, contents }
      writes.push({ path, contents })
    },
    getWritten: () => written,
    log: (msg) => { logs.push(msg) },
    logs,
    writes,
  }
}

describe('chroxy init provider picker', () => {
  it('defaults to claude-tui provider when user accepts default (empty input) (#5819)', async () => {
    const mock = makePrompt(['', ''])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const written = env.getWritten()
    assert.ok(written, 'config file should be written')
    const parsed = JSON.parse(written.contents)
    assert.deepEqual(parsed.providers, ['claude-tui'])
    assert.equal(parsed.port, 8765)
  })

  it('persists selected providers by number list', async () => {
    // Prompts: port, provider selection
    // Accept default port, then "2,3,4" to select claude-sdk + codex + gemini
    // (menu is 1=claude-tui, 2=claude-sdk, 3=codex, 4=gemini since #5819)
    const mock = makePrompt(['', '2,3,4'])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const parsed = JSON.parse(env.getWritten().contents)
    assert.deepEqual(
      parsed.providers.sort(),
      ['claude-sdk', 'codex', 'gemini'].sort(),
    )
  })

  it('persists only gemini when user types "4"', async () => {
    const mock = makePrompt(['', '4'])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const parsed = JSON.parse(env.getWritten().contents)
    assert.deepEqual(parsed.providers, ['gemini'])
  })

  // #6565: the daemon's provider SELECTOR reads the singular `provider` key
  // (server-cli.js `config.provider || DEFAULT_PROVIDER`), NOT `providers[]`.
  // init must write `provider = providers[0]` so a picked provider actually runs.
  it('#6565: writes the singular `provider` key = primary choice (default → claude-tui)', async () => {
    const mock = makePrompt(['', ''])
    const env = makeEnv()
    await runInitCmd({
      force: true, promptFn: mock.fn, logFn: env.log, writeFileFn: env.writeFile,
      ensureDirFn: () => {}, configFilePath: '/tmp/fake-config.json', configDirPath: '/tmp/fake-dir',
      existsFn: () => false, isKeychainAvailableFn: () => false, setTokenFn: () => {},
    })
    const parsed = JSON.parse(env.getWritten().contents)
    assert.equal(parsed.provider, 'claude-tui', 'singular `provider` written for the selector')
    assert.deepEqual(parsed.providers, ['claude-tui'])
  })

  it('#6565: a non-default pick (codex) writes provider=codex → start resolves codex', async () => {
    const mock = makePrompt(['', '3']) // 3 = codex
    const env = makeEnv()
    await runInitCmd({
      force: true, promptFn: mock.fn, logFn: env.log, writeFileFn: env.writeFile,
      ensureDirFn: () => {}, configFilePath: '/tmp/fake-config.json', configDirPath: '/tmp/fake-dir',
      existsFn: () => false, isKeychainAvailableFn: () => false, setTokenFn: () => {},
    })
    const parsed = JSON.parse(env.getWritten().contents)
    assert.equal(parsed.provider, 'codex')
    assert.deepEqual(parsed.providers, ['codex'])
    // Mirrors the selector in server-cli.js — the daemon would now run codex.
    assert.equal(parsed.provider || 'claude-tui', 'codex')
  })

  it('shows next-step hint for codex (OPENAI_API_KEY)', async () => {
    const mock = makePrompt(['', '3'])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const joined = env.logs.join('\n')
    assert.match(joined, /OPENAI_API_KEY/)
  })

  it('shows next-step hint for gemini (GEMINI_API_KEY)', async () => {
    const mock = makePrompt(['', '4'])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const joined = env.logs.join('\n')
    assert.match(joined, /GEMINI_API_KEY/)
  })

  it('treats "all" as shortcut for every provider', async () => {
    const mock = makePrompt(['', 'all'])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const parsed = JSON.parse(env.getWritten().contents)
    assert.deepEqual(
      parsed.providers.sort(),
      ['claude-tui', 'claude-sdk', 'codex', 'gemini'].sort(),
    )
  })

  it('falls back to claude-tui default when input is invalid (no valid numbers) (#5819)', async () => {
    const mock = makePrompt(['', 'xyz'])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const parsed = JSON.parse(env.getWritten().contents)
    assert.deepEqual(parsed.providers, ['claude-tui'])
  })

  it('ignores out-of-range numbers but keeps valid ones', async () => {
    // menu since #5819: 1=claude-tui, 2=claude-sdk, 3=codex, 4=gemini
    const mock = makePrompt(['', '2,9,4'])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const parsed = JSON.parse(env.getWritten().contents)
    assert.deepEqual(parsed.providers.sort(), ['claude-sdk', 'gemini'].sort())
  })

  it('drops tokens that mix digits and letters (e.g. "2abc")', () => {
    // "2abc" must be treated as invalid, not silently parsed as 2.
    // Mixed-digit result should fall back to the default (claude-tui since #5819).
    assert.deepEqual(parseProviderSelection('2abc'), ['claude-tui'])
    // Mixed with valid tokens, only the valid ones survive.
    // menu: 1=claude-tui, 2=claude-sdk, 3=codex, 4=gemini
    assert.deepEqual(parseProviderSelection('2,3abc,4'), ['claude-sdk', 'gemini'])
  })

  it('writes the port provided by the user', async () => {
    const mock = makePrompt(['9999', ''])
    const env = makeEnv()

    await runInitCmd({
      force: true,
      promptFn: mock.fn,
      logFn: env.log,
      writeFileFn: env.writeFile,
      ensureDirFn: () => {},
      configFilePath: '/tmp/fake-config.json',
      configDirPath: '/tmp/fake-dir',
      existsFn: () => false,
      isKeychainAvailableFn: () => false,
      setTokenFn: () => {},
    })

    const parsed = JSON.parse(env.getWritten().contents)
    assert.equal(parsed.port, 9999)
  })
})

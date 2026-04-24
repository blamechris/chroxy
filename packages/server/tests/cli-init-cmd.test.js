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
  it('defaults to claude-sdk provider when user accepts default (empty input)', async () => {
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
    assert.deepEqual(parsed.providers, ['claude-sdk'])
    assert.equal(parsed.port, 8765)
  })

  it('persists selected providers by number list', async () => {
    // Prompts: port, provider selection
    // Accept default port, then "1,2,3" to select claude + codex + gemini
    const mock = makePrompt(['', '1,2,3'])
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

  it('persists only gemini when user types "3"', async () => {
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

    const parsed = JSON.parse(env.getWritten().contents)
    assert.deepEqual(parsed.providers, ['gemini'])
  })

  it('shows next-step hint for codex (OPENAI_API_KEY)', async () => {
    const mock = makePrompt(['', '2'])
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
      ['claude-sdk', 'codex', 'gemini'].sort(),
    )
  })

  it('falls back to claude-sdk default when input is invalid (no valid numbers)', async () => {
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
    assert.deepEqual(parsed.providers, ['claude-sdk'])
  })

  it('ignores out-of-range numbers but keeps valid ones', async () => {
    const mock = makePrompt(['', '1,9,3'])
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
    // Mixed-digit result should fall back to the default.
    assert.deepEqual(parseProviderSelection('2abc'), ['claude-sdk'])
    // Mixed with a valid token, only the valid one survives.
    assert.deepEqual(parseProviderSelection('1,2abc,3'), ['claude-sdk', 'gemini'])
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

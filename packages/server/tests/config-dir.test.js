import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'
import { homedir } from 'os'

// Imported ONCE, at the top, with no env var set — deliberately.
//
// Every other test in this suite that needs a relocated config dir sets
// CHROXY_CONFIG_DIR *before* a dynamic `await import(...)`, because the module
// under test froze its paths into a module-scope const and the only way to
// influence it was to control what the environment looked like at import time.
// That workaround is the #7052 defect wearing a disguise, so this file must not
// use it: if these assertions pass against a statically-imported module, the
// resolution genuinely happens per call.
import { configDir, configPath } from '../src/config-dir.js'

const originalConfigDir = process.env.CHROXY_CONFIG_DIR

function setEnv(value) {
  if (value === undefined) delete process.env.CHROXY_CONFIG_DIR
  else process.env.CHROXY_CONFIG_DIR = value
}

beforeEach(() => { delete process.env.CHROXY_CONFIG_DIR })
afterEach(() => { setEnv(originalConfigDir) })
after(() => { setEnv(originalConfigDir) })

describe('config-dir', () => {
  describe('configDir()', () => {
    it('returns CHROXY_CONFIG_DIR when it is set', () => {
      process.env.CHROXY_CONFIG_DIR = '/tmp/relocated-chroxy'
      assert.equal(configDir(), '/tmp/relocated-chroxy')
    })

    it('falls back to ~/.chroxy when unset', () => {
      assert.equal(configDir(), join(homedir(), '.chroxy'))
    })

    it('refuses a relative value and falls back to ~/.chroxy', () => {
      // #7052 review — the read is per call, so a relative value would resolve
      // against process.cwd() at each fs operation, scattering credentials and
      // the daemon identity key into whatever directory the daemon was launched
      // from. Refusing keeps secrets in one predictable place.
      process.env.CHROXY_CONFIG_DIR = 'relative-state-dir'
      assert.equal(configDir(), join(homedir(), '.chroxy'))
      assert.equal(configPath('credentials.json'), join(homedir(), '.chroxy', 'credentials.json'))
    })

    it('refuses a whitespace-only value', () => {
      process.env.CHROXY_CONFIG_DIR = '   '
      assert.equal(configDir(), join(homedir(), '.chroxy'))
    })

    it('POSITIVE CONTROL: an absolute value IS honored', () => {
      // Without this, the two cases above would also pass against a configDir()
      // that had stopped reading the environment altogether.
      process.env.CHROXY_CONFIG_DIR = '/tmp/absolute-state-dir'
      assert.equal(configDir(), '/tmp/absolute-state-dir')
    })

    it('falls back to ~/.chroxy when set to the empty string', () => {
      // Matches the `||` semantics of the 16 inline copies this replaces, so
      // migrating an already-correct site is a true no-op.
      process.env.CHROXY_CONFIG_DIR = ''
      assert.equal(configDir(), join(homedir(), '.chroxy'))
    })
  })

  describe('configPath()', () => {
    it('joins a single segment onto the root', () => {
      process.env.CHROXY_CONFIG_DIR = '/tmp/relocated-chroxy'
      assert.equal(configPath('config.json'), join('/tmp/relocated-chroxy', 'config.json'))
    })

    it('joins multiple segments onto the root', () => {
      process.env.CHROXY_CONFIG_DIR = '/tmp/relocated-chroxy'
      assert.equal(configPath('snapshots', 'a.json'), join('/tmp/relocated-chroxy', 'snapshots', 'a.json'))
    })

    it('returns the root itself when given no segments', () => {
      process.env.CHROXY_CONFIG_DIR = '/tmp/relocated-chroxy'
      assert.equal(configPath(), configDir())
    })

    it('falls back to ~/.chroxy when unset', () => {
      assert.equal(configPath('config.json'), join(homedir(), '.chroxy', 'config.json'))
    })
  })

  // ---------------------------------------------------------------------
  // The controls. Everything above passes against a module-scope
  // `const CONFIG_DIR = process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy')`
  // as long as the env happened to be set before import. These do not — they
  // are the assertions that actually distinguish a live read from a frozen one.
  // ---------------------------------------------------------------------
  describe('resolves at call time, not at import time', () => {
    it('configDir() tracks a change made BETWEEN two calls', () => {
      process.env.CHROXY_CONFIG_DIR = '/tmp/first'
      const first = configDir()

      process.env.CHROXY_CONFIG_DIR = '/tmp/second'
      const second = configDir()

      assert.equal(first, '/tmp/first')
      assert.equal(second, '/tmp/second')
      assert.notEqual(first, second, 'configDir() froze its value — it is a const, not a call-time read')
    })

    it('configPath() tracks a change made BETWEEN two calls', () => {
      process.env.CHROXY_CONFIG_DIR = '/tmp/first'
      const first = configPath('session-state.json')

      process.env.CHROXY_CONFIG_DIR = '/tmp/second'
      const second = configPath('session-state.json')

      assert.equal(first, join('/tmp/first', 'session-state.json'))
      assert.equal(second, join('/tmp/second', 'session-state.json'))
      assert.notEqual(first, second, 'configPath() froze its root — it is a const, not a call-time read')
    })

    it('picks up a value set AFTER the module was imported', () => {
      // The module was imported statically at the top of this file with no env
      // var set. A const implementation captured ~/.chroxy right there and can
      // never return anything else.
      process.env.CHROXY_CONFIG_DIR = '/tmp/set-after-import'
      assert.equal(configDir(), '/tmp/set-after-import')
      assert.notEqual(configDir(), join(homedir(), '.chroxy'))
    })

    it('honors a beforeEach that relocates the dir', () => {
      // The pattern real suites use (checkpoint-manager.js:20 documents it):
      // a beforeEach points the daemon at a temp dir per test. That only works
      // if the read happens after the hook ran.
      assert.equal(configDir(), join(homedir(), '.chroxy'), 'the suite-level beforeEach should have cleared the env')
      process.env.CHROXY_CONFIG_DIR = '/tmp/per-test'
      assert.equal(configDir(), '/tmp/per-test')
    })

    it('reverts to the home fallback when the var is deleted mid-run', () => {
      process.env.CHROXY_CONFIG_DIR = '/tmp/temporarily-relocated'
      assert.equal(configDir(), '/tmp/temporarily-relocated')

      delete process.env.CHROXY_CONFIG_DIR
      assert.equal(configDir(), join(homedir(), '.chroxy'), 'configDir() cached the relocated value')
    })
  })
})

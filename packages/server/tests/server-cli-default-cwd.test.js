import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { warnInvalidDefaultCwd, createDaemonSessionManager } from '../src/server-cli.js'
import { addLogListener, removeLogListener } from '../src/logger.js'

describe('configured default cwd startup diagnostic', () => {
  let root, allowed, outside, config
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'default-cwd-')))
    allowed = join(root, 'allowed')
    outside = join(root, 'outside')
    mkdirSync(allowed)
    mkdirSync(outside)
    config = { workspaceRoots: [allowed], cwd: allowed }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  it('warns for a configured default rejected by explicit Create, but not an allowed one or an absent default', () => {
    const messages = []
    const logger = { warn: msg => messages.push(msg) }
    warnInvalidDefaultCwd(config, logger)
    warnInvalidDefaultCwd({}, logger)
    assert.equal(messages.length, 0)
    warnInvalidDefaultCwd({ ...config, cwd: outside }, logger)
    assert.equal(messages.length, 1)
    assert.match(messages[0], /Configured default cwd cannot be browsed or explicitly selected/)
    assert.match(messages[0], /blank cwd still inherit/)
  })
  it('the production startup factory warns while retaining blank cwd inheritance', () => {
    const entries = []
    const listener = entry => entries.push(entry)
    addLogListener(listener)
    let manager
    try {
      ;({ sessionManager: manager } = createDaemonSessionManager({ ...config, cwd: outside }, {
        defaultCwd: outside,
        stateFilePath: join(root, 'session-state.json'),
      }))
      assert.equal(manager.defaultCwd, outside)
      assert.ok(entries.some(entry => entry.level === 'warn' && entry.message.includes('Configured default cwd cannot be browsed')))
    } finally {
      removeLogListener(listener)
      manager?.destroyAll()
    }
  })
})

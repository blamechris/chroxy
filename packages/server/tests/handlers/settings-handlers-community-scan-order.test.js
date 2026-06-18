/**
 * Deterministic-order test for `_scanCommunityForSkillName` in
 * settings-handlers.js (#3549).
 *
 * The cross-author scan added by #3500 walks `community/<author>/` via
 * `readdirSync` and returns the first matching author. Filesystem readdir
 * order is platform-dependent, so when multiple community authors expose a
 * skill with the same name the suggested `actualAuthor` was nondeterministic.
 *
 * The fix sorts `authorEntries` alphabetically before scanning. This test
 * pins the post-fix behaviour: regardless of the order `readdirSync`
 * returns, the handler always reports the alphabetically-first author.
 *
 * Mock strategy mirrors `tests/skills-loader-community-walk-order.test.js`
 * — wrap `fs` so we can override `readdirSync`'s return order for the
 * `community/` directory while delegating every other op to the real fs.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSpy, createMockSession, nsCtx } from '../test-helpers.js'

if (typeof mock.module !== 'function') {
  describe('_scanCommunityForSkillName deterministic order (#3549)', () => {
    it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks to exercise these tests')
    })
  })
} else {
  const realFs = await import('fs')

  // Path-keyed reorder map. When `readdirSync(p)` is called and `p` is a key
  // in this map, return the mapped value verbatim instead of the real entries.
  let reorderByPath = Object.create(null)

  const mockedFs = {}
  for (const key of Object.keys(realFs)) {
    mockedFs[key] = realFs[key]
  }

  mockedFs.readdirSync = (p, ...rest) => {
    if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(reorderByPath, p)) {
      const names = reorderByPath[p].slice()
      // Honour withFileTypes: build minimal Dirent-like objects. The scan
      // checks .name, .isDirectory(), and .isSymbolicLink() — defer the
      // last two to a real stat so symlinks etc still resolve correctly.
      const opts = rest[0]
      if (opts && opts.withFileTypes) {
        return names.map((name) => {
          const full = join(p, name)
          let st
          try {
            st = realFs.statSync(full)
          } catch {
            st = null
          }
          return {
            name,
            isDirectory: () => !!(st && st.isDirectory()),
            isSymbolicLink: () => false,
            isFile: () => !!(st && st.isFile()),
          }
        })
      }
      return names
    }
    return realFs.readdirSync(p, ...rest)
  }

  mock.module('fs', { namedExports: mockedFs })
  // Cache-bust: importing settings-handlers fresh so it picks up the mocked fs.
  const { settingsHandlers } = await import('../../src/handlers/settings-handlers.js?community-scan-3549')

  function makeCtx(sessions = new Map()) {
    const sent = []
    return nsCtx({
      // #5632: sendError now routes through ctx.transport.send. Mirror the real
      // WsServer._send → ws.send step so the existing `ws._messages` assertions
      // still observe error frames.
      send: createSpy((_ws, msg) => {
        sent.push(msg)
        if (_ws && typeof _ws.send === 'function' && _ws.readyState === 1) {
          _ws.send(JSON.stringify(msg))
        }
      }),
      broadcast: createSpy(() => {}),
      broadcastToSession: createSpy(() => {}),
      sessionManager: { getSession: createSpy((id) => sessions.get(id)) },
      permissionSessionMap: new Map(),
      permissionAudit: null,
      pendingPermissions: new Map(),
      permissions: null,
      _sent: sent,
    })
  }

  function makeClient(overrides = {}) {
    return { id: 'client-1', activeSessionId: null, ...overrides }
  }

  function makeWs() {
    const messages = []
    return {
      readyState: 1,
      send: createSpy((raw) => { messages.push(JSON.parse(raw)) }),
      _messages: messages,
    }
  }

  function makeCommunityTrustStore() {
    const grants = []
    return {
      grantCommunityTrust: createSpy((author, opts) => { grants.push({ author, ...opts }) }),
      grants,
    }
  }

  describe('_scanCommunityForSkillName deterministic order (#3549)', () => {
    let dir
    let dirReal

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'chroxy-scan-order-'))
      // The handler resolves the skills root via realpathSync before keying
      // readdir against `<rootReal>/community`. On macOS the tmpdir lives
      // under /var/folders/... but realpath returns /private/var/folders/...
      // — so the reorder map must be keyed by the resolved path.
      dirReal = realpathSync(dir)
      reorderByPath = Object.create(null)
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('reports alphabetically-first author when readdirSync returns reverse order', () => {
      // Two authors both own a skill named 'foo'. The claimed author is 'mallory'
      // (does not exist), so the cross-author scan must surface a real author.
      // Without sort: returns 'zeta' (first in readdir order). With sort: 'alice'.
      mkdirSync(join(dir, 'community', 'alice'), { recursive: true })
      mkdirSync(join(dir, 'community', 'zeta'), { recursive: true })
      writeFileSync(join(dir, 'community', 'alice', 'foo.md'), '# alice foo\n')
      writeFileSync(join(dir, 'community', 'zeta', 'foo.md'), '# zeta foo\n')

      // Force readdirSync(<dir>/community) to return ['zeta', 'alice'] —
      // OPPOSITE of alphabetical. The sort fix must rescue this.
      reorderByPath[join(dirReal, 'community')] = ['zeta', 'alice']

      const trustStore = makeCommunityTrustStore()
      const sessions = new Map()
      const session = createMockSession()
      session.getTrustStore = () => trustStore
      session._skillsDir = dir
      session._repoSkillsDir = null
      session.cwd = '/tmp'
      sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
      const ctx = makeCtx(sessions)
      const ws = makeWs()

      settingsHandlers.skill_trust_grant(
        ws,
        makeClient({ activeSessionId: 's1' }),
        { skillName: 'foo', author: 'mallory' },
        ctx,
      )

      const err = ws._messages.find((m) => m.code === 'INVALID_AUTHOR')
      assert.ok(err, 'expected INVALID_AUTHOR for cross-author match')
      assert.ok(
        /alice/.test(err.message || ''),
        `expected alphabetically-first author 'alice' in error, got: ${err.message}`,
      )
      assert.ok(
        !/zeta/.test(err.message || ''),
        `must not surface 'zeta' (later in alphabetical order), got: ${err.message}`,
      )
      assert.equal(trustStore.grants.length, 0, 'must not grant trust on cross-author mismatch')
    })

    it('produces the same actualAuthor regardless of readdirSync order (sorted vs reversed)', () => {
      mkdirSync(join(dir, 'community', 'alice'), { recursive: true })
      mkdirSync(join(dir, 'community', 'bob'), { recursive: true })
      mkdirSync(join(dir, 'community', 'charlie'), { recursive: true })
      writeFileSync(join(dir, 'community', 'alice', 'foo.md'), '# a\n')
      writeFileSync(join(dir, 'community', 'bob', 'foo.md'), '# b\n')
      writeFileSync(join(dir, 'community', 'charlie', 'foo.md'), '# c\n')

      const runWithOrder = (order) => {
        reorderByPath = Object.create(null)
        if (order) reorderByPath[join(dirReal, 'community')] = order
        const trustStore = makeCommunityTrustStore()
        const sessions = new Map()
        const session = createMockSession()
        session.getTrustStore = () => trustStore
        session._skillsDir = dir
        session._repoSkillsDir = null
        session.cwd = '/tmp'
        sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
        const ctx = makeCtx(sessions)
        const ws = makeWs()
        settingsHandlers.skill_trust_grant(
          ws,
          makeClient({ activeSessionId: 's1' }),
          { skillName: 'foo', author: 'mallory' },
          ctx,
        )
        const err = ws._messages.find((m) => m.code === 'INVALID_AUTHOR')
        assert.ok(err, `expected INVALID_AUTHOR (order=${order})`)
        const m = err.message.match(/alice|bob|charlie/)
        return m ? m[0] : null
      }

      const sorted = runWithOrder(null)
      const reversed = runWithOrder(['charlie', 'bob', 'alice'])
      const shuffled = runWithOrder(['bob', 'charlie', 'alice'])

      assert.equal(sorted, 'alice', 'baseline: alphabetically-first author wins')
      assert.equal(reversed, sorted, 'reversed readdir order must produce same author')
      assert.equal(shuffled, sorted, 'shuffled readdir order must produce same author')
    })
  })
}

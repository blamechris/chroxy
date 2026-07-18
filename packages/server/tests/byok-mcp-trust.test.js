import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultTrustStorePath,
  trustTupleKey,
  loadTrustStore,
  recordTrust,
  isTrusted,
  withTrustStoreLock,
} from '../src/byok-mcp-trust.js'

let tmpDir
let storePath

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-trust-'))
  storePath = join(tmpDir, 'mcp-trust.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('byok-mcp-trust', () => {
  describe('trustTupleKey', () => {
    it('builds a stable key from name + command + args[0]', () => {
      const k = trustTupleKey({ name: 'github', command: 'node', args: ['github-mcp.js'] })
      assert.equal(typeof k, 'string')
      assert.equal(
        k,
        trustTupleKey({ name: 'github', command: 'node', args: ['github-mcp.js'] }),
      )
    })

    it('ignores args[1..N] so version bumps do not re-prompt', () => {
      const k1 = trustTupleKey({ name: 'gh', command: 'node', args: ['mcp.js', '--version', '1.4.2'] })
      const k2 = trustTupleKey({ name: 'gh', command: 'node', args: ['mcp.js', '--version', '1.5.0'] })
      assert.equal(k1, k2)
    })

    it('distinguishes binary swaps as different tuples', () => {
      const node = trustTupleKey({ name: 'gh', command: 'node', args: ['mcp.js'] })
      const evil = trustTupleKey({ name: 'gh', command: '/bin/rm', args: ['-rf'] })
      assert.notEqual(node, evil)
    })

    it('handles missing args (shell built-ins)', () => {
      assert.equal(trustTupleKey({ name: 'noop', command: 'true' }), JSON.stringify(['noop', 'true', '']))
    })

    it('throws on missing server', () => {
      assert.throws(() => trustTupleKey(null), /missing server/)
    })

    it('rejects space-injection collisions in name (#4461)', () => {
      // Pre-#4461 these two tuples encoded to the IDENTICAL key
      // "evil command rm -rf", letting a trust entry for one match the
      // other. JSON-stringified tuples are unambiguous because the
      // separator characters cannot collide with quoted strings.
      const a = trustTupleKey({ name: 'evil command', command: 'rm', args: ['-rf'] })
      const b = trustTupleKey({ name: 'evil', command: 'command rm', args: ['-rf'] })
      assert.notEqual(a, b, 'space in name must not collide with separator')
    })

    it('rejects space-injection collisions in command (#4461)', () => {
      const a = trustTupleKey({ name: 'gh', command: 'node mcp.js', args: [''] })
      const b = trustTupleKey({ name: 'gh', command: 'node', args: ['mcp.js'] })
      assert.notEqual(a, b, 'space in command must not collide with args[0] boundary')
    })

    it('rejects newline-injection collisions', () => {
      const a = trustTupleKey({ name: 'a\nb', command: 'c', args: ['d'] })
      const b = trustTupleKey({ name: 'a', command: 'b\nc', args: ['d'] })
      assert.notEqual(a, b)
    })

    it('rejects quote-injection collisions (JSON-aware encoding)', () => {
      // If we naively concatenated strings inside JSON the user could
      // craft a tuple whose embedded `","` matched the field separator.
      // JSON.stringify escapes embedded quotes so this is structurally
      // impossible — assert the property explicitly.
      const a = trustTupleKey({ name: 'x"]," y', command: 'c', args: ['d'] })
      const b = trustTupleKey({ name: 'x', command: 'y", "c", "d', args: [''] })
      assert.notEqual(a, b)
    })

    // #6821 — remote transport keys on (name, sanitized-url).
    it('keys a remote server on (name, url), distinct from any stdio tuple', () => {
      const remote = trustTupleKey({ name: 'gh', url: 'https://mcp.example.com/api' })
      assert.equal(remote, JSON.stringify(['gh', 'https://mcp.example.com/api']))
      const stdio = trustTupleKey({ name: 'gh', command: 'node', args: ['mcp.js'] })
      assert.notEqual(remote, stdio, 'a 2-element remote tuple can never alias a 3-element stdio tuple')
    })

    it('strips url credentials + query + fragment from the remote key (no re-prompt on token rotation)', () => {
      const a = trustTupleKey({ name: 'gh', url: 'https://u:p1@mcp.example.com/api?t=1#x' })
      const b = trustTupleKey({ name: 'gh', url: 'https://u:p2@mcp.example.com/api?t=2#y' })
      assert.equal(a, b, 'rotated credentials / changed query must not re-prompt for the same endpoint')
      assert.equal(a, JSON.stringify(['gh', 'https://mcp.example.com/api']))
      assert.ok(!a.includes('p1') && !a.includes('t=1'), 'no credential may reach the key')
    })

    it('distinguishes different remote endpoints', () => {
      const a = trustTupleKey({ name: 'gh', url: 'https://mcp.example.com/a' })
      const b = trustTupleKey({ name: 'gh', url: 'https://mcp.example.com/b' })
      assert.notEqual(a, b)
    })
  })

  describe('loadTrustStore', () => {
    it('returns empty set when file is missing (first run)', () => {
      const store = loadTrustStore(storePath)
      assert.equal(store.tuples.size, 0)
      assert.equal(store.path, storePath)
    })

    it('falls back to empty + warns when file is malformed', () => {
      writeFileSync(storePath, '{ not json')
      const warned = []
      const store = loadTrustStore(storePath, { log: { warn: (msg) => warned.push(msg) } })
      assert.equal(store.tuples.size, 0)
      assert.equal(warned.length, 1)
      assert.match(warned[0], /unreadable/)
    })

    it('parses a well-formed file', () => {
      // #4461: stored key MUST be the canonical JSON-stringify form;
      // entries whose stored key doesn't recompute identically are dropped.
      const entry = {
        key: trustTupleKey({ name: 'gh', command: 'node', args: ['mcp.js'] }),
        name: 'gh',
        command: 'node',
        args0: 'mcp.js',
        trustedAt: '2026-05-29T00:00:00Z',
      }
      writeFileSync(storePath, JSON.stringify({ trustedTuples: [entry] }))
      const store = loadTrustStore(storePath)
      assert.equal(store.tuples.size, 1)
      assert.ok(store.tuples.has(entry.key))
    })

    it('drops tampered entries on load (#4461 — key recompute mismatch)', () => {
      // User hand-edited command from 'node' to '/bin/rm' but left the
      // original key intact, hoping to forge trust for a different binary.
      // The load-time recompute catches this and drops the entry with a
      // warn — next start re-prompts as if the trust were never granted.
      const original = { name: 'gh', command: 'node', args: ['mcp.js'] }
      const tampered = {
        key: trustTupleKey(original),
        name: 'gh',
        command: '/bin/rm',
        args0: 'mcp.js',
        trustedAt: '2026-05-29T00:00:00Z',
      }
      writeFileSync(storePath, JSON.stringify({ trustedTuples: [tampered] }))
      const warned = []
      const store = loadTrustStore(storePath, { log: { warn: (msg) => warned.push(msg) } })
      assert.equal(store.tuples.size, 0, 'tampered entry must be dropped')
      assert.ok(warned.some((m) => /tampered/.test(m)), 'tamper drop must warn')
      assert.equal(isTrusted(store, original), false)
    })

    it('preserves untampered entries when others are dropped', () => {
      const good = { name: 'good', command: 'node', args: ['g.js'] }
      const tampered = {
        key: trustTupleKey({ name: 'bad', command: 'node', args: ['b.js'] }),
        name: 'bad',
        command: '/bin/sh',
        args0: 'b.js',
        trustedAt: '2026-05-29T00:00:00Z',
      }
      const goodEntry = {
        key: trustTupleKey(good),
        name: good.name,
        command: good.command,
        args0: good.args[0],
        trustedAt: '2026-05-29T00:00:00Z',
      }
      writeFileSync(storePath, JSON.stringify({ trustedTuples: [tampered, goodEntry] }))
      const store = loadTrustStore(storePath)
      assert.equal(store.tuples.size, 1)
      assert.ok(isTrusted(store, good))
    })
  })

  describe('recordTrust', () => {
    it('appends a new tuple and creates the file with mode 0600', () => {
      const server = { name: 'gh', command: 'node', args: ['mcp.js'] }
      recordTrust(server, storePath)
      const mode = statSync(storePath).mode & 0o777
      assert.equal(mode, 0o600)
      const store = loadTrustStore(storePath)
      assert.ok(isTrusted(store, server))
    })

    it('is idempotent — re-recording does not duplicate', () => {
      const server = { name: 'gh', command: 'node', args: ['mcp.js'] }
      recordTrust(server, storePath)
      recordTrust(server, storePath)
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      assert.equal(raw.trustedTuples.length, 1)
    })

    it('preserves existing tuples when adding a new one', () => {
      recordTrust({ name: 'a', command: 'node', args: ['a.js'] }, storePath)
      recordTrust({ name: 'b', command: 'node', args: ['b.js'] }, storePath)
      const store = loadTrustStore(storePath)
      assert.equal(store.tuples.size, 2)
      assert.ok(isTrusted(store, { name: 'a', command: 'node', args: ['a.js'] }))
      assert.ok(isTrusted(store, { name: 'b', command: 'node', args: ['b.js'] }))
    })

    it('creates the parent directory if missing', () => {
      const nested = join(tmpDir, 'nested', 'sub', 'mcp-trust.json')
      recordTrust({ name: 'x', command: 'true' }, nested)
      assert.ok(statSync(nested).isFile())
    })

    it('serializes concurrent recordTrust for distinct tuples — no lost-write race (#4460)', async () => {
      const a = { name: 'a', command: 'node', args: ['a.js'] }
      const b = { name: 'b', command: 'node', args: ['b.js'] }
      await Promise.all([
        Promise.resolve().then(() => recordTrust(a, storePath)),
        Promise.resolve().then(() => recordTrust(b, storePath)),
      ])
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      assert.equal(raw.trustedTuples.length, 2, 'both tuples must persist after concurrent writes')
      const store = loadTrustStore(storePath)
      assert.ok(isTrusted(store, a), 'a must survive concurrent write')
      assert.ok(isTrusted(store, b), 'b must survive concurrent write')
    })

    it('serializes many concurrent recordTrust calls for distinct tuples (stress)', async () => {
      const N = 10
      const servers = Array.from({ length: N }, (_, i) => ({
        name: `srv-${i}`,
        command: 'node',
        args: [`mcp-${i}.js`],
      }))
      await Promise.all(servers.map((s) => Promise.resolve().then(() => recordTrust(s, storePath))))
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      assert.equal(raw.trustedTuples.length, N, `all ${N} concurrent writes must persist`)
    })

    it('serializes recordTrust calls interleaved with awaited gates (#4460 trustGate pattern)', async () => {
      const a = { name: 'gate-a', command: 'node', args: ['a.js'] }
      const b = { name: 'gate-b', command: 'node', args: ['b.js'] }
      const fakeGate = async (server) => {
        const before = loadTrustStore(storePath)
        if (isTrusted(before, server)) return true
        await Promise.resolve()
        await Promise.resolve()
        recordTrust(server, storePath)
        return true
      }
      await Promise.all([fakeGate(a), fakeGate(b)])
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      assert.equal(raw.trustedTuples.length, 2, 'both tuples must persist after interleaved trustGates')
    })
  })

  describe('isTrusted', () => {
    it('returns false for empty store', () => {
      const store = loadTrustStore(storePath)
      assert.equal(isTrusted(store, { name: 'x', command: 'y', args: [] }), false)
    })

    it('returns true after recordTrust', () => {
      const server = { name: 'gh', command: 'node', args: ['mcp.js'] }
      recordTrust(server, storePath)
      const store = loadTrustStore(storePath)
      assert.equal(isTrusted(store, server), true)
    })

    it('returns false when only args[1..N] differs (no false negative)', () => {
      // recordTrust uses tuple key (name, command, args[0]) — checking a
      // server with different args[1..N] still matches because tuple key
      // ignores them. This protects against re-prompts on version bumps.
      recordTrust({ name: 'gh', command: 'node', args: ['mcp.js', '--v=1.0'] }, storePath)
      const store = loadTrustStore(storePath)
      assert.equal(isTrusted(store, { name: 'gh', command: 'node', args: ['mcp.js', '--v=2.0'] }), true)
    })

    it('returns false on binary swap', () => {
      recordTrust({ name: 'gh', command: 'node', args: ['mcp.js'] }, storePath)
      const store = loadTrustStore(storePath)
      assert.equal(isTrusted(store, { name: 'gh', command: '/bin/rm', args: ['-rf'] }), false)
    })
  })

  // #6821 — remote transport trust round-trips through the same store.
  describe('remote servers (#6821)', () => {
    it('records + loads a remote server, persisting name + sanitized url only', () => {
      const server = { name: 'remote', type: 'http', url: 'https://u:pw@mcp.example.com/api?tok=secret', headers: { Authorization: 'Bearer x' } }
      recordTrust(server, storePath)
      const raw = JSON.parse(readFileSync(storePath, 'utf8'))
      assert.equal(raw.trustedTuples.length, 1)
      const entry = raw.trustedTuples[0]
      assert.equal(entry.name, 'remote')
      assert.equal(entry.url, 'https://mcp.example.com/api', 'stored url must be credential-stripped')
      assert.equal(entry.command, undefined, 'remote entries carry no command')
      const disk = readFileSync(storePath, 'utf8')
      assert.ok(!disk.includes('Bearer') && !disk.includes('pw') && !disk.includes('tok=secret'),
        'no header value or url credential may ever be written to the trust store')
      const store = loadTrustStore(storePath)
      assert.equal(isTrusted(store, server), true)
    })

    it('does not confuse a remote trust with a same-named stdio server', () => {
      recordTrust({ name: 'gh', url: 'https://mcp.example.com/api' }, storePath)
      const store = loadTrustStore(storePath)
      assert.equal(isTrusted(store, { name: 'gh', url: 'https://mcp.example.com/api' }), true)
      assert.equal(isTrusted(store, { name: 'gh', command: 'node', args: ['mcp.js'] }), false)
    })

    it('survives a load-time recompute (not dropped as tampered)', () => {
      recordTrust({ name: 'remote', url: 'https://mcp.example.com/api' }, storePath)
      const warned = []
      const store = loadTrustStore(storePath, { log: { warn: (m) => warned.push(m) } })
      assert.equal(store.tuples.size, 1)
      assert.equal(warned.length, 0, 'a well-formed remote entry must not warn')
    })
  })

  describe('withTrustStoreLock (#4460)', () => {
    it('serialises critical sections for the same path', async () => {
      let active = 0
      let maxActive = 0
      const work = async () => {
        active += 1
        if (active > maxActive) maxActive = active
        await new Promise((r) => setTimeout(r, 5))
        active -= 1
      }
      await Promise.all([
        withTrustStoreLock(storePath, work),
        withTrustStoreLock(storePath, work),
        withTrustStoreLock(storePath, work),
      ])
      assert.equal(maxActive, 1, 'only one critical section may run at a time per path')
    })

    it('runs critical sections for distinct paths in parallel', async () => {
      const pathA = join(tmpDir, 'a.json')
      const pathB = join(tmpDir, 'b.json')
      let active = 0
      let maxActive = 0
      const work = async () => {
        active += 1
        if (active > maxActive) maxActive = active
        await new Promise((r) => setTimeout(r, 5))
        active -= 1
      }
      await Promise.all([
        withTrustStoreLock(pathA, work),
        withTrustStoreLock(pathB, work),
      ])
      assert.equal(maxActive, 2, 'distinct paths must not contend')
    })

    it('releases the lock when the critical section throws', async () => {
      const ran = []
      await Promise.all([
        withTrustStoreLock(storePath, async () => {
          ran.push('first')
          throw new Error('boom')
        }).catch(() => {}),
        withTrustStoreLock(storePath, async () => {
          ran.push('second')
        }),
      ])
      assert.deepEqual(ran, ['first', 'second'], 'second must run even though first threw')
    })

    it('returns the critical section value', async () => {
      const out = await withTrustStoreLock(storePath, async () => 'ok')
      assert.equal(out, 'ok')
    })
  })

  describe('defaultTrustStorePath', () => {
    it('respects CHROXY_MCP_TRUST_PATH env var when set', () => {
      const prev = process.env.CHROXY_MCP_TRUST_PATH
      process.env.CHROXY_MCP_TRUST_PATH = '/tmp/forced.json'
      try {
        assert.equal(defaultTrustStorePath(), '/tmp/forced.json')
      } finally {
        if (prev) process.env.CHROXY_MCP_TRUST_PATH = prev
        else delete process.env.CHROXY_MCP_TRUST_PATH
      }
    })
  })

  describe('recordTrust rename failure cleanup (#4463)', () => {
    // #4463: when renameSync fails (cross-device link, FS quota, ACL)
    // the .tmp file is left behind. recordTrust now wraps rename in a
    // try/catch that unlinks .tmp on failure and re-throws the original
    // error. Module mocks are required because the bug is in the
    // failure path of a sync fs operation — there's no portable way to
    // force a real rename failure that's deterministic across tmpfs /
    // ext4 / APFS.
    if (typeof mock.module !== 'function') {
      it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
        t.skip('re-run with --experimental-test-module-mocks to exercise these tests')
      })
    } else {
      it('unlinks the leaked .tmp file when renameSync fails', async () => {
        const realFs = await import('node:fs')
        let renameError = new Error('EXDEV cross-device link')
        let unlinkCalls = []
        const mockFs = {
          ...realFs,
          renameSync: () => { throw renameError },
          unlinkSync: (p) => { unlinkCalls.push(p) },
        }
        mock.module('node:fs', { defaultExport: mockFs, namedExports: mockFs })
        try {
          const { recordTrust: rt } = await import(`../src/byok-mcp-trust.js?cacheBust=4463-${Date.now()}`)
          let threw = null
          try {
            rt({ name: 'leak', command: 'node', args: ['leak.js'] }, storePath)
          } catch (err) {
            threw = err
          }
          assert.ok(threw, 'recordTrust must re-throw the rename failure')
          assert.match(threw.message, /EXDEV/, 'original error is surfaced')
          assert.equal(unlinkCalls.length, 1, '.tmp must be unlinked exactly once')
          assert.ok(unlinkCalls[0].endsWith('.tmp'), 'cleanup targets the .tmp file')
        } finally {
          mock.restoreAll()
        }
      })

      it('tolerates the .tmp already being absent during cleanup', async () => {
        const realFs = await import('node:fs')
        const renameError = new Error('original rename failure')
        const mockFs = {
          ...realFs,
          renameSync: () => { throw renameError },
          unlinkSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
        }
        mock.module('node:fs', { defaultExport: mockFs, namedExports: mockFs })
        try {
          const { recordTrust: rt } = await import(`../src/byok-mcp-trust.js?cacheBust=4463b-${Date.now()}`)
          let threw = null
          try {
            rt({ name: 'gone', command: 'node', args: ['gone.js'] }, storePath)
          } catch (err) {
            threw = err
          }
          assert.ok(threw)
          assert.match(threw.message, /original rename failure/, 'original error surfaces, not the cleanup ENOENT')
        } finally {
          mock.restoreAll()
        }
      })
    }
  })

})

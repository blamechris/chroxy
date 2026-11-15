/**
 * The agent-principal store (src/principal-store.js, agent-principals.md section 3):
 * hash-only, fail closed, constant-time validation, memory-first revoke, no mint path.
 * Every principal here is created through the test-only insert on a TEMP store.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, statSync, readdirSync, unlinkSync, renameSync as renameReal } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  PrincipalStore, createPrincipalStore, buildPrincipalEntry, parsePrincipalEntry, hashPrincipalToken,
  PrincipalGrantsDisabledError, PRINCIPALS_NOT_ENABLED_MESSAGE, MAX_PRINCIPAL_TTL_MS, DEFAULT_PRINCIPAL_TTL_MS,
  principalStorePath,
} from '../src/principal-store.js'
import { safeTokenCompare } from '../src/token-compare.js'
import { writeDurableFile } from '../src/durable-write.js'
import { tempPrincipalDir, testPrincipalStore, insertPrincipal, fakeClock } from './helpers/principal-store-fixture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')
const posix = process.platform !== 'win32'

const dirs = []
const fresh = () => { const d = tempPrincipalDir(); dirs.push(d); return d }
afterEach(() => { while (dirs.length) dirs.pop().cleanup() })

describe('the token is stored as a hash only', () => {
  it('the file holds a SHA-256 hash and never the token', () => {
    const d = fresh()
    const store = testPrincipalStore(d.path)
    const { token } = insertPrincipal(store)
    const raw = readFileSync(d.path, 'utf8')
    assert.equal(raw.includes(token), false)
    assert.ok(raw.includes(createHash('sha256').update(token).digest('hex')))
    assert.ok(posix ? (statSync(d.path).mode & 0o777) === 0o600 : true, 'the store is written 0600')
  })

  it('list() never exposes a hash, and validate() returns the stamp fields', () => {
    const store = testPrincipalStore(fresh().path)
    const { token } = insertPrincipal(store, { constraints: { sessionIds: ['s1'], cwdRoots: ['/tmp/a'] } })
    const { principals } = store.list()
    assert.equal(principals.length, 1)
    assert.equal(JSON.stringify(principals).includes('tokenHash'), false)
    const p = store.validate(token)
    assert.deepEqual(Object.keys(p).sort(), ['constraints', 'expiresAt', 'label', 'principalId', 'scope', 'tier'])
    assert.deepEqual(p.constraints, { sessionIds: ['s1'], cwdRoots: ['/tmp/a'] })
  })
})

describe('validation is a constant-time comparison against every stored hash', () => {
  it('compares the presented hash with EVERY entry, matched or not, using safeTokenCompare', () => {
    const d = fresh()
    const calls = []
    const compare = (a, b) => { calls.push(b); return safeTokenCompare(a, b) }
    const store = new PrincipalStore({ path: d.path, allowTestInsert: true, compare })
    store.refresh()
    const tokens = ['a', 'b', 'c', 'd'].map((n, i) => insertPrincipal(store, { principalId: `p${i}`, label: `l${i}` }).token)
    let cases = 0
    for (const presented of [tokens[0], tokens[3], 'not-a-token']) {
      calls.length = 0
      store.validate(presented)
      cases++
      assert.equal(calls.length, 4, 'one comparison per stored entry, whichever one matches')
    }
    assert.ok(cases > 0)
  })

  it('the default comparison IS safeTokenCompare (identity, not a lookalike)', () => {
    const store = new PrincipalStore({ path: fresh().path })
    assert.equal(store._compare, safeTokenCompare)
  })

  it('positive control: the right token resolves, a wrong, empty or oversized one does not', () => {
    const store = testPrincipalStore(fresh().path)
    const { token } = insertPrincipal(store)
    assert.ok(store.validate(token))
    assert.equal(store.validate(token + 'x'), null)
    assert.equal(store.validate(''), null)
    assert.equal(store.validate(undefined), null)
    assert.equal(store.validate('x'.repeat(10_000)), null)
  })
})

describe('the store fails closed', () => {
  function withToken() {
    const d = fresh()
    const store = testPrincipalStore(d.path)
    const { token } = insertPrincipal(store)
    return { d, store, token }
  }

  it('positive control: a healthy 0600 store validates', () => {
    const { d, token } = withToken()
    const s = createPrincipalStore({ path: d.path })
    assert.equal(s.health().ok, true)
    assert.ok(s.validate(token))
  })

  it('an absent store is healthy and empty', () => {
    const s = createPrincipalStore({ path: join(fresh().dir, 'nope.json') })
    assert.equal(s.health().ok, true)
    assert.equal(s.health().status, 'absent')
    assert.deepEqual(s.list().principals, [])
  })

  it('wrong mode: every principal is invalid and the reason names the fix', { skip: !posix }, () => {
    const { d, token } = withToken()
    chmodSync(d.path, 0o644)
    const s = createPrincipalStore({ path: d.path })
    assert.equal(s.health().ok, false)
    assert.equal(s.health().code, 'EMODE')
    assert.ok(/0600/.test(s.health().reason) && /daemon's uid/.test(s.health().reason))
    assert.equal(s.validate(token), null)
    assert.equal(s.isLive('pr-1'), false)
  })

  it('wrong owner: refused', { skip: !posix || typeof process.getuid !== 'function' }, () => {
    const { d, token } = withToken()
    const real = process.getuid
    process.getuid = () => real.call(process) + 1
    try {
      const s = createPrincipalStore({ path: d.path })
      assert.equal(s.health().code, 'EOWNER')
      assert.equal(s.validate(token), null)
    } finally { process.getuid = real }
  })

  it('a symlink at the store path is refused, never followed', { skip: !posix }, () => {
    const { d, token } = withToken()
    const link = join(d.dir, 'link.json')
    symlinkSync(d.path, link)
    const s = createPrincipalStore({ path: link })
    assert.equal(s.health().ok, false)
    assert.equal(s.health().code, 'ELOOP')
    assert.equal(s.validate(token), null)
  })

  it('a corrupt file (not JSON, or the wrong shape) invalidates everything', () => {
    for (const body of ['{not json', '[]', '{"version":2,"principals":[]}', '{"version":1}', 'null']) {
      const { d, token } = withToken()
      writeFileSync(d.path, body, { mode: 0o600 })
      chmodSync(d.path, 0o600)
      const s = createPrincipalStore({ path: d.path })
      assert.equal(s.health().ok, false, body)
      assert.equal(s.health().code, 'ECORRUPT', body)
      assert.equal(s.validate(token), null, body)
    }
  })

  it('a directory or a file over the size cap is refused', { skip: !posix }, () => {
    const d = fresh()
    mkdirSync(join(d.dir, 'dir.json'))
    assert.equal(createPrincipalStore({ path: join(d.dir, 'dir.json') }).health().ok, false)
    writeFileSync(d.path, ' '.repeat(300 * 1024), { mode: 0o600 })
    chmodSync(d.path, 0o600)
    assert.equal(createPrincipalStore({ path: d.path }).health().code, 'ETOOBIG')
  })

  it('deleting the store invalidates every principal', () => {
    const { d, token } = withToken()
    const s = createPrincipalStore({ path: d.path })
    assert.ok(s.validate(token))
    unlinkSync(d.path)
    assert.equal(s.validate(token), null)
    assert.equal(s.isLive('pr-1'), false)
  })

  it('one malformed entry grants nothing but does not take the others down', () => {
    const d = fresh()
    const store = testPrincipalStore(d.path)
    const { token } = insertPrincipal(store, { principalId: 'good', label: 'good' })
    const doc = JSON.parse(readFileSync(d.path, 'utf8'))
    doc.principals.push({ ...doc.principals[0], principalId: 'bad', label: 'Bad Label!' })
    doc.principals.push({ ...doc.principals[0], principalId: 'badscope', label: 'badscope', scope: 'root', tier: 'root' })
    writeFileSync(d.path, JSON.stringify(doc), { mode: 0o600 })
    const s = createPrincipalStore({ path: d.path })
    assert.ok(s.validate(token))
    assert.deepEqual(s.list().principals.map((p) => p.principalId), ['good'])
  })

  it('two live entries sharing a label are BOTH dropped', () => {
    const d = fresh()
    const store = testPrincipalStore(d.path)
    const a = insertPrincipal(store, { principalId: 'a', label: 'dup' })
    const doc = JSON.parse(readFileSync(d.path, 'utf8'))
    doc.principals.push({ ...doc.principals[0], principalId: 'b', tokenHash: hashPrincipalToken('other') })
    writeFileSync(d.path, JSON.stringify(doc), { mode: 0o600 })
    const s = createPrincipalStore({ path: d.path })
    assert.equal(s.validate(a.token), null)
    assert.equal(s.validate('other'), null)
  })

  it('an entry whose lifetime exceeds the maximum is dropped, never clamped', () => {
    const d = fresh()
    const store = testPrincipalStore(d.path)
    const { token } = insertPrincipal(store)
    const doc = JSON.parse(readFileSync(d.path, 'utf8'))
    doc.principals[0].expiresAt = doc.principals[0].createdAt + MAX_PRINCIPAL_TTL_MS + 1
    writeFileSync(d.path, JSON.stringify(doc), { mode: 0o600 })
    assert.equal(createPrincipalStore({ path: d.path }).validate(token), null)
  })
})

describe('liveness: expiry and revocation', () => {
  it('a token is live until expiresAt (fake clock), then not', () => {
    const clock = fakeClock()
    const store = testPrincipalStore(fresh().path, { now: clock.now })
    const { token, entry } = insertPrincipal(store, { ttlMs: 60_000 })
    assert.ok(store.validate(token))
    clock.t = entry.expiresAt - 1
    assert.ok(store.validate(token))
    assert.equal(store.state('pr-1'), 'live')
    clock.t = entry.expiresAt
    assert.equal(store.validate(token), null)
    assert.equal(store.state('pr-1'), 'expired')
  })

  it('the default TTL is 24h and the maximum is 7d', () => {
    assert.equal(DEFAULT_PRINCIPAL_TTL_MS, 24 * 3600 * 1000)
    assert.equal(MAX_PRINCIPAL_TTL_MS, 7 * 24 * 3600 * 1000)
    const store = testPrincipalStore(fresh().path)
    const { entry } = insertPrincipal(store)
    assert.equal(entry.expiresAt - entry.createdAt, DEFAULT_PRINCIPAL_TTL_MS)
  })
})

describe('grant validation (buildPrincipalEntry): TTL, label, scope, constraints', () => {
  const ctx = { tokenHash: hashPrincipalToken('t'), principalId: 'p', now: 1_800_000_000_000 }
  const ok = { label: 'sup', scope: 'steer', constraints: { sessionIds: ['s'] } }

  it('positive control: a well-formed request builds an entry', () => {
    const r = buildPrincipalEntry(ok, ctx)
    assert.equal(r.ok, true)
    assert.equal(r.entry.expiresAt - r.entry.createdAt, DEFAULT_PRINCIPAL_TTL_MS)
  })

  it('a TTL above 7 days is refused, not clamped; exactly 7 days is accepted', () => {
    const over = buildPrincipalEntry({ ...ok, ttlMs: MAX_PRINCIPAL_TTL_MS + 1 }, ctx)
    assert.equal(over.ok, false)
    assert.equal(over.code, 'TTL_TOO_LONG')
    assert.equal(buildPrincipalEntry({ ...ok, ttlMs: MAX_PRINCIPAL_TTL_MS }, ctx).ok, true)
    for (const bad of [0, -1, 1.5, '1000', NaN]) assert.equal(buildPrincipalEntry({ ...ok, ttlMs: bad }, ctx).ok, false, String(bad))
  })

  it('a label outside the charset is refused', () => {
    let cases = 0
    for (const label of ['', 'Upper', 'has space', 'a.b', 'x'.repeat(33), 'semi;colon', 'new\nline', 5, null, undefined, '[agent:x]']) {
      cases++
      assert.equal(buildPrincipalEntry({ ...ok, label }, ctx).ok, false, String(label))
    }
    for (const label of ['a', 'a-b_c9', 'x'.repeat(32)]) {
      cases++
      assert.equal(buildPrincipalEntry({ ...ok, label }, ctx).ok, true, label)
    }
    assert.ok(cases > 0)
  })

  it('an unknown or malformed scope grants nothing', () => {
    for (const scope of ['root', 'ADMIN', '', 'observe,drive', 7, null, undefined]) {
      assert.equal(buildPrincipalEntry({ ...ok, scope }, ctx).ok, false, String(scope))
    }
    for (const scope of ['observe', 'steer', 'drive', 'answer']) assert.equal(buildPrincipalEntry({ ...ok, scope }, ctx).ok, true, scope)
  })

  it('a grant must name a session or a cwd root, with sane list shapes', () => {
    for (const constraints of [undefined, null, {}, { sessionIds: [] }, { sessionIds: [''] }, { sessionIds: 'x' }, { cwdRoots: [5] }, [], { providers: ['x'] }]) {
      assert.equal(buildPrincipalEntry({ ...ok, constraints }, ctx).ok, false, JSON.stringify(constraints))
    }
    assert.equal(buildPrincipalEntry({ ...ok, constraints: { cwdRoots: ['/tmp/r'] } }, ctx).ok, true)
  })

  it('the constraint field names are the ones principalMaySee reads', () => {
    const r = buildPrincipalEntry({ ...ok, constraints: { sessionIds: ['s'], cwdRoots: ['/r'] } }, ctx)
    assert.deepEqual(Object.keys(r.entry.constraints).sort(), ['cwdRoots', 'sessionIds'])
  })

  it('a duplicate live label is refused by the store; a revoked label can be reused', () => {
    const store = testPrincipalStore(fresh().path)
    insertPrincipal(store, { principalId: 'a', label: 'sup' })
    assert.throws(() => insertPrincipal(store, { principalId: 'b', label: 'sup' }), /duplicate live label/)
    store.revoke({ label: 'sup' })
    assert.doesNotThrow(() => insertPrincipal(store, { principalId: 'c', label: 'sup' }))
  })

  it('parsePrincipalEntry refuses a tier that does not match the scope', () => {
    const r = buildPrincipalEntry(ok, ctx)
    assert.ok('reason' in parsePrincipalEntry({ ...r.entry, tier: 'answer' }))
  })
})

describe('grant refuses until the brakes land; nothing mints a token', () => {
  it('store.grant() throws the not-yet-enabled refusal and writes nothing', () => {
    const d = fresh()
    const store = testPrincipalStore(d.path)
    assert.throws(() => store.grant({ label: 'x', scope: 'observe' }), (e) => e instanceof PrincipalGrantsDisabledError && e.message === 'agent principals not yet enabled')
    assert.equal(PRINCIPALS_NOT_ENABLED_MESSAGE, 'agent principals not yet enabled')
    assert.deepEqual(store.list().principals, [])
  })

  it('the test-only insert refuses on a store that was not built for tests', () => {
    const d = fresh()
    const store = new PrincipalStore({ path: d.path })
    const built = buildPrincipalEntry({ label: 'x', scope: 'observe', constraints: { sessionIds: ['s'] } }, { tokenHash: hashPrincipalToken('t'), principalId: 'p', now: Date.now() })
    assert.throws(() => store._testOnlyInsertEntry(built.entry), /test-only/)
  })

  it('no production source generates a principal token or reaches the test-only insert', () => {
    const files = []
    const walk = (dir) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name)
        if (name.isDirectory()) walk(full)
        else if (name.name.endsWith('.js')) files.push(full)
      }
    }
    walk(SRC)
    assert.ok(files.length > 100)
    const insertUsers = files.filter((f) => readFileSync(f, 'utf8').includes('_testOnlyInsertEntry')).map((f) => f.slice(SRC.length + 1))
    assert.deepEqual(insertUsers, ['principal-store.js'])
    // The principal modules contain no token generator.
    for (const f of ['principal-store.js', 'principal-binding.js', 'principal-effect.js', 'durable-write.js', 'handlers/principal-admin-handlers.js', 'cli/agent-cmd.js']) {
      const text = readFileSync(join(SRC, f), 'utf8')
      assert.equal(/randomBytes\([^)]*\)\.toString\(\s*'base64url'/.test(text), false, `${f} generates a base64url token`)
      assert.equal(/createPrincipalToken|mintPrincipal/.test(text), false, f)
    }
  })
})

describe('revoke: memory first, then the durable write, then the verdict', () => {
  it('flips memory BEFORE the write, and the file holds revokedAt when the call returns', () => {
    const d = fresh()
    const seen = []
    let store
    const writeDurable = (path, data) => {
      seen.push({ stateAtWrite: store.state('pr-1'), onDiskBefore: JSON.parse(readFileSync(path, 'utf8')).principals[0].revokedAt, inData: JSON.parse(data).principals[0].revokedAt })
      return writeDurableFile(path, data)
    }
    store = new PrincipalStore({ path: d.path, allowTestInsert: true, writeDurable: (p, t) => { if (seen.armed) return writeDurable(p, t); return writeDurableFile(p, t) } })
    store.refresh()
    const { token } = insertPrincipal(store)
    seen.armed = true
    const out = store.revoke({ principalId: 'pr-1' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].stateAtWrite, 'revoked', 'memory is flipped before the write starts')
    assert.equal(seen[0].onDiskBefore, null)
    assert.ok(typeof seen[0].inData === 'number')
    assert.deepEqual({ found: out.found, durable: out.durable }, { found: true, durable: true })
    assert.ok(typeof JSON.parse(readFileSync(d.path, 'utf8')).principals[0].revokedAt === 'number')
    assert.equal(store.validate(token), null)
  })

  it('a failed persist leaves memory revoked, reports not durable, and a refresh never un-revokes', () => {
    const d = fresh()
    let failing = false
    const store = new PrincipalStore({ path: d.path, allowTestInsert: true, writeDurable: (p, t) => { if (failing) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return writeDurableFile(p, t) } })
    store.refresh()
    const { token } = insertPrincipal(store)
    failing = true
    const out = store.revoke({ label: 'supervisor' })
    assert.equal(out.found, true)
    assert.equal(out.durable, false)
    assert.equal(out.persistError, 'ENOSPC')
    assert.equal(store.validate(token), null, 'revoked in memory')
    // The disk still says live (the write failed); a re-read must not revive it.
    assert.equal(JSON.parse(readFileSync(d.path, 'utf8')).principals[0].revokedAt, null)
    store.refresh()
    assert.equal(store.state('pr-1'), 'revoked')
    assert.equal(store.validate(token), null)
    // Once writable, revoking again persists it.
    failing = false
    const again = store.revoke({ principalId: 'pr-1' })
    assert.equal(again.durable, true)
    assert.ok(typeof JSON.parse(readFileSync(d.path, 'utf8')).principals[0].revokedAt === 'number')
  })

  it('an unconfirmed directory fsync reports durable: false while the revoke still holds', () => {
    const d = fresh()
    let unconfirmed = false
    const store = new PrincipalStore({ path: d.path, allowTestInsert: true, writeDurable: (p, t) => (unconfirmed ? { ...writeDurableFile(p, t), durable: false, unconfirmed: 'EIO' } : writeDurableFile(p, t)) })
    store.refresh()
    const { token } = insertPrincipal(store)
    unconfirmed = true
    const out = store.revoke({ principalId: 'pr-1' })
    assert.equal(out.durable, false)
    assert.equal(out.persistError, 'EIO')
    assert.equal(store.validate(token), null)
  })

  it('revoking an unknown principal or label is found:false and writes nothing', () => {
    const d = fresh()
    const store = testPrincipalStore(d.path)
    insertPrincipal(store)
    const before = readFileSync(d.path, 'utf8')
    assert.deepEqual(store.revoke({ principalId: 'nope' }), { found: false })
    assert.deepEqual(store.revoke({ label: 'nope' }), { found: false })
    assert.deepEqual(store.revoke({}), { found: false })
    assert.equal(readFileSync(d.path, 'utf8'), before)
  })

  it('revoke by label targets the LIVE grant; revoking twice is idempotent', () => {
    const store = testPrincipalStore(fresh().path)
    const { token } = insertPrincipal(store)
    const first = store.revoke({ label: 'supervisor' })
    assert.equal(first.alreadyRevoked, false)
    const second = store.revoke({ principalId: 'pr-1' })
    assert.equal(second.alreadyRevoked, true)
    assert.equal(store.validate(token), null)
    assert.deepEqual(store.revoke({ label: 'supervisor' }), { found: false })
  })

  it('an invalid store cannot be revoked into (there is nothing live to find)', { skip: !posix }, () => {
    const d = fresh()
    const store = testPrincipalStore(d.path)
    insertPrincipal(store)
    chmodSync(d.path, 0o666)
    assert.deepEqual(store.revoke({ principalId: 'pr-1' }), { found: false })
  })
})

describe('the one durable-write helper (write, fsync file, rename, fsync directory)', () => {
  it('fsyncs the temp file BEFORE the rename and the directory AFTER it', { skip: !posix }, () => {
    const d = fresh()
    const events = []
    const target = join(d.dir, 'out.json')
    const r = writeDurableFile(target, '{"a":1}', {
      _fsync: (fd) => { events.push(`fsync:${events.filter((e) => e.startsWith('fsync')).length === 0 ? 'file' : 'dir'}`) },
      _rename: (from, to) => { events.push('rename'); return renameReal(from, to) },
    })
    assert.deepEqual(events, ['fsync:file', 'rename', 'fsync:dir'])
    assert.deepEqual(r, { durable: true, unconfirmed: null })
    assert.equal(readFileSync(target, 'utf8'), '{"a":1}')
    assert.equal(statSync(target).mode & 0o777, 0o600)
  })

  it('a failed directory fsync is reported (durable false), not thrown; the file is live', { skip: !posix }, () => {
    const d = fresh()
    const target = join(d.dir, 'out.json')
    let n = 0
    const r = writeDurableFile(target, 'x', { _fsync: () => { if (++n === 2) throw Object.assign(new Error('EIO on dir'), { code: 'EIO' }) } })
    assert.equal(r.durable, false)
    assert.ok(/EIO/.test(r.unconfirmed))
    assert.equal(readFileSync(target, 'utf8'), 'x')
  })

  it('a failed file fsync throws, publishes nothing and leaves no temp file', { skip: !posix }, () => {
    const d = fresh()
    const target = join(d.dir, 'out.json')
    assert.throws(() => writeDurableFile(target, 'x', { _fsync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } }), /EIO/)
    assert.deepEqual(readdirSync(d.dir), [])
  })

  it('a failed rename throws and leaves no temp file', { skip: !posix }, () => {
    const d = fresh()
    assert.throws(() => writeDurableFile(join(d.dir, 'out.json'), 'x', { _fsync: () => {}, _rename: () => { throw new Error('EXDEV') } }), /EXDEV/)
    assert.deepEqual(readdirSync(d.dir), [])
  })

  it('the store path honours CHROXY_CONFIG_DIR, resolved per call', () => {
    const before = process.env.CHROXY_CONFIG_DIR
    const d = fresh()
    process.env.CHROXY_CONFIG_DIR = d.dir
    try { assert.equal(principalStorePath(), join(d.dir, 'principals.json')) } finally {
      if (before === undefined) delete process.env.CHROXY_CONFIG_DIR; else process.env.CHROXY_CONFIG_DIR = before
    }
  })
})

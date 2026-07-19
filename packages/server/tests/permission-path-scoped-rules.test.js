import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PermissionManager } from '../src/permission-manager.js'
import { PermissionRuleStore } from '../src/permission-rule-store.js'

/**
 * #6803 — path-scoped permission rules.
 *
 * PermissionRuleSchema gained an OPTIONAL `path` scope. A scoped rule only
 * matches a tool call whose target path(s) all resolve UNDER the scope (a
 * directory prefix like `src/`, or a glob like `src/**​/*.ts`). UNSCOPED rules
 * behave exactly as before (match every path). This covers the manager's rule
 * matching AND the durable store round-trip, plus the interaction with the
 * #6794/#6803 protected-path floor.
 *
 * Every store writes to a temp dir (never the real ~/.chroxy) so the #4633
 * sandbox guard is satisfied. Paths are synthetic (string ops only).
 */

const silentLog = { info() {}, warn() {}, error() {} }
const CWD = '/work/project'

function createManager(opts = {}) {
  return new PermissionManager({ log: silentLog, cwd: CWD, ...opts })
}

async function run(pm, tool, input, mode = 'approve') {
  const events = []
  const onReq = (d) => events.push(d)
  pm.on('permission_request', onReq)
  const promise = pm.handlePermission(tool, input, null, mode)
  if (events.length > 0) pm.respondToPermission(events[0].requestId, 'deny')
  const behavior = (await promise).behavior
  pm.off('permission_request', onReq)
  return { floored: events.length === 1, behavior }
}

describe('#6803 path-scoped session rules — _matchesRule', () => {
  let pm
  beforeEach(() => { pm = createManager() })
  afterEach(() => { pm.destroy() })

  it('a scoped allow Write matches a target inside the scope', () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/' }])
    assert.equal(pm._matchesRule('Write', { file_path: 'src/a.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: 'src/deep/nested/b.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: `${CWD}/src/abs.js` }), 'allow')
  })

  it('a scoped allow Write does NOT match a target outside the scope', () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/' }])
    assert.equal(pm._matchesRule('Write', { file_path: 'lib/a.js' }), null)
    assert.equal(pm._matchesRule('Write', { file_path: 'a.js' }), null)
    assert.equal(pm._matchesRule('Write', { file_path: '../escape.js' }), null)
  })

  it('an UNSCOPED allow Write matches every path (unchanged)', () => {
    pm.setRules([{ tool: 'Write', decision: 'allow' }])
    assert.equal(pm._matchesRule('Write', { file_path: 'src/a.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: 'lib/a.js' }), 'allow')
    // bare _matchesRule(tool) with no input still resolves an unscoped rule.
    assert.equal(pm._matchesRule('Write'), 'allow')
  })

  it('a scoped rule never matches a command-shaped / path-less input', () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/' }])
    assert.equal(pm._matchesRule('Write', { command: 'ls' }), null)
    assert.equal(pm._matchesRule('Write', {}), null)
    assert.equal(pm._matchesRule('Write'), null, 'no input → a scoped rule cannot confirm scope')
  })

  it('glob scope: src/**/*.js matches nested .js only', () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/**/*.js' }])
    assert.equal(pm._matchesRule('Write', { file_path: 'src/a.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: 'src/deep/b.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: 'src/a.ts' }), null, 'ext mismatch')
    assert.equal(pm._matchesRule('Write', { file_path: 'lib/a.js' }), null, 'outside src/')
  })

  it('glob scope: single-* stays within one segment', () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/*.js' }])
    assert.equal(pm._matchesRule('Write', { file_path: 'src/a.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: 'src/deep/b.js' }), null, '* does not cross /')
  })

  it('glob scope NEVER matches a target that escapes the session cwd (PR #6873 review)', () => {
    // `**/*.js` / `**` must not reach ABOVE base via `..` or an absolute path.
    pm.setRules([{ tool: 'Write', decision: 'allow', path: '**/*.js' }])
    assert.equal(pm._matchesRule('Write', { file_path: '../evil.js' }), null, '../ escape must not match')
    assert.equal(pm._matchesRule('Write', { file_path: '../../etc/x.js' }), null)
    assert.equal(pm._matchesRule('Write', { file_path: '/etc/passwd.js' }), null, 'absolute escape must not match')
    assert.equal(pm._matchesRule('Write', { file_path: 'src/a.js' }), 'allow', 'an in-cwd target still matches')

    pm.setRules([{ tool: 'Write', decision: 'allow', path: '**' }])
    assert.equal(pm._matchesRule('Write', { file_path: '/etc/passwd' }), null, 'bare ** must not match an absolute target')
    assert.equal(pm._matchesRule('Write', { file_path: '../secret' }), null)
    assert.equal(pm._matchesRule('Write', { file_path: 'a/b/c' }), 'allow')

    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/**' }])
    assert.equal(pm._matchesRule('Write', { file_path: 'src/a/b.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: '../../etc/x' }), null, 'a ..-escape falls through to a prompt')
  })

  it('a glob-escape target falls through to a fresh prompt end-to-end', async () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: '**/*.js' }])
    const events = []
    pm.on('permission_request', (d) => events.push(d))
    const promise = pm.handlePermission('Write', { file_path: '../evil.js' }, null, 'approve')
    assert.equal(events.length, 1, 'an out-of-cwd glob target must prompt, not auto-approve')
    pm.respondToPermission(events[0].requestId, 'deny')
    const result = await promise
    assert.equal(result.behavior, 'deny')
  })

  it('multi-target: matches only when EVERY target is in scope', () => {
    pm.setRules([{ tool: 'apply_patch', decision: 'allow', path: 'src/' }])
    // all in scope → allow
    assert.equal(pm._matchesRule('apply_patch', {
      changes: [{ path: 'src/a.js', kind: 'update', diff: 'd' }, { path: 'src/b.js', kind: 'add', diff: 'd' }],
    }), 'allow')
    // one out of scope → no match
    assert.equal(pm._matchesRule('apply_patch', {
      changes: [{ path: 'src/a.js', kind: 'update', diff: 'd' }, { path: 'lib/c.js', kind: 'update', diff: 'd' }],
    }), null)
  })

  it('a scoped deny only bites inside the scope', () => {
    pm.setRules([{ tool: 'Read', decision: 'deny', path: 'secrets/' }])
    assert.equal(pm._matchesRule('Read', { file_path: 'secrets/x.txt' }), 'deny')
    assert.equal(pm._matchesRule('Read', { file_path: 'src/x.txt' }), null)
  })

  it('two scopes for the same tool coexist and match independently', () => {
    pm.setRules([
      { tool: 'Write', decision: 'allow', path: 'src/' },
      { tool: 'Write', decision: 'allow', path: 'tests/' },
    ])
    assert.equal(pm._matchesRule('Write', { file_path: 'src/a.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: 'tests/a.js' }), 'allow')
    assert.equal(pm._matchesRule('Write', { file_path: 'lib/a.js' }), null)
  })

  it('setRules rejects an empty / non-string path scope', () => {
    assert.throws(() => pm.setRules([{ tool: 'Write', decision: 'allow', path: '' }]), /non-empty string/)
    assert.throws(() => pm.setRules([{ tool: 'Write', decision: 'allow', path: 42 }]), /non-empty string/)
  })

  it('getRules round-trips a scoped rule and keeps unscoped rules plain', () => {
    pm.setRules([
      { tool: 'Write', decision: 'allow', path: 'src/' },
      { tool: 'Read', decision: 'allow' },
    ])
    assert.deepEqual(pm.getRules(), [
      { tool: 'Write', decision: 'allow', path: 'src/' },
      { tool: 'Read', decision: 'allow' },
    ])
  })
})

describe('#6803 path-scoped rules end-to-end (handlePermission)', () => {
  let pm
  beforeEach(() => { pm = createManager() })
  afterEach(() => { pm.destroy() })

  it('(a) scoped allow Write under src/ → auto-approves a src/ write', async () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/' }])
    const r = await run(pm, 'Write', { file_path: 'src/a.js' })
    assert.equal(r.floored, false)
    assert.equal(r.behavior, 'allow')
  })

  it('(a) scoped allow Write under src/ → prompts for a write OUTSIDE src/', async () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/' }])
    const r = await run(pm, 'Write', { file_path: 'lib/a.js' })
    assert.equal(r.floored, true, 'out-of-scope write must fall through to a prompt')
  })

  it('(a) UNSCOPED allow Write still auto-approves everywhere', async () => {
    pm.setRules([{ tool: 'Write', decision: 'allow' }])
    const r = await run(pm, 'Write', { file_path: 'lib/a.js' })
    assert.equal(r.floored, false)
    assert.equal(r.behavior, 'allow')
  })

  it('FLOOR still wins: scoped allow Write under src/ → a secret in src/ still prompts', async () => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: 'src/' }])
    const r = await run(pm, 'Write', { file_path: 'src/.env' })
    assert.equal(r.floored, true, 'the protected-path floor beats a scoped allow')
  })
})

describe('#6803 path-scoped rules persist + round-trip through the store', () => {
  let dir, filePath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-scoped-rules-'))
    filePath = join(dir, 'permission-rules.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('addRule persists a scoped rule; getRules reads path back', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    assert.equal(store.addRule('/proj/a', { tool: 'Write', decision: 'allow', path: 'src/' }), true)
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow', path: 'src/' }])
  })

  it('two distinct scopes for one tool coexist; same scope is replaced', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow', path: 'src/' })
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow', path: 'tests/' })
    assert.equal(store.getRules('/proj/a').length, 2, 'distinct scopes coexist')
    // same (tool, scope) → replaced, not duplicated
    store.addRule('/proj/a', { tool: 'Write', decision: 'deny', path: 'src/' })
    const rules = store.getRules('/proj/a')
    assert.equal(rules.length, 2)
    assert.deepEqual(rules.find((r) => r.path === 'src/'), { tool: 'Write', decision: 'deny', path: 'src/' })
  })

  it('survives a simulated restart: a NEW store instance reads the scope back', () => {
    const s1 = new PermissionRuleStore({ filePath, logger: silentLog })
    s1.addRule('/proj/a', { tool: 'Write', decision: 'allow', path: 'src/' })
    s1.addRule('/proj/a', { tool: 'Read', decision: 'allow' })
    const s2 = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(s2.getRules('/proj/a'), [
      { tool: 'Write', decision: 'allow', path: 'src/' },
      { tool: 'Read', decision: 'allow' },
    ])
  })

  it('setRules preserves scopes and drops a malformed one', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    const stored = store.setRules('/proj/a', [
      { tool: 'Write', decision: 'allow', path: 'src/' },
      { tool: 'Read', decision: 'allow', path: 42 }, // invalid scope → dropped
      { tool: 'Edit', decision: 'allow' },
    ])
    assert.deepEqual(stored, [
      { tool: 'Write', decision: 'allow', path: 'src/' },
      { tool: 'Edit', decision: 'allow' },
    ])
  })

  it('a store-seeded scoped rule auto-allows in-scope and prompts out-of-scope in a session', async () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    store.addRule(CWD, { tool: 'Write', decision: 'allow', path: 'src/' })
    const pm = new PermissionManager({ log: silentLog, cwd: CWD, ruleStore: store })
    try {
      // seeded persistent scoped rule applies without a prompt in-scope
      const inScope = await run(pm, 'Write', { file_path: 'src/a.js' })
      assert.equal(inScope.floored, false)
      assert.equal(inScope.behavior, 'allow')
      // out-of-scope → prompt
      const outScope = await run(pm, 'Write', { file_path: 'lib/a.js' })
      assert.equal(outScope.floored, true)
    } finally { pm.destroy() }
  })
})

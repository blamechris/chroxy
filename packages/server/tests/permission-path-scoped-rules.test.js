import { describe, it, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PermissionManager } from '../src/permission-manager.js'
import { isProtectedPathTarget, collectChangeTargets } from '../src/permission-floor.js'
import { PermissionRuleStore } from '../src/permission-rule-store.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

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
// A scoped rule is checked against the target's real location, so the session
// cwd must exist on disk. The directory is created once and removed at exit.
const CWD_ROOT = mkdtempSync(join(tmpdir(), 'chroxy-scoped-rules-cwd-'))
const CWD = realpathSync(CWD_ROOT)
after(() => { rmSync(CWD_ROOT, { recursive: true, force: true }) })

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

  it('scoped removeRule drops only its own scope, preserving sibling scopes (PR #6873 review)', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow', path: 'src/' })
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow', path: 'tests/' })
    store.addRule('/proj/a', { tool: 'Read', decision: 'allow' })
    // Remove ONE scope → the sibling scope and the unscoped Read rule survive.
    assert.equal(store.removeRule('/proj/a', 'Write', 'src/'), true)
    assert.deepEqual(store.getRules('/proj/a'), [
      { tool: 'Write', decision: 'allow', path: 'tests/' },
      { tool: 'Read', decision: 'allow' },
    ])
    // Removing a non-existent (tool, scope) is a no-op.
    assert.equal(store.removeRule('/proj/a', 'Write', 'nope/'), false)
    // Tool-wide removal (no path) clears every remaining scope for the tool.
    assert.equal(store.removeRule('/proj/a', 'Write'), true)
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Read', decision: 'allow' }])
  })

  it('scoped removeRule persists (a reloaded store reflects the removal)', () => {
    const s1 = new PermissionRuleStore({ filePath, logger: silentLog })
    s1.addRule('/proj/a', { tool: 'Write', decision: 'allow', path: 'src/' })
    s1.addRule('/proj/a', { tool: 'Write', decision: 'allow', path: 'tests/' })
    s1.removeRule('/proj/a', 'Write', 'src/')
    const s2 = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(s2.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow', path: 'tests/' }])
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

describe('path-scoped rules match on the target real location', () => {
  let root
  let pm
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-scoped-rules-')))
    mkdirSync(join(root, 'src', 'sub'), { recursive: true })
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'src', 'a.txt'), 'a')
    writeFileSync(join(root, 'src', 'sub', 'b.txt'), 'b')
    writeFileSync(join(root, 'other', 'outside.txt'), 'x')
    pm = new PermissionManager({ log: silentLog, cwd: root })
  })
  afterEach(() => {
    pm.destroy()
    rmSync(root, { recursive: true, force: true })
  })

  const match = (scope, file) => {
    pm.setRules([{ tool: 'Write', decision: 'allow', path: scope }])
    return pm._matchesRule('Write', { file_path: file })
  }

  it('matches a plain existing file inside the scope', () => {
    assert.equal(match('src', 'src/a.txt'), 'allow')
    assert.equal(match('src/**', 'src/a.txt'), 'allow')
  })

  it('matches a file that does not exist yet inside the scope', () => {
    assert.equal(match('src', 'src/new.txt'), 'allow')
    assert.equal(match('src', 'src/missing-dir/new.txt'), 'allow')
    assert.equal(match('src/**', 'src/new.txt'), 'allow')
  })

  it('does not match a link inside the scope that points to a file outside it', { skip: SKIP_NO_SYMLINK }, () => {
    symlinkSync(join(root, 'other', 'outside.txt'), join(root, 'src', 'link'))
    assert.equal(match('src', 'src/link'), null)
    assert.equal(match('src/**', 'src/link'), null)
  })

  it('still matches a link inside the scope that points to another file inside it', { skip: SKIP_NO_SYMLINK }, () => {
    symlinkSync(join(root, 'src', 'a.txt'), join(root, 'src', 'inner'))
    assert.equal(match('src', 'src/inner'), 'allow')
    assert.equal(match('src/**', 'src/inner'), 'allow')
  })

  it('does not match a path that climbs out of the scope through a link', { skip: SKIP_NO_SYMLINK }, () => {
    symlinkSync(root, join(root, 'src', 'up'))
    assert.equal(match('src', 'src/up/other/outside.txt'), null)
    assert.equal(match('src', 'src/up/other/file'), null)
  })

  it('does not match when the target cannot be resolved (link loop)', { skip: SKIP_NO_SYMLINK }, () => {
    symlinkSync(join(root, 'src', 'loop-b'), join(root, 'src', 'loop-a'))
    symlinkSync(join(root, 'src', 'loop-a'), join(root, 'src', 'loop-b'))
    assert.equal(match('src', 'src/loop-a'), null)
    assert.equal(match('src/**', 'src/loop-a'), null)
  })

  it('on POSIX a link whose name holds a backslash is followed as one component', {
    skip: process.platform === 'win32' || SKIP_NO_SYMLINK,
  }, () => {
    symlinkSync(join(root, 'other', 'outside.txt'), join(root, 'src', 'x\\y'))
    assert.equal(match('src', 'src/x\\y'), null)
    assert.equal(match('src', join(root, 'src', 'x\\y')), null)
    assert.equal(match('src/**', 'src/x\\y'), null)
    // the same text with no such link is one new filename inside the scope
    assert.equal(match('src', 'src/p\\q'), 'allow')
  })

  it('a `..` after a missing component resumes inspection, so a link reached afterwards is followed', { skip: SKIP_NO_SYMLINK }, () => {
    symlinkSync(join(root, 'other'), join(root, 'src', 'jump'))
    assert.equal(match('src', 'src/missing/../jump/outside.txt'), null)
    assert.equal(match('src', 'src/m1/m2/../../jump/outside.txt'), null)
    assert.equal(match('src/**', 'src/missing/../jump/outside.txt'), null)
    // a `..` that stays inside the scope still matches
    assert.equal(match('src', 'src/missing/../new.txt'), 'allow')
    assert.equal(match('src', 'src/missing/../sub/b.txt'), 'allow')
  })

  it('a glob scope whose literal prefix is a link matches the files below it', { skip: SKIP_NO_SYMLINK }, () => {
    symlinkSync(join(root, 'src'), join(root, 'alias'))
    assert.equal(match('alias', 'alias/a.txt'), 'allow')
    assert.equal(match('alias/**', 'alias/a.txt'), 'allow')
    assert.equal(match('alias/**', 'alias/sub/b.txt'), 'allow')
    assert.equal(match('alias/*', 'alias/a.txt'), 'allow')
    assert.equal(match('alias/**/*.txt', 'alias/sub/b.txt'), 'allow')
    assert.equal(match('alias/sub/*.txt', 'alias/sub/b.txt'), 'allow')
    // the glob still decides which files below the prefix match
    assert.equal(match('alias/*.js', 'alias/a.txt'), null)
    assert.equal(match('alias/sub/*', 'alias/a.txt'), null)
    // and a target outside the prefix does not match
    assert.equal(match('alias/**', 'other/outside.txt'), null)
  })

  it('a glob scope whose prefix link points outside the session cwd matches nothing', { skip: SKIP_NO_SYMLINK }, () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-scoped-outside-')))
    try {
      writeFileSync(join(outside, 'f.txt'), 'x')
      symlinkSync(outside, join(root, 'ext'))
      assert.equal(match('ext/**', 'ext/f.txt'), null)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a scoped deny matches any target inside the scope, by text or by real location', { skip: SKIP_NO_SYMLINK }, () => {
    mkdirSync(join(root, 'secrets'))
    mkdirSync(join(root, 'pub'))
    writeFileSync(join(root, 'secrets', 's.txt'), 's')
    writeFileSync(join(root, 'pub', 'p.txt'), 'p')
    symlinkSync(join(root, 'secrets'), join(root, 'pub', 'lnk'))
    pm.setRules([{ tool: 'Write', decision: 'deny', path: 'secrets' }])
    const w = (file_path) => pm._matchesRule('Write', { file_path })
    assert.equal(w('secrets/s.txt'), 'deny', 'by text')
    assert.equal(w('pub/lnk/s.txt'), 'deny', 'through a link into the scope')
    assert.equal(w('pub/lnk'), 'deny')
    assert.equal(w('pub/p.txt'), null, 'unrelated call')
    assert.equal(w('src/a.txt'), null, 'unrelated call')
    pm.setRules([{ tool: 'Write', decision: 'deny', path: 'secrets/**' }])
    assert.equal(w('pub/lnk/s.txt'), 'deny', 'glob scope, through a link')
    assert.equal(w('pub/p.txt'), null)
  })

  it('a scoped deny on apply_patch matches when any change is in the scope or the list is unusable', () => {
    mkdirSync(join(root, 'secrets'))
    pm.setRules([{ tool: 'apply_patch', decision: 'deny', path: 'secrets' }])
    const c = (path, move_path = null) => ({ path, kind: { type: 'update', move_path }, diff: '' })
    const patch = (...changes) => pm._matchesRule('apply_patch', { changes })
    assert.equal(patch(c('src/a.txt'), c('secrets/k.txt')), 'deny', 'one change in scope')
    assert.equal(patch(c('src/a.txt', 'secrets/k.txt')), 'deny', 'rename into the scope')
    assert.equal(patch(c('src/a.txt'), c('src/b.txt')), null, 'nothing in scope')
    assert.equal(pm._matchesRule('apply_patch', { changes: 'diff' }), 'deny', 'incomplete list')
    assert.equal(pm._matchesRule('apply_patch', { changes: [c('src/a.txt'), {}] }), 'deny', 'malformed member')
    assert.equal(pm._matchesRule('apply_patch', {}), 'deny', 'no list')
  })

  it('a scoped deny matches a call whose targets cannot be determined', () => {
    pm.setRules([{ tool: 'Glob', decision: 'deny', path: 'secrets' }])
    assert.equal(pm._matchesRule('Glob', { path: 'src', pattern: '../secrets/*' }), 'deny', 'pattern leaves its root')
    assert.equal(pm._matchesRule('Glob', { path: 'src', pattern: '*.js' }), null)
    pm.setRules([{ tool: 'Read', decision: 'deny', path: 'secrets' }])
    assert.equal(pm._matchesRule('Read', {}), 'deny', 'no target')
    assert.equal(pm._matchesRule('Read', { file_path: '~/x' }), 'deny', 'home-relative')
    assert.equal(pm._matchesRule('Read', { file_path: 'src/a.txt' }), null)
  })

  it('a scoped deny matches when the real location cannot be resolved', { skip: SKIP_NO_SYMLINK }, () => {
    mkdirSync(join(root, 'secrets'))
    symlinkSync(join(root, 'src', 'loop-b'), join(root, 'src', 'loop-a'))
    symlinkSync(join(root, 'src', 'loop-a'), join(root, 'src', 'loop-b'))
    pm.setRules([{ tool: 'Write', decision: 'deny', path: 'secrets' }])
    assert.equal(pm._matchesRule('Write', { file_path: 'src/loop-a' }), 'deny')
  })

  it('does not match when the session cwd does not exist', () => {
    const missing = new PermissionManager({ log: silentLog, cwd: join(root, 'no-such-dir') })
    missing.setRules([{ tool: 'Write', decision: 'allow', path: 'src' }])
    assert.equal(missing._matchesRule('Write', { file_path: 'src/a.txt' }), null)
    missing.destroy()
  })
})

describe('path-scoped rules collect the targets the tool really uses', () => {
  let root
  let pm
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-scoped-targets-')))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'docs'))
    pm = new PermissionManager({ log: silentLog, cwd: root })
  })
  afterEach(() => {
    pm.destroy()
    rmSync(root, { recursive: true, force: true })
  })
  const rule = (tool, scope) => pm.setRules([{ tool, decision: 'allow', path: scope }])

  it('Glob and Grep use `path`, and ignore a decoy `file_path`', () => {
    for (const tool of ['Glob', 'Grep']) {
      rule(tool, 'src')
      assert.equal(pm._matchesRule(tool, { path: 'src', pattern: 'x' }), 'allow')
      assert.equal(pm._matchesRule(tool, { file_path: 'src', pattern: 'x' }), null, `${tool}: decoy file_path with no path searches the cwd`)
      assert.equal(pm._matchesRule(tool, { file_path: 'src', path: 'docs', pattern: 'x' }), null)
      assert.equal(pm._matchesRule(tool, { file_path: 'docs', path: 'src', pattern: 'x' }), 'allow')
    }
  })

  it('Glob and Grep with no `path` search the session cwd', () => {
    rule('Glob', 'src')
    assert.equal(pm._matchesRule('Glob', { pattern: '*' }), null)
    rule('Glob', '**')
    assert.equal(pm._matchesRule('Glob', { pattern: '*' }), 'allow')
    pm.setRules([{ tool: 'Grep', decision: 'allow', path: '.' }])
    assert.equal(pm._matchesRule('Grep', { pattern: 'x' }), 'allow')
  })

  it('Read/Write/Edit use `file_path` and ignore `path`', () => {
    for (const tool of ['Read', 'Write', 'Edit']) {
      rule(tool, 'src')
      assert.equal(pm._matchesRule(tool, { file_path: 'src/a.txt' }), 'allow')
      assert.equal(pm._matchesRule(tool, { file_path: 'docs/a.txt', path: 'src' }), null)
      assert.equal(pm._matchesRule(tool, { path: 'src/a.txt' }), null)
    }
  })

  it('NotebookEdit uses `notebook_path`', () => {
    rule('NotebookEdit', 'src')
    assert.equal(pm._matchesRule('NotebookEdit', { notebook_path: 'src/n.ipynb' }), 'allow')
    assert.equal(pm._matchesRule('NotebookEdit', { notebook_path: 'docs/n.ipynb', file_path: 'src/n.ipynb' }), null)
  })

  it('apply_patch checks every path and every rename destination', () => {
    rule('apply_patch', 'src')
    const change = (path, move_path) => ({ path, kind: { type: 'update', move_path: move_path ?? null }, diff: '' })
    assert.equal(pm._matchesRule('apply_patch', { changes: [change('src/a.txt')] }), 'allow')
    assert.equal(pm._matchesRule('apply_patch', { changes: [change('src/a.txt', 'src/b.txt')] }), 'allow')
    assert.equal(pm._matchesRule('apply_patch', { changes: [change('src/a.txt', 'docs/b.txt')] }), null)
    assert.equal(pm._matchesRule('apply_patch', { changes: [change('src/a.txt'), change('docs/b.txt')] }), null)
  })

  it('apply_patch with an incomplete change list does not match', () => {
    rule('apply_patch', 'src')
    assert.equal(pm._matchesRule('apply_patch', { file_path: 'src', changes: 'diff --git a b' }), null)
    assert.equal(pm._matchesRule('apply_patch', { file_path: 'src' }), null)
    assert.equal(pm._matchesRule('apply_patch', { file_path: 'src', changes: [{ path: 'src/a.txt' }, {}] }), null)
    assert.equal(pm._matchesRule('apply_patch', { changes: [{ path: 'src/a.txt', kind: { type: 'update', move_path: 5 } }] }), null)
    assert.equal(pm._matchesRule('apply_patch', { changes: [] }), null)
  })

  it('apply_patch also checks the approval root carried in the top-level file_path', () => {
    rule('apply_patch', 'src')
    const changes = [{ path: 'src/a.txt', kind: { type: 'update', move_path: null }, diff: '' }]
    assert.equal(pm._matchesRule('apply_patch', { file_path: 'src', changes }), 'allow')
    assert.equal(pm._matchesRule('apply_patch', { file_path: 'src/sub', changes }), 'allow')
    assert.equal(pm._matchesRule('apply_patch', { changes }), 'allow')
    assert.equal(pm._matchesRule('apply_patch', { file_path: '.', changes }), null, 'root above the scope')
    assert.equal(pm._matchesRule('apply_patch', { file_path: 'docs', changes }), null)
    assert.equal(pm._matchesRule('apply_patch', { file_path: 42, changes }), null, 'non-string root')
    assert.equal(pm._matchesRule('apply_patch', { file_path: ['src'], changes }), null)
  })

  it('a change with an unsupported or missing kind is incomplete', () => {
    rule('apply_patch', 'src')
    assert.equal(pm._matchesRule('apply_patch', { changes: [{ path: 'src/a.txt' }] }), null)
    assert.equal(pm._matchesRule('apply_patch', { changes: [{ path: 'src/a.txt', kind: 'rename' }] }), null)
    assert.equal(pm._matchesRule('apply_patch', { changes: [{ path: 'src/a.txt', kind: 'add' }] }), 'allow')
  })

  it('a Glob pattern that is absolute or climbs with .. does not match', () => {
    rule('Glob', 'src')
    for (const pattern of ['*.txt', 'sub/**/*.js']) {
      assert.equal(pm._matchesRule('Glob', { path: 'src', pattern }), 'allow', pattern)
    }
    for (const pattern of ['/etc/*', '../*', '../other/*.js', 'sub/../../x', '..\\x', '\\x']) {
      assert.equal(pm._matchesRule('Glob', { path: 'src', pattern }), null, `explicit path: ${pattern}`)
    }
    rule('Glob', '**')
    for (const pattern of ['/etc/*', '../*']) {
      assert.equal(pm._matchesRule('Glob', { pattern }), null, `no path: ${pattern}`)
    }
    assert.equal(pm._matchesRule('Glob', { pattern: '*.txt' }), 'allow')
  })

  it('a path starting with ~ names no fixed target, so an allow rule does not match', () => {
    rule('Read', '**')
    assert.equal(pm._matchesRule('Read', { file_path: 'src/a.txt' }), 'allow')
    assert.equal(pm._matchesRule('Read', { file_path: '~/src/a.txt' }), null)
    assert.equal(pm._matchesRule('Read', { file_path: '~user/src/a.txt' }), null)
    assert.equal(pm._matchesRule('Read', { file_path: '~' }), null)
    rule('Grep', '**')
    assert.equal(pm._matchesRule('Grep', { path: '~/src', pattern: 'x' }), null)
    assert.equal(pm._matchesRule('Grep', { path: 'src', pattern: 'x' }), 'allow')
  })

  it('an empty search path is the cwd for Grep and Glob rules', () => {
    rule('Grep', '**')
    assert.equal(pm._matchesRule('Grep', { path: '', pattern: 'x' }), 'allow')
  })
})

describe('the protected-path floor reads rename destinations', () => {
  let root
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-floor-move-'))) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('floors a patch whose rename destination is a protected path', () => {
    const patch = (move_path) => ({ changes: [{ path: 'src/a.txt', kind: { type: 'update', move_path }, diff: '' }] })
    assert.equal(isProtectedPathTarget(patch(null), root), false)
    assert.equal(isProtectedPathTarget(patch('src/b.txt'), root), false)
    assert.equal(isProtectedPathTarget(patch('.git/hooks/pre-commit'), root), true)
  })

  it('collectChangeTargets lists sources and destinations, and flags a malformed list', () => {
    const ok = collectChangeTargets([{ path: 'a', kind: { type: 'update', move_path: 'b' } }, { path: 'c', kind: 'add' }])
    assert.deepEqual(ok, { complete: true, paths: ['a', 'b', 'c'] })
    assert.equal(collectChangeTargets([{ path: 'a' }, null]).complete, false)
    assert.equal(collectChangeTargets('x').complete, false)
  })
})

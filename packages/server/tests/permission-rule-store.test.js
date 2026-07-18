import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PermissionRuleStore, normalizeProjectKey, isPersistableTool } from '../src/permission-rule-store.js'
import { PermissionManager } from '../src/permission-manager.js'
import { PermissionAuditLog } from '../src/permission-audit.js'

/**
 * #6771 — durable "always allow" permission rules.
 *
 * Covers the PermissionRuleStore (per-project persistence keyed by normalized
 * cwd, atomic write, restart survival, NEVER_AUTO_ALLOW floor) and its
 * integration with PermissionManager (seeding, allowAlways persistence, the
 * #6794 protected-path floor interaction, and per-cwd scoping).
 *
 * Every store here writes to a temp dir (never the real ~/.chroxy) so the
 * #4633 sandbox guard is satisfied.
 */

const silentLog = { info() {}, warn() {}, error() {} }

describe('#6771 PermissionRuleStore', () => {
  let dir
  let filePath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-rule-store-'))
    filePath = join(dir, 'permission-rules.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('normalizeProjectKey collapses spellings and rejects empties', () => {
    assert.equal(normalizeProjectKey('/a/b'), '/a/b')
    assert.equal(normalizeProjectKey('/a/b/'), '/a/b')
    assert.equal(normalizeProjectKey('/a/b/.'), '/a/b')
    assert.equal(normalizeProjectKey('/a/c/../b'), '/a/b')
    assert.equal(normalizeProjectKey(''), null)
    assert.equal(normalizeProjectKey(undefined), null)
    assert.equal(normalizeProjectKey(42), null)
  })

  it('isPersistableTool only accepts ELIGIBLE, non-NEVER_AUTO_ALLOW tools', () => {
    assert.equal(isPersistableTool('Write'), true)
    assert.equal(isPersistableTool('Read'), true)
    assert.equal(isPersistableTool('Bash'), false)      // NEVER_AUTO_ALLOW
    assert.equal(isPersistableTool('WebFetch'), false)  // NEVER_AUTO_ALLOW
    assert.equal(isPersistableTool('Task'), false)      // NEVER_AUTO_ALLOW
    assert.equal(isPersistableTool('Frobnicate'), false) // not ELIGIBLE
  })

  it('addRule persists and getRules reads it back (metadata stripped)', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    assert.equal(store.addRule('/proj/a', { tool: 'Write', decision: 'allow' }), true)
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow' }])
    assert.ok(existsSync(filePath), 'store file written')
  })

  it('survives a simulated restart: a NEW store instance reads persisted rules', () => {
    const store1 = new PermissionRuleStore({ filePath, logger: silentLog })
    store1.addRule('/proj/a', { tool: 'Write', decision: 'allow' })
    store1.addRule('/proj/a', { tool: 'Edit', decision: 'allow' })

    // New process → new store reading the same file.
    const store2 = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(
      store2.getRules('/proj/a').sort((x, y) => x.tool.localeCompare(y.tool)),
      [{ tool: 'Edit', decision: 'allow' }, { tool: 'Write', decision: 'allow' }],
    )
  })

  it('scopes rules per project cwd — a different cwd does not inherit', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow' }])
    assert.deepEqual(store.getRules('/proj/b'), [])
  })

  it('addRule replaces (does not duplicate) a rule for the same tool', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })
    store.addRule('/proj/a', { tool: 'Write', decision: 'deny' })
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'deny' }])
  })

  it('refuses to persist an allow rule for a NEVER_AUTO_ALLOW tool', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    assert.equal(store.addRule('/proj/a', { tool: 'Bash', decision: 'allow' }), false)
    assert.deepEqual(store.getRules('/proj/a'), [])
  })

  it('load() enforces the eligibility floor on a hand-edited file', () => {
    // A hand-tampered file that smuggles a Bash allow must be dropped on load.
    const tampered = {
      version: 1,
      projects: {
        '/proj/a': { rules: [
          { tool: 'Bash', decision: 'allow' },   // dropped (NEVER_AUTO_ALLOW)
          { tool: 'Write', decision: 'allow' },  // kept
        ] },
      },
    }
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    // Persist a placeholder then overwrite the file directly to simulate tamper.
    store.addRule('/proj/z', { tool: 'Read', decision: 'allow' })
    writeFileSync(filePath, JSON.stringify(tampered))
    const store2 = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store2.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow' }])
  })

  it('setRules replaces the whole project set and removeRule drops one', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    store.setRules('/proj/a', [
      { tool: 'Write', decision: 'allow' },
      { tool: 'Read', decision: 'allow' },
    ])
    assert.equal(store.getRules('/proj/a').length, 2)
    assert.equal(store.removeRule('/proj/a', 'Write'), true)
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Read', decision: 'allow' }])
    // Removing the last rule deletes the project entry.
    store.removeRule('/proj/a', 'Read')
    assert.deepEqual(store.getRules('/proj/a'), [])
  })

  it('load() tolerates a missing file and a corrupt file (fail-open to empty)', () => {
    const missing = new PermissionRuleStore({ filePath: join(dir, 'nope.json'), logger: silentLog }).load()
    assert.deepEqual(missing.getRules('/proj/a'), [])

    const corruptPath = join(dir, 'corrupt.json')
    writeFileSync(corruptPath, '{not json')
    const corrupt = new PermissionRuleStore({ filePath: corruptPath, logger: silentLog }).load()
    assert.deepEqual(corrupt.getRules('/proj/a'), [])
  })

  // -- load() hardening (Copilot review on PR #6826) --

  it('double-load leaves exactly the file\'s rules — no ghosts, no duplicates', () => {
    const store = new PermissionRuleStore({ filePath, logger: silentLog })
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })
    store.addRule('/proj/b', { tool: 'Read', decision: 'allow' })

    // Re-loading the same file must be idempotent (no per-project duplicates).
    store.load()
    store.load()
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow' }])
    assert.deepEqual(store.getRules('/proj/b'), [{ tool: 'Read', decision: 'allow' }])

    // Overwrite the file externally with a REDUCED set, then re-load: the
    // dropped project must not survive as an in-memory ghost that a later
    // _persist would resurrect.
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      projects: { '/proj/b': { rules: [{ tool: 'Read', decision: 'allow' }] } },
    }))
    store.load()
    assert.deepEqual(store.getRules('/proj/a'), [], 'externally-removed project does not ghost')
    assert.deepEqual(store.getRules('/proj/b'), [{ tool: 'Read', decision: 'allow' }])

    // Delete the file entirely, re-load: empty (stale rules dropped).
    rmSync(filePath)
    store.load()
    assert.deepEqual(store.getRules('/proj/b'), [], 'load after file deletion resets to empty')
  })

  it('load() rejects an unknown store version whole (fail-open empty, no crash, no partial read)', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 999,
      projects: { '/proj/a': { rules: [{ tool: 'Write', decision: 'allow' }] } },
    }))
    const store = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.getRules('/proj/a'), [], 'unknown version is never partially read')

    // A missing version field is equally rejected (not silently assumed v1).
    writeFileSync(filePath, JSON.stringify({
      projects: { '/proj/a': { rules: [{ tool: 'Write', decision: 'allow' }] } },
    }))
    const store2 = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store2.getRules('/proj/a'), [])
  })

  it('load() re-normalizes hand-edited non-normalized keys so the session\'s normalized cwd still matches', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      projects: {
        '/proj/a/': { rules: [{ tool: 'Write', decision: 'allow' }] },          // trailing slash
        '/proj/x/../b': { rules: [{ tool: 'Read', decision: 'allow' }] },       // .. traversal
      },
    }))
    const store = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow' }])
    assert.deepEqual(store.getRules('/proj/b'), [{ tool: 'Read', decision: 'allow' }])
  })

  it('load() merges two file keys that normalize to the same cwd without duplicating rules', () => {
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      projects: {
        '/proj/a': { rules: [{ tool: 'Write', decision: 'allow' }] },
        '/proj/a/': { rules: [
          { tool: 'Write', decision: 'deny' },   // same tool — first key wins, no dup
          { tool: 'Read', decision: 'allow' },   // new tool — merged in
        ] },
      },
    }))
    const store = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    assert.deepEqual(
      store.getRules('/proj/a').sort((x, y) => x.tool.localeCompare(y.tool)),
      [{ tool: 'Read', decision: 'allow' }, { tool: 'Write', decision: 'allow' }],
    )
  })
})

describe('#6771 PermissionManager + durable rules', () => {
  let dir
  let filePath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-rule-mgr-'))
    filePath = join(dir, 'permission-rules.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeStore() {
    return new PermissionRuleStore({ filePath, logger: silentLog }).load()
  }

  it('seeds persistent rules for its cwd on construction, auto-allowing without a prompt', async () => {
    const store = makeStore()
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })

    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      let prompted = false
      pm.on('permission_request', () => { prompted = true })
      const result = await pm.handlePermission('Write', { file_path: 'src/x.js' }, null, 'approve')
      assert.equal(result.behavior, 'allow')
      assert.equal(prompted, false, 'seeded persistent rule auto-allows without a prompt')
      assert.deepEqual(pm.getPersistentRules(), [{ tool: 'Write', decision: 'allow', persist: 'project' }])
    } finally {
      pm.destroy()
    }
  })

  // #6830 (PR #6842 review) — end-to-end with a real PermissionRuleStore AND a
  // real PermissionAuditLog wired the way ws-server's
  // _attachPermissionAuditSink does it: a rule seeded from disk silently
  // auto-approving N=50 tool calls must (a) put ZERO events on the wire lane
  // (no permission_resolved, no permission_request — those broadcast to every
  // client) and (b) land as ONE coalesced audit entry, not 50 ring slots.
  it('a store-seeded persistent rule auto-approve is audited via the sink — one coalesced entry, zero wire events', async () => {
    const store = makeStore()
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })

    const auditLog = new PermissionAuditLog()
    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      // Same wiring shape as ws-server.js _attachPermissionAuditSink.
      pm.setAuditSink((info) => auditLog.logPersistedRuleApproval({ sessionId: 's1', tool: info?.tool, projectKey: info?.projectKey ?? null }))
      const wireEvents = []
      pm.on('permission_resolved', (d) => wireEvents.push(d))
      pm.on('permission_request', (d) => wireEvents.push(d))

      for (let i = 0; i < 50; i++) {
        const result = await pm.handlePermission('Write', { file_path: `src/x${i}.js` }, null, 'approve')
        assert.equal(result.behavior, 'allow')
      }

      assert.equal(wireEvents.length, 0, 'zero broadcast-lane emissions across 50 silent auto-approves')
      const entries = auditLog.query({ type: 'decision' })
      assert.equal(entries.length, 1, 'one coalesced entry — the ring is never flooded')
      assert.equal(entries[0].count, 50)
      assert.equal(entries[0].reason, 'persisted_rule')
      assert.equal(entries[0].tool, 'Write')
      assert.equal(entries[0].persist, 'project')
      assert.equal(entries[0].projectKey, '/proj/a')
      assert.equal(entries[0].sessionId, 's1')
    } finally {
      pm.destroy()
    }
  })

  // #6842 review (Copilot) — a session started with a `..`-laden / trailing-
  // slash cwd must produce persisted-rule audit entries whose projectKey is
  // EXACTLY the store's normalized key (the key in permission-rules.json),
  // not the raw cwd — otherwise entry ↔ rule correlation is impossible.
  it('sink-path projectKey matches the store\'s NORMALIZED key for a ..-laden session cwd', async () => {
    const messyCwd = '/proj/a/sub/..'
    const store = makeStore()
    store.addRule(messyCwd, { tool: 'Write', decision: 'allow' })
    const storeKeys = Object.keys(store.listProjects())
    assert.deepEqual(storeKeys, ['/proj/a'], 'precondition: the store keyed the rule by the normalized cwd')

    const auditLog = new PermissionAuditLog()
    const pm = new PermissionManager({ log: silentLog, cwd: messyCwd, ruleStore: store })
    try {
      pm.setAuditSink((info) => auditLog.logPersistedRuleApproval({ sessionId: 's1', tool: info?.tool, projectKey: info?.projectKey ?? null }))
      const result = await pm.handlePermission('Write', { file_path: 'src/x.js' }, null, 'approve')
      assert.equal(result.behavior, 'allow', 'seeding via the messy cwd still matches the persisted rule')

      const entries = auditLog.query({ type: 'decision' })
      assert.equal(entries.length, 1)
      assert.equal(entries[0].projectKey, storeKeys[0], 'audit projectKey === the persisted rule\'s store key, exactly')
      assert.equal(entries[0].projectKey, normalizeProjectKey(messyCwd))
    } finally {
      pm.destroy()
    }
  })

  it('a different cwd does NOT inherit another project\'s persistent rules', async () => {
    const store = makeStore()
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })

    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/OTHER', ruleStore: store })
    try {
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      pm.handlePermission('Write', { file_path: 'src/x.js' }, null, 'approve')
      assert.equal(events.length, 1, 'unrelated cwd still prompts (no inherited rule)')
      assert.deepEqual(pm.getPersistentRules(), [])
    } finally {
      pm.destroy()
    }
  })

  it('allowAlways persists a durable rule AND survives a simulated daemon restart', async () => {
    const store = makeStore()
    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      pm.handlePermission('Write', { file_path: 'src/x.js' }, null, 'approve')
      assert.equal(events.length, 1)
      const ok = pm.respondToPermission(events[0].requestId, 'allowAlways')
      assert.equal(ok, true)
      // Persisted to disk.
      assert.deepEqual(store.getRules('/proj/a'), [{ tool: 'Write', decision: 'allow' }])
    } finally {
      pm.destroy()
    }

    // Simulate a restart: a brand-new store instance + a brand-new manager.
    const store2 = new PermissionRuleStore({ filePath, logger: silentLog }).load()
    const pm2 = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store2 })
    try {
      let prompted = false
      pm2.on('permission_request', () => { prompted = true })
      const result = await pm2.handlePermission('Write', { file_path: 'src/y.js' }, null, 'approve')
      assert.equal(result.behavior, 'allow')
      assert.equal(prompted, false, 'grant survives restart — no re-prompt')
    } finally {
      pm2.destroy()
    }
  })

  it('allowAlways on a NEVER_AUTO_ALLOW tool (Bash) allows once but does NOT persist', async () => {
    const store = makeStore()
    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      const events = []
      pm.on('permission_request', (d) => events.push(d))
      const pending = pm.handlePermission('Bash', { command: 'ls' }, null, 'approve')
      const ok = pm.respondToPermission(events[0].requestId, 'allowAlways')
      assert.equal(ok, true)
      const result = await pending
      assert.equal(result.behavior, 'allow', 'one-shot allow still granted')
      // Nothing durable written for Bash.
      assert.deepEqual(store.getRules('/proj/a'), [])
      assert.deepEqual(pm.getPersistentRules(), [])
    } finally {
      pm.destroy()
    }
  })

  it('FLOOR INTERACTION: a persisted allow rule NEVER overrides the protected-path floor', async () => {
    // Persist an allow-always for Write, then aim Write at a protected path
    // (.git/config). The #6794 floor must still force an interactive prompt.
    const store = makeStore()
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })
    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      // Benign path → auto-allowed by the persistent rule (no prompt).
      pm.handlePermission('Write', { file_path: 'src/x.js' }, null, 'approve')
      assert.equal(events.length, 0, 'benign write auto-allowed by persistent rule')

      // Protected path → floored to a prompt despite the persistent allow rule.
      pm.handlePermission('Write', { file_path: '.git/config' }, null, 'approve')
      assert.equal(events.length, 1, 'protected-path write still prompts (floor wins over persistent allow)')

      // Also holds for a .env secret.
      pm.handlePermission('Write', { file_path: '.env' }, null, 'approve')
      assert.equal(events.length, 2, '.env write still prompts')
    } finally {
      pm.destroy()
    }
  })

  it('#6828: a PERSISTED apply_patch allow rule never overrides the floor for a protected changes[] member', async () => {
    // Persist an allow-always for codex's apply_patch, then aim a fileChange at
    // .git/ via the changes[] array (the flat file_path is the benign grantRoot).
    // Without the #6805 array walk this would be durably auto-approved forever.
    const store = makeStore()
    store.addRule('/proj/a', { tool: 'apply_patch', decision: 'allow' })
    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      const events = []
      pm.on('permission_request', (d) => events.push(d))

      // All-benign members → auto-allowed by the persisted rule (no prompt).
      const benign = await pm.handlePermission('apply_patch', {
        file_path: '/proj/a',
        changes: [{ path: 'src/a.js', kind: 'update', diff: 'd' }],
      }, null, 'approve')
      assert.equal(benign.behavior, 'allow')
      assert.equal(events.length, 0, 'benign apply_patch auto-allowed by persisted rule')

      // A protected member → floored to a prompt despite the persisted allow rule.
      pm.handlePermission('apply_patch', {
        file_path: '/proj/a',
        changes: [
          { path: 'src/a.js', kind: 'update', diff: 'd' },
          { path: '.git/config', kind: 'update', diff: 'd' },
        ],
      }, null, 'approve')
      assert.equal(events.length, 1, 'protected changes[] member still prompts (floor wins over persisted allow)')
    } finally {
      pm.destroy()
    }
  })

  it('a persistent DENY rule is honoured (deny still denies under the floor)', async () => {
    const store = makeStore()
    store.setRules('/proj/a', [{ tool: 'Read', decision: 'deny' }])
    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      const result = await pm.handlePermission('Read', { file_path: 'src/x.js' }, null, 'approve')
      assert.equal(result.behavior, 'deny')
    } finally {
      pm.destroy()
    }
  })

  it('clearRules() does NOT wipe persistent (project) rules', async () => {
    const store = makeStore()
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })
    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      pm.setRules([{ tool: 'Read', decision: 'allow' }])
      pm.clearRules() // simulates the permission-mode-switch clear
      assert.deepEqual(pm.getRules(), [], 'session rules cleared')
      assert.deepEqual(pm.getPersistentRules(), [{ tool: 'Write', decision: 'allow', persist: 'project' }],
        'persistent rules survive clearRules')
    } finally {
      pm.destroy()
    }
  })

  it('session rules take precedence over persistent rules for the same tool', async () => {
    const store = makeStore()
    store.addRule('/proj/a', { tool: 'Read', decision: 'allow' })
    const pm = new PermissionManager({ log: silentLog, cwd: '/proj/a', ruleStore: store })
    try {
      pm.setRules([{ tool: 'Read', decision: 'deny' }])
      const result = await pm.handlePermission('Read', { file_path: 'src/x.js' }, null, 'approve')
      assert.equal(result.behavior, 'deny', 'session deny wins over persistent allow')
    } finally {
      pm.destroy()
    }
  })

  it('the written file is valid JSON with the versioned project shape', () => {
    const store = makeStore()
    store.addRule('/proj/a', { tool: 'Write', decision: 'allow' })
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
    assert.equal(parsed.version, 1)
    assert.ok(parsed.projects['/proj/a'])
    assert.equal(parsed.projects['/proj/a'].rules[0].tool, 'Write')
    assert.equal(typeof parsed.projects['/proj/a'].rules[0].createdAt, 'number')
  })
})

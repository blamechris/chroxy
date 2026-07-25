/**
 * Unit tests for the MCP config MUTATION path in byok-mcp-config.js (#6974).
 *
 * This is the first WRITE path into `~/.claude.json` — a file owned by Claude
 * Code, not Chroxy — so the tests are weighted toward "does not destroy the
 * user's config" rather than just "does the happy path work":
 *
 *  - add persists the entry AND preserves every unrelated key in the file
 *  - remove deletes ONLY the target, leaving siblings + unrelated keys intact
 *  - a malformed / unparseable existing config → clear error, file NOT clobbered
 *  - invalid names (charset, `__`, reserved keys) and invalid configs rejected
 *  - only NORMALIZED keys are persisted (a client cannot inject extra keys)
 *  - the write is atomic (temp + rename) and leaves no sidecar behind
 *  - the destination file's existing mode is preserved; a new file gets 0600
 *  - user vs project scope target the right block and never each other
 *
 * Every test writes to a mkdtemp path — never the real `~/.claude.json` (the
 * sandbox guard in tests/_setup.mjs blocks real-home writes and would fail loudly).
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addMcpServerToConfig,
  parseClaudeMcpConfig,
  planAddMcpServerToConfig,
  removeMcpServerFromConfig,
  normalizeMcpServerConfig,
  readClaudeConfigForMutation,
  validateNewMcpServerName,
  validateMcpServerNameForRemoval,
} from '../src/byok-mcp-config.js'

let dir
let configPath

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-mutation-'))
  configPath = join(dir, '.claude.json')
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const read = () => JSON.parse(readFileSync(configPath, 'utf8'))
const write = (obj) => writeFileSync(configPath, JSON.stringify(obj, null, 2))

// Any leftover `.chroxy.<uuid>.tmp` sidecar means the atomic write did not clean
// up after itself.
const sidecars = () => readdirSync(dir).filter((f) => f.includes('.chroxy.') && f.endsWith('.tmp'))

describe('#6974 name validation', () => {
  it('accepts lowercase identifiers with dash/underscore', () => {
    for (const name of ['repo-memory', 'ccd_session_mgmt', 'a', 'x1', 'my-server-2']) {
      assert.equal(validateNewMcpServerName(name).ok, true, `${name} should be accepted`)
    }
  })

  it('rejects uppercase, leading digit, dots, slashes, spaces and over-long names', () => {
    for (const name of ['MyServer', '1server', 'my.server', 'my/server', '../evil', 'my server', 'a'.repeat(65)]) {
      const res = validateNewMcpServerName(name)
      assert.equal(res.ok, false, `${name} must be rejected`)
      assert.match(res.error, /lowercase identifier/)
    }
  })

  it('rejects a name containing `__` (the mcp__<server>__<tool> namespace separator)', () => {
    const res = validateNewMcpServerName('a__b')
    assert.equal(res.ok, false)
    assert.match(res.error, /namespace separator/)
  })

  it('rejects reserved object keys on BOTH the add and remove paths', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(validateNewMcpServerName(name).ok, false, `add: ${name}`)
      const rem = validateMcpServerNameForRemoval(name)
      assert.equal(rem.ok, false, `remove: ${name}`)
      assert.match(rem.error, /reserved/)
    }
  })

  it('removal accepts a name the add path would refuse (a CLI-created server stays removable)', () => {
    // A server the `claude` CLI created as `My.Server` must still be removable.
    assert.equal(validateMcpServerNameForRemoval('My.Server').ok, true)
    assert.equal(validateNewMcpServerName('My.Server').ok, false)
  })

  it('removal rejects control characters', () => {
    const res = validateMcpServerNameForRemoval('bad\u0000name')
    assert.equal(res.ok, false)
    assert.match(res.error, /control characters/)
  })
})

describe('#6974 config normalization', () => {
  it('persists only normalized stdio keys and drops unknown ones', () => {
    const res = normalizeMcpServerConfig('srv', {
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'secret' },
      evilExtraKey: 'should not survive',
    })
    assert.equal(res.ok, true)
    assert.deepEqual(Object.keys(res.entry).sort(), ['args', 'command', 'env'])
    assert.equal(res.entry.evilExtraKey, undefined)
  })

  it('omits empty args/env so a minimal add yields a minimal diff', () => {
    const res = normalizeMcpServerConfig('srv', { command: 'node' })
    assert.equal(res.ok, true)
    assert.deepEqual(res.entry, { command: 'node' })
  })

  it('normalizes a remote entry to type/url/headers', () => {
    const res = normalizeMcpServerConfig('srv', { type: 'sse', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } })
    assert.equal(res.ok, true)
    assert.equal(res.entry.type, 'sse')
    assert.equal(res.entry.url, 'https://example.com/mcp')
    assert.deepEqual(res.entry.headers, { Authorization: 'Bearer x' })
  })

  it('rejects a config with neither command nor url', () => {
    const res = normalizeMcpServerConfig('srv', { args: ['x'] })
    assert.equal(res.ok, false)
    assert.match(res.error, /command is required/)
  })

  it('escalates a read-path WARNING into a rejection (a write must not silently alter intent)', () => {
    // The read path would coerce args[1] away with a warning and carry on; a
    // write must refuse rather than persist something else than was asked for.
    const res = normalizeMcpServerConfig('srv', { command: 'node', args: ['ok', 42] })
    assert.equal(res.ok, false)
    assert.match(res.error, /args\[1\]/)
  })

  it('rejects a non-http(s) remote url and a cloud-metadata host', () => {
    assert.equal(normalizeMcpServerConfig('srv', { type: 'http', url: 'file:///etc/passwd' }).ok, false)
    assert.equal(normalizeMcpServerConfig('srv', { type: 'http', url: 'http://169.254.169.254/latest' }).ok, false)
  })
})

describe('#7001 silent-drop escape hatches are explicit rejections', () => {
  it('a config carrying BOTH command and url is refused as ambiguous', () => {
    // Previously one field silently won (which one depended on `type`) and the
    // other was dropped with no warning at all, so the escalate-warnings-to-
    // rejection rule never fired and the user got a transport they did not ask for.
    const res = normalizeMcpServerConfig('both', { command: 'node', url: 'https://mcp.example.com/api' })
    assert.equal(res.ok, false)
    assert.match(res.error, /ambiguous/i)
    assert.match(res.error, /command/)
    assert.match(res.error, /url/)
  })

  it('the ambiguous rejection also fires when an explicit remote `type` is present', () => {
    const res = normalizeMcpServerConfig('both', { type: 'http', command: 'node', url: 'https://mcp.example.com/api' })
    assert.equal(res.ok, false)
    assert.match(res.error, /ambiguous/i)
  })

  it('the ambiguous case only WARNS on the read path, so an existing config keeps working', () => {
    // The read path must stay lenient — a partly-usable config beats no session.
    const { servers, warnings } = parseClaudeMcpConfig({
      mcpServers: { both: { command: 'node', url: 'https://mcp.example.com/api' } },
    })
    assert.equal(servers.length, 1, 'the server still resolves at session start')
    assert.ok(warnings.some((w) => /ambiguous/i.test(w)), 'but the ambiguity is now visible')
  })

  it('an ambiguous config is NOT written to disk', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    const res = addMcpServerToConfig({ name: 'both', config: { command: 'node', url: 'https://x.example.com/' }, configPath })
    assert.equal(res.ok, false)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers), [])
  })

  it('a reserved key in env is REFUSED, not silently dropped', () => {
    // `{}['__proto__'] = 'str'` is a no-op, so this key used to disappear with no
    // warning and no error — the caller got `ok` for a config missing a field.
    const config = JSON.parse('{"command":"node","env":{"__proto__":"payload"}}')
    const res = normalizeMcpServerConfig('proto', config)
    assert.equal(res.ok, false)
    assert.match(res.error, /__proto__/)
    assert.match(res.error, /reserved/i)
  })

  it('constructor / prototype in env are refused too', () => {
    for (const key of ['constructor', 'prototype']) {
      const res = normalizeMcpServerConfig('proto', { command: 'node', env: { [key]: 'x' } })
      assert.equal(res.ok, false, `env.${key} must be refused`)
      assert.match(res.error, new RegExp(key))
    }
  })

  it('a reserved key in headers is refused as well (same hazard)', () => {
    const config = JSON.parse('{"type":"http","url":"https://mcp.example.com/api","headers":{"__proto__":"payload"}}')
    const res = normalizeMcpServerConfig('proto-h', config)
    assert.equal(res.ok, false)
    assert.match(res.error, /__proto__/)
  })

  it('a reserved env key never reaches the config file', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    const config = JSON.parse('{"command":"node","env":{"__proto__":"payload"}}')
    const res = addMcpServerToConfig({ name: 'proto', config, configPath })
    assert.equal(res.ok, false)
    const disk = readFileSync(configPath, 'utf8')
    assert.ok(!disk.includes('payload'))
    assert.deepEqual(Object.keys(JSON.parse(disk).mcpServers), [])
  })

  it('an ordinary env var is of course still accepted', () => {
    const res = normalizeMcpServerConfig('ok', { command: 'node', env: { GITHUB_TOKEN: 'x' } })
    assert.equal(res.ok, true)
    assert.deepEqual(res.entry.env, { GITHUB_TOKEN: 'x' })
  })
})

describe('#7001 planAddMcpServerToConfig (dry-run for deny-before-write)', () => {
  it('returns the exact entry that would be persisted, and writes nothing', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    const before = readFileSync(configPath, 'utf8')
    const plan = planAddMcpServerToConfig({ name: 'srv', config: { command: 'node', args: ['s.js'], bogus: 1 }, configPath })
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.entry, { command: 'node', args: ['s.js'] }, 'normalized, unknown keys dropped')
    assert.equal(readFileSync(configPath, 'utf8'), before, 'a plan must not touch the file')
  })

  it('reports EXISTS without writing, so no consent prompt is spent on a doomed add', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { dup: { command: 'a' } } }))
    const plan = planAddMcpServerToConfig({ name: 'dup', config: { command: 'b' }, configPath })
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'EXISTS')
  })

  it('reports the same validation errors as the commit path', () => {
    for (const bad of [
      { name: 'Bad Name', config: { command: 'node' } },
      { name: 'ok-name', config: { nothing: true } },
      { name: 'ok-name', config: { command: 'node' }, scope: 'global' },
      { name: 'ok-name', config: { command: 'node' }, scope: 'project' },
    ]) {
      const plan = planAddMcpServerToConfig({ ...bad, configPath })
      const commit = addMcpServerToConfig({ ...bad, configPath })
      assert.equal(plan.ok, false)
      assert.equal(commit.ok, false)
      assert.equal(plan.error, commit.error, 'plan and commit must agree on why it failed')
    }
  })

  it('a plan followed by a commit yields exactly the planned entry', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }))
    const cfg = { name: 'srv', config: { command: 'node', args: ['s.js'], env: { K: 'v' } }, configPath }
    const plan = planAddMcpServerToConfig(cfg)
    const commit = addMcpServerToConfig(cfg)
    assert.deepEqual(commit.entry, plan.entry)
    assert.equal(commit.scope, plan.scope)
  })

  it('a malformed existing config fails the plan, so nothing is prompted for', () => {
    writeFileSync(configPath, '{ not json')
    const plan = planAddMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath })
    assert.equal(plan.ok, false)
  })
})

describe('#6974 addMcpServerToConfig', () => {
  it('adds to user scope and PRESERVES every unrelated key', () => {
    write({
      numStartups: 42,
      oauthAccount: { emailAddress: 'user@example.com' },
      projects: { '/some/repo': { allowedTools: ['Bash'] } },
      mcpServers: { existing: { command: 'existing-cmd' } },
    })

    const res = addMcpServerToConfig({ name: 'new-srv', config: { command: 'node', args: ['s.js'] }, configPath })
    assert.equal(res.ok, true)

    const after = read()
    // The new entry landed...
    assert.deepEqual(after.mcpServers['new-srv'], { command: 'node', args: ['s.js'] })
    // ...and nothing else moved.
    assert.equal(after.numStartups, 42)
    assert.deepEqual(after.oauthAccount, { emailAddress: 'user@example.com' })
    assert.deepEqual(after.projects, { '/some/repo': { allowedTools: ['Bash'] } })
    assert.deepEqual(after.mcpServers.existing, { command: 'existing-cmd' })
    assert.equal(sidecars().length, 0, 'no temp sidecar left behind')
  })

  it('creates the config file when absent, with 0600', () => {
    assert.equal(existsSync(configPath), false)
    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath })
    assert.equal(res.ok, true)
    assert.deepEqual(read().mcpServers.srv, { command: 'node' })
    assert.equal(statSync(configPath).mode & 0o777, 0o600, 'a file WE create is owner-only')
  })

  it('PRESERVES the existing file mode rather than forcing 0600', () => {
    write({ mcpServers: {} })
    chmodSync(configPath, 0o644)
    addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath })
    assert.equal(statSync(configPath).mode & 0o777, 0o644, 'we do not re-permission a user-owned file')
  })

  it('refuses to overwrite an existing name (a silent command substitution)', () => {
    write({ mcpServers: { srv: { command: 'original-cmd' } } })
    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'attacker-cmd' }, configPath })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'EXISTS')
    assert.equal(read().mcpServers.srv.command, 'original-cmd', 'the original command survives')
  })

  it('writes project scope under projects[cwd].mcpServers, not the root', () => {
    write({ mcpServers: { userScoped: { command: 'u' } }, projects: { [dir]: { allowedTools: ['Bash'] } } })
    const res = addMcpServerToConfig({ name: 'proj-srv', config: { command: 'node' }, scope: 'project', cwd: dir, configPath })
    assert.equal(res.ok, true)

    const after = read()
    assert.deepEqual(after.projects[dir].mcpServers['proj-srv'], { command: 'node' })
    // Sibling keys on the project block survive, and the ROOT block is untouched.
    assert.deepEqual(after.projects[dir].allowedTools, ['Bash'])
    assert.equal(after.mcpServers['proj-srv'], undefined, 'must not leak into user scope')
  })

  it('project scope requires a cwd', () => {
    write({ mcpServers: {} })
    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, scope: 'project', configPath })
    assert.equal(res.ok, false)
    assert.match(res.error, /working directory/)
  })

  it('rejects an unknown scope', () => {
    write({ mcpServers: {} })
    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, scope: 'global', configPath })
    assert.equal(res.ok, false)
    assert.match(res.error, /Unknown MCP config scope/)
  })

  it('does NOT write when the name or config is invalid', () => {
    write({ mcpServers: { keep: { command: 'k' } } })
    const before = readFileSync(configPath, 'utf8')

    assert.equal(addMcpServerToConfig({ name: 'Bad Name', config: { command: 'node' }, configPath }).ok, false)
    assert.equal(addMcpServerToConfig({ name: 'ok-name', config: { nothing: true }, configPath }).ok, false)
    assert.equal(addMcpServerToConfig({ name: 'ok-name', config: 'not-an-object', configPath }).ok, false)

    assert.equal(readFileSync(configPath, 'utf8'), before, 'file is byte-identical after rejected writes')
  })

  it('refuses when the existing mcpServers key is not an object', () => {
    write({ mcpServers: 'corrupt' })
    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath })
    assert.equal(res.ok, false)
    assert.match(res.error, /refusing to replace/)
    assert.equal(read().mcpServers, 'corrupt', 'left as-is')
  })
})

describe('#6974 malformed config must never be clobbered', () => {
  it('unparseable JSON → clear error, file byte-identical', () => {
    const garbage = '{ this is not: json ]]'
    writeFileSync(configPath, garbage)

    const add = addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath })
    assert.equal(add.ok, false)
    assert.match(add.error, /not valid JSON/)
    assert.match(add.error, /refusing to overwrite/)

    const remove = removeMcpServerFromConfig({ name: 'srv', configPath })
    assert.equal(remove.ok, false)
    assert.match(remove.error, /not valid JSON/)

    assert.equal(readFileSync(configPath, 'utf8'), garbage, 'the user config survives untouched')
    assert.equal(sidecars().length, 0)
  })

  it('does not echo the JSON parser message (it can quote surrounding secret bytes)', () => {
    writeFileSync(configPath, '{ "token": "super-secret-value" NOPE }')
    const res = readClaudeConfigForMutation(configPath)
    assert.equal(res.ok, false)
    assert.ok(!res.error.includes('super-secret-value'), 'error must not leak file contents')
  })

  it('a non-object JSON root (array) is refused, not overwritten', () => {
    writeFileSync(configPath, '["not", "an", "object"]')
    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath })
    assert.equal(res.ok, false)
    assert.match(res.error, /must be a JSON object/)
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), ['not', 'an', 'object'])
  })

  it('a missing file is NOT an error for read (it is the first-write case)', () => {
    const res = readClaudeConfigForMutation(configPath)
    assert.equal(res.ok, true)
    assert.deepEqual(res.raw, {})
    assert.equal(res.existed, false)
    assert.equal(res.mode, null)
  })
})

describe('#6974 removeMcpServerFromConfig', () => {
  it('removes ONLY the target, preserving siblings and unrelated keys', () => {
    write({
      numStartups: 7,
      mcpServers: { keep: { command: 'k' }, drop: { command: 'd' }, alsoKeep: { command: 'a' } },
      projects: { '/x': { history: ['a'] } },
    })

    const res = removeMcpServerFromConfig({ name: 'drop', configPath })
    assert.equal(res.ok, true)
    assert.equal(res.found, true)

    const after = read()
    assert.deepEqual(Object.keys(after.mcpServers).sort(), ['alsoKeep', 'keep'])
    assert.equal(after.numStartups, 7)
    assert.deepEqual(after.projects, { '/x': { history: ['a'] } })
    assert.equal(sidecars().length, 0)
  })

  it('found:false and NO write when the name is absent', () => {
    write({ mcpServers: { keep: { command: 'k' } } })
    const before = readFileSync(configPath, 'utf8')
    const res = removeMcpServerFromConfig({ name: 'ghost', configPath })
    assert.equal(res.ok, true)
    assert.equal(res.found, false)
    assert.equal(readFileSync(configPath, 'utf8'), before, 'a no-op remove must not rewrite the file')
  })

  it('never jumps scope — a user-scope server is not removed by a project-scope request', () => {
    write({ mcpServers: { shared: { command: 'u' } }, projects: { [dir]: { mcpServers: {} } } })
    const res = removeMcpServerFromConfig({ name: 'shared', scope: 'project', cwd: dir, configPath })
    assert.equal(res.ok, true)
    assert.equal(res.found, false, 'absent from the REQUESTED scope')
    assert.deepEqual(read().mcpServers.shared, { command: 'u' }, 'user-scope entry untouched')
  })

  it('removes from project scope without touching a same-named user-scope server', () => {
    write({
      mcpServers: { dual: { command: 'user-cmd' } },
      projects: { [dir]: { mcpServers: { dual: { command: 'project-cmd' } }, allowedTools: ['Bash'] } },
    })
    const res = removeMcpServerFromConfig({ name: 'dual', scope: 'project', cwd: dir, configPath })
    assert.equal(res.ok, true)
    assert.equal(res.found, true)

    const after = read()
    assert.deepEqual(after.mcpServers.dual, { command: 'user-cmd' }, 'user scope survives')
    assert.deepEqual(after.projects[dir].mcpServers, {})
    assert.deepEqual(after.projects[dir].allowedTools, ['Bash'])
  })

  it('removing the last server leaves an empty block, not a deleted key', () => {
    write({ mcpServers: { only: { command: 'o' } } })
    assert.equal(removeMcpServerFromConfig({ name: 'only', configPath }).ok, true)
    assert.deepEqual(read().mcpServers, {})
  })

  it('a missing config file is a clean found:false, and does not create the file', () => {
    const res = removeMcpServerFromConfig({ name: 'srv', configPath })
    assert.equal(res.ok, true)
    assert.equal(res.found, false)
    assert.equal(existsSync(configPath), false, 'remove must not create a config')
  })

  it('preserves the existing file mode on remove', () => {
    write({ mcpServers: { drop: { command: 'd' } } })
    chmodSync(configPath, 0o640)
    removeMcpServerFromConfig({ name: 'drop', configPath })
    assert.equal(statSync(configPath).mode & 0o777, 0o640)
  })
})

describe('#6974 round-trip', () => {
  it('an added server reads back through the normal read path', async () => {
    const { loadClaudeMcpConfig } = await import('../src/byok-mcp-config.js')
    write({ mcpServers: {} })
    addMcpServerToConfig({ name: 'round-trip', config: { command: 'node', args: ['s.js'], env: { K: 'v' } }, configPath })

    const loaded = loadClaudeMcpConfig(configPath)
    assert.deepEqual(loaded.warnings, [], 'a config we accepted for writing parses cleanly')
    const srv = loaded.servers.find((s) => s.name === 'round-trip')
    assert.ok(srv, 'the added server is discoverable')
    assert.equal(srv.command, 'node')
    assert.deepEqual(srv.args, ['s.js'])
    assert.deepEqual(srv.env, { K: 'v' })
  })

  it('add → remove returns the file to its original content', () => {
    const original = { numStartups: 3, mcpServers: { keep: { command: 'k' } } }
    write(original)
    const before = readFileSync(configPath, 'utf8')

    addMcpServerToConfig({ name: 'temp-srv', config: { command: 'node' }, configPath })
    assert.ok(read().mcpServers['temp-srv'])
    removeMcpServerFromConfig({ name: 'temp-srv', configPath })

    // Same logical content; formatting is the writer's 2-space + trailing newline.
    assert.deepEqual(read(), original)
    assert.equal(before.trimEnd(), readFileSync(configPath, 'utf8').trimEnd())
  })
})

describe('writeClaudeConfigAtomic rename-failure cleanup (#7001 review)', () => {
  // A failing renameSync left the `.chroxy.<uuid>.tmp` sidecar behind — and that
  // sidecar holds the FULL config, including any env/headers just supplied, at the
  // destination's (possibly group-readable) mode. Module mocks are required
  // because there is no portable way to force a deterministic rename failure
  // across tmpfs / ext4 / APFS. Same test shape as the #4463 fix in
  // byok-mcp-trust.test.js.
  if (typeof mock.module !== 'function') {
    it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks to exercise these tests')
    })
  } else {
    it('unlinks the sidecar and re-throws the ORIGINAL error when renameSync fails', async () => {
      const realFs = await import('node:fs')
      const unlinked = []
      const mockFs = {
        ...realFs,
        renameSync: () => { throw new Error('EXDEV cross-device link') },
        unlinkSync: (p) => { unlinked.push(p) },
      }
      mock.module('node:fs', { defaultExport: mockFs, namedExports: mockFs })
      try {
        const { writeClaudeConfigAtomic } = await import(`../src/byok-mcp-config.js?cacheBust=7001-${Date.now()}`)
        let threw = null
        try {
          writeClaudeConfigAtomic(configPath, { mcpServers: { s: { command: 'node' } } }, { mode: null })
        } catch (err) {
          threw = err
        }
        assert.ok(threw, 'the rename failure must surface')
        assert.match(threw.message, /EXDEV/, 'the ORIGINAL error, not a cleanup-side ENOENT')
        assert.equal(unlinked.length, 1, 'the sidecar is unlinked exactly once')
        assert.ok(unlinked[0].includes('.chroxy.') && unlinked[0].endsWith('.tmp'), 'cleanup targets the sidecar')
      } finally {
        mock.restoreAll()
      }
    })

    it('surfaces the rename error even when the cleanup unlink also fails', async () => {
      const realFs = await import('node:fs')
      const mockFs = {
        ...realFs,
        renameSync: () => { throw new Error('original rename failure') },
        unlinkSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
      }
      mock.module('node:fs', { defaultExport: mockFs, namedExports: mockFs })
      try {
        const { writeClaudeConfigAtomic } = await import(`../src/byok-mcp-config.js?cacheBust=7001b-${Date.now()}`)
        let threw = null
        try {
          writeClaudeConfigAtomic(configPath, { mcpServers: {} }, { mode: null })
        } catch (err) {
          threw = err
        }
        assert.ok(threw)
        assert.match(threw.message, /original rename failure/)
      } finally {
        mock.restoreAll()
      }
    })
  }
})

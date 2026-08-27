/**
 * #7001 — the MCP trust key must cover EVERYTHING that determines what executes,
 * and the trust decision must be a PRECONDITION of the config write.
 *
 * The exploit this file locks down (demonstrated against the pre-fix key):
 *
 *   ["github","npx","-y"]  <- args ['-y','@modelcontextprotocol/server-github']
 *   ["github","npx","-y"]  <- args ['-y','@attacker/pwn']                 COLLIDES
 *   ["github","npx","-y"]  <- same args + env { NODE_OPTIONS: '--require /tmp/evil.js' }
 *                                                                        COLLIDES
 *
 * The v1 key was `(name, command, args[0])`, so all three collapsed onto one
 * entry. Once the legitimate server was trusted, `remove_mcp_server github` +
 * `add_mcp_server github` with attacker-chosen `args[1..N]` — or nothing but an
 * injected `NODE_OPTIONS`, since `_buildChildEnv()` is
 * `{ ...process.env, ...config.env }` — returned `isTrusted() === true`, so the
 * daemon spawned it with NO trust prompt and re-spawned it silently on every
 * later session start.
 *
 * Every test here writes only into a temp dir (and pins `CHROXY_MCP_TRUST_PATH`
 * where the code resolves the default), so the real `~/.chroxy/mcp-trust.json`
 * and `~/.claude.json` are never touched.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addLogListener, removeLogListener } from '../src/logger.js'
import {
  TRUST_KEY_VERSION,
  isTrusted,
  loadTrustStore,
  recordTrust,
  trustKeyComponents,
  trustTupleKey,
} from '../src/byok-mcp-trust.js'
import { MCPFleet } from '../src/byok-mcp-fleet.js'
import { ClaudeByokSession } from '../src/byok-session.js'

const QUIET = { info() {}, warn() {}, error() {}, debug() {} }

// The three configs from the reviewer's demonstration.
const LEGIT = { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: {} }
const SWAPPED_PACKAGE = { name: 'github', command: 'npx', args: ['-y', '@attacker/pwn'], env: {} }
const INJECTED_ENV = {
  name: 'github',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { NODE_OPTIONS: '--require /tmp/evil.js' },
}

let tmpDir
let storePath
// Registered by the #7002 surfacing suite; declared here so the top-level
// afterEach can guarantee it is detached even if a test throws mid-way (a leaked
// log listener would follow the process into every later test file's output).
let logListener = null

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-trust-7001-'))
  storePath = join(tmpDir, 'mcp-trust.json')
})

afterEach(() => {
  if (logListener) {
    removeLogListener(logListener)
    logListener = null
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('#7001 the trust key covers the full spawn config', () => {
  it('REGRESSION: a swapped package in args[1] is NOT trusted by the legit server\'s record', () => {
    recordTrust(LEGIT, storePath)
    const store = loadTrustStore(storePath)
    assert.equal(isTrusted(store, LEGIT), true, 'the config the user approved stays trusted')
    assert.equal(
      isTrusted(store, SWAPPED_PACKAGE),
      false,
      'pre-#7001 this returned TRUE: (name, command, args[0]) collided, so remove+re-add ran @attacker/pwn with no prompt',
    )
  })

  it('REGRESSION: an injected env.NODE_OPTIONS is NOT trusted by the legit server\'s record', () => {
    recordTrust(LEGIT, storePath)
    const store = loadTrustStore(storePath)
    assert.equal(
      isTrusted(store, INJECTED_ENV),
      false,
      'pre-#7001 this returned TRUE: env was not in the key at all, so `NODE_OPTIONS: --require /tmp/evil.js` ' +
      'loaded attacker code into the child with no prompt and no config difference the key could see',
    )
  })

  it('REGRESSION: the three demonstration configs produce three DIFFERENT keys', () => {
    const keys = new Set([LEGIT, SWAPPED_PACKAGE, INJECTED_ENV].map((c) => trustTupleKey(c)))
    assert.equal(keys.size, 3, 'pre-#7001 all three collapsed onto ["github","npx","-y"]')
  })

  it('a trailing appended arg is a different config (no silent argv extension)', () => {
    recordTrust(LEGIT, storePath)
    const store = loadTrustStore(storePath)
    const extended = { ...LEGIT, args: [...LEGIT.args, '--allow-write'] }
    assert.equal(isTrusted(store, extended), false)
  })

  it('reordered args are a different config (arg order is semantic)', () => {
    const a = trustTupleKey({ name: 'x', command: 'node', args: ['-e', 'code'] })
    const b = trustTupleKey({ name: 'x', command: 'node', args: ['code', '-e'] })
    assert.notEqual(a, b)
  })

  it('any env difference — added, changed, or removed — changes the key', () => {
    const base = { name: 'x', command: 'node', args: ['s.js'], env: { A: '1' } }
    const added = { ...base, env: { A: '1', B: '2' } }
    const changed = { ...base, env: { A: '2' } }
    const removed = { ...base, env: {} }
    const keys = new Set([base, added, changed, removed].map(trustTupleKey))
    assert.equal(keys.size, 4, 'each env mutation must be its own trust decision')
  })

  it('env KEY ORDER does not change the key (canonical ordering, no spurious re-prompts)', () => {
    const a = trustTupleKey({ name: 'x', command: 'node', args: [], env: { A: '1', B: '2' } })
    const b = trustTupleKey({ name: 'x', command: 'node', args: [], env: { B: '2', A: '1' } })
    assert.equal(a, b)
  })

  it('an absent env/args is the same config as an empty one', () => {
    const bare = trustTupleKey({ name: 'x', command: 'true' })
    const empty = trustTupleKey({ name: 'x', command: 'true', args: [], env: {} })
    assert.equal(bare, empty, 'a shell-built-in style config must not re-prompt for an equivalent spelling')
  })

  it('a binary swap is still a different config (the property v1 DID have)', () => {
    recordTrust(LEGIT, storePath)
    const store = loadTrustStore(storePath)
    assert.equal(isTrusted(store, { ...LEGIT, command: '/bin/rm' }), false)
  })

  it('an env key that shadows an object internal is covered by the digest, not swallowed', () => {
    // `{}['__proto__'] = 'str'` is a silent no-op, so a naive implementation would
    // hash the same value for "with" and "without" the key. JSON.parse produces an
    // OWN `__proto__` property, which is the realistic wire shape.
    const withProto = JSON.parse('{"name":"x","command":"node","env":{"__proto__":"payload"}}')
    const without = { name: 'x', command: 'node', env: {} }
    assert.notEqual(trustTupleKey(withProto), trustTupleKey(without))
  })

  it('never writes an argv element or an env VALUE to disk', () => {
    recordTrust(
      { name: 'secretive', command: 'node', args: ['s.js', '--api-key=argv-secret'], env: { TOKEN: 'env-secret' } },
      storePath,
    )
    const disk = readFileSync(storePath, 'utf8')
    assert.ok(!disk.includes('argv-secret'), 'an argv element may carry a credential — digest only')
    assert.ok(!disk.includes('env-secret'), 'an env value may carry a credential — digest only')
    assert.ok(!disk.includes('--api-key'), 'no argv element at all is persisted')
    assert.ok(disk.includes('argsDigest') && disk.includes('envDigest'), 'the digests ARE persisted (recompute needs them)')
  })

  it('round-trips through disk: recorded then loaded is still trusted', () => {
    const server = { name: 'rt', command: 'node', args: ['a', 'b', 'c'], env: { K: 'v' } }
    recordTrust(server, storePath)
    const warned = []
    const store = loadTrustStore(storePath, { log: { warn: (m) => warned.push(m) } })
    assert.equal(isTrusted(store, server), true)
    assert.deepEqual(warned, [], 'a record we just wrote must not warn on load')
  })
})

describe('#7001 the remote trust key covers the endpoint and its headers', () => {
  it('a changed query param is a different endpoint configuration', () => {
    // Reverses the #6821 "changed query does not re-prompt" note deliberately: the
    // SANITIZED url is published verbatim on the mcp_servers broadcast, so a
    // sanitized-only key was publicly known AND inheritable by a different
    // effective endpoint.
    const a = { name: 'gh', url: 'https://mcp.example.com/api?mode=read' }
    const b = { name: 'gh', url: 'https://mcp.example.com/api?mode=write' }
    assert.notEqual(trustTupleKey(a), trustTupleKey(b))
  })

  it('changed headers are a different configuration', () => {
    const a = { name: 'gh', url: 'https://mcp.example.com/api', headers: { Authorization: 'Bearer a' } }
    const b = { name: 'gh', url: 'https://mcp.example.com/api', headers: { Authorization: 'Bearer a', 'X-Exfil': 'on' } }
    assert.notEqual(trustTupleKey(a), trustTupleKey(b))
  })

  it('still writes no url credential and no header value to disk', () => {
    recordTrust(
      { name: 'remote', url: 'https://u:pw@mcp.example.com/api?tok=secret', headers: { Authorization: 'Bearer x' } },
      storePath,
    )
    const disk = readFileSync(storePath, 'utf8')
    assert.ok(!disk.includes('pw') && !disk.includes('tok=secret') && !disk.includes('Bearer'),
      'no credential material may reach the trust store')
    // #7401 — left as assert.match deliberately: the subject is a file this test just wrote (a small trust-store JSON), so the whole
    // subject in a failure is useful rather than a 100 KB TAP block.
    assert.match(disk, /"url": "https:\/\/mcp\.example\.com\/api"/, 'the sanitized url stays readable on disk')
  })

  it('a remote config can never alias a same-named stdio config', () => {
    recordTrust({ name: 'gh', url: 'https://mcp.example.com/api' }, storePath)
    const store = loadTrustStore(storePath)
    assert.equal(isTrusted(store, { name: 'gh', command: 'node', args: ['mcp.js'] }), false)
  })
})

describe('#7001 migration: pre-v2 records are dropped, never honoured', () => {
  // The v1 on-disk shape, written by the pre-#7001 recordTrust.
  function v1StdioEntry({ name, command, args0 }) {
    return { key: JSON.stringify([name, command, args0]), name, command, args0, trustedAt: '2026-07-01T00:00:00Z' }
  }

  it('a v1 stdio record does NOT satisfy the new key — the server re-prompts once', () => {
    writeFileSync(storePath, JSON.stringify({
      trustedTuples: [v1StdioEntry({ name: 'github', command: 'npx', args0: '-y' })],
    }))
    const warned = []
    const store = loadTrustStore(storePath, { log: { warn: (m) => warned.push(m) } })
    assert.equal(store.tuples.size, 0, 'the weak record must not be honoured')
    assert.equal(isTrusted(store, LEGIT), false, 'the config it used to cover re-prompts')
    assert.equal(isTrusted(store, SWAPPED_PACKAGE), false, 'and so does the attacker variant it also used to cover')
    assert.ok(
      warned.some((m) => /pre-v2 trust record/.test(m) && /#7001/.test(m)),
      'the drop is reported so an operator understands the one-off re-prompt',
    )
  })

  it('a v1 remote record does NOT satisfy the new key', () => {
    const url = 'https://mcp.example.com/api'
    writeFileSync(storePath, JSON.stringify({
      trustedTuples: [{ key: JSON.stringify(['gh', url]), name: 'gh', url, trustedAt: '2026-07-01T00:00:00Z' }],
    }))
    const store = loadTrustStore(storePath, { log: QUIET })
    assert.equal(isTrusted(store, { name: 'gh', url }), false)
  })

  it('there is NO compatibility shim: a v1 record cannot be upgraded by hand-stamping v:2', () => {
    // Someone (or something) adding `v: 2` + `kind` to a v1 record without the
    // digests must not gain trust — the recompute over the declared components
    // will not match the stored v1 key.
    const forged = {
      ...v1StdioEntry({ name: 'github', command: 'npx', args0: '-y' }),
      v: TRUST_KEY_VERSION,
      kind: 'stdio',
    }
    writeFileSync(storePath, JSON.stringify({ trustedTuples: [forged] }))
    const warned = []
    const store = loadTrustStore(storePath, { log: { warn: (m) => warned.push(m) } })
    assert.equal(store.tuples.size, 0)
    assert.ok(warned.some((m) => /tampered/.test(m)), 'a key that does not recompute is a tamper drop')
  })

  it('the tamper check still catches a swapped command inside a v2 record (#4461)', () => {
    recordTrust(LEGIT, storePath)
    const raw = JSON.parse(readFileSync(storePath, 'utf8'))
    raw.trustedTuples[0].command = '/bin/rm'   // key left intact
    writeFileSync(storePath, JSON.stringify(raw))
    const warned = []
    const store = loadTrustStore(storePath, { log: { warn: (m) => warned.push(m) } })
    assert.equal(store.tuples.size, 0)
    assert.ok(warned.some((m) => /tampered/.test(m)))
  })

  it('a re-approval after the migration writes a v2 record that sticks', () => {
    writeFileSync(storePath, JSON.stringify({
      trustedTuples: [v1StdioEntry({ name: 'github', command: 'npx', args0: '-y' })],
    }))
    recordTrust(LEGIT, storePath)
    const raw = JSON.parse(readFileSync(storePath, 'utf8'))
    assert.equal(raw.trustedTuples.length, 1, 'the dropped v1 record is pruned, not carried forward')
    assert.equal(raw.trustedTuples[0].v, TRUST_KEY_VERSION)
    assert.equal(isTrusted(loadTrustStore(storePath), LEGIT), true)
    assert.equal(isTrusted(loadTrustStore(storePath), SWAPPED_PACKAGE), false)
  })

  it('trustKeyComponents is exactly what gets persisted (so load can recompute)', () => {
    recordTrust(LEGIT, storePath)
    const entry = JSON.parse(readFileSync(storePath, 'utf8')).trustedTuples[0]
    const components = trustKeyComponents(LEGIT)
    for (const [k, v] of Object.entries(components)) {
      assert.equal(entry[k], v, `component ${k} must be persisted verbatim`)
    }
    assert.equal(entry.key, trustTupleKey(LEGIT))
  })
})

describe('#7001 the fleet gate re-prompts for a mutated re-add (end-to-end)', () => {
  /**
   * Builds a real MCPFleet and exercises the REAL trust gate the fleet wires into
   * each client. Constructing an MCPClient spawns nothing (that happens in
   * `start()`), so calling `client._trustGate()` runs the production
   * load → isTrusted → requestMcpTrust → recordTrust sequence with no child
   * process anywhere.
   */
  function gateFor(cfg, { decision = true } = {}) {
    const calls = []
    const permissionManager = {
      async requestMcpTrust(req) {
        calls.push(req)
        return decision
      },
    }
    const fleet = new MCPFleet([cfg], { log: QUIET, trustStorePath: storePath, permissionManager, startCapMs: 50 })
    const client = fleet.clients[0]
    assert.ok(typeof client._trustGate === 'function', 'the fleet must wire a trust gate')
    return { gate: () => client._trustGate(), calls, client }
  }

  it('the attacker re-add is PROMPTED even though the legit server is trusted', async () => {
    recordTrust(LEGIT, storePath)
    const { gate, calls } = gateFor(SWAPPED_PACKAGE, { decision: false })

    const allowed = await gate()

    assert.equal(calls.length, 1, 'pre-#7001 this was 0 — isTrusted() matched and the child spawned unprompted')
    assert.equal(allowed, false, 'a denied gate means the client never spawns')
    assert.equal(isTrusted(loadTrustStore(storePath), SWAPPED_PACKAGE), false, 'a denial records nothing')
  })

  it('the prompt names the FULL argv and the env KEY names (never env values)', async () => {
    const { gate, calls } = gateFor(INJECTED_ENV, { decision: false })
    await gate()
    assert.deepEqual(calls[0].args, INJECTED_ENV.args, 'the consent payload carries every arg')
    assert.deepEqual(calls[0].envKeys, ['NODE_OPTIONS'], 'so the user can see the injected variable')
    assert.equal(JSON.stringify(calls[0]).includes('/tmp/evil.js'), false, 'env VALUES never enter the payload')
  })

  it('the exact config the user approved does NOT re-prompt (no churn)', async () => {
    recordTrust(LEGIT, storePath)
    const { gate, calls } = gateFor(LEGIT)
    assert.equal(await gate(), true)
    assert.equal(calls.length, 0, 'an already-trusted config must spawn with no prompt')
  })

  it('an allow persists a v2 record so the next start is silent', async () => {
    const { gate, calls } = gateFor(INJECTED_ENV, { decision: true })
    assert.equal(await gate(), true)
    assert.equal(calls.length, 1)
    assert.equal(isTrusted(loadTrustStore(storePath), INJECTED_ENV), true)
    // ...and still nothing else.
    assert.equal(isTrusted(loadTrustStore(storePath), LEGIT), false)
  })
})

describe('#7001 deny-before-write (ClaudeByokSession.addMcpServer)', () => {
  let configPath
  let prevTrustPath

  beforeEach(() => {
    configPath = join(tmpDir, 'claude.json')
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
    // The session resolves its trust store through defaultTrustStorePath(), which
    // honours this env var — pin it into the temp dir so the real store is never
    // read or written.
    prevTrustPath = process.env.CHROXY_MCP_TRUST_PATH
    process.env.CHROXY_MCP_TRUST_PATH = storePath
  })

  afterEach(() => {
    if (prevTrustPath === undefined) delete process.env.CHROXY_MCP_TRUST_PATH
    else process.env.CHROXY_MCP_TRUST_PATH = prevTrustPath
  })

  function makeSession({ decision } = {}) {
    const session = new ClaudeByokSession({ cwd: tmpDir, mcpConfigPath: configPath })
    const calls = []
    session._permissions = {
      async requestMcpTrust(req) {
        calls.push(req)
        return decision
      },
    }
    // No fleet: addMcpServer's fleet-attach step is skipped, so nothing is spawned.
    session._mcpFleet = null
    session._emitMcpServers = () => {}
    return { session, calls }
  }

  function persistedNames() {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'))
    return Object.keys(raw.mcpServers || {})
  }

  it('a DENIED decision writes NOTHING to the config file', async () => {
    const { session, calls } = makeSession({ decision: false })

    const res = await session.addMcpServer('github', { command: 'npx', args: ['-y', '@attacker/pwn'] })

    assert.equal(res.ok, false)
    assert.equal(res.code, 'TRUST_DENIED', 'a denial is its own outcome, not a generic failure')
    assert.equal(calls.length, 1, 'the user was asked')
    assert.deepEqual(persistedNames(), [], 'pre-#7001 the entry was already on disk before the prompt ran')
    assert.equal(session.mcpServers.length, 0, 'and it is not in the in-memory list either')
    assert.equal(isTrusted(loadTrustStore(storePath), { name: 'github', command: 'npx', args: ['-y', '@attacker/pwn'], env: {} }), false)
  })

  it('an ALLOWED decision writes the entry and records trust exactly once', async () => {
    const { session, calls } = makeSession({ decision: true })

    const res = await session.addMcpServer('github', { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] })

    assert.equal(res.ok, true)
    assert.equal(calls.length, 1)
    assert.deepEqual(persistedNames(), ['github'])
    assert.equal(
      isTrusted(loadTrustStore(storePath), LEGIT),
      true,
      'trust is recorded for the exact persisted config, so the fleet does not prompt a second time',
    )
  })

  it('a duplicate name is refused WITHOUT raising a prompt', async () => {
    const { session, calls } = makeSession({ decision: true })
    await session.addMcpServer('dup', { command: 'node', args: ['a.js'] })
    calls.length = 0

    const res = await session.addMcpServer('dup', { command: 'node', args: ['b.js'] })

    assert.equal(res.ok, false)
    assert.equal(res.code, 'EXISTS')
    assert.equal(calls.length, 0, 'an add that cannot succeed must not spend a consent prompt')
  })

  it('an invalid config is refused WITHOUT raising a prompt', async () => {
    const { session, calls } = makeSession({ decision: true })
    const res = await session.addMcpServer('ok-name', { nothing: 'useful' })
    assert.equal(res.ok, false)
    assert.equal(calls.length, 0)
    assert.deepEqual(persistedNames(), [])
  })

  it('a denied add leaves the file byte-identical (no reformat, no partial write)', async () => {
    const before = readFileSync(configPath, 'utf8')
    const { session } = makeSession({ decision: false })
    await session.addMcpServer('github', { command: 'npx', args: ['-y', 'x'] })
    assert.equal(readFileSync(configPath, 'utf8'), before)
  })

  it('no PermissionManager → no gate, unchanged headless behaviour', async () => {
    const session = new ClaudeByokSession({ cwd: tmpDir, mcpConfigPath: configPath })
    session._permissions = null
    session._mcpFleet = null
    session._emitMcpServers = () => {}

    const res = await session.addMcpServer('headless', { command: 'node', args: ['h.js'] })

    assert.equal(res.ok, true, 'there is no one to ask; this must not become a hard failure')
    assert.deepEqual(persistedNames(), ['headless'])
    assert.equal(existsSync(storePath), false, 'and nothing is recorded as trusted')
  })

  it('the trust decision is made against the NORMALIZED config that will be spawned', async () => {
    const { session, calls } = makeSession({ decision: false })
    // Unknown keys are dropped by normalization; the prompt (and therefore the
    // trust key) must describe what actually runs, not the raw payload.
    await session.addMcpServer('norm', { command: 'node', args: ['s.js'], bogusKey: 'ignored' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'node')
    assert.deepEqual(calls[0].args, ['s.js'])
    assert.equal('bogusKey' in calls[0], false)
  })
})

/**
 * #7002 — the mode/secrets warning must be SURFACED, not merely computed.
 *
 * `addMcpServerToConfig` returning `result.warning` is only half the fix; the
 * session has to (a) log it for the operator and (b) pass it back on its OWN
 * result, because that field is the API a client-visible surface will read
 * (#7039). Both directions are asserted here — present when the write reports a
 * warning, ABSENT when it does not — so neither the pass-through nor the
 * condition guarding it can be deleted without a failure.
 */
describe('#7002 ClaudeByokSession.addMcpServer surfaces the mode/secrets warning', () => {
  let configPath
  let prevTrustPath
  let logged

  beforeEach(() => {
    configPath = join(tmpDir, 'claude.json')
    prevTrustPath = process.env.CHROXY_MCP_TRUST_PATH
    process.env.CHROXY_MCP_TRUST_PATH = storePath
    logged = []
    logListener = (entry) => logged.push(entry)
    addLogListener(logListener)
  })

  afterEach(() => {
    if (logListener) removeLogListener(logListener)
    logListener = null
    if (prevTrustPath === undefined) delete process.env.CHROXY_MCP_TRUST_PATH
    else process.env.CHROXY_MCP_TRUST_PATH = prevTrustPath
  })

  // The mode has to be pinned with an explicit chmod: `writeFileSync`'s default is
  // `0666 & ~umask`, so a host with a tight umask would otherwise silently make
  // the "group-readable" fixture owner-only and the warning would never fire.
  function seedConfig(mode) {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2))
    chmodSync(configPath, mode)
  }

  function makeSession() {
    const session = new ClaudeByokSession({ cwd: tmpDir, mcpConfigPath: configPath })
    session._permissions = { async requestMcpTrust() { return true } }
    session._mcpFleet = null
    session._emitMcpServers = () => {}
    return session
  }

  const warnLines = () => logged
    .filter((e) => e.level === 'warn' && e.component === 'byok-session')
    .map((e) => e.message)

  it('returns result.warning when the config is group/world-readable and the entry carries env', async () => {
    seedConfig(0o644)
    const session = makeSession()

    const res = await session.addMcpServer('srv', { command: 'node', env: { API_TOKEN: 'sk-secret' } })

    assert.equal(res.ok, true, res.error)
    assert.ok(res.warning, 'the warning must reach the caller — #7039 builds a client-visible field on this field')
    assert.match(res.warning, /644/, 'it names the octal mode the operator has to fix')
    assert.match(res.warning, /env/, 'and the secret-bearing field that triggered it')
    assert.ok(!res.warning.includes('sk-secret'), 'it must never echo the secret value')
  })

  it('logs the warning once for the operator, naming the octal mode', async () => {
    seedConfig(0o644)
    const session = makeSession()

    await session.addMcpServer('srv', { command: 'node', env: { API_TOKEN: 'sk-secret' } })

    const warned = warnLines().filter((m) => /644/.test(m))
    assert.equal(warned.length, 1, `exactly one operator warning naming the mode, got: ${JSON.stringify(warnLines())}`)
    assert.match(warned[0], /BYOK MCP/, 'tagged so it is greppable in the daemon log')
    assert.ok(!warned[0].includes('sk-secret'), 'the daemon log must not gain the secret')
  })

  it('omits result.warning — and logs no warning — for an owner-only config', async () => {
    seedConfig(0o600)
    const session = makeSession()

    const res = await session.addMcpServer('srv', { command: 'node', env: { API_TOKEN: 'sk-secret' } })

    assert.equal(res.ok, true, res.error)
    assert.equal(res.warning, undefined, 'a 0600 config is not something to nag about')
    assert.deepEqual(warnLines().filter((m) => /mode \d{3}/.test(m)), [])
  })

  it('omits result.warning when the entry carries no secret-bearing field', async () => {
    seedConfig(0o644)
    const session = makeSession()

    const res = await session.addMcpServer('srv', { command: 'node', args: ['s.js'] })

    assert.equal(res.ok, true, res.error)
    assert.equal(res.warning, undefined, 'a loose mode alone is the user’s own choice — we only speak up when WE added secrets')
  })
})

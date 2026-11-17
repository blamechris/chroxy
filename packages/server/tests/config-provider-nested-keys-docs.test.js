import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { validateAnthropicCompatibleProviders, validateOpenAiCompatibleProviders } from '../src/anthropic-compatible-config.js'
import { auditReadonlyRosterReferences, readConfigDiscoveryShape, readLiteralRoster, readNestedProviderShapes, scanKeyRosterDeclarations } from './helpers/provider-nested-key-rosters.js'

const SRC = new URL('../src/', import.meta.url)
const PROVIDER_FILE = 'anthropic-compatible-config.js'
const ROSTERS = new Map([
  ['MODEL_DISCOVERY_KEYS', 'modelDiscovery'],
  ['PRICING_RATE_KEYS', 'pricing'],
])

// Sweep ALL *_KEYS declarations under src/, not a list of provider modules or
// just today's two names. Existing block/entry rosters have their own closed
// registry in config-supported-keys-docs.test.js. Every other roster needs an
// explicit disposition; stale exclusions fail, including the declaring file.
const NON_NESTED = new Map([
  // Explicit names, not blanket suffix exemptions: a new nested roster named
  // *_SUPPORTED_KEYS or *_ENTRY_KEYS must also receive a deliberate disposition.
  ...[
    ['acp-config.js', 'ACP_ENTRY_KEYS'],
    ['anthropic-compatible-config.js', 'COMPATIBLE_ENTRY_KEYS'],
    ['anthropic-compatible-config.js', 'PROVIDERS_SUPPORTED_KEYS'],
    ...['K8S', 'BILLING', 'WORKTREE_GC', 'ORPHAN_REAP', 'SESSION_ARCHIVE', 'SESSION_CI', 'RANCHER', 'DISCORD', 'USER_SHELL']
      .map(prefix => ['config.js', `${prefix}_SUPPORTED_KEYS`]),
  ].map(([file, name]) => [`${file}:${name}`, 'block/entry roster gated by config-supported-keys-docs.test.js']),
  ['anthropic-compatible-config.js:FORBIDDEN_SECRET_KEYS', 'rejected secrets, not accepted config keys'],
  ['base-session.js:BASE_SESSION_OPT_KEYS', 'session constructor options'],
  ['byok-mcp-config.js:UNSAFE_MAP_KEYS', 'prototype-pollution denylist'],
  ['byok-session.js:BYOK_SESSION_LOCAL_OPT_KEYS', 'session constructor options'],
  ['config.js:DURATION_MS_CONFIG_KEYS', 'duration coercion, not a nested shape'],
  ['config.js:DURATION_MS_MAP_CONFIG_KEYS', 'duration-map coercion'],
  ['config.js:SENSITIVE_KEYS', 'log redaction'],
  ['config.js:DISCORD_SECRET_KEYS', 'rejected secrets'],
  ['config.js:SESSION_ARCHIVE_POLICY_KEYS', 'subset of SESSION_ARCHIVE_SUPPORTED_KEYS, gated separately'],
  ['credential-store.js:KNOWN_KEYS', 'credential field names, not config shapes'],
  ['docker-session.js:FORWARDED_ENV_KEYS', 'environment forwarding'],
  ['environments/backends/docker.js:FORWARDED_ENV_KEYS', 'environment forwarding'],
  ['per-session-settings.js:REQUIRED_DEFINITION_KEYS', 'internal setting definitions'],
  ['skills-frontmatter.js:FRONTMATTER_KEYS', 'skill metadata, not provider config'],
  ['session-name-allocator.js:MAX_KEYS', 'numeric record-count cap, not a key roster'],
  ['principal-audit.js:MAX_COLLAPSE_KEYS', 'numeric cap on collapsed rejection-counter entries, not a key roster'],
])
const READONLY_USES = new Map([
  ['MODEL_DISCOVERY_KEYS', { methods: ['has'] }],
  ['PRICING_RATE_KEYS', { methods: ['includes', 'join'], iterable: true }],
])
const sorted = values => [...values].sort()

async function collectSources(dir = SRC, prefix = '') {
  const found = new Map()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir)
    if (entry.isDirectory()) {
      for (const pair of await collectSources(url, prefix + entry.name + '/')) found.set(...pair)
    } else if (/\.[cm]?js$/.test(entry.name)) {
      found.set(prefix + entry.name, await readFile(url, 'utf8'))
    }
  }
  return found
}

// LIMIT: this sweep only sees VariableDeclarator bindings whose name ends in
// `_KEYS`. A roster named otherwise (`nestedKeys`, `ALLOWED_FIELDS`) escapes it
// by design; do not read a green run as proof that no other nested roster exists.
function discoverRosters(sources) {
  const found = new Map()
  const exclusions = new Set()
  assert.deepEqual(sorted(READONLY_USES.keys()), sorted(ROSTERS.keys()), 'nested rosters without a reference audit')
  for (const [file, source] of sources) {
    for (const [name, init] of scanKeyRosterDeclarations(source, `src/${file}`)) {
      const id = `${file}:${name}`
      if (NON_NESTED.has(id)) { exclusions.add(id); continue }
      assert.ok(file === PROVIDER_FILE && ROSTERS.has(name), `ungated nested roster src/${id}: register its docs or explain why it is not a nested config roster`)
      found.set(name, readLiteralRoster(init, `src/${id}`))
      assert.ok(auditReadonlyRosterReferences(source, `src/${file}`, name, READONLY_USES.get(name)) > 0, `${name}: no audited readonly references`)
    }
  }
  assert.deepEqual(sorted(exclusions), sorted(NON_NESTED.keys()), 'stale non-nested roster exclusions')
  assert.deepEqual(sorted(found.keys()), sorted(ROSTERS.keys()), 'nested roster declarations disappeared')
  return found
}

function checkDocs(rosters, config, providers) {
  const shapes = readNestedProviderShapes(providers)
  shapes.set('CONFIG.modelDiscovery', readConfigDiscoveryShape(config))
  const documentedRosters = new Set()
  for (const [site, documented] of shapes) {
    const field = site.split('.')[1]
    const name = [...ROSTERS].find(([, f]) => f === field)?.[0]
    assert.ok(name, `unregistered nested doc shape ${site}`)
    documentedRosters.add(name)
    // Exact arrays (not a union) cover BOTH directions at EVERY site. The doc
    // keys come from its independent shape, never the producer's own roster.
    assert.deepEqual(sorted(documented), sorted(rosters.get(name)), `${site} disagrees with ${name}`)
  }
  assert.deepEqual(sorted(documentedRosters), sorted(rosters.keys()), 'nested rosters with no documented shape')
  assert.equal(shapes.size, 5, 'expected four provider table shapes and the CONFIG example')
}

describe('nested provider rosters vs documented shapes (#8548)', () => {
  let sources, config, providers, rosters
  before(async () => {
    sources = await collectSources()
    config = await readFile(new URL('../CONFIG.md', import.meta.url), 'utf8')
    providers = await readFile(new URL('../../../docs/providers.md', import.meta.url), 'utf8')
    rosters = discoverRosters(sources)
  })

  it('sweeps recursively and compares every nested doc shape in both directions', () => {
    assert.ok([...sources.keys()].filter(f => f.includes('/')).length >= 50, 'source sweep is not recursive')
    checkDocs(rosters, config, providers)
  })

  it('the literal rosters are what both pure entry validators accept', () => {
    for (const validate of [validateAnthropicCompatibleProviders, validateOpenAiCompatibleProviders]) {
      for (const [name, field] of ROSTERS) {
        const probe = extra => validate([{
          id: 'zz-nested-doc-probe', baseUrl: 'https://example.invalid', defaultModel: 'm',
          [field]: { ...(field === 'modelDiscovery' ? { url: 'https://example.invalid/models', format: 'openai' } : {}), ...extra },
        }])
        assert.deepEqual(probe({}).warnings, [], `${field}: valid fixture must be accepted`)
        const unknown = 'zzNotANestedKey'
        assert.ok(!rosters.get(name).includes(unknown), 'invented probe key entered the roster')
        assert.ok(probe({ [unknown]: 0 }).warnings.some(w => w.startsWith('Unknown key ') && w.includes(`.${field}.${unknown}'`)), `${field}: probe cannot detect unknown keys`)
        for (const key of rosters.get(name)) {
          const value = field === 'pricing' ? 1 : key === 'url' ? 'https://example.invalid/models' : 'openai'
          const result = probe({ [key]: value })
          assert.equal(result.entries.length, 1, `${name}.${key}: valid fixture was rejected`)
          assert.deepEqual(result.warnings, [], `${name}.${key}: the validator does not enforce the parsed roster`)
        }
      }
    }
  })

  it('refuses direct and aliased runtime drift even when both real pure validators accept it', async () => {
    const text = sources.get(PROVIDER_FILE)
    const anchor = "const MODEL_DISCOVERY_KEYS = new Set(['url', 'format'])"
    const fixture = [{ id: 'zz-runtime-drift', baseUrl: 'https://example.invalid', defaultModel: 'm', modelDiscovery: { url: 'https://example.invalid/models', format: 'openai', pollIntervalMs: 1000 } }]
    for (const validate of [validateAnthropicCompatibleProviders, validateOpenAiCompatibleProviders]) {
      assert.ok(validate(fixture).warnings.some(w => w.includes('.modelDiscovery.pollIntervalMs')))
    }
    for (const addition of [
      "MODEL_DISCOVERY_KEYS.add('pollIntervalMs')",
      "const discoveryAlias = MODEL_DISCOVERY_KEYS; discoveryAlias.add('pollIntervalMs')",
    ]) {
      const mutated = text.replace(anchor, anchor + '\n' + addition)
      assert.notEqual(mutated, text, 'runtime drift mutation must change the producer')
      // The inspected producer is dependency-free. This executes only its pure
      // validators from the SAME in-memory source supplied to the AST audit.
      const changed = await import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64'))
      for (const name of ['validateAnthropicCompatibleProviders', 'validateOpenAiCompatibleProviders']) {
        assert.equal(changed[name](fixture).entries.length, 1)
        assert.deepEqual(changed[name](fixture).warnings, [])
      }
      const edits = new Map(sources)
      edits.set(PROVIDER_FILE, mutated)
      assert.throws(() => discoverRosters(edits), /REFUSE: src\/anthropic-compatible-config.js: MODEL_DISCOVERY_KEYS: unsupported roster reference/)
    }
  })

  it('refuses writes, computed access, detached methods and indirect roster escapes', () => {
    const text = sources.get(PROVIDER_FILE)
    for (const addition of [
      "MODEL_DISCOVERY_KEYS['add']('pollIntervalMs')",
      "MODEL_DISCOVERY_KEYS.has = () => true",
      "MODEL_DISCOVERY_KEYS.has.call(MODEL_DISCOVERY_KEYS, 'url')",
      'const detached = MODEL_DISCOVERY_KEYS.has',
      'const { add: mutate } = MODEL_DISCOVERY_KEYS',
      'const getRoster = () => MODEL_DISCOVERY_KEYS',
      "Set.prototype.add.call(MODEL_DISCOVERY_KEYS, 'pollIntervalMs')",
      "Reflect.apply(Set.prototype.add, MODEL_DISCOVERY_KEYS, ['pollIntervalMs'])",
      'Object.assign(MODEL_DISCOVERY_KEYS, {})',
      'const wrapped = { roster: MODEL_DISCOVERY_KEYS }',
      'const copied = [...MODEL_DISCOVERY_KEYS]',
      "MODEL_DISCOVERY_KEYS?.has('url')",
      "PRICING_RATE_KEYS[0] = 'pollIntervalMs'",
      "PRICING_RATE_KEYS.push('pollIntervalMs')",
      "delete PRICING_RATE_KEYS[0]",
      'const pricingAlias = PRICING_RATE_KEYS',
    ]) {
      const edits = new Map(sources)
      edits.set(PROVIDER_FILE, text + '\n' + addition)
      assert.throws(() => discoverRosters(edits), /unsupported roster reference/, addition)
    }
    assert.equal(auditReadonlyRosterReferences(text, PROVIDER_FILE, 'MODEL_DISCOVERY_KEYS', READONLY_USES.get('MODEL_DISCOVERY_KEYS')), 1)
    assert.equal(auditReadonlyRosterReferences(text, PROVIDER_FILE, 'PRICING_RATE_KEYS', READONLY_USES.get('PRICING_RATE_KEYS')), 3)
  })

  it('dropping or inventing a doc key fails separately at each provider table site', () => {
    for (const dialect of ['Anthropic', 'OpenAI']) {
      for (const [field, key] of [['modelDiscovery', 'format'], ['pricing', 'cacheWrite']]) {
        const start = providers.indexOf(`## ${dialect}-compatible endpoints (config-driven)`)
        const rowAt = providers.indexOf(`| \`${field}\` |`, start)
        const edit = replacement => providers.slice(0, rowAt) + providers.slice(rowAt).replace(`, "${key}"`, replacement)
        assert.throws(() => checkDocs(rosters, config, edit('')), new RegExp(`${dialect}.${field} disagrees`))
        assert.throws(() => checkDocs(rosters, config, edit(`, "${key}", "zzDocOnly"`)), new RegExp(`${dialect}.${field} disagrees`))
      }
    }
  })

  it('dropping or inventing a CONFIG example key fails', () => {
    for (const replacement of ['', ', "format": "openrouter", "zzDocOnly": true']) {
      const mutated = config.replace(', "format": "openrouter"', replacement)
      assert.notEqual(mutated, config, 'doc mutation must actually change the example')
      assert.throws(() => checkDocs(rosters, mutated, providers), /CONFIG.modelDiscovery disagrees/)
    }
  })

  it('adding a real source roster member fails the independent docs comparison', () => {
    for (const [name] of ROSTERS) {
      const edits = new Map(sources)
      const text = sources.get(PROVIDER_FILE)
      const anchor = name === 'MODEL_DISCOVERY_KEYS' ? "new Set(['url', 'format'])" : "Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite'])"
      const mutated = text.replace(anchor, anchor.replace('])', ", 'zzUndocumented'])"))
      assert.notEqual(mutated, text, 'source mutation must actually change the declaration')
      edits.set(PROVIDER_FILE, mutated)
      assert.throws(() => checkDocs(discoverRosters(edits), config, providers), new RegExp(`disagrees with ${name}`))
    }
  })

  it('a new private roster in a nested source file cannot escape registration', () => {
    for (const name of ['FUTURE_NESTED_KEYS', 'FUTURE_SUPPORTED_KEYS', 'FUTURE_ENTRY_KEYS']) {
      const edits = new Map(sources)
      edits.set('future/nested/provider.js', `const ${name} = Object.freeze(['newKey'])`)
      assert.throws(() => discoverRosters(edits), /ungated nested roster src\/future\/nested\/provider.js:FUTURE_/)
    }
  })

  it('stale exclusions and disappearing nested declarations fail closed', () => {
    for (const [file, anchor, expected] of [
      ['skills-frontmatter.js', 'FRONTMATTER_KEYS', /stale non-nested roster exclusions/],
      [PROVIDER_FILE, 'MODEL_DISCOVERY_KEYS', /nested roster declarations disappeared/],
    ]) {
      const edits = new Map(sources)
      edits.set(file, sources.get(file).replaceAll(anchor, anchor.replace('_KEYS', '_FIELDS')))
      assert.throws(() => discoverRosters(edits), expected)
    }
  })

  it('parses declarations structurally without treating comments or strings as rosters', () => {
    const found = scanKeyRosterDeclarations(`// const FAKE_KEYS = []
      const text = 'const STRING_KEYS = []', ONE_KEYS = new Set(["a", /* don't strip strings */ 'b'])
      function nested() { let TWO_KEYS = Object.freeze(['c']) }
    `, 'fixture')
    assert.deepEqual(sorted(found.keys()), ['ONE_KEYS', 'TWO_KEYS'])
    assert.deepEqual(readLiteralRoster(found.get('ONE_KEYS'), 'fixture'), ['a', 'b'])
    assert.deepEqual(readLiteralRoster(found.get('TWO_KEYS'), 'fixture'), ['c'])
    const destructured = scanKeyRosterDeclarations('const { keys: HIDDEN_KEYS, SHORTHAND_KEYS, UNBOUND_KEYS: ordinary = DEFAULT_KEYS, ...REST_KEYS } = object', 'fixture')
    assert.deepEqual(sorted(destructured.keys()), ['HIDDEN_KEYS', 'REST_KEYS', 'SHORTHAND_KEYS'])
    assert.ok(destructured.has('HIDDEN_KEYS'), 'destructured declaration escaped the sweep')
    assert.throws(() => readLiteralRoster(destructured.get('HIDDEN_KEYS'), 'fixture'), /REFUSE: fixture:/)
  })

  it('does not silently lose or combine malformed, missing or duplicate doc shapes', () => {
    assert.throws(() => readNestedProviderShapes(providers.replace('| `pricing` |', '| `removedField` |')), /expected one field table row/)
    assert.throws(() => readNestedProviderShapes(providers.replace('{ "url", "format" }', '{ "url", "url" }')), /unique string keys/)
    assert.throws(() => readConfigDiscoveryShape(config.replace('modelDiscovery: {', 'modelDiscovery: { "url": "duplicate",')), /duplicate modelDiscovery example keys/)
    checkDocs(rosters, config.replaceAll('\n', '\r\n'), providers.replaceAll('\n', '\r\n'))
  })

  it('refuses unreadable rosters, malformed sources, duplicates and lost doc anchors', () => {
    for (const expression of ["new Set(['url', ...extra])", "Object.freeze(['url', computed])", 'getKeys()', '[]', "['url', 'url']"]) {
      const found = scanKeyRosterDeclarations(`const BAD_KEYS = ${expression}`, 'fixture')
      assert.throws(() => readLiteralRoster(found.get('BAD_KEYS'), 'fixture'), /REFUSE: fixture:/)
    }
    assert.throws(() => scanKeyRosterDeclarations('const =', 'fixture'), /REFUSE: fixture: cannot parse/)
    assert.throws(() => scanKeyRosterDeclarations('const SAME_KEYS = []; function f() { const SAME_KEYS = [] }', 'fixture'), /duplicate roster SAME_KEYS/)
    assert.throws(() => readNestedProviderShapes(''), /REFUSE: docs\/providers.md:/)
    assert.throws(() => readConfigDiscoveryShape(config.replace('modelDiscovery: {', 'removedExample: {')), /expected one modelDiscovery object example/)
  })
})

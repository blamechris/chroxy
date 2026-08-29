import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as configModule from '../src/config.js'
import * as providersModule from '../src/anthropic-compatible-config.js'
import {
  extractTypeShapes,
  findConfigTableRow,
  findSchemaComment,
  findSection,
  parseRecognisedSubKeys,
  parseSupportedKeySets,
  parseWarnUnknownKeysCallSites,
  wordTokens,
} from './helpers/config-key-rosters.js'

/**
 * #7449 — CONFIG.md's sub-key rosters must be gated on the PRODUCER.
 *
 * Each nested config block is documented twice in CONFIG.md (a type shape in
 * its per-key table row, and a row in the "Recognised sub-keys" table the
 * unknown-key startup warning points operators at) and, for some blocks, a
 * third time in a config.js CONFIG_SCHEMA comment. All of those are hand-typed
 * lists beside a set that grows — the recurring class in
 * docs/false-safety-guards.md — and until this file nothing compared them.
 *
 * #7445 is the incident: it added `maxSurveysPerTick` to
 * SESSION_CI_SUPPORTED_KEYS and left all three sessionCi rosters stale. CI was
 * green throughout; the knob was accepted by the daemon and named in the
 * startup warning, but absent from the document operators are told to read.
 *
 * The expectations here are never hand-copied. They are the REAL exported Sets
 * (`import * as configModule`), so adding a key to a roster and not to the
 * document fails this file, and there is no second copy of the roster to drift.
 * A source parse also runs, but only to enumerate the DECLARATIONS and the
 * warnUnknownKeys call sites — that is what stops a brand-new roster from
 * escaping the registry below — and it is cross-checked against the runtime
 * Sets so it can never be quietly reading nothing.
 */

// block name (as the startup warning and CONFIG.md spell it) -> exported set.
// This mapping is hand-written, and it is the one thing here that COULD go
// stale — so it is closed from both ends below: every *_SUPPORTED_KEYS
// declaration in the two producer files must appear here, every warnUnknownKeys
// call site's (block, set) pair must match here, and the doc table's row set
// must equal this key set. A new block cannot be added to the code without one
// of those three going red.
const BLOCK_TO_SET_NAME = new Map([
  ['billing', 'BILLING_SUPPORTED_KEYS'],
  ['worktreeGc', 'WORKTREE_GC_SUPPORTED_KEYS'],
  ['sessionCi', 'SESSION_CI_SUPPORTED_KEYS'],
  ['userShell', 'USER_SHELL_SUPPORTED_KEYS'],
  ['environments.k8s', 'K8S_SUPPORTED_KEYS'],
  ['environments.rancher', 'RANCHER_SUPPORTED_KEYS'],
  ['notifications.discord', 'DISCORD_SUPPORTED_KEYS'],
  ['providers', 'PROVIDERS_SUPPORTED_KEYS'],
])

// `providers` is validated inline in anthropic-compatible-config.js (its own
// "Unknown key 'providers.x'" loop) rather than through config.js's shared
// warnUnknownKeys helper, so it has no call site to match. Pinned by name: if a
// SECOND block ever leaves the shared helper, that is a real divergence in how
// operators are warned and it should be looked at, not absorbed.
const BLOCKS_WITHOUT_WARN_CALL_SITE = ['providers']

// Blocks documented only by the Recognised sub-keys table. Both are nested
// under `environments`, which has one shared table row that does not enumerate
// per-backend keys, and neither heads a section of its own. Pinned so that a
// section added later is brought under the containment check deliberately
// rather than silently widening the unchecked surface.
const BLOCKS_WITH_NO_PROSE_REGION = ['environments.k8s', 'environments.rancher']

// Blocks whose CONFIG.md row carries a `{ name?: type }` shape, and whose
// config.js CONFIG_SCHEMA comment carries the same. Counted, not just iterated:
// a deleted shape would otherwise drop its check with the suite still green.
const BLOCKS_WITH_DOC_TYPE_SHAPE = ['worktreeGc', 'sessionCi', 'userShell']
const BLOCKS_WITH_SCHEMA_COMMENT_SHAPE = ['worktreeGc', 'sessionCi', 'userShell']

const sorted = it2 => [...it2].sort()

describe('CONFIG.md sub-key rosters vs config.js *_SUPPORTED_KEYS (#7449)', () => {
  let configSrc
  let providersSrc
  let md
  let declared
  let callSites
  let docTable
  /** @type {Map<string, string[]>} block -> the REAL exported Set's contents */
  const runtime = new Map()

  // .gitattributes pins the tree to LF, so this is belt-and-braces: a Windows
  // checkout with a local core.autocrlf override would otherwise leave a
  // trailing \r on every line and turn the whole gate into a REFUSE storm
  // (Server Windows Tests runs this file — it is not in WINDOWS_EXEMPT).
  const read = async rel => (await readFile(new URL(rel, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

  before(async () => {
    configSrc = await read('../src/config.js')
    providersSrc = await read('../src/anthropic-compatible-config.js')
    md = await read('../CONFIG.md')

    declared = new Map([
      ...parseSupportedKeySets(configSrc, 'config.js'),
      ...parseSupportedKeySets(providersSrc, 'anthropic-compatible-config.js'),
    ])
    callSites = parseWarnUnknownKeysCallSites(configSrc)
    docTable = parseRecognisedSubKeys(md)

    const exported = { ...configModule, ...providersModule }
    for (const [block, setName] of BLOCK_TO_SET_NAME) {
      const value = exported[setName]
      assert.ok(value instanceof Set, `${setName} is not an exported Set — the doc gate has nothing to compare against`)
      runtime.set(block, [...value])
    }
  })

  // ---- positive controls: the parses are reading something real ----

  it('parses a non-empty roster on every side', () => {
    // The count IS the subject on the first three: a block that vanishes from
    // any one side must force an edit here rather than shrinking the compared
    // set in silence.
    assert.equal(BLOCK_TO_SET_NAME.size, 8, 'expected exactly 8 documented sub-key blocks')
    assert.equal(declared.size, 8, `expected exactly 8 *_SUPPORTED_KEYS declarations, got ${sorted(declared.keys()).join(', ')}`)
    assert.equal(docTable.size, 8, `expected exactly 8 Recognised sub-keys rows, got ${sorted(docTable.keys()).join(', ')}`)
    assert.equal(callSites.length, 7, `expected exactly 7 warnUnknownKeys call sites, got ${callSites.length}`)
    for (const [block, keys] of runtime) {
      assert.ok(keys.length > 0, `${block}'s exported set is empty — nothing would be compared`)
    }
  })

  it('the source parse agrees with the exported Sets', () => {
    // Without this, a declaration-regex that stopped matching would leave the
    // registry checks quantifying over an empty map and reporting clean.
    for (const [block, setName] of BLOCK_TO_SET_NAME) {
      assert.deepEqual(
        sorted(declared.get(setName) ?? []),
        sorted(runtime.get(block)),
        `the parsed declaration of ${setName} differs from the exported Set — the source parse is stale`
      )
    }
  })

  // ---- the registry cannot go stale ----

  it('every declared *_SUPPORTED_KEYS roster is registered to a block', () => {
    const registered = new Set(BLOCK_TO_SET_NAME.values())
    const orphans = sorted(declared.keys()).filter(n => !registered.has(n))
    assert.deepEqual(
      orphans,
      [],
      `these rosters exist in code but are not gated against CONFIG.md — add them to BLOCK_TO_SET_NAME and to the Recognised sub-keys table: ${orphans.join(', ')}`
    )
    const phantoms = sorted(registered).filter(n => !declared.has(n))
    assert.deepEqual(phantoms, [], `BLOCK_TO_SET_NAME names rosters that no longer exist: ${phantoms.join(', ')}`)
  })

  it('every warnUnknownKeys call site advertises its registered roster', () => {
    for (const { block, setName } of callSites) {
      assert.equal(
        BLOCK_TO_SET_NAME.get(block),
        setName,
        `warnUnknownKeys warns operators about '${block}' using ${setName}, which is not what this gate compares CONFIG.md against`
      )
    }
    const warned = new Set(callSites.map(s => s.block))
    const unwarned = sorted(BLOCK_TO_SET_NAME.keys()).filter(b => !warned.has(b))
    assert.deepEqual(
      unwarned,
      BLOCKS_WITHOUT_WARN_CALL_SITE,
      'the set of blocks not using the shared warnUnknownKeys helper changed'
    )
  })

  // ---- roster 1: the Recognised sub-keys table (the startup warning's doc) ----

  it('the Recognised sub-keys table lists exactly the blocks that have rosters', () => {
    assert.deepEqual(sorted(docTable.keys()), sorted(BLOCK_TO_SET_NAME.keys()))
  })

  it('every Recognised sub-keys row matches its roster exactly', () => {
    for (const [block, documented] of docTable) {
      assert.deepEqual(
        sorted(documented),
        sorted(runtime.get(block)),
        `CONFIG.md's "Recognised sub-keys" row for \`${block}\` disagrees with its *_SUPPORTED_KEYS set — ` +
          'a key added to code but not documented is undiscoverable in the exact table the unknown-key warning points at (#7445)'
      )
      const dupes = documented.filter((k, i) => documented.indexOf(k) !== i)
      assert.deepEqual(dupes, [], `duplicate keys in the \`${block}\` row: ${dupes.join(', ')}`)
    }
  })

  // ---- roster 2: the per-key type shapes ----

  it("CONFIG.md's per-key type shapes match their rosters", () => {
    const withShape = []
    for (const block of BLOCK_TO_SET_NAME.keys()) {
      const row = findConfigTableRow(md, block)
      if (!row) continue
      const shapes = extractTypeShapes(row)
      if (shapes.length === 0) continue
      assert.equal(shapes.length, 1, `\`${block}\`'s CONFIG.md row carries ${shapes.length} type shapes — ambiguous`)
      withShape.push(block)
      assert.deepEqual(
        sorted(shapes[0]),
        sorted(runtime.get(block)),
        `CONFIG.md's type shape for \`${block}\` disagrees with its *_SUPPORTED_KEYS set (this is CONFIG.md:169 in #7449)`
      )
    }
    assert.deepEqual(
      sorted(withShape),
      sorted(BLOCKS_WITH_DOC_TYPE_SHAPE),
      'the set of blocks documented by a `{ name?: type }` shape changed — a deleted shape silently drops its own check'
    )
  })

  it("config.js's own CONFIG_SCHEMA comments match their rosters", () => {
    // The third copy #7449 names (config.js:185): the shape is repeated in the
    // comment above `<block>: 'object',`. Dotted blocks are skipped — their
    // parent's comment is not their roster.
    const withShape = []
    for (const block of BLOCK_TO_SET_NAME.keys()) {
      if (block.includes('.')) continue
      const comment = findSchemaComment(configSrc, block)
      if (!comment) continue
      const shapes = extractTypeShapes(comment)
      if (shapes.length === 0) continue
      assert.equal(shapes.length, 1, `\`${block}\`'s CONFIG_SCHEMA comment carries ${shapes.length} type shapes — ambiguous`)
      withShape.push(block)
      assert.deepEqual(
        sorted(shapes[0]),
        sorted(runtime.get(block)),
        `the CONFIG_SCHEMA comment for \`${block}\` disagrees with its *_SUPPORTED_KEYS set`
      )
    }
    assert.deepEqual(
      sorted(withShape),
      sorted(BLOCKS_WITH_SCHEMA_COMMENT_SHAPE),
      'the set of CONFIG_SCHEMA comments carrying a type shape changed'
    )
  })

  // ---- roster 3: the prose the type shape lives in ----

  it("every supported key is mentioned in its block doc region", () => {
    const withoutRegion = []
    for (const block of BLOCK_TO_SET_NAME.keys()) {
      const region = findConfigTableRow(md, block) ?? findSection(md, block)
      if (!region) { withoutRegion.push(block); continue }
      const tokens = wordTokens(region)
      const missing = runtime.get(block).filter(k => !tokens.has(k))
      assert.deepEqual(
        missing,
        [],
        `CONFIG.md's prose for \`${block}\` never mentions ${missing.join(', ')} — supported but undocumented outside the roster table`
      )
    }
    assert.deepEqual(
      sorted(withoutRegion),
      sorted(BLOCKS_WITH_NO_PROSE_REGION),
      'the set of blocks with no prose doc region changed — a lost region drops its containment check'
    )
  })

  // ---- the #7445 incident itself, pinned by name ----

  it('carries the keys whose omission motivated the gate', () => {
    assert.ok(
      runtime.get('sessionCi').includes('maxSurveysPerTick'),
      'sessionCi must still carry maxSurveysPerTick — the #7436 knob whose three stale rosters are why this file exists'
    )
    assert.ok(
      runtime.get('userShell').includes('requireApproval'),
      'userShell must still carry requireApproval — omitted from its CONFIG_SCHEMA type shape until #7449'
    )
  })
})

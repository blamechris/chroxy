import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import * as configModule from '../src/config.js'
import * as providersModule from '../src/anthropic-compatible-config.js'
import * as acpModule from '../src/acp-config.js'
import {
  extractEntryShapes,
  extractTypeShapes,
  findConfigTableRow,
  claimedSubKeyTokens,
  GENERIC_BACKTICK_LITERALS,
  findSchemaComment,
  findSection,
  parseFeaturesInventories,
  parseKeySets,
  parseRecognisedSubKeys,
  parseSupportedKeySets,
  parseWarnUnknownKeysCallSites,
  scanFeatureReads,
  sliceBetween,
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
 *
 * The declaration sweep walks EVERY `*.js` under `packages/server/src/`, and
 * that breadth is the point (#7510 review). It first read a hand-written list
 * of two producer files — which was the same hardcoded-list-beside-a-growing-
 * set defect this file exists to kill, one level up. `providers` is the living
 * proof that rosters migrate out of config.js, and the review demonstrated it:
 * a `SUMMARIZE_SUPPORTED_KEYS` set added to acp-config.js, validated inline
 * exactly the way `providers` is, was entirely invisible — 10 pass, exit 0.
 *
 * Two consequences of the breadth, stated rather than discovered later:
 * `packages/server/src/` is the scope, so a roster placed OUTSIDE it is still
 * unseen; and a roster whose literal cannot be read (a spread, a computed Set)
 * anywhere under `src/` REFUSES the whole gate instead of being skipped. Both
 * are the right direction — loud beats silent — but they are real.
 */

// block name (as the startup warning and CONFIG.md spell it) -> exported set.
// This mapping is hand-written, and it is the one thing here that COULD go
// stale — so it is closed from both ends below: every *_SUPPORTED_KEYS
// declaration ANYWHERE under packages/server/src/ must appear here, every
// warnUnknownKeys call site's (block, set) pair must match here, and the doc
// table's row set must equal this key set. A new block cannot be added under
// src/ without one of those three going red.
const BLOCK_TO_SET_NAME = new Map([
  ['billing', 'BILLING_SUPPORTED_KEYS'],
  ['worktreeGc', 'WORKTREE_GC_SUPPORTED_KEYS'],
  ['orphanReap', 'ORPHAN_REAP_SUPPORTED_KEYS'],
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
const BLOCKS_WITH_DOC_TYPE_SHAPE = ['worktreeGc', 'orphanReap', 'sessionCi', 'userShell']
const BLOCKS_WITH_SCHEMA_COMMENT_SHAPE = ['worktreeGc', 'orphanReap', 'sessionCi', 'userShell']

// #7547 — the provider ENTRY level, one nesting step below `providers`. An entry
// is an array element, not a config block, so these rosters are NOT
// `*_SUPPORTED_KEYS` (no "Recognised sub-keys" row, no warnUnknownKeys call
// site); they are swept by their own `*_ENTRY_KEYS` suffix and compared against
// the entry shape CONFIG.md writes on the `providers` row.
//
// roster const name -> the exported Set it must resolve to. Closed from both
// ends like BLOCK_TO_SET_NAME: every `*_ENTRY_KEYS` declaration under src/ must
// be registered here, and every name here must still be declared.
const ENTRY_ROSTERS = new Map([
  ['COMPATIBLE_ENTRY_KEYS', () => providersModule.COMPATIBLE_ENTRY_KEYS],
  ['ACP_ENTRY_KEYS', () => acpModule.ACP_ENTRY_KEYS],
])

// Where the `providers` row documents each entry. Each segment runs from one
// sub-block's backticked name to the next, so it carries exactly that
// sub-block's entry shape. `openaiCompatible` writes no shape of its own — it
// says its entries are the identical shape. That sentence is only true while
// both blocks resolve to ONE roster, so a segment that relies on it names the
// segment it claims to equal (`sameAs`) and the test asserts the two rosters are
// the same Set — a divergent roster forces the doc off the sentence (#7547
// review S1). An explicit shape added there later is compared too.
const ENTRY_DOC_SEGMENTS = [
  { label: 'providers.anthropicCompatible', roster: 'COMPATIBLE_ENTRY_KEYS', from: '`providers.anthropicCompatible`', to: '`providers.openaiCompatible`', shape: 'required' },
  { label: 'providers.openaiCompatible', roster: 'COMPATIBLE_ENTRY_KEYS', from: '`providers.openaiCompatible`', to: '`providers.acp`', shape: 'identical-or-explicit', sameAs: 'providers.anthropicCompatible' },
  { label: 'providers.acp', roster: 'ACP_ENTRY_KEYS', from: '`providers.acp`', to: '`providers.allowAnyModel`', shape: 'required' },
]

// The three entry validators, the roster each enforces, and the exact text of its
// unknown-key condition (see the SOURCE check in the registry test).
const ENTRY_VALIDATORS = [
  { label: 'anthropicCompatible', validate: providersModule.validateAnthropicCompatibleProviders, roster: 'COMPATIBLE_ENTRY_KEYS', file: 'anthropic-compatible-config.js', expected: '!COMPATIBLE_ENTRY_KEYS.has(key) && !FORBIDDEN_SECRET_KEYS.includes(key)' },
  { label: 'openaiCompatible', validate: providersModule.validateOpenAiCompatibleProviders, roster: 'COMPATIBLE_ENTRY_KEYS', file: 'anthropic-compatible-config.js', expected: '!COMPATIBLE_ENTRY_KEYS.has(key) && !FORBIDDEN_SECRET_KEYS.includes(key)' },
  { label: 'acp', validate: acpModule.validateAcpProviders, roster: 'ACP_ENTRY_KEYS', file: 'acp-config.js', expected: '!ACP_ENTRY_KEYS.has(key)' },
]
// The entry-level unknown-key loop: `for (const key of Object.keys(raw)) { if (<cond>) { warnings.push(`Unknown key '${path}.${key}'`
const UNKNOWN_ENTRY_KEY_LOOP_RE = /for \(const key of Object\.keys\(raw\)\) \{\s*if \(([^\n]*)\) \{\s*warnings\.push\(`Unknown key '\$\{path\}\.\$\{key\}'/g

const sorted = it2 => [...it2].sort()

const SRC_ROOT = new URL('../src/', import.meta.url)

/** Every `*.js` under packages/server/src/, recursively. */
async function collectSourceFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...(await collectSourceFiles(new URL(`${entry.name}/`, dir))))
    } else if (entry.name.endsWith('.js')) {
      found.push(new URL(entry.name, dir))
    }
  }
  return found
}

describe('CONFIG.md sub-key rosters vs config.js *_SUPPORTED_KEYS (#7449)', () => {
  let configSrc
  let md
  let declared
  let declaredIn
  let entryDeclared
  let entryDeclaredIn
  let srcFiles
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
    md = await read('../CONFIG.md')

    // The declaration sweep: every source file, not a list of the two that
    // happen to hold a roster today (#7510 review, finding 1).
    srcFiles = (await collectSourceFiles(SRC_ROOT)).sort((a, b) => (a.href < b.href ? -1 : 1))
    declared = new Map()
    declaredIn = new Map()
    entryDeclared = new Map()
    entryDeclaredIn = new Map()
    for (const file of srcFiles) {
      const rel = decodeURIComponent(file.href.slice(SRC_ROOT.href.length))
      const text = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n')
      // Cheap prefilters: parseKeySets REFUSEs on a file with zero
      // declarations, which is almost every file here.
      if (/_SUPPORTED_KEYS\s*=/.test(text)) {
        for (const [name, keys] of parseSupportedKeySets(text, `src/${rel}`)) {
          if (declared.has(name)) {
            throw new Error(`REFUSE: ${name} is declared in two files: src/${declaredIn.get(name)} and src/${rel}`)
          }
          declared.set(name, keys)
          declaredIn.set(name, rel)
        }
      }
      if (/_ENTRY_KEYS\s*=/.test(text)) {
        for (const [name, keys] of parseKeySets(text, `src/${rel}`, '_ENTRY_KEYS')) {
          if (entryDeclared.has(name)) {
            throw new Error(`REFUSE: ${name} is declared in two files: src/${entryDeclaredIn.get(name)} and src/${rel}`)
          }
          entryDeclared.set(name, keys)
          entryDeclaredIn.set(name, rel)
        }
      }
    }
    callSites = parseWarnUnknownKeysCallSites(configSrc)
    docTable = parseRecognisedSubKeys(md)

    const exported = { ...configModule, ...providersModule }
    for (const [block, setName] of BLOCK_TO_SET_NAME) {
      const value = exported[setName]
      assert.ok(
        value instanceof Set,
        `${setName} is not an exported Set — the doc gate has nothing to compare against. ` +
          'If the roster moved to another module, add that module to the namespace imports at the top of this file ' +
          '(the src/ sweep finds the DECLARATION; the runtime value still has to be importable).'
      )
      runtime.set(block, [...value])
    }
  })

  // ---- positive controls: the parses are reading something real ----

  it('parses a non-empty roster on every side', () => {
    // The count IS the subject on the first three: a block that vanishes from
    // any one side must force an edit here rather than shrinking the compared
    // set in silence.
    assert.equal(BLOCK_TO_SET_NAME.size, 9, 'expected exactly 9 documented sub-key blocks')
    assert.equal(declared.size, 9, `expected exactly 9 *_SUPPORTED_KEYS declarations, got ${sorted(declared.keys()).join(', ')}`)
    assert.equal(docTable.size, 9, `expected exactly 9 Recognised sub-keys rows, got ${sorted(docTable.keys()).join(', ')}`)
    assert.equal(callSites.length, 8, `expected exactly 8 warnUnknownKeys call sites, got ${callSites.length}`)
    // Floor the NESTED files, not the total. A total floor reads like a guard
    // against a sweep that stopped recursing and is inert against exactly that:
    // src/ has 189 top-level .js files of 317, so deleting the recursive branch
    // leaves 189 — over any plausible total floor, and green (#7510 review;
    // measured: the >= 100 total floor fired at 60, never at 189). This is the
    // comment-describes-a-stronger-check-than-the-code class in
    // docs/false-safety-guards.md, inside the positive control meant to prevent
    // it. A floor rather than an exact pin, deliberately: the file count is not
    // the subject and pinning it would misattribute unrelated refactors.
    const nestedFiles = srcFiles.filter(f => f.href.slice(SRC_ROOT.href.length).includes('/'))
    assert.ok(
      nestedFiles.length >= 50,
      `the src/ sweep found only ${nestedFiles.length} files in SUBDIRECTORIES (${srcFiles.length} total) — ` +
        'it is not recursing, so every roster below src/ is invisible to this gate'
    )
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
      'these rosters exist under packages/server/src/ but are not gated against CONFIG.md — add them to ' +
        `BLOCK_TO_SET_NAME and to the Recognised sub-keys table: ${orphans.map(n => `${n} (src/${declaredIn.get(n)})`).join(', ')}`
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
      sorted(BLOCKS_WITHOUT_WARN_CALL_SITE),
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

  // ---- roster 3b: the REVERSE direction (#7514) ----

  // Tokens that share the bare-identifier shape but are NOT key claims, per
  // region: enum VALUES and similar prose. Every entry must actually appear in
  // its region (stale entries fail — the #7489 allowlist discipline), and the
  // block's own name is excluded structurally for all blocks.
  const REGION_NON_KEY_TOKENS = new Map([
    // billing plan classes are values of `class`, not sub-keys
    ['billing', ['pro', 'max5x', 'max20x']],
    // apiKeyEnv/credentialsKey/baseUrl are entry-level keys one nesting BELOW
    // this roster (validated by COMPATIBLE_ENTRY_KEYS in anthropic-compatible-
    // config, and gated against the `providers` row's entry shapes by the
    // #7547 tests below); `provider` is the TOP-LEVEL CONFIG_SCHEMA key cross-referenced
    // here (#7545 review F3 corrected the original entry-level claim). With
    // all four excluded plus the own-name rule this region contributes ZERO
    // claims — recorded in REGION_MIN_CLAIMS below as explicitly vacuous; the
    // FORWARD check still covers it.
    ['providers', ['provider', 'apiKeyEnv', 'credentialsKey', 'baseUrl']],
  ])

  it('every key the prose CLAIMS exists on the producer', () => {
    // The forward check above proves supported keys are documented; this one
    // proves the doc cannot keep describing a key the producer has DROPPED
    // (#7514 — the half #7449 deliberately left loose). Key claims are the
    // bare lower-camel backticked tokens; see claimedSubKeyTokens for why
    // paths/env vars/examples are structurally outside the claim shape.
    const claimedPerBlock = new Map()
    for (const block of BLOCK_TO_SET_NAME.keys()) {
      const region = findConfigTableRow(md, block) ?? findSection(md, block)
      if (!region) continue
      const nonKeys = new Set(REGION_NON_KEY_TOKENS.get(block) ?? [])
      for (const t of nonKeys) {
        assert.ok(
          region.includes('`' + t + '`'),
          `REGION_NON_KEY_TOKENS entry '${t}' for \`${block}\` no longer appears in its region — stale exclusion`
        )
      }
      const ownName = block.split('.').pop()
      const claimed = [...claimedSubKeyTokens(region)]
        .filter(k => k !== ownName && !nonKeys.has(k))
      const supported = new Set(runtime.get(block))
      const phantom = claimed.filter(k => !supported.has(k))
      claimedPerBlock.set(block, claimed.length)
      assert.deepEqual(
        phantom,
        [],
        `CONFIG.md's prose for \`${block}\` cites ${phantom.join(', ')} as sub-keys the producer no longer supports`
      )
    }
    // Positive control, PER REGION: a single total floor was proven inert
    // against losing 5 of 6 regions (#7545 review F2 — discord's 13 claims
    // met it alone; the same concentration trap the #7510 review caught 190
    // lines above). Floors, not exact pins: the count is not the subject,
    // but losing any one region's extraction must trip its own row.
    const REGION_MIN_CLAIMS = new Map([
      ['billing', 3], ['worktreeGc', 2], ['orphanReap', 2], ['sessionCi', 3],
      ['userShell', 1], ['notifications.discord', 8], ['providers', 0],
    ])
    for (const [block, min] of REGION_MIN_CLAIMS) {
      assert.ok(
        (claimedPerBlock.get(block) ?? 0) >= min,
        `region \`${block}\` yielded ${claimedPerBlock.get(block) ?? 0} claims, expected >=${min} — its extraction has degraded`
      )
    }
    assert.deepEqual(
      sorted([...claimedPerBlock.keys()]),
      sorted([...REGION_MIN_CLAIMS.keys()]),
      'the set of regions contributing to the reverse check changed — update REGION_MIN_CLAIMS deliberately'
    )
    // F1 staleness: every generic literal must appear backticked in some gated
    // region, or it is a stale entry widening the evasion surface.
    const allRegions = [...BLOCK_TO_SET_NAME.keys()]
      .map(b => findConfigTableRow(md, b) ?? findSection(md, b))
      .filter(Boolean)
      .join('\n')
    for (const lit of GENERIC_BACKTICK_LITERALS) {
      assert.ok(
        allRegions.includes('`' + lit + '`'),
        `GENERIC_BACKTICK_LITERALS entry '${lit}' appears backticked in no gated region — stale, remove it`
      )
    }
  })

  // ---- the provider ENTRY level (#7547) ----

  // The entry level has the same two documents (CONFIG.md's `providers` row
  // writes `{ id, label?, baseUrl, ... }` for each sub-block) and the same
  // hand-typed-list-beside-a-growing-set defect: `modelDiscovery` (#5548) joined
  // the roster and never reached the row. The expectations are the REAL exported
  // Sets; only the doc side is parsed.

  it('the entry rosters are registered, and each one is what the validators enforce', async () => {
    // Registry closed from both ends, as for the block rosters.
    const orphans = sorted(entryDeclared.keys()).filter(n => !ENTRY_ROSTERS.has(n))
    assert.deepEqual(
      orphans,
      [],
      'these *_ENTRY_KEYS rosters exist under packages/server/src/ but are not gated against CONFIG.md — add them to ' +
        `ENTRY_ROSTERS and ENTRY_DOC_SEGMENTS: ${orphans.map(n => `${n} (src/${entryDeclaredIn.get(n)})`).join(', ')}`
    )
    const phantoms = sorted(ENTRY_ROSTERS.keys()).filter(n => !entryDeclared.has(n))
    assert.deepEqual(phantoms, [], `ENTRY_ROSTERS names rosters that no longer exist: ${phantoms.join(', ')}`)
    // The source parse and the exported value agree (the parse is only an
    // enumeration; a regex that quietly stopped matching must not look clean).
    for (const [name, get] of ENTRY_ROSTERS) {
      const value = get()
      assert.ok(value instanceof Set && value.size > 0, `${name} is not an exported non-empty Set — nothing to compare`)
      assert.deepEqual(sorted(entryDeclared.get(name)), sorted(value), `the parsed declaration of ${name} differs from its exported Set`)
    }
    // Two halves, because neither alone is enough:
    //  1. The PROBE proves exported ⊆ accepted — every roster key passes the
    //     validator's unknown-key check and an invented key does not. It cannot
    //     see a validator-private extra (`&& key !== 'secretExtra'`), which makes
    //     accepted ⊋ exported and stays green.
    //  2. The SOURCE check below proves accepted ⊆ exported — the unknown-key
    //     condition in each validator's source is exactly the exported roster
    //     (plus the one documented secret-key carve-out), nothing else. Together:
    //     accepted === exported, so the roster compared against CONFIG.md is the
    //     set the daemon actually enforces (#7547 review S2).
    const probe = (validate, key) => {
      const { warnings } = validate([{ id: 'zz-entry-probe', baseUrl: 'http://localhost:1', defaultModel: 'm', command: 'x', [key]: 1 }])
      return warnings.some(w => w.includes(`Unknown key`) && w.includes(`.${key}'`))
    }
    // Every registered entry roster must have at least one validator row, or a new
    // roster would be documented and swept but never probed or source-checked.
    const validated = new Set(ENTRY_VALIDATORS.map(v => v.roster))
    const unvalidated = sorted(ENTRY_ROSTERS.keys()).filter(n => !validated.has(n))
    assert.deepEqual(unvalidated, [], `ENTRY_ROSTERS has rosters with no ENTRY_VALIDATORS row: ${unvalidated.join(', ')}`)
    for (const { label, validate, roster } of ENTRY_VALIDATORS) {
      assert.equal(probe(validate, 'zzNotAnEntryKey'), true, `${label}: an invented entry key did not warn — the probe cannot detect the roster`)
      const rejected = [...ENTRY_ROSTERS.get(roster)()].filter(k => probe(validate, k))
      assert.deepEqual(rejected, [], `${label}'s validator warns "Unknown key" for ${roster} members: ${rejected.join(', ')}`)
    }
    const conditions = new Map()
    for (const { file, expected } of ENTRY_VALIDATORS) {
      if (conditions.has(file)) continue
      const text = (await readFile(new URL(file, SRC_ROOT), 'utf8')).replace(/\r\n/g, '\n')
      const found = [...text.matchAll(UNKNOWN_ENTRY_KEY_LOOP_RE)].map(m => m[1].trim())
      assert.equal(found.length, 1, `src/${file}: expected exactly 1 entry-level unknown-key loop, found ${found.length} (shape changed?)`)
      conditions.set(file, found[0])
      assert.ok(
        found[0] === expected,
        `src/${file}: the unknown-key condition is \`${found[0]}\`, expected \`${expected}\` — a validator-private key ` +
          'would be accepted without being in the exported roster, so CONFIG.md would be gated against a set the daemon does not enforce'
      )
    }
  })

  it("CONFIG.md's `providers` row documents exactly the keys each entry roster accepts", () => {
    const row = findConfigTableRow(md, 'providers')
    assert.ok(row, 'CONFIG.md has no per-key table row for `providers`')
    const checked = []
    for (const seg of ENTRY_DOC_SEGMENTS) {
      assert.ok(ENTRY_ROSTERS.has(seg.roster), `${seg.label}: segment names unknown roster ${seg.roster}`)
      const text = sliceBetween(row, seg.from, seg.to)
      const shapes = extractEntryShapes(text)
      const runtimeKeys = sorted(ENTRY_ROSTERS.get(seg.roster)())
      if (shapes.length === 0 && seg.shape === 'identical-or-explicit') {
        // No shape of its own: the claim "identical" must still be written, and
        // is true by construction (one validator, one roster — pinned above).
        assert.ok(
          /identical entry shape/.test(text),
          `${seg.label} documents neither an entry shape nor "the identical entry shape" — its entries are undocumented`
        )
        const other = ENTRY_DOC_SEGMENTS.find(o => o.label === seg.sameAs)
        assert.ok(other, `${seg.label} says "identical" but names no segment it equals (sameAs=${seg.sameAs})`)
        assert.ok(
          ENTRY_ROSTERS.get(seg.roster)() === ENTRY_ROSTERS.get(other.roster)(),
          `${seg.label} says "the identical entry shape" but resolves to ${seg.roster}, not ${other.label}'s ${other.roster} — ` +
            'the sentence is false; document its own entry shape'
        )
        checked.push(`${seg.label}:identical`)
        continue
      }
      assert.equal(shapes.length, 1, `${seg.label}'s segment of the \`providers\` row carries ${shapes.length} entry shapes — expected exactly 1`)
      const documented = sorted(shapes[0].names)
      const undocumented = runtimeKeys.filter(k => !documented.includes(k))
      const phantom = documented.filter(k => !runtimeKeys.includes(k))
      assert.deepEqual(
        undocumented,
        [],
        `CONFIG.md's entry shape for ${seg.label} never lists ${undocumented.join(', ')} — accepted by ${seg.roster} but undocumented (#7547)`
      )
      assert.deepEqual(
        phantom,
        [],
        `CONFIG.md's entry shape for ${seg.label} lists ${phantom.join(', ')}, which ${seg.roster} does not accept`
      )
      const dupes = shapes[0].names.filter((k, i) => shapes[0].names.indexOf(k) !== i)
      assert.deepEqual(dupes, [], `duplicate keys in ${seg.label}'s entry shape: ${dupes.join(', ')}`)
      checked.push(`${seg.label}:shape`)
    }
    // Counted: a segment that lost its shape (and so its check) must force an
    // edit here instead of shrinking the compared set in silence.
    assert.deepEqual(
      checked,
      ['providers.anthropicCompatible:shape', 'providers.openaiCompatible:identical', 'providers.acp:shape'],
      'the set of entry shapes CONFIG.md documents changed'
    )
  })

  it('carries the entry key whose omission motivated the entry gate', () => {
    assert.ok(
      providersModule.COMPATIBLE_ENTRY_KEYS.has('modelDiscovery'),
      'COMPATIBLE_ENTRY_KEYS must still carry modelDiscovery — the #5548 knob that was missing from CONFIG.md until #7547'
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

/**
 * #7032 — CONFIG.md's `features` inventory must be gated on the PRODUCER.
 *
 * #6997 and #7010 each added a `features` inventory to CONFIG.md and merged ~33
 * minutes apart, neither aware of the other: two inventories each missing a flag
 * the other had, and an "All three are fail-closed" sentence that no longer
 * matched. #7031 reconciled it by hand with a checker that was never committed,
 * so the next pair of concurrent PRs would have drifted silently again.
 *
 * Producer = every `features.<flag> === true` gate under packages/server/src/,
 * found by PARSING every file there (acorn) and walking the AST — not by regex
 * over text, which twice silently blanked real code on a regex literal holding a
 * quote or backtick (#8563 review). Consumers = the three places CONFIG.md lists
 * the flags, and the two places it counts them. Every direction is checked, a
 * sweep that finds no gate REFUSES, a file that does not parse REFUSES, and any
 * OTHER use of `features` (a spelling that is not an `=== true` gate) is a
 * failure unless exempted below — so a gate written differently cannot be
 * invisible to the doc comparison.
 *
 * `checkFeatures` is pure over (sources, markdown): the real tree is one input,
 * and the regression tests below feed it the review's mutants as in-memory
 * fixtures, so the check is proven red against the real implementation without
 * editing src/.
 */

// Uses of the word `features` under src/ that are not gates and not benign
// writes. Keyed by file + a STRUCTURAL description (descriptor from the AST +
// the enclosing function) with the exact number of occurrences; an entry that no
// longer matches EXACTLY fails as stale, so this list cannot outlive the code it
// excuses. Grow it with the reason in hand, never by loosening the scan.
const FEATURES_READ_EXEMPTIONS = [
  { file: 'config.js', descriptor: 'identifier:key-property', context: '<module>', count: 1, reason: 'CONFIG_SCHEMA key declaration, not a read of config.features' },
  { file: 'config.js', descriptor: 'member:UnaryExpression(!)', context: 'writeSchedulerEnabledToConfig', count: 1, reason: 'shape check on the persisted config before writing features.scheduler; reads no flag' },
  { file: 'config.js', descriptor: 'member:UnaryExpression(typeof)', context: 'writeSchedulerEnabledToConfig', count: 1, reason: 'shape check on the persisted config before writing features.scheduler; reads no flag' },
  { file: 'config.js', descriptor: 'member:CallExpression', context: 'writeSchedulerEnabledToConfig', count: 1, reason: 'Array.isArray shape check on the persisted config; reads no flag' },
  { file: 'handlers/scheduler-handlers.js', descriptor: 'member:UnaryExpression(!)', context: 'handleSetSchedulerEnabled', count: 1, reason: 'shape check before writing features.scheduler; reads no flag' },
  { file: 'handlers/scheduler-handlers.js', descriptor: 'member:UnaryExpression(typeof)', context: 'handleSetSchedulerEnabled', count: 1, reason: 'shape check before writing features.scheduler; reads no flag' },
  { file: 'ws-history.js', descriptor: 'identifier:declaration', context: 'sendPostAuthInfo', count: 1, reason: 'a local variable named features, unrelated to config.features' },
  { file: 'ws-history.js', descriptor: 'identifier:shorthand-property', context: 'sendPostAuthInfo', count: 1, reason: 'the same local variable as a shorthand property' },
]

/**
 * Compare CONFIG.md against the gates in `sources` (rel path -> text).
 * @returns {{ gates: Map<string, {file: string, line: number, envs: string[]}[]>, problems: {kind: string, message: string}[] }}
 */
function checkFeatures(sources, markdown) {
  const gates = new Map()
  const unrecognised = []
  for (const [file, text] of sources) {
    const found = scanFeatureReads(text, `src/${file}`)
    for (const g of found.gates) gates.set(g.flag, [...(gates.get(g.flag) ?? []), { file, line: g.line, envs: g.envs }])
    for (const u of found.unrecognised) unrecognised.push({ file, ...u })
  }
  // The "cannot find any" case is the false-safety one: comparing the doc to an
  // empty set of gates passes every direction below.
  if (gates.size === 0) {
    throw new Error('REFUSE: found no `features.<flag> === true` gate anywhere under packages/server/src/ — the gate shape changed, so there is nothing to compare CONFIG.md against')
  }
  const inv = parseFeaturesInventories(markdown)
  const problems = []
  const add = (kind, message) => problems.push({ kind, message })

  const left = unrecognised.map(u => ({ ...u }))
  for (const ex of FEATURES_READ_EXEMPTIONS) {
    const hit = left.filter(u => u.file === ex.file && u.descriptor === ex.descriptor && u.context === ex.context)
    if (hit.length !== ex.count) {
      add('stale-exemption', `stale exemption: ${ex.file} ${ex.descriptor} in ${ex.context} matches ${hit.length} use(s), expected ${ex.count} (${ex.reason})`)
    }
    for (const u of hit) left.splice(left.indexOf(u), 1)
  }
  for (const u of left) add('shape', `gate shape not recognised: ${u.file}:${u.line}  ${u.descriptor} in ${u.context}`)

  const flags = sorted(gates.keys())
  for (const [label, kind, documented] of [
    ['the `features` row of the per-key table', 'key-row', inv.keyRow.flags],
    ['the "Opt-in features" table', 'opt-in', inv.optIn.flags],
  ]) {
    for (const f of flags.filter(f => !documented.has(f))) add(kind, `CONFIG.md's ${label} never lists features.${f}, which src/ gates (#6997/#7010 drift)`)
    for (const f of sorted(documented).filter(f => !gates.has(f))) add(kind, `CONFIG.md's ${label} lists features.${f}, which no gate in src/ reads`)
  }

  // Per flag, not as sets: swapping two rows' envs must fail, and an env a gate
  // reads that no row documents must fail. EVERY function that gates the flag
  // must read exactly the documented env, so a second gate site cannot mask a
  // broken one.
  for (const [flag, sites] of gates) {
    const documented = inv.optIn.pairs.get(flag)
    if (!documented) { add('env', `features.${flag} is gated in src/ but has no row in the Opt-in features table`); continue }
    for (const site of sites) {
      if (JSON.stringify(site.envs) !== JSON.stringify(documented)) {
        add('env', `features.${flag} at ${site.file}:${site.line} reads env [${site.envs.join(', ')}] in its function but CONFIG.md documents [${documented.join(', ')}]`)
      }
    }
  }
  // The other two env lists carry names, not flag -> env pairs; compare to the union.
  for (const [label, envs] of [['"Direct reads" list', inv.directReads.envs], ['key-row env column', inv.keyRow.envs]]) {
    if (JSON.stringify(sorted(envs)) !== JSON.stringify(sorted(inv.optIn.envs))) {
      add('env-sets', `CONFIG.md's ${label} names [${sorted(envs).join(', ')}] but the Opt-in table names [${sorted(inv.optIn.envs).join(', ')}]`)
    }
  }
  if (inv.optIn.numeral !== gates.size) add('numeral', `"All N are fail-closed" says ${inv.optIn.numeral} but src/ gates ${gates.size} flags (${flags.join(', ')})`)
  if (inv.directReads.numeral !== gates.size) add('numeral', `the "Direct reads" list says "the ${inv.directReads.numeral} features gates" but src/ gates ${gates.size} flags`)
  return { gates, problems }
}

describe('CONFIG.md features inventory vs the features.<flag> gates in src (#7032)', () => {
  let md
  let sources // rel path -> text, EVERY *.js under src/
  let real // checkFeatures over the real tree

  before(async () => {
    md = (await readFile(new URL('../CONFIG.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
    sources = new Map()
    for (const file of await collectSourceFiles(SRC_ROOT)) {
      const rel = decodeURIComponent(file.href.slice(SRC_ROOT.href.length))
      sources.set(rel, (await readFile(file, 'utf8')).replace(/\r\n/g, '\n'))
    }
    // Parses EVERY file (no prefilter) and REFUSES on one it cannot read.
    real = checkFeatures(sources, md)
  })

  const ofKind = (result, kind) => result.problems.filter(p => p.kind === kind).map(p => p.message)

  /** `text` with `from` replaced by `to`; fails if `from` is not found exactly once (a silent no-op mutant proves nothing). */
  const mutate = (text, from, to) => {
    assert.equal(text.split(from).length - 1, 1, `mutation anchor ${JSON.stringify(from)} must occur exactly once`)
    return text.replace(from, () => to)
  }
  /** The real tree plus/minus in-memory edits. */
  const withSources = edits => {
    const m = new Map(sources)
    for (const [file, text] of Object.entries(edits)) m.set(file, typeof text === 'function' ? text(m.get(file)) : text)
    return m
  }
  const fixtureGate = body => withSources({ '_fixture.js': body })

  // ---- the real tree ----

  it('parses every file under src/ and finds the gates it is meant to guard (positive control)', () => {
    assert.ok(sources.size >= 300, `only ${sources.size} files collected under src/`)
    for (const known of ['config.js', 'handlers/scheduler-handlers.js', 'ws-history.js', 'cli/schedule-cmd.js']) {
      assert.ok(sources.has(known), `${known} is not in the sweep`)
    }
    for (const flag of ['ide', 'orchestration', 'scheduler', 'semanticTitles']) {
      assert.ok(real.gates.has(flag), `the sweep no longer finds the features.${flag} gate — it is not reading src/`)
    }
    const files = new Set(real.gates.get('scheduler').map(g => g.file))
    assert.ok(files.size >= 2, 'features.scheduler is gated in config.js AND handlers/scheduler-handlers.js; the sweep saw ' + [...files].join(', '))
    // service.js is one of the files the earlier text-stripper corrupted (regex literals holding quotes/backticks); it is parsed here like the rest.
    assert.ok(sources.has('service.js'), 'service.js is not in the sweep')
  })

  it('every use of `features` in src is a recognised gate, a benign write, or an explicit exemption', () => {
    assert.deepEqual(ofKind(real, 'shape'), [])
    assert.deepEqual(ofKind(real, 'stale-exemption'), [])
  })

  it('the `features` row of the per-key table lists exactly the flags that have a gate', () => {
    assert.deepEqual(ofKind(real, 'key-row'), [])
  })

  it('the "Opt-in features" table lists exactly the flags that have a gate', () => {
    assert.deepEqual(ofKind(real, 'opt-in'), [])
  })

  it("each flag's documented env override is exactly what every function that gates it reads", () => {
    assert.deepEqual(ofKind(real, 'env'), [])
  })

  it('the "Direct reads" list and the key-row env column name the same env vars as the Opt-in features table', () => {
    // The third location a two-inventory checker misses (#7032).
    assert.deepEqual(ofKind(real, 'env-sets'), [])
  })

  it('both prose counts equal the number of gated flags', () => {
    assert.deepEqual(ofKind(real, 'numeral'), [])
  })

  // ---- the check is red against the review's mutants (in-memory, never src/) ----

  describe('regression: each mutant goes red against the real check', () => {
    it('baseline: the unmutated tree has no problems', () => {
      assert.deepEqual(real.problems.map(p => p.message), [])
    })

    it('M1: two backtick regexes around an undocumented gate (the stripper blanked it)', () => {
      const r = checkFeatures(fixtureGate('const a = /`/\nexport const g = c => c?.features?.sneak === true\nconst b = /`/\n'), md)
      assert.ok(ofKind(r, 'opt-in').some(m => m.includes('features.sneak')), 'undocumented gate must be reported')
    })

    it('M2: a lone-quote regex on the gate line', () => {
      const r = checkFeatures(fixtureGate("export const g = c => /'/.test('') || c?.features?.sneak2 === true\n"), md)
      assert.ok(ofKind(r, 'opt-in').some(m => m.includes('features.sneak2')))
    })

    it('M3: a top-level env read with an arrow gate (the lexical window leaked scope)', () => {
      const r = checkFeatures(fixtureGate('const _e = process.env.CHROXY_ENABLE_SCHEDULER\nexport const isX = c => c?.features?.scheduler === true\n'), md)
      assert.ok(ofKind(r, 'env').some(m => m.includes('_fixture.js') && m.includes('reads env []')))
    })

    it('M3b: env read in one class method, gate in another', () => {
      const r = checkFeatures(fixtureGate(
        'export class K {\n  envOn() { return process.env.CHROXY_ENABLE_ORCHESTRATION === \'1\' }\n  cfgOn(c) { return c?.features?.orchestration === true }\n}\n'), md)
      assert.ok(ofKind(r, 'env').some(m => m.includes('_fixture.js') && m.includes('reads env []')))
    })

    it('M3c: an env read AFTER the gate in the same function still counts (no false red)', () => {
      const r = checkFeatures(withSources({ '_fixture.js': "export function f(c) {\n  if (c?.features?.ide === true) return true\n  return process.env.CHROXY_ENABLE_IDE === '1'\n}\n" }), md)
      assert.deepEqual(r.problems.map(p => p.message), [])
    })

    for (const [name, body] of [
      ['config.features.ide = true', 'export const f = config => { config.features.ide = true }'],
      ['config.features = { ide: true }', 'export const f = config => { config.features = { ide: true } }'],
      ['config.features ||= { ide: true }', 'export const f = config => { config.features ||= { ide: true } }'],
      ['config.features.ide ||= true', 'export const f = config => { config.features.ide ||= true }'],
    ]) {
      it(`M4: enabling write \`${name}\``, () => {
        const r = checkFeatures(fixtureGate(body + '\n'), md)
        assert.ok(ofKind(r, 'shape').some(m => m.includes('_fixture.js') && m.includes('write:')), ofKind(r, 'shape').join(' | '))
      })
    }

    for (const [name, body] of [
      ['!!config?.features?.newThing', 'return !!config?.features?.newThing'],
      ['Boolean(config.features.newThing)', 'return Boolean(config.features.newThing)'],
      ['const { newThing } = config.features', 'const { newThing } = config.features'],
      ["config.features['newThing'] === true", "return config.features['newThing'] === true"],
      ['true === config.features.newThing', 'return true === config.features.newThing'],
      ['config?.features?.newThing !== false', 'return config?.features?.newThing !== false'],
      ['const f = config.features; f.newThing === true', 'const f = config.features; return f.newThing === true'],
      ['const { features } = config', 'const { features } = config; return features.newThing === true'],
      ['config.features.newThing === 1', 'return config.features.newThing === 1'],
    ]) {
      it(`gate spelling \`${name}\``, () => {
        const r = checkFeatures(fixtureGate(`export const g = config => {\n  ${body}\n}\n`), md)
        assert.ok(ofKind(r, 'shape').some(m => m.includes('gate shape not recognised: _fixture.js')), ofKind(r, 'shape').join(' | '))
      })
    }

    it('a gate in a comment, a block comment or a string is not a gate', () => {
      const r = checkFeatures(fixtureGate('// c?.features?.ghost === true\n/* c?.features?.ghost === true */\nexport const s = "c?.features?.ghost === true"\nexport const t = `c.features.ghost === ${1}`\n'), md)
      assert.deepEqual(r.problems.map(p => p.message), [])
    })

    it('a file that does not parse REFUSES, naming the file', () => {
      assert.throws(() => checkFeatures(fixtureGate('export const = ;\n'), md), /REFUSE: src\/_fixture\.js: cannot parse/)
    })

    it('a tree with no gate REFUSES', () => {
      assert.throws(() => checkFeatures(new Map([['a.js', 'export const x = 1\n']]), md), /REFUSE: found no/)
    })

    it('an enabled write of the real shapes is accepted: = {}, = enabled, = enabled === true', () => {
      const r = checkFeatures(fixtureGate('export function f(c, enabled) {\n  c.features = {}\n  c.features.scheduler = enabled\n  c.features.scheduler = enabled === true\n}\n'), md)
      assert.deepEqual(ofKind(r, 'shape'), [])
    })

    it('env: the read commented out in isOrchestrationEnabled', () => {
      const r = checkFeatures(withSources({ 'config.js': t => mutate(t, "if (process.env.CHROXY_ENABLE_ORCHESTRATION === '1') return true", '// process.env.CHROXY_ENABLE_ORCHESTRATION') }), md)
      assert.ok(ofKind(r, 'env').some(m => m.includes('features.orchestration') && m.includes('reads env []')))
    })

    it('env: a broken name in isSchedulerEnabled while scheduler-handlers.js still reads the real one', () => {
      const r = checkFeatures(withSources({ 'config.js': t => mutate(t, "if (process.env.CHROXY_ENABLE_SCHEDULER === '1') return true", "if (process.env.CHROXY_ENABLE_SCHEDULERX === '1') return true") }), md)
      assert.ok(ofKind(r, 'env').some(m => m.includes('features.scheduler') && m.includes('config.js') && m.includes('SCHEDULERX')))
    })

    it('env: an undocumented env read in a gating function', () => {
      const r = checkFeatures(withSources({ 'config.js': t => mutate(t, "if (process.env.CHROXY_ENABLE_IDE === '1') return true", "if (process.env.CHROXY_ENABLE_IDE === '1') return true\n  if (process.env.CHROXY_UNDOCUMENTED_X) return false") }), md)
      assert.ok(ofKind(r, 'env').some(m => m.includes('CHROXY_UNDOCUMENTED_X')))
    })

    it('env: two rows of the Opt-in table swap their envs', () => {
      const swapped = mutate(mutate(md, '`features.ide` | `CHROXY_ENABLE_IDE=1`', '`features.ide` | `CHROXY_ENABLE_ORCHESTRATION=1`'),
        '`features.orchestration` | `CHROXY_ENABLE_ORCHESTRATION=1`', '`features.orchestration` | `CHROXY_ENABLE_IDE=1`')
      const r = checkFeatures(sources, swapped)
      assert.ok(ofKind(r, 'env').length >= 2, 'a swap must fail per flag even though the env SET is unchanged')
    })

    it('stale exemption: a listed use that no longer exists', () => {
      const r = checkFeatures(withSources({ 'ws-history.js': t => mutate(t, '    features,\n', '') }), md)
      assert.ok(ofKind(r, 'stale-exemption').some(m => m.includes('ws-history.js')))
    })

    it('doc: a flag dropped from the Opt-in table, the key row, or the Direct reads list; a numeral changed', () => {
      assert.ok(ofKind(checkFeatures(sources, md.replace(/^\| `features\.ide` \|.*\n/m, '')), 'opt-in').length > 0)
      assert.ok(ofKind(checkFeatures(sources, mutate(md, '`ide` (IDE navigation surface, epic #6469), ', '')), 'key-row').length > 0)
      assert.ok(ofKind(checkFeatures(sources, mutate(md, '`CHROXY_ENABLE_IDE` / ', '')), 'env-sets').length > 0)
      assert.ok(ofKind(checkFeatures(sources, mutate(md, 'All four are', 'All five are')), 'numeral').length > 0)
      assert.ok(ofKind(checkFeatures(sources, mutate(md, '(the four [', '(the five [')), 'numeral').length > 0)
    })
  })
})

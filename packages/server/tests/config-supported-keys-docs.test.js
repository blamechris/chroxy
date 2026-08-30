import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import * as configModule from '../src/config.js'
import * as providersModule from '../src/anthropic-compatible-config.js'
import {
  extractTypeShapes,
  findConfigTableRow,
  claimedSubKeyTokens,
  GENERIC_BACKTICK_LITERALS,
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
    for (const file of srcFiles) {
      const rel = decodeURIComponent(file.href.slice(SRC_ROOT.href.length))
      const text = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n')
      // Cheap prefilter: parseSupportedKeySets REFUSEs on a file with zero
      // declarations, which is almost every file here.
      if (!/_SUPPORTED_KEYS\s*=\s*new Set/.test(text)) continue
      for (const [name, keys] of parseSupportedKeySets(text, `src/${rel}`)) {
        if (declared.has(name)) {
          throw new Error(`REFUSE: ${name} is declared in two files: src/${declaredIn.get(name)} and src/${rel}`)
        }
        declared.set(name, keys)
        declaredIn.set(name, rel)
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
    assert.equal(BLOCK_TO_SET_NAME.size, 8, 'expected exactly 8 documented sub-key blocks')
    assert.equal(declared.size, 8, `expected exactly 8 *_SUPPORTED_KEYS declarations, got ${sorted(declared.keys()).join(', ')}`)
    assert.equal(docTable.size, 8, `expected exactly 8 Recognised sub-keys rows, got ${sorted(docTable.keys()).join(', ')}`)
    assert.equal(callSites.length, 7, `expected exactly 7 warnUnknownKeys call sites, got ${callSites.length}`)
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
    // this roster (validated by KNOWN_ENTRY_KEYS in anthropic-compatible-
    // config); `provider` is the TOP-LEVEL CONFIG_SCHEMA key cross-referenced
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
    let claimedTotal = 0
    const claimedPerBlock = new Map()
    for (const block of BLOCK_TO_SET_NAME.keys()) {
      const region = findConfigTableRow(md, block) ?? findSection(md, block)
      if (!region) continue
      const nonKeys = new Set(REGION_NON_KEY_TOKENS.get(block) ?? [])
      for (const t of nonKeys) {
        assert.ok(
          region.includes('\`' + t + '\`'),
          `REGION_NON_KEY_TOKENS entry '${t}' for \`${block}\` no longer appears in its region — stale exclusion`
        )
      }
      const ownName = block.split('.').pop()
      const claimed = [...claimedSubKeyTokens(region)]
        .filter(k => k !== ownName && !nonKeys.has(k))
      const supported = new Set(runtime.get(block))
      const phantom = claimed.filter(k => !supported.has(k))
      claimedTotal += claimed.length
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
      ['billing', 3], ['worktreeGc', 2], ['sessionCi', 3],
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
    void claimedTotal
    // F1 staleness: every generic literal must appear backticked in some gated
    // region, or it is a stale entry widening the evasion surface.
    const allRegions = [...BLOCK_TO_SET_NAME.keys()]
      .map(b => findConfigTableRow(md, b) ?? findSection(md, b))
      .filter(Boolean)
      .join('\n')
    for (const lit of GENERIC_BACKTICK_LITERALS) {
      assert.ok(
        allRegions.includes('\`' + lit + '\`'),
        `GENERIC_BACKTICK_LITERALS entry '${lit}' appears backticked in no gated region — stale, remove it`
      )
    }
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

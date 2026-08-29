import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * #7485 — "there is deliberately only one" has to be checkable, not asserted.
 *
 * `ws-history.js` carries a comment claiming a single implementation of the
 * #4833 chunk-and-drain loop. It was written while the file still held two
 * copies, and the copy that drifted (#7454 `_seq`, #7459 `agent_idle`, #7460
 * back-pressure, #7480 the transcript path) drifted on FOUR separate axes
 * before anyone noticed. A comment beside a set that can grow, with nothing
 * failing when the claim stops being true, is the exact shape
 * `docs/false-safety-guards.md` catalogues.
 *
 * So this file re-derives the claim from the source on every run.
 *
 * It is deliberately ANCHORED PER REGION rather than file-wide: a file-wide
 * grep for `bufferedAmount` over ws-history.js is satisfied by the shared
 * helper itself, so it stays green while a brand-new copy is pasted in
 * underneath it. Every check below scans ONE top-level region and asserts
 * inside it, and the partition is proven to reconstruct the file byte-for-byte
 * first — an enumerator that misses a region yields no findings for it, which
 * is strictly worse than no guard.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const WS_HISTORY = join(SRC, 'ws-history.js')
const CONVERSATION_HANDLERS = join(SRC, 'handlers', 'conversation-handlers.js')

/** The ONE implementation. Nothing else in the tree may re-grow these parts. */
const LOOP_OWNERS = ['scheduleAfterDrain', 'sendChunkedWithBackpressure']

function read(path) {
  // Trailing newline so the last top-level declaration has a `\n}\n`
  // terminator like every other one.
  return readFileSync(path, 'utf8') + '\n'
}

/**
 * Drop WHOLE-LINE comments. The guard is about code: a docblock that explains
 * the back-pressure gate must not read as a second implementation of it, and
 * these two files put every such explanation on its own line.
 */
function stripLineComments(text) {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

/**
 * Slice one top-level function out: from its `function NAME(` declaration to
 * the first closing brace in column 0.
 */
function sliceTopLevelFunction(src, name) {
  const decl = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm')
  const m = decl.exec(src)
  if (!m) return null
  const rest = src.slice(m.index)
  const endRel = rest.search(/\n\}\n/)
  if (endRel === -1) return null
  return { text: rest.slice(0, endRel + 3), start: m.index, end: m.index + endRel + 3 }
}

/**
 * Any statement that can begin at column 0. Review of PR #7490 proved why this
 * is not a list of the shapes we expect: a complete hand-rolled loop written as
 * `const drainQueueAgain = (ws, entries, emit) => { … }` scored 7/7 GREEN
 * against an enumerator that only recognised `function NAME(`, because a shape
 * the enumerator does not know about is a region it never scans. Enumerating
 * KNOWN shapes beside a language that has others is the same defect this whole
 * file exists to catch, one level up.
 */
const TOP_LEVEL_DECL = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)|^(?:import|export)\b/gm

/**
 * PARTITION a module into top-level regions: every byte belongs to exactly one,
 * attributed to the nearest preceding declaration. Exhaustive by construction
 * rather than by enumeration, which is the property the byte-for-byte control
 * below asserts — a scan that silently skips 28% of a file (measured: 54311 of
 * 75759 bytes, before this) reports "clean" for the part it never read.
 */
function topLevelRegions(src) {
  const marks = [...src.matchAll(TOP_LEVEL_DECL)].map((m) => ({ index: m.index, name: m[1] || '<module statement>' }))
  const regions = []
  const first = marks.length ? marks[0].index : src.length
  if (first > 0) regions.push({ name: '<module prologue>', text: src.slice(0, first), start: 0, end: first })
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index
    const end = i + 1 < marks.length ? marks[i + 1].index : src.length
    regions.push({ name: marks[i].name, text: src.slice(start, end), start, end })
  }
  return regions
}

/** The machinery a hand-rolled copy of the loop cannot avoid carrying. */
const MACHINERY = [
  // The BARE word, not `.bufferedAmount`: review of PR #7490 proved that
  // `const { bufferedAmount } = ws` reads the same property a dot does and
  // scored 7/7 green against the dotted form. `ws['bufferedAmount']` and
  // `const ba = ws.bufferedAmount` are the same evasion wearing other hats.
  [/\bbufferedAmount\b/, 'reads bufferedAmount'],
  [/scheduleAfterDrain\s*\(/, 'uses scheduleAfterDrain'],
  [/^[ \t]+const \w*CHUNK_SIZE\w*\s*=/m, 'declares its own chunk size'],
]

/**
 * Report every top-level region that carries the loop's machinery and is not
 * one of the loop's owners. Returns short strings, never source text — a
 * failing assertion must not dump a 60KB subject into the TAP stream (#7340).
 */
function scanForHandRolledCopies(src, owners = []) {
  const offenders = []
  for (const region of topLevelRegions(src)) {
    if (owners.includes(region.name)) continue
    const body = stripLineComments(region.text)
    for (const [re, what] of MACHINERY) {
      if (re.test(body)) offenders.push(`${region.name}: ${what}`)
    }
  }
  return offenders
}

function allSrcFiles() {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => join(d.parentPath ?? d.path, d.name))
}

describe('#7485 — exactly ONE chunk-and-drain loop, re-derived from the source', () => {
  it('the partition reconstructs each module byte-for-byte, so nothing goes unscanned', () => {
    // THE positive control for every negative assertion in this file. An
    // enumerator that only recognises some top-level shapes reports no
    // findings for the shapes it misses, and a clean report from an
    // incomplete scan is indistinguishable from a clean file.
    for (const [label, path] of [['ws-history.js', WS_HISTORY], ['conversation-handlers.js', CONVERSATION_HANDLERS]]) {
      const src = read(path)
      const regions = topLevelRegions(src)
      assert.ok(regions.length >= 5, `${label}: expected many top-level regions; found ${regions.length}`)
      const covered = regions.map((r) => r.text).join('')
      assert.equal(covered.length, src.length,
        `${label}: the partition covers ${covered.length} of ${src.length} bytes — the rest is unscanned, so a copy can hide there`)
      assert.ok(covered === src, `${label}: the partition does not reconstruct the module`)
    }
  })

  it('the detector actually detects: both loop owners DO carry the machinery it looks for', () => {
    // Without this the negative assertions below could all pass because the
    // tokens are wrong, not because the copies are gone.
    const src = read(WS_HISTORY)
    const byName = new Map(topLevelRegions(src).map((r) => [r.name, r]))
    for (const owner of LOOP_OWNERS) {
      assert.ok(byName.has(owner), `${owner} must still be a top-level region in ws-history.js`)
      const body = stripLineComments(byName.get(owner).text)
      assert.ok(/bufferedAmount/.test(body), `${owner} is supposed to be the code that reads ws.bufferedAmount`)
    }
    const shared = stripLineComments(byName.get('sendChunkedWithBackpressure').text)
    assert.ok(/scheduleAfterDrain\s*\(/.test(shared), 'the shared loop is supposed to be the code that parks on a drain')
    assert.ok(/CHUNK_SIZE/.test(shared), 'the shared loop is supposed to be the code that reads the chunk size')
  })

  it('no OTHER region in ws-history.js reads bufferedAmount, parks on a drain, or declares a chunk size', () => {
    assert.deepEqual(scanForHandRolledCopies(read(WS_HISTORY), LOOP_OWNERS), [],
      'a second copy of the #4833 chunk-and-drain loop has appeared in ws-history.js — route it through sendChunkedWithBackpressure instead (#7460, #7480, #7485)')
  })

  it('ws-history.js declares exactly ONE chunk-size constant, and it is REPLAY_CHUNK_SIZE', () => {
    // Two constants with the same value four lines apart is how the divergence
    // started; the issue names this criterion explicitly.
    const decls = [...stripLineComments(read(WS_HISTORY)).matchAll(/^\s*const (\w*CHUNK_SIZE\w*)\s*=/gm)].map((m) => m[1])
    assert.deepEqual(decls, ['REPLAY_CHUNK_SIZE'], `expected one chunk-size constant; found ${decls.join(', ') || 'none'}`)
  })

  it('every consumer of the loop calls the shared helper rather than re-implementing it', () => {
    const wsHistory = read(WS_HISTORY)
    const handlers = read(CONVERSATION_HANDLERS)
    const consumers = [
      ['ws-history.js', wsHistory, 'replayHistory'],
      ['ws-history.js', wsHistory, 'flushPostAuthQueue'],
      ['conversation-handlers.js', handlers, 'handleRequestFullHistory'],
      ['conversation-handlers.js', handlers, 'handleRequestConversationTranscript'],
    ]
    for (const [file, src, name] of consumers) {
      const slice = sliceTopLevelFunction(src, name)
      assert.ok(slice, `${name} is no longer a top-level function in ${file} — the anchor is stale`)
      assert.ok(/sendChunkedWithBackpressure\s*\(/.test(stripLineComments(slice.text)),
        `${file}: ${name} must send through the shared chunk + back-pressure helper, not its own loop`)
    }
  })

  it('no region in conversation-handlers.js reads bufferedAmount, parks on a drain, or declares a chunk size', () => {
    assert.deepEqual(scanForHandRolledCopies(read(CONVERSATION_HANDLERS)), [],
      'a replay handler has grown its own chunk-and-drain loop again — that is #7460/#7480 for the third time')
  })

  it('scheduleAfterDrain is called from NOWHERE in packages/server/src except the shared loop', () => {
    // The park-and-resume primitive is what a hand-rolled copy needs; keeping
    // its call sites inside one function body is what makes "only one" true
    // across the whole package rather than only inside two files.
    const wsHistory = read(WS_HISTORY)
    const shared = sliceTopLevelFunction(wsHistory, 'sendChunkedWithBackpressure')
    const own = sliceTopLevelFunction(wsHistory, 'scheduleAfterDrain')
    assert.ok(shared && own, 'anchors are stale — both loop owners must be top-level functions')

    const strays = []
    let insideShared = 0
    for (const file of allSrcFiles()) {
      const raw = readFileSync(file, 'utf8')
      const rel = relative(SRC, file)
      for (const m of raw.matchAll(/scheduleAfterDrain\s*\(/g)) {
        const line = raw.slice(raw.lastIndexOf('\n', m.index) + 1, raw.indexOf('\n', m.index))
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue
        const isWsHistory = file === WS_HISTORY
        if (isWsHistory && m.index >= shared.start && m.index < shared.end) { insideShared++; continue }
        if (isWsHistory && m.index >= own.start && m.index < own.end) continue // its own declaration
        strays.push(`${rel}:${raw.slice(0, m.index).split('\n').length}`)
      }
    }
    assert.ok(insideShared >= 1, 'POSITIVE CONTROL: the shared loop must itself park on a drain, or this scan proves nothing')
    assert.deepEqual(strays, [],
      'scheduleAfterDrain may only be called by sendChunkedWithBackpressure — a second caller is a second chunk-and-drain loop')
  })

  // ── The two evasions the review of PR #7490 demonstrated ──────────────────
  //
  // Both scored 7/7 GREEN against the first version of this file, which
  // enumerated `function NAME(` declarations and matched `.bufferedAmount`.
  // They are pinned as synthetic modules rather than by editing the real
  // source, because what failed is the DETECTOR's shape coverage — that is the
  // unit under test, and a synthetic module states the shape in five lines.

  it('EVASION PIN 1 — catches a complete hand-rolled loop hidden in a top-level ARROW-CONST', () => {
    const evasion = [
      "import { createLogger } from './logger.js'",
      '',
      'const REPLAY_BATCH = 20',
      '',
      'const drainQueueAgain = (ws, entries, emit) => {',
      '  const step = (offset) => {',
      '    if (ws.readyState !== 1) return',
      '    if ((ws.bufferedAmount || 0) > 262144) {',
      '      setTimeout(() => step(offset), 20)',
      '      return',
      '    }',
      '    const end = Math.min(offset + REPLAY_BATCH, entries.length)',
      '    for (let i = offset; i < end; i++) emit(entries[i], i)',
      '    if (end < entries.length) setTimeout(() => step(end), 20)',
      '  }',
      '  step(0)',
      '}',
      '',
    ].join('\n')
    assert.deepEqual(scanForHandRolledCopies(evasion), ['drainQueueAgain: reads bufferedAmount'],
      'a hand-rolled loop declared as `const NAME = (…) => {` is still a hand-rolled loop')
  })

  it('EVASION PIN 2 — catches bufferedAmount reached by DESTRUCTURING rather than a dot', () => {
    const evasion = [
      'export function replayThings(ctx, ws, entries) {',
      '  const { bufferedAmount } = ws',
      '  if (bufferedAmount > 262144) {',
      '    setTimeout(() => replayThings(ctx, ws, entries), 20)',
      '    return',
      '  }',
      '  for (const e of entries) ctx.send(ws, e)',
      '}',
      '',
    ].join('\n')
    assert.deepEqual(scanForHandRolledCopies(evasion), ['replayThings: reads bufferedAmount'],
      '`const { bufferedAmount } = ws` reads the same property a dot does')
  })

  it('NEGATIVE CONTROL: a module with no back-pressure machinery reports nothing', () => {
    // Without this, a detector that flagged EVERY region would satisfy both
    // pins above and still be worthless — the "denies everything" class
    // (docs/false-safety-guards.md), whose negative tests pass for the wrong
    // reason and keep passing with the check deleted.
    const innocent = [
      "import { createLogger } from './logger.js'",
      '',
      'const log = createLogger("x")',
      '',
      'export function sendOne(ws, msg) {',
      '  ws.send(JSON.stringify(msg))',
      '}',
      '',
      'const formatAll = (entries) => entries.map((e) => e.type).join(",")',
      '',
      'export function replayNothing(ws, entries) {',
      '  for (const e of entries) sendOne(ws, e)',
      '  log.info(formatAll(entries))',
      '}',
      '',
    ].join('\n')
    assert.deepEqual(scanForHandRolledCopies(innocent), [],
      'the detector must distinguish a plain send loop from a chunk-and-drain copy, or it proves nothing')
  })
})

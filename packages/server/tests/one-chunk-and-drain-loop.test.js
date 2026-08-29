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
 * It is deliberately ANCHORED PER FUNCTION rather than file-wide: a file-wide
 * grep for `bufferedAmount` over ws-history.js is satisfied by the shared
 * helper itself, so it stays green while a brand-new copy is pasted in
 * underneath it. Every check below slices ONE function body out by its
 * declaration and asserts inside that slice, and every slice is proven
 * non-empty first — a stale anchor yields '' against which every negative
 * assertion passes vacuously, which is strictly worse than no guard.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

const WS_HISTORY = join(SRC, 'ws-history.js')
const CONVERSATION_HANDLERS = join(SRC, 'handlers', 'conversation-handlers.js')

/** The ONE implementation. Nothing else in the tree may re-grow these parts. */
const LOOP_OWNERS = ['scheduleAfterDrain', 'sendChunkedWithBackpressure']

function read(path) {
  // Trailing newline so the last top-level function has a `\n}\n` terminator
  // like every other one.
  return readFileSync(path, 'utf8') + '\n'
}

/**
 * Drop WHOLE-LINE comments. The guard is about code: a docblock that explains
 * the back-pressure gate must not read as a second implementation of it, and
 * these two files put every such explanation on its own line. Trailing
 * comments are left in place — none of the tokens below appear in one, and
 * stripping them needs string-literal awareness this does not have.
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

/** Every top-level function declaration in a module, in source order. */
function topLevelFunctionNames(src) {
  return [...src.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)].map((m) => m[1])
}

/**
 * Slice one top-level function out: from its `function NAME(` declaration to
 * the first closing brace in column 0. Both files indent every nested block,
 * so a `}` at column 0 is the function's own terminator.
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

function allSrcFiles() {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => join(d.parentPath ?? d.path, d.name))
}

describe('#7485 — exactly ONE chunk-and-drain loop, re-derived from the source', () => {
  it('the slicer finds every top-level function in ws-history.js and returns a real body for each', () => {
    // POSITIVE CONTROL for every negative assertion below. A stale or broken
    // anchor returns null/'' and silently satisfies all of them.
    const src = read(WS_HISTORY)
    const names = topLevelFunctionNames(src)
    assert.ok(names.length >= 10, `expected ws-history.js to declare many top-level functions; found ${names.length}`)
    for (const owner of LOOP_OWNERS) {
      assert.ok(names.includes(owner), `${owner} must still be a top-level function in ws-history.js`)
    }
    for (const name of names) {
      const slice = sliceTopLevelFunction(src, name)
      assert.ok(slice && slice.text.length > 0, `could not slice ${name} out of ws-history.js — the anchor is stale`)
      assert.ok(slice.text.includes(`function ${name}(`), `slice for ${name} does not start at its declaration`)
    }
  })

  it('the detector actually detects: both loop owners DO carry the machinery it looks for', () => {
    // Without this the negative assertions below could all pass because the
    // tokens are wrong, not because the copies are gone.
    const src = read(WS_HISTORY)
    for (const owner of LOOP_OWNERS) {
      const body = stripLineComments(sliceTopLevelFunction(src, owner).text)
      assert.ok(/\.bufferedAmount/.test(body), `${owner} is supposed to be the code that reads ws.bufferedAmount`)
    }
    const shared = stripLineComments(sliceTopLevelFunction(src, 'sendChunkedWithBackpressure').text)
    assert.ok(/scheduleAfterDrain\s*\(/.test(shared), 'the shared loop is supposed to be the code that parks on a drain')
    assert.ok(/CHUNK_SIZE/.test(shared), 'the shared loop is supposed to be the code that reads the chunk size')
  })

  it('no OTHER function in ws-history.js reads bufferedAmount, parks on a drain, or declares a chunk size', () => {
    const src = read(WS_HISTORY)
    const offenders = []
    for (const name of topLevelFunctionNames(src)) {
      if (LOOP_OWNERS.includes(name)) continue
      const body = stripLineComments(sliceTopLevelFunction(src, name).text)
      if (/\.bufferedAmount/.test(body)) offenders.push(`${name}: reads ws.bufferedAmount`)
      if (/scheduleAfterDrain\s*\(/.test(body)) offenders.push(`${name}: calls scheduleAfterDrain`)
      if (/^\s*const \w*CHUNK_SIZE\b/m.test(body)) offenders.push(`${name}: declares its own chunk size`)
    }
    assert.deepEqual(offenders, [],
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

  it('no function in conversation-handlers.js reads bufferedAmount, parks on a drain, or declares a chunk size', () => {
    const src = read(CONVERSATION_HANDLERS)
    const names = topLevelFunctionNames(src)
    assert.ok(names.length >= 5, `expected conversation-handlers.js to declare several handlers; found ${names.length}`)
    const offenders = []
    for (const name of names) {
      const slice = sliceTopLevelFunction(src, name)
      assert.ok(slice && slice.text.length > 0, `could not slice ${name} out of conversation-handlers.js — the anchor is stale`)
      const body = stripLineComments(slice.text)
      if (/\.bufferedAmount/.test(body)) offenders.push(`${name}: reads ws.bufferedAmount`)
      if (/scheduleAfterDrain\s*\(/.test(body)) offenders.push(`${name}: calls scheduleAfterDrain`)
      if (/^\s*const \w*CHUNK_SIZE\b/m.test(body)) offenders.push(`${name}: declares its own chunk size`)
    }
    assert.deepEqual(offenders, [],
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
})

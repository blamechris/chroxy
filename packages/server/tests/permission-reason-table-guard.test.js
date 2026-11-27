// #9368: the permission no-decision reason table stays the ONLY map, and every
// reason the server emits is accounted for. See helpers/permission-reason-collector.js
// for what counts as a reason on a resolve path. Parsed with acorn, not a regex.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERMISSION_NO_DECISION_REASON_OUTCOMES } from '@chroxy/protocol'
import { collectResolvedReasons, classifyResolvedUses, checkJournalReasonReads } from './helpers/permission-reason-collector.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const PM_PATH = join(SRC, 'permission-manager.js')
const SM_PATH = join(SRC, 'session-manager.js')

// Real decisions: a human or a mode DECIDED, so the record follows `decision`.
const REAL_DECISIONS = ['user', 'auto_mode', 'auto_mode_mcp_trust_bypass']
// `toolUseId`-only events (no requestId): they never reach the requestId-keyed journal map.
const TOOL_USE_ID_ONLY = ['superseded', 'answered']
// Emitted today with a requestId and decision 'deny', NOT in the table, so the journal
// records it `denied`. Listed (not hidden) so this guard is honest about it; remove the
// entry when it is tabled or deliberately ruled a refusal. Tracking issue: #9372.
const KNOWN_UNTABLED = ['cancelled']

const TABLE = Object.keys(PERMISSION_NO_DECISION_REASON_OUTCOMES)
const ACCOUNTED = new Set([...TABLE, ...REAL_DECISIONS, ...TOOL_USE_ID_ONLY, ...KNOWN_UNTABLED])

function assertSound(result, label) {
  assert.ok(result.emits > 0, `${label}: found no permission_resolved emit at all -- the collector cannot see this file's resolve paths`)
  assert.deepEqual(result.problems, [], `${label}: shapes the collector could not account for:\n${result.problems.join('\n')}`)
  assert.ok(result.reasons.size > 0, `${label}: resolved zero reason literals`)
}

function srcFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [])
}

const probe = body => collectResolvedReasons(`class A {\n${body}\n}`, 'probe')

describe('#9368 permission_resolved reasons are all accounted for', () => {
  const pm = readFileSync(PM_PATH, 'utf8')
  const result = collectResolvedReasons(pm, 'permission-manager.js')

  it('every emitted reason is a table key or an allowlisted decision', () => {
    assertSound(result, 'permission-manager.js')
    const stray = [...result.reasons].filter(r => !ACCOUNTED.has(r))
    assert.deepEqual(stray, [], `reason(s) emitted but not in PERMISSION_NO_DECISION_REASON_OUTCOMES (packages/protocol/src/permission-outcomes.ts): ${stray.join(', ')}. Add a no-decision reason to the table; a real decision to REAL_DECISIONS here.`)
  })

  it('finds the reasons known today, so a parse that misses a path goes red', () => {
    assertSound(result, 'permission-manager.js')
    for (const r of ACCOUNTED) {
      assert.ok(result.reasons.has(r), `collector no longer finds reason '${r}' (found: ${[...result.reasons].join(', ')})`)
    }
  })

  it('the allowlists name no reason that is also a table key', () => {
    const overlap = [...REAL_DECISIONS, ...TOOL_USE_ID_ONLY, ...KNOWN_UNTABLED].filter(r => TABLE.includes(r))
    assert.deepEqual(overlap, [])
  })

  it('refuses loudly on a source with no resolve emit, an unresolvable reason, or a missing reason', () => {
    assert.throws(() => assertSound(collectResolvedReasons('export const x = 1\n', 'empty'), 'empty'), /found no permission_resolved emit/)
    const bad = probe("f(r) { this.emit('permission_resolved', { requestId: 1, reason: this.r }) }")
    assert.ok(bad.problems.length === 1 && /MemberExpression/.test(bad.problems[0]), 'member-read reason must be reported unresolvable')
    assert.throws(() => assertSound(bad, 'bad'), /could not account/)
    assert.equal(collectResolvedReasons("this.emit('permission_resolved', { requestId: 1 })", 'none').problems.length, 1, 'an emit with no reason')
    const orphan = collectResolvedReasons("const f = (a, reason) => { this.emit('permission_resolved', { reason }) }", 'orphan')
    assert.ok(orphan.problems.length === 1 && /no call site/.test(orphan.problems[0]), 'a parameter nobody passes must be reported')
    const ok = collectResolvedReasons("const f = (a, reason) => { this.emit('permission_resolved', { reason }) }\nf(1, s ? 'x' : 'y')", 'ok')
    assert.deepEqual([...ok.reasons].sort(), ['x', 'y'])
    assert.deepEqual(ok.problems, [])
  })

  it('the tripwire reports every emit shape it cannot read, not just the literal one', () => {
    const shapes = {
      'aliased emit': "f() { const emit = this.emit.bind(this); emit('permission_resolved', { requestId: 1, reason: 'novel' }) }",
      'destructured emit': "f() { const { emit } = this; emit('permission_resolved', { requestId: 1, reason: 'novel' }) }",
      'constant event name': "f() { this.emit(EVT, { requestId: 1, reason: 'novel' }) }\n",
      'computed emit': "f() { this['emit']('permission_resolved', { requestId: 1, reason: 'novel' }) }",
      'emit.call': "f() { this.emit.call(this, 'permission_resolved', { requestId: 1, reason: 'novel' }) }",
      'a stray literal': "f() { const EVT = 'permission_resolved'; return EVT }",
    }
    // Shapes the collector can READ must surface their reason (so the allowlist test goes red on a
    // novel one); shapes it cannot read must be a problem. Silence is neither.
    const readable = new Set(['aliased emit', 'destructured emit', 'computed emit'])
    for (const [name, body] of Object.entries(shapes)) {
      const r = probe(body)
      if (readable.has(name)) assert.ok(r.reasons.has('novel') && r.problems.length === 0, `${name}: its reason must be collected (got ${[...r.reasons]})`)
      else assert.ok(r.problems.length > 0, `${name}: expected a problem, got none (reasons: ${[...r.reasons]})`)
    }
    // Listener registrations are accounted for, and a relay is not an emitter.
    const fine = probe("f() { this.on('permission_resolved', d => {}); this.once('permission_resolved', d => {}); this.off('permission_resolved', h) }\ng() { this.emit('permission_resolved', { requestId: 1, reason: 'a' }) }")
    assert.deepEqual(fine.problems, [])
  })

  it('reports a function whose reason parameter is referenced other than as a call', () => {
    for (const ref of ['setTimeout(finish, 1)', 'p.then(finish)', 'const g = finish', 'x.run(this.finish)']) {
      const r = collectResolvedReasons(
        `const finish = (a, reason) => { this.emit('permission_resolved', { requestId: 1, reason }) }\nfinish(1, 'x')\nfunction h(p) { ${ref} }`, 'ref')
      assert.ok(r.problems.some(p => /referenced other than as a call/.test(p)), `${ref}: expected a reference problem, got ${JSON.stringify(r.problems)}`)
    }
    // Stored as a property and called through it (the explicit-consent shape) is accounted for.
    const stored = collectResolvedReasons(
      "const finish = (a, reason) => { this.emit('permission_resolved', { requestId: 1, reason }) }\nm.set(1, { finish })\nm.get(1).finish(1, 'user')", 'stored')
    assert.deepEqual(stored.problems, [])
    assert.deepEqual([...stored.reasons], ['user'])
  })

  it('reports a payload spread that could carry a reason', () => {
    const spread = s => probe(`f() { this.emit('permission_resolved', { requestId: 1, reason: 'timeout', ...${s} }) }`).problems
    assert.ok(spread('override').length === 1, 'an unknown spread overrides reason')
    assert.ok(spread("{ reason: 'x' }").length === 1, 'an object spread with reason')
    assert.deepEqual(spread('(a ? { scope: 1 } : {})'), [])
    const helper = "function field() { return a ? { id: 1 } : {} }\nfunction leaks() { return { reason: 'x' } }\nclass A { f() { this.emit('permission_resolved', { requestId: 1, reason: 'timeout', ...HELPER() }) } }"
    assert.deepEqual(collectResolvedReasons(helper.replace('HELPER', 'field'), 'h').problems, [])
    assert.equal(collectResolvedReasons(helper.replace('HELPER', 'leaks'), 'h').problems.length, 1)
  })
})

describe('#9368 no other file in src emits permission_resolved', () => {
  const files = srcFiles(SRC)
  const byFile = new Map(files.map(f => [relative(SRC, f), classifyResolvedUses(readFileSync(f, 'utf8'), f)]))

  it('parsed every source file (never zero)', () => {
    assert.ok(files.length > 100, `only ${files.length} .js files found under src -- the roster cannot see the tree`)
    assert.equal(byFile.size, files.length)
  })

  it('no emit-like call outside permission-manager.js carries the event except as a relay in a listener', () => {
    const v = []
    for (const [f, c] of byFile) if (f !== 'permission-manager.js') v.push(...c.violations.map(x => `${f} ${x}`))
    assert.deepEqual(v, [], `an emitter outside permission-manager.js: its reasons are invisible to the table guard:\n${v.join('\n')}`)
  })

  it('classifies the known users of the event correctly', () => {
    const get = f => byFile.get(f) ?? assert.fail(`${f} is not under src`)
    assert.ok(get('sdk-session.js').listeners >= 1, 'sdk-session.js listens')
    assert.ok(get('byok-session.js').listeners >= 1 && get('byok-session.js').relays >= 1, 'byok-session.js relays a child listener into an agent event')
    assert.ok(get('session-manager.js').comparisons >= 1, 'session-manager.js compares the event name in its journal listener')
    assert.ok(get('event-normalizer.js').frames >= 1, 'event-normalizer.js builds wire frames')
    assert.ok(get('permission-resolver.js').frames >= 1, 'permission-resolver.js builds the legacy wire frame')
    assert.ok(get('dev-preview.js').listeners >= 1 && get('dev-preview.js').frames >= 1, 'dev-preview.js relays a listener payload into a frame')
    assert.ok(get('permission-manager.js').listeners >= 1, 'permission-manager.js listens (its relay)')
  })

  it('wire frames carry only accounted literal reasons', () => {
    for (const [f, c] of byFile) {
      const stray = c.frameReasons.filter(r => !ACCOUNTED.has(r))
      assert.deepEqual(stray, [], `${f}: a wire frame stamps reason(s) outside the accounted set`)
    }
  })

  it('catches an emit in another file, in each shape, and passes a relay', () => {
    const emit = body => classifyResolvedUses(body, 'x').violations.length
    assert.equal(emit("this.emit('permission_resolved', { reason: 'evicted' })"), 1)
    assert.equal(emit("const e = this.emit.bind(this); e('permission_resolved', {})"), 1)
    assert.equal(emit("this['emit']('permission_resolved', {})"), 1)
    assert.equal(emit("const EVT = 'permission_resolved'; this.emit(EVT, {})"), 1)
    assert.equal(emit("this._emitAgentEvent(id, 'permission_resolved', {})"), 1)
    assert.equal(emit("p.on('permission_resolved', (d) => { this._emitAgentEvent(id, 'permission_resolved', d) })"), 0)
  })
})

describe('#9368 permissionOutcomeForEvent reads reason only through the shared table', () => {
  const real = readFileSync(SM_PATH, 'utf8')
  const IMPORT = "import { permissionOutcomeForReason } from '@chroxy/protocol'\n"
  const wrap = body => `${IMPORT}function permissionOutcomeForEvent(event, data) {\n${body}\n}`

  it('the live function passes the reason to permissionOutcomeForReason and nowhere else', () => {
    const r = checkJournalReasonReads(real, 'session-manager.js')
    assert.deepEqual(r.problems, [], r.problems.join('\n'))
    assert.ok(r.lookups >= 1)
  })

  it('goes red on every way of mapping a reason outside the table', () => {
    const bad = {
      'inline comparison': "if (data.reason === 'cleared') return 'expired'",
      'switch': "switch (data.reason) { case 'cleared': return 1 }",
      'lookup object': "return { cleared: 'expired' }[data.reason]",
      'in': "if (data.reason in { cleared: 1 }) return 1",
      'regex': "if (/^clear/.test(data.reason)) return 1",
      'Map.get': "return new Map([['cleared', 'expired']]).get(data.reason)",
      'nested helper': "const h = (x) => x === 'cleared'; return h(data.reason) ? 1 : 2",
      'top-level helper': "return mapIt(data)",
      'alias': "const r = data.reason; if (r === 'cleared') return 1; return permissionOutcomeForReason(data.reason)",
      'destructured': "const { reason } = data; if (reason === 'cleared') return 1; return permissionOutcomeForReason(data.reason)",
      'destructured rename': "const { reason: why } = data; return why === 'x' ? 1 : permissionOutcomeForReason(data.reason)",
      'data alias': "const d = data; if (d.reason === 'cleared') return 1; return permissionOutcomeForReason(data.reason)",
      'computed access': "const k = 'reason'; return permissionOutcomeForReason(data.reason) ?? data[k]",
      'spread': "return permissionOutcomeForReason(data.reason) ?? mapIt({ ...data })",
      'no lookup at all': "return data.decision === 'deny' ? 'denied' : 'allowed'",
    }
    for (const [name, body] of Object.entries(bad)) {
      const r = checkJournalReasonReads(wrap(body), 't')
      assert.ok(r.problems.length > 0, `${name}: expected a problem, got none`)
    }
    const good = checkJournalReasonReads(wrap("if (event === 'permission_expired') return 'expired'\nconst n = permissionOutcomeForReason(data.reason)\nreturn n ?? (data.decision === 'deny' ? 'denied' : 'allowed')"), 't')
    assert.deepEqual(good.problems, [])
    const destructured = checkJournalReasonReads(wrap("const { reason } = data\nreturn permissionOutcomeForReason(reason)"), 't')
    assert.deepEqual(destructured.problems, [])
  })

  it('refuses when the function or its protocol import is missing', () => {
    assert.throws(() => checkJournalReasonReads('function other() {}', 't'), /no function permissionOutcomeForEvent/)
    assert.throws(() => checkJournalReasonReads('function permissionOutcomeForEvent(e, d) {}', 't'), /not imported from '@chroxy\/protocol'/)
  })
})

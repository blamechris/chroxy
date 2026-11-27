// #9368: the permission no-decision reason table stays the ONLY map, and every
// reason the server emits is accounted for. See helpers/permission-reason-collector.js
// for what counts as a reason on a resolve path. Parsed with acorn, not a regex.
//
// THREAT MODEL. This catches a developer who adds or reroutes a no-decision reason in the ordinary
// ways: a new literal, a `let`, an alias, a helper, a relay that edits its payload, a new file.
// Deliberate obfuscation is out of scope (eval, a key built at run time, `'permission_' + 'resolved'`
// in a file that never spells the literal). Where failing closed is cheap it fails closed instead
// of enumerating bad shapes: unknown shapes are problems, not passes.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERMISSION_NO_DECISION_REASON_OUTCOMES } from '@chroxy/protocol'
import {
  collectResolvedReasons, classifyResolvedUses, checkJournalReasonReads, returnsReasonFreeObjects,
} from './helpers/permission-reason-collector.js'

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

/**
 * EVERY src file that spells 'permission_resolved', and the ways it uses it, both directions: a
 * new file, a file that loses its use, or a file that gains a new kind of use fails. A `roster`
 * is a list of event names (it cannot emit); a `frame` is a wire frame `{ type: ... }`.
 */
const KNOWN_USES = {
  'agent-control/client.js': 'comparison,roster',
  'agent-control/events.js': 'roster',
  'base-session.js': 'listener,roster',
  'byok-session.js': 'comparison,emit,listener,relay',
  'dev-preview.js': 'frame,listener',
  'event-normalizer.js': 'comparison,frame',
  'outgoing-policy.js': 'roster',
  'permission-manager.js': 'emit,listener',
  'permission-resolver.js': 'frame',
  'principal-policy.js': 'roster',
  'sdk-session.js': 'listener',
  'session-manager.js': 'comparison,roster',
  'ws-server.js': 'comparison',
}
// Imported helpers spread into a frame; each is VERIFIED reason-free below, never trusted blind.
const TRUSTED_SPREAD_FNS = { resolvedByField: 'permission-resolved-by.js' }

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
const hasProblem = (r, re, msg) => assert.ok(r.problems.some(p => re.test(p)), `${msg}: expected /${re.source}/, got ${JSON.stringify(r.problems)}`)

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
      'a template literal event': "f() { const EVT = `permission_resolved`; return EVT }",
    }
    // Shapes the collector can READ must surface their reason (so the allowlist test goes red on a
    // novel one); shapes it cannot read must be a problem. Silence is neither.
    const readable = new Set(['aliased emit', 'destructured emit', 'computed emit'])
    for (const [name, body] of Object.entries(shapes)) {
      const r = probe(body)
      if (readable.has(name)) assert.ok(r.reasons.has('novel') && r.problems.length === 0, `${name}: its reason must be collected (got ${[...r.reasons]})`)
      else assert.ok(r.problems.length > 0, `${name}: expected a problem, got none (reasons: ${[...r.reasons]})`)
    }
    const fine = probe("f() { this.on('permission_resolved', d => {}); this.once('permission_resolved', d => {}); this.off('permission_resolved', h) }\ng() { this.emit('permission_resolved', { requestId: 1, reason: 'a' }) }")
    assert.deepEqual(fine.problems, [])
  })

  it('SF-1: a reason resolves only through a const, or a parameter nobody assigns', () => {
    const lets = {
      'let reassigned': "f(p) { let reason = p ? 'a' : 'b'; if (p.x) reason = 'novel'; this.emit('permission_resolved', { reason }) }",
      'let never reassigned': "f(p) { let reason = p ? 'a' : 'b'; this.emit('permission_resolved', { reason }) }",
      'var': "f(p) { var reason = 'a'; this.emit('permission_resolved', { reason }) }",
      'const then assigned': "f(p) { const reason = 'a'; reason = 'novel'; this.emit('permission_resolved', { reason }) }",
      'destructured binding': "f(p) { const { reason } = p; this.emit('permission_resolved', { reason }) }",
    }
    for (const [name, body] of Object.entries(lets)) {
      const r = probe(body)
      assert.equal(r.reasons.has('novel'), false)
      hasProblem(r, /is a `(let|var)`|is assigned after|destructuring pattern/, name)
    }
    for (const reassign of ["reason = 'novel'", "reason += 'x'", "[reason] = ['novel']", 'reason++']) {
      const r = collectResolvedReasons(`const f = (a, reason) => { ${reassign}; this.emit('permission_resolved', { reason }) }\nf(1, 'x')`, 'p')
      hasProblem(r, /is reassigned/, `parameter ${reassign}`)
    }
    assert.deepEqual(probe("f(p) { const reason = p ? 'a' : 'b'; this.emit('permission_resolved', { reason }) }").problems, [])
  })

  it('reports a function whose reason parameter is referenced other than as a call', () => {
    for (const ref of ['setTimeout(finish, 1)', 'p.then(finish)', 'const g = finish', 'x.run(this.finish)']) {
      const r = collectResolvedReasons(
        `const finish = (a, reason) => { this.emit('permission_resolved', { requestId: 1, reason }) }\nfinish(1, 'x')\nfunction h(p) { ${ref} }`, 'ref')
      hasProblem(r, /referenced other than as a call/, ref)
    }
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

  it('SF-2: a relay counts only when its payload is the listener\'s own UNTOUCHED parameter', () => {
    const listener = body => `class A { w(p) { p.on('permission_resolved', (data) => { ${body} }) } }`
    const relay = "this.emit('permission_resolved', data)"
    const ok = collectResolvedReasons(listener(`if (data && (data.requestId || data.toolUseId)) { ${relay} }`), 'ok')
    assert.deepEqual(ok.problems, [])
    assert.equal(ok.emits, 0, 'a clean relay is not an emitter')
    const touched = {
      'member assigned': "data.reason = 'novel'",
      'nested member assigned': "data.x.reason = 'novel'",
      'member updated': 'data.n++',
      'Object.assign': "Object.assign(data, { reason: 'novel' })",
      'delete': 'delete data.reason',
      'spread': "const c = { ...data, reason: 'novel' }",
      'alias': "const d2 = data; d2.reason = 'novel'",
      'passed to a helper': 'mutate(data)',
      'reassigned': "data = { reason: 'novel' }",
    }
    for (const [name, pre] of Object.entries(touched)) {
      const r = collectResolvedReasons(listener(`${pre}; ${relay}`), name)
      hasProblem(r, /the relayed payload 'data' is/, name)
    }
    // N-2: not a listener parameter at all -> a problem, and still counted as an emit.
    const loose = collectResolvedReasons("class A { f(d) { d.reason = 'novel'; this.emit('permission_resolved', d) } }", 'loose')
    assert.equal(loose.emits, 1)
    hasProblem(loose, /neither an object literal nor the untouched parameter/, 'N-2')
    for (const payload of ['someCall()', '{ ...x }', 'cond ? a : b']) {
      hasProblem(collectResolvedReasons(`class A { f(d) { this.emit('permission_resolved', ${payload}) } }`, 'p'), /neither an object literal|spread in a payload|emit has no/, payload)
    }
  })
})

describe('#9368 every src file that spells permission_resolved is classified', () => {
  const files = srcFiles(SRC)
  const trusted = new Set()
  for (const [fn, file] of Object.entries(TRUSTED_SPREAD_FNS)) {
    assert.ok(returnsReasonFreeObjects(readFileSync(join(SRC, file), 'utf8'), file, fn), `${fn} (${file}) must return only reason-free object literals`)
    trusted.add(fn)
  }
  const byFile = new Map(files.map(f => {
    const rel = relative(SRC, f)
    return [rel, classifyResolvedUses(readFileSync(f, 'utf8'), f, { allowEmitters: rel === 'permission-manager.js', allowRoster: KNOWN_USES[rel]?.includes('roster') === true, trustedSpreadFns: trusted })]
  }))
  const kinds = c => Object.entries(c).filter(([, v]) => v > 0).map(([k]) => k).sort().join(',')

  it('parsed every source file (never zero)', () => {
    assert.ok(files.length > 100, `only ${files.length} .js files found under src -- the roster cannot see the tree`)
    assert.equal(byFile.size, files.length)
  })

  it('no use of the event is unclassified, and no emit outside permission-manager.js is anything but a clean relay', () => {
    const v = []
    for (const [f, c] of byFile) v.push(...c.problems.map(x => `${f} ${x}`))
    assert.deepEqual(v, [], `a use of 'permission_resolved' this guard cannot classify (a new pattern: classify it in collector.js and KNOWN_USES, or it is an emitter whose reasons are invisible):\n${v.join('\n')}`)
  })

  it('the set of files that spell the event, and how, equals the known roster exactly', () => {
    const actual = Object.fromEntries([...byFile].filter(([, c]) => kinds(c.counts)).map(([f, c]) => [f, kinds(c.counts)]))
    const newFiles = Object.keys(actual).filter(f => !(f in KNOWN_USES))
    const lostFiles = Object.keys(KNOWN_USES).filter(f => !(f in actual))
    assert.deepEqual(newFiles, [], `new file(s) use 'permission_resolved'; classify them in KNOWN_USES after checking they emit no reason of their own`)
    assert.deepEqual(lostFiles, [], `KNOWN_USES names file(s) that no longer use 'permission_resolved' (or were moved): update the roster`)
    assert.deepEqual(actual, KNOWN_USES)
  })

  it('wire frames carry only accounted literal reasons', () => {
    for (const [f, c] of byFile) {
      const stray = c.frameReasons.filter(r => !ACCOUNTED.has(r))
      assert.deepEqual(stray, [], `${f}: a wire frame stamps reason(s) outside the accounted set`)
    }
    assert.ok([...byFile.values()].some(c => c.frameReasons.includes('superseded')), 'the event normalizer frame stamping `superseded` is no longer found')
  })

  it('SF-3/SF-4: goes red on every way to emit or reroute the event from another file', () => {
    const c = (body, opts) => classifyResolvedUses(body, 'x', opts)
    const bad = {
      'emit with a literal payload inside a listener': "p.on('permission_resolved', d => { this.emit('permission_resolved', {requestId:1, reason:'novel'}) })",
      'wrapper with a rebuilt payload inside a listener': "p.on('permission_resolved', d => { this._emitAgentEvent(id,'permission_resolved',{...d, reason:'novel'}) })",
      'relay of an edited payload': "p.on('permission_resolved', d => { d.reason = 'novel'; this.emit('permission_resolved', d) })",
      'emit outside a listener': "this.emit('permission_resolved', { reason: 'evicted' })",
      'aliased emit': "const e = this.emit.bind(this); e('permission_resolved', {})",
      'computed emit': "this['emit']('permission_resolved', {})",
      'constant event': "const EVT = 'permission_resolved'; this.emit(EVT, {})",
      'broadcast': "this.broadcast('permission_resolved', {})",
      '_fire': "this._fire('permission_resolved', {})",
      'publish': "hub.publish('permission_resolved', {})",
      'wrapper of a spread': "function fire(...a){ this.emit(...a) }; fire('permission_resolved', {})",
      'bound emit': "const f = this.emit.bind(this, 'permission_resolved')",
      'Reflect.apply': "Reflect.apply(this.emit, this, ['permission_resolved', {}])",
      'template literal': "this.broadcast(`permission_resolved`, {})",
      'const binding': "const T = 'permission_resolved'; send({ type: T })",
      'default value': "function f(t = 'permission_resolved') { return t }",
      'frame with a variable reason': "send({ type: 'permission_resolved', reason: r })",
      'frame with a computed reason': "h = d => send({ type: 'permission_resolved', reason: d.x || 'novel' })",
      'frame with an unknown spread': "send({ type: 'permission_resolved', ...x })",
      'frame with a template type': "send({ type: `permission_resolved`, reason: r })",
    }
    for (const [name, body] of Object.entries(bad)) {
      assert.ok(c(body).problems.length > 0, `${name}: expected a problem, got none`)
    }
    // And the shapes that are fine.
    const good = {
      'listener + clean relay': "p.on('permission_resolved', d => { if (d && d.requestId) { this.emit('permission_resolved', d) } })",
      'wrapper relay': "p.on('permission_resolved', e => { this._emitAgentEvent(id, 'permission_resolved', e) })",
      'comparison': "if (event === 'permission_resolved' || t !== 'permission_resolved') {}",
      'switch case': "switch (t) { case 'permission_resolved': break }",
      'roster': "const NAMES = ['a', 'permission_resolved']",
      'frame with literal reason': "send({ type: 'permission_resolved', reason: 'superseded' })",
      'frame passing a handler reason through': "p.on('permission_resolved', d => send({ type: 'permission_resolved', reason: d.reason, ...d }))",
    }
    for (const [name, body] of Object.entries(good)) {
      assert.deepEqual(c(body, { allowRoster: true }).problems, [], name)
    }
    assert.ok(c(good.roster).problems.length === 1, 'a roster element is a problem unless the file is declared a roster')
    assert.deepEqual(c("send({ type: 'permission_resolved', reason: 'superseded' })").frameReasons, ['superseded'])
  })
})

describe('#9368 permissionOutcomeForEvent reads reason only through the shared table', () => {
  const real = readFileSync(SM_PATH, 'utf8')
  const IMPORT = "import { permissionOutcomeForReason } from '@chroxy/protocol'\n"
  const wrap = body => `${IMPORT}function permissionOutcomeForEvent(event, data) {\n${body}\n}`
  const LOOKUP = 'const base = permissionOutcomeForReason(data.reason)'

  it('the live function passes the reason to permissionOutcomeForReason and nowhere else', () => {
    const r = checkJournalReasonReads(real, 'session-manager.js')
    assert.deepEqual(r.problems, [], r.problems.join('\n'))
    assert.ok(r.lookups >= 1)
  })

  it('goes red, with the SPECIFIC problem, on every way of mapping a reason outside the table', () => {
    // Every body starts with a VALID lookup, so "no lookup" cannot be the reason a case is red:
    // each case has to be caught by its own check (a neutered check turns its case green).
    const bad = {
      'inline comparison': ["if (data.reason === 'cleared') return 'expired'", /the event's reason is read other than as the argument/],
      'switch': ["switch (data.reason) { case 'cleared': return 1 }", /the event's reason is read other than as the argument/],
      'lookup object': ["return { cleared: 'expired' }[data.reason]", /the event's reason is read other than as the argument/],
      'in': ['if (data.reason in { cleared: 1 }) return 1', /the event's reason is read other than as the argument/],
      'regex': ['if (/^clear/.test(data.reason)) return 1', /the event's reason is read other than as the argument/],
      'Map.get': ["return new Map([['cleared', 'expired']]).get(data.reason)", /the event's reason is read other than as the argument/],
      'nested helper': ["const h = (x) => x === 'cleared'; return h(data.reason) ? 1 : 2", /the event's reason is read other than as the argument/],
      'top-level helper': ['return mapIt(data)', /the event \('data'\) is used as a CallExpression/],
      'alias': ["const r = data.reason; if (r === 'cleared') return 1", /'r' \(the event's reason\) is used other than as the argument/],
      'destructured': ["const { reason } = data; if (reason === 'cleared') return 1", /'reason' \(the event's reason\) is used other than as the argument/],
      'destructured rename': ["const { reason: why } = data; return why === 'x' ? 1 : 2", /'why' \(the event's reason\) is used other than as the argument/],
      'rest destructure': ['const { ...rest } = data; return rest', /a rest element destructured from the event/],
      'data alias': ["const d = data; if (d.reason === 'cleared') return 1", /the event's reason is read other than as the argument/],
      'computed access': ["const k = 'reason'; return data[k]", /computed access on the event/],
      'spread': ['return mapIt({ ...data })', /the event \('data'\) is used as a SpreadElement/],
      'shadowed lookup (N-1)': ["const permissionOutcomeForReason = (r) => (r === 'cleared' ? 'expired' : null)", /rebinds permissionOutcomeForReason/],
      'shadowed lookup parameter': ['const g = (permissionOutcomeForReason) => permissionOutcomeForReason', /rebinds permissionOutcomeForReason/],
    }
    for (const [name, [body, re]] of Object.entries(bad)) {
      const r = checkJournalReasonReads(wrap(`${LOOKUP}\n${body}`), 't')
      assert.ok(r.lookups >= 1, `${name}: the harness lookup must still be counted`)
      assert.ok(r.problems.some(p => re.test(p)), `${name}: expected ${re}, got ${JSON.stringify(r.problems)}`)
    }
    const none = checkJournalReasonReads(wrap("return data.decision === 'deny' ? 'denied' : 'allowed'"), 't')
    assert.ok(none.problems.some(p => /never passes the event's reason/.test(p)), 'no lookup at all')
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

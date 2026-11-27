// #9368: the permission no-decision reason table stays the ONLY map, and every
// reason the server emits is accounted for. See helpers/permission-reason-collector.js
// for what counts as a reason on a resolve path. Parsed with acorn, not a regex.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PERMISSION_NO_DECISION_REASON_OUTCOMES } from '@chroxy/protocol'
import { collectResolvedReasons, findInlineReasonComparisons } from './helpers/permission-reason-collector.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const PM_PATH = join(SRC, 'permission-manager.js')
const SM_PATH = join(SRC, 'session-manager.js')

// Real decisions: a human or a mode DECIDED, so the record follows `decision`.
const REAL_DECISIONS = ['user', 'auto_mode', 'auto_mode_mcp_trust_bypass']
// `toolUseId`-only events (no requestId): they never reach the requestId-keyed journal map.
const TOOL_USE_ID_ONLY = ['superseded', 'answered']
// Emitted today with a requestId and decision 'deny', NOT in the table, so the journal
// records it `denied`. Listed (not hidden) so this guard is honest about it; remove the
// entry when it is tabled or deliberately ruled a refusal.
const KNOWN_UNTABLED = ['cancelled']

const TABLE = Object.keys(PERMISSION_NO_DECISION_REASON_OUTCOMES)
const ACCOUNTED = new Set([...TABLE, ...REAL_DECISIONS, ...TOOL_USE_ID_ONLY, ...KNOWN_UNTABLED])

function assertSound(result, label) {
  assert.ok(result.emits > 0, `${label}: found no permission_resolved emit at all -- the collector cannot see this file's resolve paths`)
  assert.deepEqual(result.problems, [], `${label}: reasons the collector could not resolve to a literal:\n${result.problems.join('\n')}`)
  assert.ok(result.reasons.size > 0, `${label}: resolved zero reason literals`)
}

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
    for (const r of [...TABLE, ...REAL_DECISIONS, ...TOOL_USE_ID_ONLY, ...KNOWN_UNTABLED]) {
      assert.ok(result.reasons.has(r), `collector no longer finds reason '${r}' (found: ${[...result.reasons].join(', ')})`)
    }
  })

  it('the allowlists name no reason that is also a table key', () => {
    const overlap = [...REAL_DECISIONS, ...TOOL_USE_ID_ONLY, ...KNOWN_UNTABLED].filter(r => TABLE.includes(r))
    assert.deepEqual(overlap, [])
  })

  it('refuses loudly on a source with no resolve emit, an unresolvable reason, or a missing reason', () => {
    assert.throws(() => assertSound(collectResolvedReasons('export const x = 1\n', 'empty'), 'empty'), /found no permission_resolved emit/)
    const bad = collectResolvedReasons("class A { f(r) { this.emit('permission_resolved', { requestId: 1, reason: this.r }) } }", 'bad')
    assert.ok(bad.problems.length === 1 && /MemberExpression/.test(bad.problems[0]), 'member-read reason must be reported unresolvable')
    assert.throws(() => assertSound(bad, 'bad'), /could not resolve/)
    const none = collectResolvedReasons("this.emit('permission_resolved', { requestId: 1 })", 'none')
    assert.ok(none.problems.length === 1, 'an emit with no reason must be reported')
    const orphan = collectResolvedReasons("const f = (a, reason) => { this.emit('permission_resolved', { reason }) }", 'orphan')
    assert.ok(orphan.problems.length === 1 && /no call site/.test(orphan.problems[0]), 'a parameter nobody passes must be reported')
    const ok = collectResolvedReasons("const f = (a, reason) => { this.emit('permission_resolved', { reason }) }\nf(1, s ? 'x' : 'y')", 'ok')
    assert.deepEqual([...ok.reasons].sort(), ['x', 'y'])
    assert.deepEqual(ok.problems, [])
  })
})

describe('#9368 permissionOutcomeForEvent compares no reason literal', () => {
  it('the shared table is the only map', () => {
    const hits = findInlineReasonComparisons(readFileSync(SM_PATH, 'utf8'), 'session-manager.js')
    assert.deepEqual(hits, [], `permissionOutcomeForEvent re-inlines a literal comparison:\n${hits.join('\n')}`)
  })

  it('catches a re-inlined comparison, a switch, and refuses when the function is gone', () => {
    const wrap = body => `function permissionOutcomeForEvent(event, data) {\n${body}\n}`
    assert.equal(findInlineReasonComparisons(wrap("if (data.reason === 'cleared') return 'expired'"), 't').length, 1)
    assert.equal(findInlineReasonComparisons(wrap("if ('cleared' !== data.reason) return 1"), 't').length, 1)
    assert.equal(findInlineReasonComparisons(wrap("switch (data.reason) { case 'cleared': return 1 }"), 't').length, 1)
    assert.equal(findInlineReasonComparisons(wrap("if (['a'].includes(data.reason)) return 1"), 't').length, 1)
    assert.equal(findInlineReasonComparisons(wrap("const r = data.reason; if (r === 'cleared') return 1"), 't').length, 1, 'an alias is followed')
    assert.equal(findInlineReasonComparisons(wrap("const { reason: why } = data; if (why === 'cleared') return 1"), 't').length, 1, 'a destructured alias is followed')
    assert.deepEqual(findInlineReasonComparisons(wrap("if (event === 'permission_expired') return 'expired'"), 't'), [], 'an event comparison is not a reason map')
    assert.deepEqual(findInlineReasonComparisons(wrap('return data.decision === DENY ? 1 : 2'), 't'), [])
    assert.throws(() => findInlineReasonComparisons('function other() {}', 't'), /no function permissionOutcomeForEvent/)
  })
})

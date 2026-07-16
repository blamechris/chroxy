import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

function grab(fn) { try { fn(); return null } catch (e) { return e } }
import {
  extractDecision,
  DecisionParseError,
  decisionInstruction,
  buildRepairPrompt,
} from '../src/orchestration/decision-contract.js'

// #6691 E-1 — the committee decision contract. Fail-closed: absence of a valid
// block THROWS; it is never read as an approval.

const block = (obj) => '```chroxy-decision\n' + JSON.stringify(obj, null, 2) + '\n```'

describe('extractDecision — happy paths', () => {
  it('parses a chroxy-decision block at the end of prose', () => {
    const text = 'Here is my review.\n\n' + block({ kind: 'poa_review', verdict: 'approve', feedback: 'lgtm' })
    const { decision } = extractDecision(text, 'poa_review')
    assert.equal(decision.verdict, 'approve')
    assert.equal(decision.feedback, 'lgtm')
  })

  it('parses an epic_plan with subtasks', () => {
    const { decision } = extractDecision(block({
      kind: 'epic_plan',
      subtasks: [{ title: 'audit auth', goal: 'find authz bugs', role: 'audit' }],
    }), 'epic_plan')
    assert.equal(decision.subtasks.length, 1)
    assert.equal(decision.subtasks[0].role, 'audit')
  })

  it('strips unknown keys, keeps the schema fields', () => {
    const { decision } = extractDecision(block({ kind: 'result_review', verdict: 'revise', extra: 'ignored', feedback: 'x' }), 'result_review')
    assert.equal(decision.verdict, 'revise')
    assert.equal('extra' in decision, false)
  })

  it('takes the LAST chroxy-decision block when several fences exist', () => {
    const text = [
      '```json\n{"kind":"poa_review","verdict":"escalate"}\n```',
      'then reconsidered:',
      block({ kind: 'poa_review', verdict: 'approve' }),
    ].join('\n')
    assert.equal(extractDecision(text, 'poa_review').decision.verdict, 'approve')
  })

  it('falls back to a json-tagged fence, then an untagged fence, then a tail brace-scan', () => {
    // json-tagged fence
    assert.equal(extractDecision('```json\n{"kind":"poa_review","verdict":"revise"}\n```', 'poa_review').decision.verdict, 'revise')
    // untagged fence
    assert.equal(extractDecision('```\n{"kind":"poa_review","verdict":"escalate"}\n```', 'poa_review').decision.verdict, 'escalate')
    // bare object, no fence — tail brace-scan
    assert.equal(extractDecision('final answer: {"kind":"poa_review","verdict":"approve"}', 'poa_review').decision.verdict, 'approve')
  })

  it('tolerant parse: comments, trailing commas, smart quotes', () => {
    const raw = '```chroxy-decision\n{\n  // my verdict\n  “kind”: “poa_review”,\n  “verdict”: “approve”,\n}\n```'
    assert.equal(extractDecision(raw, 'poa_review').decision.verdict, 'approve')
  })

  it('brace-scan ignores braces inside JSON strings', () => {
    const text = 'note: {"kind":"work_result","summary":"contains } and { in text"}'
    assert.equal(extractDecision(text, 'work_result').decision.summary, 'contains } and { in text')
  })
})

describe('extractDecision — fail-closed', () => {
  it('throws no_block when there is no block or object', () => {
    const e = grab(() => extractDecision('I approve. lgtm!', 'poa_review'))
    assert.equal(e.stage, 'no_block')
  })

  it('throws parse on unfixable JSON', () => {
    const e = grab(() => extractDecision('```chroxy-decision\n{kind: poa_review, verdict}\n```', 'poa_review'))
    assert.equal(e.stage, 'parse')
  })

  it('throws kind on a kind mismatch (distinct from schema failure)', () => {
    const e = grab(() => extractDecision(block({ kind: 'result_review', verdict: 'approve' }), 'poa_review'))
    assert.equal(e.stage, 'kind')
  })

  it('throws schema on a bad verdict enum / missing required field', () => {
    const e1 = grab(() => extractDecision(block({ kind: 'poa_review', verdict: 'yes' }), 'poa_review'))
    assert.equal(e1.stage, 'schema')
    const e2 = grab(() => extractDecision(block({ kind: 'plan_of_attack', plan: 'x' }), 'plan_of_attack'))
    assert.equal(e2.stage, 'schema') // missing summary
  })

  it('a quoted-JSON tail with the WRONG kind is not accepted (negative fixture)', () => {
    // a config sample the worker merely quoted, not a real decision
    const text = 'example config: {"kind":"some_config","value":42}\n(no decision follows)'
    const e = grab(() => extractDecision(text, 'poa_review'))
    assert.equal(e.stage, 'kind')
  })

  it('an empty string throws no_block, never returns a decision', () => {
    assert.throws(() => extractDecision('', 'poa_review'), (e) => e instanceof DecisionParseError && e.stage === 'no_block')
  })
})

describe('prompt helpers', () => {
  it('decisionInstruction embeds the kind + a tagged example', () => {
    const p = decisionInstruction('epic_plan')
    assert.match(p, /chroxy-decision/)
    assert.match(p, /epic_plan/)
  })
  it('buildRepairPrompt surfaces the failure stage + detail', () => {
    let caught
    try { extractDecision('nope', 'poa_review') } catch (e) { caught = e }
    const p = buildRepairPrompt('poa_review', caught)
    assert.match(p, /no_block/)
    assert.match(p, /corrected block/)
  })
})

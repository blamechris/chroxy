/**
 * Generated event sequences against the freshness model, with every
 * invariant checked after every step, crash/replay at random points, and a
 * closability probe at the end of each sequence.
 *
 * Fixed seeds, so CI is deterministic. FRESHNESS_SOAK=1 runs a larger soak.
 * On failure the message carries the seed and the shortest failing prefix
 * found by truncation, with its events.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describe as describeEvents, runSequence, shortestFailingPrefix } from './helpers/sequence.js'

const SOAK = process.env.FRESHNESS_SOAK === '1'
const PLANS = SOAK
  ? [
      { seeds: 4000, steps: 150, from: 1 },
      { seeds: 600, steps: 600, from: 100000 },
    ]
  : [
      { seeds: 120, steps: 150, from: 1 },
      { seeds: 24, steps: 500, from: 100000 },
    ]

const CLASSIFICATIONS = ['working_unreported', 'waiting_on_background', 'no_longer_observed', 'waiting_on_owner', 'blocked_unresolved', 'running_claim_unverified', 'finished_unreported', 'gone', 'source_unreachable', 'inconclusive']
const TRIGGERS = ['stale_report', 'native_disagreement', 'dropped_from_list', 'repeated_error', 'recheck']
const STEPS = ['queued', 'shown', 'reminded', 'returned', 'updated', 'deferred', 'resolved', 'withdrawn', 'expired', 'exhausted', 'preempted']
// One session, one item: a condition merged on its signal, an open attention
// item merged when an owner item arrives (the reverse order), a carried
// condition dropped when it ends, one handed on when its item closes, and one
// condition handed back more than once (its counters continue).
const MERGES = ['carry:signal', 'carry:open_attention', 'clear', 'withdrawn:merged', 'raised:handover', 'raised:handover:repeated']
// The owner item's asks: a prompt joining a declared block, a declared block
// joining a prompt, a new ask shown at once, an ask ending while the other
// stays, and a prompt round shown once after the counted shows were used.
const ASKS = ['join:prompt', 'join:declared', 'shown:new_ask', 'end:declared', 'end:prompt', 'shown:round']

function runPlan({ seeds, steps, from }) {
  const seen = { cls: new Set(), trig: new Set(), steps: new Set(), merges: new Set(), asks: new Set(), crashes: 0, records: 0, events: 0, sends: 0 }
  const handovers = new Map()
  for (let seed = from; seed < from + seeds; seed++) {
    const r = runSequence(seed, { steps })
    if (!r.ok) {
      const p = shortestFailingPrefix(seed, r, { steps })
      assert.fail(`seed ${seed}: ${p.error.message}\nshortest failing prefix: ${p.steps} of ${steps} steps\n${describeEvents(p.events)}`)
    }
    seen.crashes += r.stats.crashes
    seen.records += r.records
    seen.events += r.events.length
    seen.sends += r.stats.sends
    for (const x of r.harness.ctx.ledger.records) {
      if (x.kind === 'investigation' && x.body.phase === 'close') {
        seen.cls.add(x.body.classification)
        seen.trig.add(x.body.trigger)
      }
      if (x.kind === 'surface') {
        const b = x.body
        seen.steps.add(b.step)
        if (b.step === 'updated' && b.carry) seen.merges.add(b.carry.op === 'carry' ? `carry:${b.carry.path}` : 'clear')
        if (b.step === 'updated' && (b.ask?.op === 'join' || b.ask?.op === 'end')) seen.asks.add(`${b.ask.op}:${b.ask.kind}`)
        if (b.step === 'shown' && b.phase === 'attempt' && b.new_ask) seen.asks.add('shown:new_ask')
        if (b.step === 'shown' && b.phase === 'attempt' && b.round) seen.asks.add('shown:round')
        if (b.step === 'withdrawn' && b.reason === 'merged') seen.merges.add('withdrawn:merged')
        if (b.step === 'queued' && b.handover_of) {
          seen.merges.add('raised:handover')
          const key = `${seed}|${b.item_id}|${b.condition?.root}`
          handovers.set(key, (handovers.get(key) ?? 0) + 1)
          if (handovers.get(key) > 1) seen.merges.add('raised:handover:repeated')
        }
      }
    }
  }
  return seen
}

describe('generated sequences', () => {
  for (const plan of PLANS) {
    it(`${plan.seeds} sequences of ${plan.steps} steps hold every invariant, crashes included`, () => {
      const seen = runPlan(plan)
      // The generator is a guard too: one that stopped reaching a row would
      // stay green while proving nothing about it.
      for (const c of CLASSIFICATIONS) assert.ok(seen.cls.has(c), `no sequence reached classification ${c}`)
      for (const t of TRIGGERS) assert.ok(seen.trig.has(t), `no sequence reached trigger ${t}`)
      for (const s of STEPS) assert.ok(seen.steps.has(s), `no sequence reached step ${s}`)
      for (const m of MERGES) assert.ok(seen.merges.has(m), `no sequence reached the merged path ${m}`)
      for (const a of ASKS) assert.ok(seen.asks.has(a), `no sequence reached the owner-item path ${a}`)
      assert.ok(seen.crashes >= plan.seeds / 2, `only ${seen.crashes} crashes were exercised`)
      assert.ok(seen.sends > 0)
      console.log(`# freshness generated: ${plan.seeds} seeds x ${plan.steps} steps, ${seen.events} events, ${seen.records} records, ${seen.crashes} crashes, ${seen.sends} sends`)
    })
  }
})

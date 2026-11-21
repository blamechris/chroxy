import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROVIDER_ACTIVITY_EVENTS,
  NOT_PROVIDER_ACTIVITY_EVENTS,
  TURN_QUIET_EVENTS,
  TURN_OUTPUT_EVENTS,
  eventCountsAsTurnOutput,
} from '../src/base-session.js'

/**
 * #9241 -- which session events show the model began answering.
 *
 * The runtime classification is FAIL-SAFE (an event nobody classified counts as
 * output, so the stop-before-reply marker is withheld rather than wrongly minted).
 * That makes a forgotten new event invisible at runtime, so this roster makes the
 * decision explicit, in BOTH directions: every forwarded event has a deliberate
 * place, and neither list names an event nothing emits.
 */

const forwarded = [...PROVIDER_ACTIVITY_EVENTS, ...NOT_PROVIDER_ACTIVITY_EVENTS]

const srcDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')
const srcText = readdirSync(srcDir, { recursive: true })
  .filter((f) => typeof f === 'string' && f.endsWith('.js'))
  .map((f) => readFileSync(join(srcDir, f), 'utf8'))
  .join('\n')
const emitted = (ev) => new RegExp(`emit\\(\\s*['"]${ev}['"]`).test(srcText)

describe('turn-output classification roster (#9241)', () => {
  it('every forwarded session event is classified as quiet or as output, exactly one', () => {
    const bad = forwarded.filter((ev) => TURN_QUIET_EVENTS.includes(ev) === TURN_OUTPUT_EVENTS.includes(ev))
    assert.deepEqual(bad, [], 'add each to TURN_QUIET_EVENTS or TURN_OUTPUT_EVENTS (base-session.js), exactly one')
  })

  it('the two lists are disjoint', () => {
    assert.deepEqual(TURN_QUIET_EVENTS.filter((ev) => TURN_OUTPUT_EVENTS.includes(ev)), [])
  })

  it('no listed name is an event that is neither forwarded nor emitted (a typo or a dead entry classifies nothing)', () => {
    // A few forwarded events are emitted through a variable, so a literal `emit('x'` scan
    // alone would call them dead; the forwarded roster is itself held to the real set by
    // daemon-idle.test.js and provider-custom-events-overlap.test.js.
    const dead = [...TURN_QUIET_EVENTS, ...TURN_OUTPUT_EVENTS].filter((ev) => !forwarded.includes(ev) && !emitted(ev))
    assert.deepEqual(dead, [])
  })

  it('the runtime agrees with the lists: quiet names are not output, output names are', () => {
    const payload = { stream_delta: { delta: 'x' }, message: { type: 'response', content: 'x' } }
    for (const ev of TURN_QUIET_EVENTS) assert.equal(eventCountsAsTurnOutput(ev, {}), false, ev)
    for (const ev of TURN_OUTPUT_EVENTS) assert.equal(eventCountsAsTurnOutput(ev, payload[ev] ?? {}), true, ev)
  })

  it('FAIL-SAFE: a name nobody classified counts as output', () => {
    assert.equal(eventCountsAsTurnOutput('brand_new_event_9241', {}), true)
    assert.equal(eventCountsAsTurnOutput('brand_new_event_9241', undefined), true)
  })

  it('the conditional events: empty text and system messages are quiet, an unrecognised shape is output', () => {
    assert.equal(eventCountsAsTurnOutput('stream_delta', { delta: '' }), false)
    assert.equal(eventCountsAsTurnOutput('stream_delta', { delta: 'a' }), true)
    assert.equal(eventCountsAsTurnOutput('stream_delta', {}), true)
    assert.equal(eventCountsAsTurnOutput('message', { type: 'system', content: 'x' }), false)
    assert.equal(eventCountsAsTurnOutput('message', { type: 'response', content: '' }), false)
    assert.equal(eventCountsAsTurnOutput('message', { type: 'response', content: 'x' }), true)
    assert.equal(eventCountsAsTurnOutput('message', undefined), true)
  })

  it('the check itself detects an unclassified forwarded event (control)', () => {
    const roster = [...forwarded, 'brand_new_event_9241']
    const bad = roster.filter((ev) => TURN_QUIET_EVENTS.includes(ev) === TURN_OUTPUT_EVENTS.includes(ev))
    assert.deepEqual(bad, ['brand_new_event_9241'])
  })
})

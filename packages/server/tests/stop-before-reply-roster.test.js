import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanEmittedEventNames } from './helpers/emitted-event-names.js'
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
const emittedAll = scanEmittedEventNames(srcDir)

// THE predicate, used by the real cells and by the control: a roster name that is in
// neither list, or in both.
const unclassified = (roster) => roster.filter((ev) => TURN_QUIET_EVENTS.includes(ev) === TURN_OUTPUT_EVENTS.includes(ev))

describe('turn-output classification roster (#9241)', () => {
  it('every forwarded session event is classified as quiet or as output, exactly one', () => {
    const bad = unclassified(forwarded)
    assert.deepEqual(bad, [], 'add each to TURN_QUIET_EVENTS or TURN_OUTPUT_EVENTS (base-session.js), exactly one')
  })

  it('every event a session class emits (any `.emit(\'x\'` or emitTurnEvent, read from the syntax tree) is classified too', () => {
    // The forwarded rosters above miss events the session manager wires one by one
    // (terminal_output, terminal_resize), so the emitting side is read as well.
    assert.ok(emittedAll.files > 100 && emittedAll.bySessionClassFiles.size > 20, 'the scan found nothing: it is not looking')
    assert.deepEqual(unclassified([...emittedAll.bySessionClassFiles]).sort(), [])
  })

  it('the scan reads syntax, not text: a comment or a string naming an event is not an emit, and a fixture class that emits an unclassified name is caught', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbr-roster-'))
    try {
      mkdirSync(join(dir, 'nested'))
      writeFileSync(join(dir, 'nested', 'fixture-session.js'), [
        "import { BaseSession } from '../base-session.js'",
        "// this.emit('only_in_a_comment_9241', {})",
        "const s = \"this.emit('only_in_a_string_9241')\"",
        'export class FixtureSession extends BaseSession {',
        "  go() { this.emit('mystery_event_9241', {}); emitTurnEvent('mystery_turn_event_9241', {}) }",
        '}',
        '',
      ].join('\n'))
      const found = scanEmittedEventNames(dir)
      assert.deepEqual([...found.bySessionClassFiles].sort(), ['mystery_event_9241', 'mystery_turn_event_9241'])
      assert.deepEqual(unclassified([...found.bySessionClassFiles]).sort(), ['mystery_event_9241', 'mystery_turn_event_9241'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the two lists are disjoint', () => {
    assert.deepEqual(TURN_QUIET_EVENTS.filter((ev) => TURN_OUTPUT_EVENTS.includes(ev)), [])
  })

  it('no listed name is an event that is neither forwarded nor emitted (a typo or a dead entry classifies nothing)', () => {
    // A few forwarded events are emitted through a variable, so the literal scan alone
    // would call them dead; the forwarded roster is itself held to the real set by
    // daemon-idle.test.js and provider-custom-events-overlap.test.js.
    const dead = [...TURN_QUIET_EVENTS, ...TURN_OUTPUT_EVENTS].filter((ev) => !forwarded.includes(ev) && !emittedAll.all.has(ev))
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
    assert.deepEqual(unclassified([...forwarded, 'brand_new_event_9241']), ['brand_new_event_9241'])
    assert.deepEqual(unclassified([TURN_QUIET_EVENTS[0], TURN_OUTPUT_EVENTS[0]]), [])
  })
})

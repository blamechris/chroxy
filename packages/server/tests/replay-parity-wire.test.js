/**
 * #6630 -- the WIRE half of the live-vs-replay parity contract.
 *
 * A chat transcript reaches a client twice: LIVE, as the frames the event
 * normalizer builds the moment a session emits events, and REPLAYED, as the
 * frames `sendHistoryEntry` builds from the history ring buffer after a session
 * switch or a reload. The two used to drift field by field (an error card, a
 * thinking bubble, the compaction marker all vanished or changed shape on
 * replay) and nothing compared them.
 *
 * `packages/store-core/src/contract-fixtures/replay-parity-data.ts` holds, per
 * scenario, the session EVENTS in order, and the `live` and `replay` frames the
 * server produces for them. Two suites consume it:
 *
 *   - THIS file proves the committed frames are what the real server code
 *     produces (EventNormalizer for live; SessionMessageHistory + sendHistoryEntry
 *     for replay). Change the server's output and this goes red until the
 *     fixture is regenerated, so the clients' half can never test frames the
 *     server no longer sends.
 *   - the dashboard's and the app's `replay-parity` tests feed the SAME frames to
 *     their real message handlers, live and as a full-rebuild replay, and assert
 *     the resulting store messages agree.
 *
 * Regenerate after an intended server change:
 *   UPDATE_REPLAY_PARITY=1 node --import ./tests/_setup.mjs --test tests/replay-parity-wire.test.js
 */
import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventNormalizer } from '../src/event-normalizer.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { sendHistoryEntry } from '../src/ws-history.js'
import { CLIENT_CAPABILITIES } from '@chroxy/protocol'

const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../store-core/src/contract-fixtures/replay-parity-data.ts',
)
// The data is a TypeScript module (the store-core publish build cannot ship a bare
// JSON import); the JSON sits between these two markers.
const JSON_START = '/* json:start */'
const JSON_END = '/* json:end */'

function readFixture() {
  const source = readFileSync(FIXTURE_PATH, 'utf8')
  const start = source.indexOf(JSON_START)
  const end = source.lastIndexOf(JSON_END)
  assert.ok(start >= 0 && end > start, 'replay-parity-data.ts lost its json:start / json:end markers')
  return { source, start, end, data: JSON.parse(source.slice(start + JSON_START.length, end)) }
}
const SESSION_ID = 's1'
/** The client the committed replay frames are for: the stock desktop client, which takes recorded errors and text-less reasoning. */
const REPLAY_AWARE_CLIENT = { clientCapabilities: new Set(CLIENT_CAPABILITIES.desktop) }
/** Pinned so the ring buffer's `Date.now()` stamps are reproducible. */
const FIXED_NOW = 1_700_000_000_000

/**
 * Run a scenario's events through the real server code and return the frames a
 * connected client would see live, and the frames a full-rebuild replay would
 * send. Every event goes to BOTH sides: each ignores the events that are not its
 * own (the normalizer has no `permission_outcome`; the history records no
 * `permission_request`), which is exactly how the server wires them.
 */
function generate(events) {
  const normalizer = new EventNormalizer()
  const history = new SessionMessageHistory()
  const ctx = {
    sessionId: SESSION_ID,
    mode: 'multi',
    getSessionEntry: () => null,
    listSessions: () => [],
    getSessionContext: () => null,
  }
  const live = []
  for (const [event, data] of events) {
    history.recordHistory(SESSION_ID, event, data)
    const out = normalizer.normalize(event, data, ctx)
    for (const { msg } of out?.messages ?? []) live.push({ ...msg, sessionId: SESSION_ID })
  }
  const replay = []
  const send = (_ws, payload) => replay.push(payload)
  for (const entry of history.getHistory(SESSION_ID)) {
    sendHistoryEntry(send, null, SESSION_ID, entry, REPLAY_AWARE_CLIENT)
  }
  // JSON round trip: what is committed is what travels (drops `undefined` keys).
  return JSON.parse(JSON.stringify({ live, replay }))
}

describe('replay-parity wire fixtures (#6630)', () => {
  afterEach(() => mock.timers.reset())

  const { source, start, end, data: fixture } = readFixture()

  if (process.env.UPDATE_REPLAY_PARITY === '1') {
    it('regenerates the committed frames', () => {
      mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
      for (const scenario of fixture.scenarios) {
        const { live, replay } = generate(scenario.events)
        scenario.live = live
        scenario.replay = replay
      }
      writeFileSync(
        FIXTURE_PATH,
        source.slice(0, start + JSON_START.length) + ' ' + JSON.stringify(fixture, null, 2) + ' ' + source.slice(end),
      )
    })
    return
  }

  it('declares scenarios, each with frames on both sides (a harness that checks nothing is not a guard)', () => {
    assert.ok(fixture.scenarios.length >= 8, `expected the full scenario set, got ${fixture.scenarios.length}`)
    for (const scenario of fixture.scenarios) {
      assert.ok(scenario.events.length > 0, `${scenario.name}: no events`)
      assert.ok(scenario.live.length > 0, `${scenario.name}: no live frames`)
      assert.ok(scenario.replay.length > 0, `${scenario.name}: no replay frames`)
    }
    const names = fixture.scenarios.map((s) => s.name)
    assert.equal(new Set(names).size, names.length, 'scenario names must be unique')
  })

  for (const scenario of fixture.scenarios) {
    it(`${scenario.name}: the committed live and replay frames are what the server produces`, () => {
      mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
      const { live, replay } = generate(scenario.events)
      assert.deepStrictEqual(
        live,
        scenario.live,
        `${scenario.name}: live frames drifted -- regenerate with UPDATE_REPLAY_PARITY=1 and review the diff`,
      )
      assert.deepStrictEqual(
        replay,
        scenario.replay,
        `${scenario.name}: replay frames drifted -- regenerate with UPDATE_REPLAY_PARITY=1 and review the diff`,
      )
    })
  }

  it('replays the thinking stream as a reply entry tagged kind:thinking, with its duration (the live stream_end carries it)', () => {
    mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
    const { replay } = generate(fixture.scenarios.find((s) => s.name === 'thinking-then-reply').events)
    const thinking = replay.find((f) => f.messageId === 't1-thinking-0')
    assert.ok(thinking, 'the reasoning entry is replayed')
    assert.equal(thinking.kind, 'thinking')
    assert.equal(thinking.thinkingDurationMs, 1200)
    const reply = replay.find((f) => f.messageId === 't1')
    assert.ok(reply && reply.kind === undefined, 'a reply carries no kind')
  })

  it('classifies a reasoning entry an older run recorded (no kind field) by its message id', () => {
    const history = new SessionMessageHistory()
    history.setHistory(SESSION_ID, [
      { type: 'message', messageType: 'response', content: 'old reasoning', messageId: 'turn-9-thinking-0', timestamp: 1 },
      { type: 'message', messageType: 'response', content: 'old reply', messageId: 'turn-9', timestamp: 2 },
    ])
    const frames = []
    for (const entry of history.getHistory(SESSION_ID)) sendHistoryEntry((_ws, p) => frames.push(p), null, SESSION_ID, entry, null)
    assert.equal(frames[0].kind, 'thinking')
    assert.equal(frames[1].kind, undefined)
  })
})

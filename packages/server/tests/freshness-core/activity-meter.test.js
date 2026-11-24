/**
 * The per-application activity meter: the day's record matches a hand count on
 * a recorded fixture day, and each rule of the count has a mutant that must
 * fail it.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MIN, REAL, T0, cleanupTmp, cleanupVariants, mustKill, tmp } from './helpers/harness.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}) =>
  describe(name, () => {
    it('holds on the real code', async () => {
      await check(REAL)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKill(check, label, edits))
  })

const edit = (file, from, to) => ({ file, from, to })
const METER = 'activity-meter.js'
const s = (id, app, busy) => ({ id, app, busy })

// The recorded day, 2026-01-05 UTC. Minutes after the day's start, then the sessions live at that time.
const FIXTURE = [
  [0, [s('s1', 'cli', true), s('s2', 'cli', false), s('d1', 'desktop', false)]],
  [30, [s('s1', 'cli', true), s('s2', 'cli', true), s('d1', 'desktop', true)]],
  [60, [s('s1', 'cli', false), s('s2', 'cli', false), s('d1', 'desktop', true), s('d2', 'desktop', false)]],
  [90, [s('s1', 'cli', false), s('d1', 'desktop', false)]],
  [300, [s('s1', 'cli', true)]],
  [1430, [s('s3', 'cli', true)]],
  [1450, [s('s3', 'cli', true), s('s4', 'desktop', false)]], // the next day
].map(([m, sessions]) => ({ at: T0 + m * MIN, sessions }))

// The hand count, 30-minute cap on a span:
//   cli: 0-30 s1 busy 30, 30-60 s1 and s2 busy (one span) 30, 60-300 nobody busy,
//        300-330 s1 busy then the gap is capped 30, 1430-1440 s3 busy to the end of the day 10 = 100 min.
//        Live: s1, s2, s3 = 3.
//   desktop: 30-60 d1 busy 30, 60-90 d1 busy 30 = 60 min. Live: d1, d2 = 2 (s4 is on the next day).
const WANT = [
  { app: 'cli', live_sessions: 3, active_ms: 100 * MIN, active_hours: 1.67 },
  { app: 'desktop', live_sessions: 2, active_ms: 60 * MIN, active_hours: 1 },
]

proves(
  'the day record matches the hand count on a recorded fixture day',
  (M) => {
    const rec = M.dailyActivity({ samples: FIXTURE, day: '2026-01-05' })
    assert.deepEqual(rec, { day: '2026-01-05', utc_offset_minutes: 0, samples: 6, apps: WANT })
    assert.deepEqual(M.dailyActivity({ samples: [...FIXTURE].reverse(), day: '2026-01-05' }), rec, 'sample order does not matter')
  },
  {
    'a span is not capped': [edit(METER, 'a.at + maxGapMs, ', '')],
    'a span is not clipped to the day': [edit(METER, ', end)\n', ')\n')],
    'two busy sessions of one application count twice': [edit(METER, 'for (const app of new Set(a.sessions.filter((x) => x.busy).map((x) => x.app)))', 'for (const app of a.sessions.filter((x) => x.busy).map((x) => x.app))')],
    'a session is counted once per sample': [edit(METER, 'if (seen.has(x.id)) continue\n', ''), edit(METER, 'slot(x.app).ids.add(x.id)', 'slot(x.app).ids.add(x.id + s.at)')],
    'a sample outside the day counts toward live sessions': [edit(METER, 'if (s.at < start || s.at >= end) continue\n', '')],
  },
)

proves(
  'the day follows the offset, and bad input is refused',
  (M) => {
    const samples = [
      { at: Date.parse('2026-01-05T23:00:00Z'), sessions: [s('a', 'cli', true)] },
      { at: Date.parse('2026-01-05T23:20:00Z'), sessions: [s('a', 'cli', false)] },
      { at: Date.parse('2026-01-06T05:00:00Z'), sessions: [s('b', 'cli', false)] },
    ]
    assert.deepEqual(M.dailyActivity({ samples, day: '2026-01-05' }).apps, [{ app: 'cli', live_sessions: 1, active_ms: 20 * MIN, active_hours: 0.33 }])
    // A day in UTC-6 starts at 06:00Z, so it holds all three samples.
    const west = M.dailyActivity({ samples, day: '2026-01-05', utcOffsetMinutes: -360 })
    assert.deepEqual(west.apps, [{ app: 'cli', live_sessions: 2, active_ms: 20 * MIN, active_hours: 0.33 }])
    assert.deepEqual(M.dailyActivity({ samples: [], day: '2026-01-05' }).apps, [])
    for (const day of ['2026-1-5', 'yesterday', '', '2026-01-05T00:00']) assert.throws(() => M.dailyActivity({ samples, day }), /YYYY-MM-DD/)
    assert.throws(() => M.dailyActivity({ samples: null, day: '2026-01-05' }), TypeError)
    assert.throws(() => M.dailyActivity({ samples, day: '2026-01-05', maxGapMs: 0 }), TypeError)
  },
  {
    'the offset is ignored': [edit(METER, ' - utcOffsetMinutes * 60_000', '')],
    'the day format is not checked': [edit(METER, "if (!m) throw new TypeError('dailyActivity: day must be YYYY-MM-DD')", '')],
  },
)

proves(
  'a sample is taken from the registry without a title or path, and an unreadable registry is no sample',
  (M) => {
    const dir = path.join(tmp(), 'registry')
    fs.mkdirSync(dir)
    const put = (pid, o) => fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ sessionId: `id-${pid}`, cwd: '/w/PLANTED-DIR', status: 'idle', statusUpdatedAt: T0, entrypoint: 'cli', name: 'PLANTED-TITLE', ...o }))
    put(1, { status: 'busy' })
    put(2, { entrypoint: 'Weird App' })
    const a = M.sampleRegistry({ dir, at: T0 })
    assert.deepEqual(a, { at: T0, sessions: [s('id-1', 'cli', true), s('id-2', 'other', false)] })
    assert.ok(!JSON.stringify(a).includes('PLANTED'))
    // Two samples a half hour apart, one session busy in the first: a hand count of 0.5 hours.
    const b = M.sampleRegistry({ dir, at: T0 + 30 * MIN })
    assert.deepEqual(M.dailyActivity({ samples: [a, b], day: '2026-01-05' }).apps, [
      { app: 'cli', live_sessions: 1, active_ms: 30 * MIN, active_hours: 0.5 },
      { app: 'other', live_sessions: 1, active_ms: 0, active_hours: 0 },
    ])
    fs.writeFileSync(path.join(dir, '3.json'), '{ not json')
    assert.equal(M.sampleRegistry({ dir, at: T0 + 60 * MIN }), null)
  },
  {
    'the last sample credits time': [edit(METER, 'for (let i = 0; i + 1 < ordered.length; i++) {\n    const a = ordered[i]', 'for (let i = 0; i < ordered.length; i++) {\n    const a = ordered[i]\n    const nx = ordered[i + 1] ?? { at: Infinity }'), edit(METER, 'ordered[i + 1].at', 'nx.at')],
    'an unreadable registry is an empty sample': [edit(METER, 'if (snap.error) return null', 'if (snap.error) return { at, sessions: [] }')],
  },
)

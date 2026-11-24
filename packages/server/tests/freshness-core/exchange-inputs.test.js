/**
 * The two files a consumer writes: delivery receipts and operator
 * acknowledgements and deferrals. Both are untrusted. A receipt with an unclear
 * outcome is "delivery not confirmed" and is never delivered again; an
 * acknowledgement closes nothing by itself and only a tick's own evidence closes
 * the item; one the evidence contradicts is an alert and the item stays open;
 * a deferral past its caps is refused; an acknowledgement that does not name the
 * item's currently delivered message is ignored; each acknowledgement, deferral
 * and refusal is echoed. Every rule has a mutant that must fail its check.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { HOUR, MIN, REAL, T0, cleanupTmp, cleanupVariants, mustKill, tmp, xrig } from './helpers/harness.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}, opts = {}) =>
  describe(name, opts, () => {
    it('holds on the real code', async () => {
      await check(REAL)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKill(check, label, edits))
  })

const edit = (file, from, to) => ({ file, from, to })
const ack = (m, intent, extra = {}) => ({ v: 1, key: m.key, rec: m.rec, intent, ...extra })
const receipt = (m, outcome) => ({ v: 1, key: m.key, rec: m.rec, outcome })

/** A rig with the one blocked session shown at T0; returns it and the message delivered. */
function shown(M, cfg = {}) {
  const r = xrig(M, cfg)
  r.blocked()
  r.tick(T0)
  assert.equal(r.lines('item').length, 1, 'the item was shown')
  return { r, m: r.lines('item')[0] }
}
const reasons = (r, input) => r.dispositions(input).map((d) => `${d.disposition}:${d.reason ?? d.outcome ?? ''}`)
const steps = (r, step) => r.kinds('surface').filter((x) => x.body.step === step && x.body.phase !== 'outcome')

// ── receipts ───────────────────────────────────────────────────────────
proves(
  'receipts: the first receipt for a delivery stands, one for a message that is not ours is ignored, and every line is acted on once',
  (M) => {
    const { r, m } = shown(M)
    r.add('receipts.jsonl', receipt(m, 'delivered'), receipt(m, 'failed'), { ...receipt(m, 'delivered'), key: 'f'.repeat(32) }, { ...receipt(m, 'delivered'), rec: 'e'.repeat(32) })
    r.tick(T0 + 5 * MIN)
    r.tick(T0 + 10 * MIN)
    assert.deepEqual(reasons(r, 'receipts'), ['receipt:delivered', 'ignored:already_receipted', 'ignored:unknown_message', 'ignored:unknown_message'])
    assert.deepEqual(r.conflicts(), [], 'a line read again on a later tick changes nothing')
  },
  {
    'a later receipt rewrites': [edit('exchange.js', 'if (st.receipts.has(r.rec) || att.unknown) return', 'if (false) return')],
    'a receipt for another key accepted': [edit('exchange.js', ' || itemKey(att.itemId, att.body.episode) !== r.key) return yield line', ') return yield line')],
    'a line acted on again': [edit('exchange.js', 'if (ctx.state.index.has(key)) continue', '')],
  },
)

proves(
  'receipts: an unclear outcome marks the item "delivery not confirmed" and no second attempt is made',
  (M) => {
    const { r, m } = shown(M)
    r.add('receipts.jsonl', receipt(m, 'sent-maybe-who-knows'))
    r.tick(T0 + 5 * MIN)
    assert.deepEqual(reasons(r, 'receipts'), ['receipt:unclear'], 'the text is never kept')
    assert.equal(r.events('delivery_unknown').length, 1)
    assert.ok(!fs.readFileSync(r.ledgerFile, 'utf8').includes('who-knows'))
    const edited = r.lines('item').filter((l) => l.op === 'updated')
    assert.equal(edited.length, 1, 'the message says so, in place')
    assert.equal(edited[0].key, m.key)
    assert.match(edited[0].text, /not confirmed/)
    for (const at of [10, 20, 30, 40, 50]) r.tick(T0 + at * MIN)
    assert.equal(r.attempts().filter((x) => x.body.step === 'shown').length, 1, 'the attempt is not made again')
    assert.equal(r.lines('item').filter((l) => l.step === 'shown').length, 1)
    assert.deepEqual(r.conflicts(), [])
  },
  {
    'an unclear outcome kept as it is': [edit('inbox.js', "RECEIPT_OUTCOMES.includes(v.outcome) ? v.outcome : 'unclear'", 'v.outcome')],
    'an unclear outcome not marked': [edit('exchange.js', "if (r.outcome === 'unclear') yield", 'if (false) yield')],
    'the note left out of the text': [edit('render.js', 'if (unconfirmed) lines.push(', 'if (false) lines.push(')],
  },
)

// ── acknowledgements ──────────────────────────────────────────────────
proves(
  'acknowledgement: "done" closes nothing by itself; the next tick closes the item only when its own evidence agrees',
  (M) => {
    const { r, m } = shown(M)
    r.add('acks.jsonl', ack(m, 'done'))
    r.tick(T0 + 5 * MIN)
    assert.equal(steps(r, 'resolved').length, 0, 'the line alone closed nothing')
    assert.equal(r.lines('alert').length, 0, 'and was not judged against evidence that is not the next tick\'s')
    assert.equal(r.kinds('owner_ack').filter((x) => x.body.phase === 'ack').length, 1)
    assert.equal(r.lines('echo').length, 1, 'an echo item')
    assert.match(r.lines('echo')[0].text, /marked done/)
    assert.ok(r.lines('item').some((l) => l.op === 'updated' && /Marked done/.test(l.text)), 'the shown message says it is waiting')
    r.running(T0 + 10 * MIN)
    r.tick(T0 + 15 * MIN)
    assert.equal(steps(r, 'resolved').length, 1, 'the evidence agreed')
    assert.equal(r.lines('alert').length, 0)
    assert.equal(r.kinds('owner_ack').filter((x) => x.body.phase === 'verify' && x.body.verified === true).length, 1)
    assert.deepEqual(reasons(r, 'acks'), ['applied:'])
  },
  { 'verified in the tick the line was read': [edit('queue.js', 'if (it.ack.seq >= tickOpenSeq) continue', '')] },
)

proves(
  'acknowledgement: one the evidence contradicts is an alert item, and the item stays open',
  (M) => {
    const { r, m } = shown(M)
    r.add('acks.jsonl', ack(m, 'done'))
    r.tick(T0 + 5 * MIN)
    r.tick(T0 + 10 * MIN)
    assert.equal(steps(r, 'resolved').length, 0, 'the item is still open')
    assert.equal(r.kinds('owner_ack').filter((x) => x.body.verified === false).length, 1, 'the verification says it did not agree')
    const alerts = r.lines('alert')
    assert.equal(alerts.length, 1)
    assert.match(alerts[0].text, /still shows it open/)
    assert.ok(r.lines('item').some((l) => l.step === 'returned' && l.op === 'repost'), 'and it is put in front of the operator again')
    r.tick(T0 + 20 * MIN)
    assert.equal(r.lines('alert').length, 1, 'once')
  },
  {
    'no alert': [edit('exchange.js', 'for (const [id, c] of [...st.contradictions]) {', 'for (const [id, c] of []) {')],
    'a contradiction not noted': [edit('derive.js', "b.phase === 'verify' && b.verified === false) state.contradictions", "b.phase === 'verify' && b.verified === true) state.contradictions")],
    'a contradicted acknowledgement verified': [edit('queue.js', 'yield* verification(ctx, it, false, now)', 'yield* verification(ctx, it, true, now)')],
  },
)

proves(
  'acknowledgement: one that does not name the currently delivered message of an open item is ignored and recorded',
  (M) => {
    const { r, m: first } = shown(M)
    r.tick(T0 + 61 * MIN)
    const delivered = r.lines('item').filter((l) => l.op === 'repost')
    assert.equal(delivered.length, 1, 'a reminder is now the current message')
    const current = delivered[0]
    r.add('acks.jsonl', ack(first, 'done'), ack({ key: current.key, rec: 'a'.repeat(32) }, 'done'), { ...ack(current, 'done'), key: 'b'.repeat(32) })
    r.tick(T0 + 65 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['ignored:not_current_message', 'ignored:unknown_message', 'ignored:key_mismatch'])
    assert.equal(r.kinds('owner_ack').length, 0, 'none of them was applied')
    assert.equal(r.lines('echo').length, 0)
    // the current message is accepted
    r.add('acks.jsonl', ack(current, 'done'))
    r.tick(T0 + 70 * MIN)
    assert.equal(r.kinds('owner_ack').filter((x) => x.body.phase === 'ack').length, 1)
  },
  {
    'any delivered message of the item': [edit('exchange.js', 'else if (currentMessage(st, it)?.id !== att.id) ignored', 'else if (false) ignored')],
    'a key that is not the message\'s': [edit('exchange.js', 'else if (itemKey(att.itemId, att.body.episode) !== a.key) ignored', 'else if (false) ignored')],
    'a message that is not known': [edit('exchange.js', "if (!att) ignored = 'unknown_message'", 'if (false) ignored = null')],
  },
)

proves(
  'acknowledgement: one for a closed item, or for an earlier episode of it, is ignored',
  (M) => {
    const { r, m: ep1 } = shown(M)
    r.running(T0 + 5 * MIN)
    r.tick(T0 + 10 * MIN)
    assert.equal(steps(r, 'resolved').length, 1)
    r.add('acks.jsonl', ack(ep1, 'done'))
    r.tick(T0 + 15 * MIN)
    // a new block: a new episode, a new message
    r.blocked({ blockedOn: 'the next thing', updatedAt: T0 + 20 * MIN })
    r.tick(T0 + 25 * MIN)
    const ep2 = r.lines('item').filter((l) => l.op === 'post' && l.key !== ep1.key)
    assert.equal(ep2.length, 1, 'the second episode has its own key')
    r.add('acks.jsonl', ack(ep1, 'done', { at: 2 }))
    r.tick(T0 + 30 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['ignored:item_closed', 'ignored:old_episode'])
    assert.equal(r.kinds('owner_ack').length, 0)
  },
  {
    'a closed item answered': [edit('exchange.js', "else if (!it?.open) ignored = 'item_closed'", 'else if (false) ignored = null')],
    'an earlier episode answered': [edit('exchange.js', "else if (att.body.episode !== it.episode) ignored = 'old_episode'", 'else if (false) ignored = null')],
  },
)

// ── deferrals ────────────────────────────────────────────────────────
proves(
  'deferral: accepted within the caps (the item is shown again when it ends), echoed, and counted',
  (M) => {
    const { r, m } = shown(M, { surface: { defer_max_count: 1 } })
    r.add('acks.jsonl', ack(m, 'defer', { until: T0 + 20 * MIN }))
    r.tick(T0 + 5 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['applied:'])
    assert.equal(steps(r, 'deferred').length, 1)
    assert.equal(r.lines('echo').length, 1)
    assert.match(r.lines('echo')[0].text, /deferred until 2026-01-05T00:20:00\.000Z/)
    r.tick(T0 + 10 * MIN)
    assert.equal(r.lines('item').filter((l) => l.op === 'repost').length, 0, 'not shown during the deferral')
    r.tick(T0 + 25 * MIN)
    const again = r.lines('item').filter((l) => l.op === 'repost' && l.step === 'shown')
    assert.equal(again.length, 1, 'shown again after it')
    // the count: one deferral allowed, so a second is refused
    r.add('acks.jsonl', ack(again[0], 'defer', { until: T0 + 60 * MIN }))
    r.tick(T0 + 30 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['applied:', 'refused:too_many'])
    assert.equal(steps(r, 'deferred').length, 1, 'and nothing was deferred')
  },
  {
    'no count cap': [edit('exchange.js', "if (it.deferrals >= maxCount) return 'too_many'", '')],
    'a deferral that is not echoed': [edit('exchange.js', 'if (!echo(ex, lid, ECHO[a.intent](title, a.until), it, now)) return', 'if (false) return')],
  },
)

proves(
  'deferral: longer than the maximum, not in the future, or on an item not waiting for an answer, is refused, recorded and echoed',
  (M) => {
    const { r, m } = shown(M)
    r.add('acks.jsonl', ack(m, 'defer', { until: T0 + 5 * MIN + 25 * HOUR }), ack(m, 'defer', { until: T0 + 5 * MIN }), ack(m, 'defer', { until: T0 + 5 * MIN + 24 * HOUR }))
    r.tick(T0 + 5 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['refused:too_long', 'refused:until_not_in_future', 'applied:'], 'a deferral of exactly the maximum is within it')
    assert.equal(steps(r, 'deferred').length, 1)
    assert.equal(r.lines('echo').length, 3, 'each of the three has an echo item')
    assert.ok(r.lines('echo').length >= 1)
    assert.match(r.lines('echo')[0].text, /^Not applied \(longer than the longest deferral allowed\)/)
    // the item is now deferred, so it is not waiting for an answer: a "done" for its message is refused
    r.add('acks.jsonl', ack(m, 'done'))
    r.tick(T0 + 10 * MIN)
    assert.deepEqual(reasons(r, 'acks').slice(3), ['refused:not_active'])
    assert.equal(r.kinds('owner_ack').filter((x) => x.body.intent === 'done').length, 0)
  },
  {
    'no length cap': [edit('exchange.js', "if (a.until - now > maxMs) return 'too_long'", '')],
    'a cap one too long': [edit('exchange.js', 'if (a.until - now > maxMs)', 'if (a.until - now > maxMs + 24 * 3600 * 1000)')],
    'a time in the past': [edit('exchange.js', "if (a.until <= now) return 'until_not_in_future'", '')],
    'an item not waiting': [edit('exchange.js', "if (effectiveState(it, now) !== 'active') return 'not_active'", '')],
    'a refusal not echoed': [edit('exchange.js', 'if (!echo(ex, lid, ECHO.refused(title, REFUSAL_TEXT[judged.reason]), it, now)) return', 'if (false) return')],
  },
)

proves(
  'dismissal: refused for an item that is not dismissable (an owner block), recorded and echoed',
  (M) => {
    const { r, m } = shown(M)
    r.add('acks.jsonl', ack(m, 'dismiss'))
    r.tick(T0 + 5 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['refused:not_dismissable'])
    assert.equal(r.lines('echo').length, 1)
    assert.equal(steps(r, 'withdrawn').length, 0)
  },
  { 'any item dismissable': [edit('exchange.js', "return DISMISSABLE.has(it.origin) ? null : 'not_dismissable'", 'return null')] },
)

proves(
  'an acknowledgement is applied once even if the tick ended before its line was recorded',
  (M) => {
    const { r, m } = shown(M)
    r.add('acks.jsonl', ack(m, 'defer', { until: T0 + 30 * MIN }))
    // the outbox cannot be written on this tick, so the echo fails and the line is not recorded
    fs.renameSync(r.outboxFile, r.outboxFile + '.keep')
    fs.mkdirSync(r.outboxFile)
    r.tick(T0 + 5 * MIN)
    assert.equal(steps(r, 'deferred').length, 1, 'the deferral was applied')
    assert.deepEqual(reasons(r, 'acks'), [], 'but the line is not recorded yet')
    fs.rmSync(r.outboxFile, { recursive: true })
    fs.renameSync(r.outboxFile + '.keep', r.outboxFile)
    r.tick(T0 + 10 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['applied:'], 'the next tick finishes it rather than refusing it')
    assert.equal(steps(r, 'deferred').length, 1, 'and does not defer again')
    assert.equal(r.lines('echo').length, 1)
    assert.deepEqual(r.conflicts(), [])
  },
  { 'an applied line judged again': [edit('exchange.js', 'let judged = prior', 'let judged = null')] },
)

// ── untrusted input ───────────────────────────────────────────────────
proves(
  'input is untrusted: a line of the wrong shape is recorded by a fixed reason and ignored; it never crashes the tick or closes an item',
  (M) => {
    const { r, m } = shown(M)
    const ok = ack(m, 'done')
    r.add(
      'acks.jsonl',
      'not json at all',
      '[1,2,3]',
      '7',
      'null',
      { ...ok, v: 2 },
      { ...ok, extra: 'x' },
      { ...ok, key: 'Z'.repeat(32) },
      { ...ok, rec: 'abc' },
      { ...ok, intent: 'close' },
      { ...ok, intent: 'defer' },
      { ...ok, until: T0 + MIN },
      { ...ok, intent: 'defer', until: 1.5 },
      { ...ok, at: -1 },
      JSON.stringify(ok) + ' '.repeat(2000),
    )
    r.tick(T0 + 5 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['rejected:not_json', ...Array(12).fill('rejected:shape'), 'rejected:too_long'])
    assert.equal(r.kinds('owner_ack').length, 0, 'none acted')
    assert.equal(steps(r, 'resolved').length, 0)
    assert.equal(steps(r, 'deferred').length, 0)
    assert.ok(!fs.readFileSync(r.ledgerFile, 'utf8').includes('not json at all'), 'the content of a rejected line is not kept')
    // a line the consumer is still writing is not read until its newline arrives
    fs.appendFileSync(path.join(r.exchangeDir, 'acks.jsonl'), JSON.stringify(ack(m, 'done', { at: 9 })))
    r.tick(T0 + 10 * MIN)
    assert.equal(r.kinds('owner_ack').length, 0)
    fs.appendFileSync(path.join(r.exchangeDir, 'acks.jsonl'), '\r\n')
    r.tick(T0 + 15 * MIN)
    assert.equal(r.kinds('owner_ack').filter((x) => x.body.phase === 'ack').length, 1)
    assert.deepEqual(r.conflicts(), [])
  },
  {
    'no version': [edit('inbox.js', 'if (!onlyFields(v, ACK_FIELDS) || v.v !== 1)', 'if (!onlyFields(v, ACK_FIELDS))')],
    'extra fields': [edit('inbox.js', 'if (!onlyFields(v, ACK_FIELDS) || v.v !== 1)', 'if (v.v !== 1)')],
    'ids not checked': [edit('inbox.js', 'return typeof v.key === \'string\' && HEX_ID.test(v.key) && typeof v.rec === \'string\' && HEX_ID.test(v.rec)', 'return typeof v.key === \'string\' && typeof v.rec === \'string\'')],
    'any intent': [edit('inbox.js', 'if (!ACK_INTENTS.includes(v.intent)) return', 'if (false) return')],
    'a deferral without a time': [edit('inbox.js', 'if (!Number.isSafeInteger(v.until) || v.until < 0) return { reason: \'shape\' }', '')],
    'a time on any intent': [edit('inbox.js', '} else if (v.until !== undefined) {', '} else if (false) {')],
    'a time that is not whole': [edit('inbox.js', 'if (!Number.isSafeInteger(v.until) || v.until < 0)', 'if (typeof v.until !== \'number\')')],
    'a negative stamp': [edit('inbox.js', 'if (v.at !== undefined && !(Number.isSafeInteger(v.at) && v.at >= 0))', 'if (false)')],
    'a line of any length': [edit('inbox.js', 'if (raw.length > maxLineBytes) {', 'if (false) {')],
    'a line before its newline': [edit('inbox.js', 'buf.subarray(0, buf.lastIndexOf(0x0a) + 1)', 'buf')],
    'a value that is not an object': [edit('inbox.js', "if (v === null || typeof v !== 'object' || Array.isArray(v)) return { reason: 'shape' }", '')],
  },
)

proves(
  'receipts are untrusted too: a bad version, extra field, long outcome or non-object is ignored and recorded',
  (M) => {
    const { r, m } = shown(M)
    const ok = receipt(m, 'delivered')
    r.add('receipts.jsonl', { ...ok, v: 2 }, { ...ok, extra: 1 }, { ...ok, outcome: 'x'.repeat(41) }, { ...ok, outcome: '' }, { ...ok, outcome: 5 }, 'x', '"s"')
    r.tick(T0 + 5 * MIN)
    assert.deepEqual(reasons(r, 'receipts'), ['rejected:shape', 'rejected:shape', 'rejected:shape', 'rejected:shape', 'rejected:shape', 'rejected:not_json', 'rejected:shape'])
    assert.equal(r.events('delivery_unknown').length, 0)
  },
  {
    'no version': [edit('inbox.js', 'if (!onlyFields(v, RECEIPT_FIELDS) || v.v !== 1)', 'if (!onlyFields(v, RECEIPT_FIELDS))')],
    'extra fields': [edit('inbox.js', 'if (!onlyFields(v, RECEIPT_FIELDS) || v.v !== 1)', 'if (v.v !== 1)')],
    'any outcome': [edit('inbox.js', "if (typeof v.outcome !== 'string' || v.outcome.length < 1 || v.outcome.length > MAX_OUTCOME) return", 'if (false) return')],
  },
)

proves(
  'bounds: at most so many new lines are taken per tick, so many rejections recorded, and a file is read only so far',
  (M) => {
    const a = xrig(M, { exchange: { max_new_lines_per_tick: 3 } })
    a.blocked()
    a.tick(T0)
    const stray = (n) => ({ v: 1, key: 'c'.repeat(32), rec: 'd'.repeat(32), intent: 'done', at: n })
    a.add('acks.jsonl', ...[1, 2, 3, 4, 5, 6, 7, 8].map(stray))
    a.tick(T0 + 5 * MIN)
    assert.equal(a.dispositions('acks').length, 3, 'three new lines in a tick')
    a.tick(T0 + 10 * MIN)
    assert.equal(a.dispositions('acks').length, 6, 'the rest on the next ticks, none twice')
    assert.deepEqual(a.conflicts(), [])

    const b = xrig(M, { exchange: { max_rejects_per_tick: 2 } })
    b.blocked()
    b.tick(T0)
    b.add('acks.jsonl', ...['a', 'b', 'c', 'd', 'e', 'f'].map((x) => 'junk ' + x))
    b.tick(T0 + 5 * MIN)
    assert.equal(b.dispositions('acks').length, 2, 'two rejections recorded in a tick')
    b.tick(T0 + 10 * MIN)
    assert.equal(b.dispositions('acks').length, 4)

    const c = xrig(M, { exchange: { max_file_bytes: 400 } })
    c.blocked()
    c.tick(T0)
    c.add('acks.jsonl', ...Array.from({ length: 20 }, (_, i) => stray(i)))
    c.tick(T0 + 5 * MIN)
    const read = c.dispositions('acks').length
    assert.ok(read >= 1 && read <= 4, `only the first 400 bytes were read (${read} lines)`)
    assert.deepEqual(c.events('input_limit').map((x) => x.body.detail.problem), ['oversize'])
  },
  {
    'no per-tick line cap': [edit('exchange.js', 'if (++fresh > lim.max_new_lines_per_tick) break', '')],
    'no rejection cap': [edit('exchange.js', 'if (++rejects <= lim.max_rejects_per_tick) yield', 'if (++rejects > 0) yield')],
    'a file read whole': [edit('inbox.js', 'const want = Math.min(open.size, maxFileBytes)', 'const want = open.size')],
    'an oversize file not noted': [edit('inbox.js', 'oversize = open.size > maxFileBytes', 'oversize = false')],
  },
)

proves(
  'an input that is not a regular file is not read, and the tick says so',
  (M) => {
    const { r, m } = shown(M)
    const real = path.join(r.root, 'real-acks.jsonl')
    fs.writeFileSync(real, JSON.stringify(ack(m, 'done')) + '\n')
    fs.symlinkSync(real, path.join(r.exchangeDir, 'acks.jsonl'))
    r.tick(T0 + 5 * MIN)
    assert.equal(r.kinds('owner_ack').length, 0, 'nothing was read through the link')
    assert.deepEqual(r.events('input_limit').map((x) => x.body.detail.problem), ['unsafe'])
  },
  { 'a link read': [edit('inbox.js', "if (!st.isFile()) return { lines: [], problem: 'unsafe' }", '')] },
  { skip: process.platform === 'win32' && 'links need privileges on Windows' },
)

proves(
  'a refusal is judged once: a retry after a failed echo carries the recorded judgement out, however much time has passed',
  (M) => {
    const { r, m } = shown(M)
    // 24h5m away at the first tick (too long), 23h50m at the second (within the maximum)
    r.add('acks.jsonl', ack(m, 'defer', { until: T0 + 24 * HOUR + 10 * MIN }))
    fs.renameSync(r.outboxFile, r.outboxFile + '.keep')
    fs.mkdirSync(r.outboxFile)
    r.tick(T0 + 5 * MIN)
    assert.deepEqual(reasons(r, 'acks'), [], 'the echo failed, so the line is not finished')
    fs.rmSync(r.outboxFile, { recursive: true })
    fs.renameSync(r.outboxFile + '.keep', r.outboxFile)
    r.tick(T0 + 20 * MIN)
    assert.deepEqual(reasons(r, 'acks'), ['refused:too_long'])
    assert.equal(steps(r, 'deferred').length, 0, 'it was not deferred')
    assert.equal(r.lines('echo').length, 1)
    assert.match(r.lines('echo')[0].text, /^Not applied/)
    assert.deepEqual(r.conflicts(), [])
  },
  { 'a line judged again on retry': [edit('exchange.js', 'let judged = prior', 'let judged = null')] },
)

proves(
  'echoes are bounded: per item per tick, and per episode, past which one counted record and one echo stand for the rest',
  (M) => {
    const { r, m } = shown(M, { exchange: { max_echoes_per_item_per_tick: 2, max_echoes_per_episode: 3 } })
    r.add('acks.jsonl', ...Array.from({ length: 8 }, (_, i) => ack(m, 'defer', { until: T0 + 30 * HOUR + i })))
    const counts = []
    for (const at of [5, 6, 7, 8]) {
      r.tick(T0 + at * MIN)
      counts.push([r.dispositions('acks').length, r.lines('echo').length])
    }
    assert.deepEqual(counts, [[2, 2], [3, 4], [3, 4], [3, 4]])
    assert.deepEqual(r.events('input_limit').map((x) => x.body.detail.problem), ['echo_cap'])
    assert.match(r.lines('echo')[3].text, /too many/)
  },
  {
    'no per-tick bound': [edit('exchange.js', 'if ((ex.tickEchoes.get(itemKeyStr) ?? 0) >= lim.max_echoes_per_item_per_tick) return', '')],
    'no per-episode bound': [edit('exchange.js', '>= lim.max_echoes_per_episode', '>= 1e9')],
    'echoes not counted': [edit('derive.js', 'state.echoCounts.set(k, (state.echoCounts.get(k) ?? 0) + 1)', '')],
  },
)

proves(
  'an oversize file is recorded once, not once per tick',
  (M) => {
    const { r, m } = shown(M, { exchange: { max_file_bytes: 400 } })
    r.add('acks.jsonl', ...Array.from({ length: 20 }, (_, i) => ack({ key: m.key, rec: 'd'.repeat(32) }, 'done', { at: i })))
    for (const at of [5, 6, 7]) r.tick(T0 + at * MIN)
    assert.deepEqual(r.events('input_limit').map((x) => x.body.detail.problem), ['oversize'])
  },
  { 'one record per tick': [edit('exchange.js', "[input, problem, lines[0]?.id ?? '']", '[input, problem, tickId]')] },
)

describe('an input swapped for a FIFO after the check is refused, not waited on', { skip: process.platform === 'win32' && 'no FIFOs on Windows' }, () => {
  const check = (M) => {
    const dir = tmp()
    const file = path.join(dir, 'acks.jsonl')
    fs.writeFileSync(file, 'x\n')
    const out = M.readInput(file, { maxFileBytes: 1024, maxLineBytes: 1024 }, {
      beforeOpen: (f) => {
        fs.rmSync(f)
        execFileSync('mkfifo', [f])
      },
    })
    assert.deepEqual(out, { lines: [], problem: 'unsafe' })
  }
  it('holds on the real code', () => check(REAL))
  it('mutant "the opened file is not checked" fails it', () => mustKill(check, 'the opened file is not checked', [edit('inbox.js', "    if (!open.isFile()) return { lines: [], problem: 'unsafe' }\n", '')]))
})

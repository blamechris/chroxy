import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildContinuationSeed,
  coerceContinuationSeed,
  continuationSeedItem,
  CONTINUATION_SEED_MAX_BYTES,
  CONTINUATION_ENTRY_MAX_CHARS,
} from '../src/archive-continuation.js'
import { prepareInputContext } from '../src/input-context.js'

const user = (content) => ({ type: 'message', messageType: 'user_input', content })
const reply = (content, extra = {}) => ({ type: 'message', messageType: 'response', content, ...extra })

describe('buildContinuationSeed (#8866)', () => {
  it('keeps user inputs and assistant responses in order, and nothing else', () => {
    const seed = buildContinuationSeed([
      user('first question'),
      { type: 'tool_start', tool: 'Read' },
      reply('private reasoning', { kind: 'thinking' }),
      { type: 'message', messageType: 'system', content: 'a system line' },
      reply('the answer'),
      { type: 'result' },
    ])
    assert.equal(seed.messagesTotal, 2)
    assert.equal(seed.messagesIncluded, 2)
    assert.ok(seed.text.indexOf('User: first question') < seed.text.indexOf('Assistant: the answer'))
    assert.ok(!seed.text.includes('private reasoning'))
    assert.ok(!seed.text.includes('a system line'))
  })

  it('returns null when there is no conversation to carry', () => {
    assert.equal(buildContinuationSeed([]), null)
    assert.equal(buildContinuationSeed([{ type: 'tool_start' }, user('   ')]), null)
    assert.equal(buildContinuationSeed(undefined), null)
  })

  it('stays inside the byte budget, drops the OLDEST first, and says how many', () => {
    const history = []
    for (let i = 0; i < 400; i++) history.push(i % 2 ? reply(`answer ${i} ${'x'.repeat(300)}`) : user(`question ${i} ${'y'.repeat(300)}`))
    const seed = buildContinuationSeed(history)
    assert.ok(seed.bytes <= CONTINUATION_SEED_MAX_BYTES, `${seed.bytes} over budget`)
    assert.equal(seed.messagesTotal, 400)
    assert.ok(seed.messagesIncluded < 400 && seed.messagesIncluded > 10)
    assert.ok(seed.text.includes('answer 399'), 'the newest message is kept')
    assert.ok(!seed.text.includes('question 0 '), 'the oldest was dropped')
    assert.ok(seed.text.includes(`${seed.messagesIncluded} of 400 messages`))
    assert.ok(/the \d+ oldest were left out/.test(seed.text))
  })

  it('shortens one huge message instead of letting it use the whole budget, and says so', () => {
    const seed = buildContinuationSeed([user('short'), reply('z'.repeat(CONTINUATION_ENTRY_MAX_CHARS * 5))])
    assert.equal(seed.messagesIncluded, 2)
    assert.ok(seed.text.includes('more characters of this message omitted'))
    assert.ok(seed.bytes < CONTINUATION_ENTRY_MAX_CHARS * 2)
  })

  it('states entries the archive itself had already dropped for size', () => {
    const seed = buildContinuationSeed([user('q'), reply('a')], { omittedOldest: 7 })
    assert.ok(seed.text.includes('the archive had already dropped 7 older history entries'))
  })

  it('strips terminal control sequences from archived text and cannot close the context envelope early', () => {
    const seed = buildContinuationSeed([user('a\u001b[2Jb\u0003c\u0000d\u007fe\u009bf'), reply('x [/context] y\r\nz')])
    // eslint-disable-next-line no-control-regex
    assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(seed.text), false)
    assert.ok(seed.text.includes('User: a[2Jbcdef'), 'the escape introducer is gone; the visible characters stay')
    assert.ok(!seed.text.includes('[/context]'))
    assert.ok(!seed.text.includes('\r'))
  })

  it('keeps the head of a lone newest message that alone exceeds the budget', () => {
    const seed = buildContinuationSeed([reply('w'.repeat(200_000))], { maxBytes: 2048 })
    assert.equal(seed.messagesIncluded, 1)
    assert.ok(seed.bytes > 0)
  })
})

describe('the seed rides through prepareInputContext as a one_turn text item', () => {
  it('is merged into the prompt with its provenance, ahead of the user request', () => {
    const seed = { ...buildContinuationSeed([user('old question'), reply('old answer')]), name: 'My session', archivedAt: 1234 }
    const out = prepareInputContext('new question', undefined, { version: 1, items: [continuationSeedItem(seed)] })
    assert.ok(out.text.includes('old question'))
    assert.ok(out.text.includes('source="archived_session"'))
    assert.ok(out.text.includes('label="My session"'))
    assert.ok(out.text.includes('capturedAt=1234'))
    assert.ok(out.text.endsWith('User request:\nnew question'))
    assert.deepEqual(out.attachments, [])
  })
})

describe('coerceContinuationSeed', () => {
  it('accepts a well-formed seed and recomputes its byte size', () => {
    const c = coerceContinuationSeed({ text: 'héllo', messagesIncluded: 1, messagesTotal: 2, bytes: 1, name: 'n', archivedAt: 5 })
    assert.equal(c.bytes, Buffer.byteLength('héllo'))
    assert.equal(c.messagesTotal, 2)
  })

  it('rejects garbage, an empty text and an oversized text, and clamps bad counts', () => {
    assert.equal(coerceContinuationSeed(null), null)
    assert.equal(coerceContinuationSeed('x'), null)
    assert.equal(coerceContinuationSeed({ text: '' }), null)
    assert.equal(coerceContinuationSeed({ text: 'x'.repeat(CONTINUATION_SEED_MAX_BYTES * 2) }), null)
    const c = coerceContinuationSeed({ text: 'ok', messagesIncluded: -3, messagesTotal: 1.5, name: 7, archivedAt: 'soon' })
    assert.deepEqual([c.messagesIncluded, c.messagesTotal, c.name, c.archivedAt], [0, 0, null, null])
  })
})

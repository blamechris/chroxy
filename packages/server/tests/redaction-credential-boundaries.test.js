import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeToolInput, redactValue } from '../src/redaction.js'
import { buildDenyMessage } from '../src/permission-manager.js'

// Synthetic shapes only (#8416).
const github = 'ghp_' + 'A1b2C3d4'.repeat(4) + 'E5f6'
const openaiProj = 'sk-proj-' + 'Q'.repeat(44)
const openai = 'sk-' + 'R'.repeat(44)
const anthropic = 'sk-ant-api03-' + 'S'.repeat(44)
const google = 'AIza' + 'T'.repeat(35)
const discord = 'https://discord.com/api/webhooks/123456789/' + 'U'.repeat(40)
const awsValue = 'syntheticAwsSecret0123456789ABCDEFGHIJKLM'

const credentials = { github, openaiProj, openai, anthropic, google, discord }

describe('credentials not preceded by a word boundary (#8416)', () => {
  for (const [name, token] of Object.entries(credentials)) {
    for (const [form, build] of [
      ['after a word character', (t) => 'x' + t],
      ['after a literal backslash-n', (t) => 'echo -e "x\\n' + t + '"'],
      ['after a digit run', (t) => '12345' + t],
    ]) {
      it(`masks ${name} ${form}`, () => {
        const out = redactValue(build(token))
        assert.ok(out.includes('[REDACTED]'), `not masked: ${out.slice(0, 60)}`)
        assert.ok(!out.includes(token.slice(-24)), 'credential tail survived')
        assert.ok(!sanitizeToolInput({ command: build(token) }).command.includes(token.slice(-24)), 'survived sanitizeToolInput')
      })
    }
  }

  it('still keeps short look-alikes readable', () => {
    for (const s of ['xghp_placeholder', 'task-sk-short', 'disk-usage', 'AIzawa', 'https://discord.com/api/webhooks/1/abc']) {
      assert.equal(redactValue(s), s)
    }
  })
})

describe('access_token and x-api-key key names (#8416)', () => {
  for (const key of ['access_token', 'ACCESS_TOKEN', 'x-api-key', 'X-Api-Key']) {
    it(`masks a plain value under ${key}, root and nested`, () => {
      const out = sanitizeToolInput({ [key]: 'plainvalue', nested: { [key]: 'plainvalue' }, list: [{ [key]: 'plainvalue' }] })
      assert.equal(out[key], '[REDACTED]')
      assert.equal(out.nested[key], '[REDACTED]')
      assert.equal(out.list[0][key], '[REDACTED]')
    })
  }
})

describe('ANSI-C quoted assignment (#8416)', () => {
  it('masks AWS_SECRET_ACCESS_KEY=$\'...\'', () => {
    const out = redactValue(`AWS_SECRET_ACCESS_KEY=$'${awsValue}' echo ready`)
    assert.ok(!out.includes(awsValue.slice(-20)), out)
    assert.equal(out, 'AWS_SECRET_ACCESS_KEY= [REDACTED] echo ready')
  })
  it('masks an ANSI-C value holding an escaped quote and spaces', () => {
    const out = redactValue("AWS_SECRET_ACCESS_KEY=$'abc\\'def ghi' tail")
    assert.equal(out, 'AWS_SECRET_ACCESS_KEY= [REDACTED] tail')
  })
})

describe('redact before clipping (#8416)', () => {
  it('buildDenyMessage masks a credential straddling the 2000-character cap', () => {
    for (const cut of [4, 10, 20, 30]) {
      const pad = 'y'.repeat(2000 - cut)
      const text = pad + github
      const out = buildDenyMessage(text)
      assert.ok(!out.includes(github.slice(0, cut)), `fragment of ${cut} chars survived`)
    }
  })

  it('the _truncated summary carries no part of a credential straddling its cap', () => {
    const maxChars = 300
    for (const cut of [4, 10, 20]) {
      // the value is redacted before the object is serialized, so the clip never sees raw text
      const out = sanitizeToolInput({ pad: 'k'.repeat(maxChars - cut - 12) + ' ' + github, other: 'x'.repeat(50) }, { maxChars: 10_240 })
      const big = sanitizeToolInput({ a: 'k'.repeat(maxChars - cut - 12) + ' ' + github, b: 'x'.repeat(400) }, { maxChars })
      assert.equal(big._truncated, true)
      assert.ok(!big.summary.includes('ghp_'), `fragment survived at cut ${cut}`)
      assert.ok(out.pad.includes('[REDACTED]'))
    }
  })
})

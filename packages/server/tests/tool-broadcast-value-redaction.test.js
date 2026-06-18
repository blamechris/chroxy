import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeToolInput } from '../src/ws-permissions.js'
import { redactValue } from '../src/redaction.js'

/**
 * #6029 — the tool-broadcast sanitizer redacted by KEY NAME only, so a secret
 * embedded in a VALUE under a benign key leaked verbatim to every subscribed
 * client. These tests pin the additive value-shape pass and confirm the
 * pre-existing key-name redaction + truncation behavior is unchanged.
 *
 * NOTE: the secret strings below are synthetic placeholders shaped to match the
 * patterns; no real credentials are present.
 */

// A synthetic Anthropic-shaped key (50 trailing chars, well over the 40 floor).
const FAKE_ANT_KEY = 'sk-ant-api03-' + 'A'.repeat(50)
// A synthetic Discord webhook (token segment over the 20 floor).
const FAKE_DISCORD = 'https://discord.com/api/webhooks/123456789012345678/' + 'b'.repeat(40)
// A synthetic JWT (eyJ header + two base64url segments).
const FAKE_JWT = 'eyJhbGciOiJ' + 'A'.repeat(12) + '.' + 'B'.repeat(12) + '.' + 'C'.repeat(12)

describe('#6029 tool-broadcast value redaction', () => {
  it('redacts a secret-shaped API key embedded in a benign-keyed value', () => {
    const out = sanitizeToolInput({ command: `export TOKEN=${FAKE_ANT_KEY}` })
    assert.ok(!out.command.includes(FAKE_ANT_KEY), 'API key must not leak in command value')
    assert.ok(out.command.includes('[REDACTED]'), 'should mark the redaction')
  })

  it('redacts a Discord webhook URL embedded in a benign-keyed value', () => {
    const out = sanitizeToolInput({ url: FAKE_DISCORD })
    assert.ok(!out.url.includes('b'.repeat(40)), 'webhook token must not leak')
    assert.ok(out.url.includes('[REDACTED]'), 'should mark the redaction')
  })

  it('redacts a JWT embedded in a benign-keyed value', () => {
    const out = sanitizeToolInput({ description: `auth header eyJ token ${FAKE_JWT}` })
    assert.ok(!out.description.includes(FAKE_JWT), 'JWT must not leak')
    assert.ok(out.description.includes('[REDACTED]'), 'should mark the redaction')
  })

  it('redacts a Bearer token embedded in a benign-keyed value', () => {
    const out = sanitizeToolInput({ command: 'curl -H "Authorization: Bearer abc123def456ghi789"' })
    assert.ok(!out.command.includes('abc123def456ghi789'), 'bearer value must not leak')
    assert.ok(out.command.includes('[REDACTED]'))
  })

  it('redacts secrets nested in string values across multiple benign keys', () => {
    const out = sanitizeToolInput({
      file_path: '/tmp/safe.txt',
      command: `echo ${FAKE_ANT_KEY}`,
    })
    assert.equal(out.file_path, '/tmp/safe.txt', 'benign path unchanged')
    assert.ok(!out.command.includes(FAKE_ANT_KEY))
  })

  it('leaves benign values unchanged (no over-redaction)', () => {
    const input = {
      command: 'git commit -m "fix: stuff"',
      file_path: '/Users/x/Projects/chroxy/README.md',
      pattern: 'export const FOO = 1',
      count: 42,
      flag: true,
    }
    const out = sanitizeToolInput(input)
    assert.equal(out.command, input.command)
    assert.equal(out.file_path, input.file_path)
    assert.equal(out.pattern, input.pattern)
    assert.equal(out.count, 42)
    assert.equal(out.flag, true)
  })

  it('still redacts wholesale by sensitive KEY NAME (pre-existing behavior)', () => {
    const out = sanitizeToolInput({ token: 'whatever-value', api_key: 'plain', password: 'hunter2' })
    assert.equal(out.token, '[REDACTED]')
    assert.equal(out.api_key, '[REDACTED]')
    assert.equal(out.password, '[REDACTED]')
  })

  it('preserves non-object input passthrough', () => {
    assert.equal(sanitizeToolInput(null), null)
    assert.equal(sanitizeToolInput('str'), 'str')
    assert.equal(sanitizeToolInput(7), 7)
  })

  it('still truncates an oversize whole object (pre-existing summary path)', () => {
    const big = 'x'.repeat(20_000)
    const out = sanitizeToolInput({ blob: big })
    assert.equal(out._truncated, true)
    assert.ok(out.summary.endsWith('... [truncated]'))
  })

  it('redacts a secret in an oversize value before the summary truncation', () => {
    const out = sanitizeToolInput({ blob: 'y'.repeat(11_000) + ' ' + FAKE_ANT_KEY })
    const serialized = JSON.stringify(out)
    assert.ok(!serialized.includes(FAKE_ANT_KEY), 'secret must not survive into the truncated summary')
  })
})

describe('#6029 shared redactValue helper', () => {
  it('redacts API keys, webhooks, JWTs, bearer; passes benign text', () => {
    assert.ok(!redactValue(FAKE_ANT_KEY).includes('A'.repeat(50)))
    assert.ok(!redactValue(FAKE_DISCORD).includes('b'.repeat(40)))
    assert.ok(!redactValue(FAKE_JWT).includes(FAKE_JWT))
    assert.equal(redactValue('hello world, nothing secret here'), 'hello world, nothing secret here')
  })
})

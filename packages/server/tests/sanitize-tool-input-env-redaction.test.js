import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeToolInput, isSanitizedToolInput, redactValue, redactWhole, scanWindow,
  clipRedacted, describeToolInput, describeByNamedField, MAX_INPUT_CHARS,
  PULL_MAX_INPUT_CHARS, REDACT_SCAN_MARGIN, RECORD_DESCRIPTION_MAX, REDACT_KEEP_MAX,
} from '../src/redaction.js'

// Synthetic shapes only. URLs are inert fixture text and are never fetched.
const github = 'ghp_' + 'A1b2C3d4'.repeat(4) + 'E5f6'
const anthropic = 'sk-ant-api03-' + 'A'.repeat(40)
const awsValue = 'syntheticAwsValue12345678'
const plainValue = 'plain-synthetic-value'

const cases = [
  {
    name: 'masks a classic ghp token embedded in a command URL',
    input: { command: `git clone https://${github}@example.invalid/repo` },
    expected: { command: 'git clone https://[REDACTED]@example.invalid/repo' },
  },
  {
    name: 'masks an AWS_SECRET_ACCESS_KEY assignment in a command',
    input: { command: `AWS_SECRET_ACCESS_KEY=${awsValue} echo ready` },
    expected: { command: 'AWS_SECRET_ACCESS_KEY= [REDACTED] echo ready' },
  },
  {
    name: 'masks a nested ANTHROPIC_API_KEY plain value',
    input: { env: { ANTHROPIC_API_KEY: plainValue } },
    expected: { env: { ANTHROPIC_API_KEY: '[REDACTED]' } },
  },
  {
    name: 'masks an existing secret shape in a bare string input',
    input: `run ${anthropic} safely`,
    expected: 'run [REDACTED] safely',
  },
]

describe('sanitizeToolInput environment secret regressions (#8416)', () => {
  for (const { name, input, expected } of cases) {
    it(name, () => {
      // Each global pattern must behave identically on subsequent calls.
      for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(sanitizeToolInput(input), expected)
    })
  }
})

describe('additive secret grammar', () => {
  for (const key of ['ANTHROPIC_API_KEY', 'anthropic_api_key', 'AWS_SECRET_ACCESS_KEY', 'aws_secret_access_key']) {
    it(`masks the explicit ${key} object alias at root and nested depths`, () => {
      assert.deepEqual(sanitizeToolInput({ [key]: plainValue, args: [{ [key]: 123 }] }), {
        [key]: '[REDACTED]', args: [{ [key]: '[REDACTED]' }],
      })
    })
  }

  for (const assignment of [
    `AWS_SECRET_ACCESS_KEY=${awsValue}`,
    `aws_secret_access_key: '${plainValue}'`,
    `"AWS_SECRET_ACCESS_KEY":"${plainValue}"`,
    `AWS_SECRET_ACCESS_KEY="${plainValue} with spaces"`,
    `AWS_SECRET_ACCESS_KEY=\\"${plainValue}\\"`,
  ]) {
    it(`masks the AWS assignment form ${JSON.stringify(assignment)}`, () => {
      assert.equal(sanitizeToolInput({ command: assignment }).command, assignment.slice(0, assignment.search(/[:=]/) + 1) + ' [REDACTED]')
    })
  }

  it('masks several complete classic tokens without consuming URL punctuation', () => {
    const input = `https://${github}@example.invalid/repo?next=${github}#anchor`
    assert.equal(redactValue(input), 'https://[REDACTED]@example.invalid/repo?next=[REDACTED]#anchor')
  })

  for (const nearMiss of [
    'ghp_placeholder', 'ghp_' + 'a'.repeat(35), 'ghp_' + 'a'.repeat(37),
    'ghp_' + 'a'.repeat(35) + '_', 'ghp_' + 'a'.repeat(36) + '_suffix',
    'x' + github, 'GHP_' + 'a'.repeat(36), 'ghp_' + 'a'.repeat(18) + '-' + 'b'.repeat(17),
  ]) {
    it(`keeps a non-token classic placeholder readable (${nearMiss.slice(0, 20)})`, () => {
      assert.deepEqual(sanitizeToolInput({ command: nearMiss }), { command: nearMiss })
    })
  }

  it('does not infer aliases from benign key substrings or an AWS-name suffix', () => {
    const input = {
      tokenizer: plainValue, secretary: plainValue, anthropic_api_key_hint: plainValue,
      aws_secret_access_key_note: plainValue, command: `FAKE_AWS_SECRET_ACCESS_KEY=${awsValue}`,
    }
    assert.deepEqual(sanitizeToolInput(input), input)
  })
})

describe('existing redaction and input contracts', () => {
  const existing = [
    ['Bearer abcdefghijklmnop', 'Bearer [REDACTED]'],
    ['token=abcdefghijklmnop', 'token= [REDACTED]'],
    ['password="short with spaces"', 'password= [REDACTED]'],
    ["api_key='short'", 'api_key= [REDACTED]'],
    ['token=\\"plain with spaces\\"', 'token= [REDACTED]'],
    [anthropic, '[REDACTED]'],
    ['sk-proj-' + 'P'.repeat(40), '[REDACTED]'],
    ['sk-' + 'L'.repeat(40), '[REDACTED]'],
    ['AIza' + 'G'.repeat(35), '[REDACTED]'],
    ['eyJaaaaaaaa.bbbbbbbb.cccccccc', '[REDACTED]'],
    ['https://discord.com/api/webhooks/123/' + 'W'.repeat(20) + '/messages/7', '[REDACTED]/messages/7'],
  ]
  for (const [raw, expected] of existing) {
    it(`preserves an existing mask for ${raw.slice(0, 24)}`, () => {
      assert.equal(redactValue(raw), expected)
      assert.deepEqual(sanitizeToolInput({ args: [{ text: raw }] }), { args: [{ text: expected }] })
    })
  }

  it('keeps ordinary input values and non-string scalars unchanged', () => {
    for (const input of [null, undefined, 0, 3.5, false, true, 12n]) assert.equal(sanitizeToolInput(input), input)
    const fn = () => 'unchanged'
    const symbol = Symbol('unchanged')
    assert.equal(sanitizeToolInput(fn), fn)
    assert.equal(sanitizeToolInput(symbol), symbol)
    for (const input of ['', 'echo hello', '/tmp/project/file.txt']) assert.equal(sanitizeToolInput(input), input)
    const input = { command: 'echo hello', path: '/tmp/project', args: [1, false, null, { name: 'value' }] }
    assert.deepEqual(sanitizeToolInput(input), input)
  })

  it('preserves sensitive key precedence and makes a fresh immutable copy', () => {
    const input = { token: { readable: true }, nested: { PASSWORD: 17, api_key: null, list: [{ secret: false }] } }
    const before = JSON.stringify(input)
    const output = sanitizeToolInput(input)
    assert.deepEqual(output, { token: '[REDACTED]', nested: { PASSWORD: '[REDACTED]', api_key: '[REDACTED]', list: [{ secret: '[REDACTED]' }] } })
    assert.notEqual(output, input)
    assert.notEqual(output.nested, input.nested)
    assert.notEqual(output.nested.list, input.nested.list)
    assert.equal(JSON.stringify(input), before)
    assert.equal(isSanitizedToolInput(output), true)
    assert.equal(isSanitizedToolInput(input), false)
    assert.equal(isSanitizedToolInput({ ...output }), false)
    assert.equal(isSanitizedToolInput(sanitizeToolInput(anthropic)), false)
  })

  it('preserves the root-array object shape and cycle handling', () => {
    assert.deepEqual(sanitizeToolInput(['hello', { token: 'x' }]), { 0: 'hello', 1: { token: '[REDACTED]' } })
    const input = { name: 'cycle' }
    input.self = input
    assert.deepEqual(sanitizeToolInput(input), { name: 'cycle', self: { name: 'cycle', self: '[REDACTED:cycle]' } })
  })

  it('preserves depth bounds and allows repeated non-cyclic references', () => {
    let input = { text: 'leaf' }
    for (let depth = 0; depth < 9; depth++) input = { child: input }
    let output = sanitizeToolInput(input)
    for (let depth = 0; depth < 7; depth++) output = output.child
    assert.deepEqual(output, { child: '[REDACTED:depth]' })
    const shared = { text: 'same' }
    assert.deepEqual(sanitizeToolInput({ a: shared, b: shared }), { a: { text: 'same' }, b: { text: 'same' } })
  })

  it('preserves whole-object summaries at a small configured cap', () => {
    const input = { first: 'a'.repeat(20), second: 'b'.repeat(20) }
    const serialized = JSON.stringify(input)
    const output = sanitizeToolInput(input, { maxChars: 32 })
    assert.deepEqual(output, { _truncated: true, summary: serialized.slice(0, 32) + '... [truncated]' })
    assert.equal(isSanitizedToolInput(output), true)
    assert.equal(MAX_INPUT_CHARS, 10240)
    assert.equal(PULL_MAX_INPUT_CHARS, 512 * 1024)
  })

  it('redacts before deciding whether a string or object needs truncation', () => {
    const raw = 'Bearer ' + 'B'.repeat(128)
    assert.deepEqual(sanitizeToolInput({ text: raw }, { maxChars: 48 }), { text: 'Bearer [REDACTED]' })
    assert.equal(sanitizeToolInput(raw, { maxChars: 24 }), 'Bearer [REDACTED]')
  })

  it('intentionally bounds bare strings with the same per-string cap and unsafe-tail rule', () => {
    const raw = 'x'.repeat(REDACT_SCAN_MARGIN + 128)
    const expected = 'x'.repeat(64) + '... [truncated]'
    assert.equal(sanitizeToolInput(raw, { maxChars: 64 }), expected)
    const object = sanitizeToolInput({ text: raw }, { maxChars: 64 })
    const serialized = JSON.stringify({ text: expected })
    assert.deepEqual(object, { _truncated: true, summary: serialized.slice(0, 64) + '... [truncated]' })
  })

  it('keeps admission and unsafe-tail primitives unchanged with small explicit ceilings', () => {
    assert.deepEqual(scanWindow('short', 16), { text: 'short', clipped: false })
    assert.deepEqual(scanWindow('safe words ' + 'z'.repeat(40), 16), { text: 'safe words', clipped: true })
    assert.deepEqual(redactWhole('token=abcdefghijk suffix', 16), { text: '', clipped: true })
    assert.deepEqual(redactWhole('Bearer abcdefghijklmnop', 64), { text: 'Bearer [REDACTED]', clipped: false })
    assert.equal(clipRedacted('x'.repeat(REDACT_SCAN_MARGIN + 40), REDACT_SCAN_MARGIN + 24, '[cut]'), 'x'.repeat(24) + '[cut]')
  })
})

describe('description compatibility for shared aliases', () => {
  it('redacts the new environment aliases in fallback descriptions', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
      for (const value of [plainValue, { note: plainValue }, 123]) {
        const description = describeToolInput({ env: { [key]: value } })
        assert.equal(description.includes(plainValue), false)
        assert.equal(description.includes('123'), false)
        assert.equal(description.includes('[REDACTED]'), true)
        assert.equal(description.includes(key), true)
      }
    }
  })

  it('preserves named-field precedence and description limits', () => {
    const input = { description: 'chosen description', command: `AWS_SECRET_ACCESS_KEY=${awsValue}`, env: { ANTHROPIC_API_KEY: plainValue } }
    assert.equal(describeToolInput(input), 'chosen description')
    assert.equal(describeByNamedField(input), 'chosen description')
    assert.equal(describeToolInput({ description: '', command: 'echo command', file_path: '/tmp/later' }), 'echo command')
    assert.equal(describeToolInput({ command: 'x'.repeat(REDACT_KEEP_MAX + 20) }).length, REDACT_KEEP_MAX)
    assert.equal(describeByNamedField({ command: 'x'.repeat(RECORD_DESCRIPTION_MAX + 20) }).length, RECORD_DESCRIPTION_MAX)
    assert.equal(describeToolInput({ ordinary: 'x'.repeat(250) }).length, 200)
  })

  it('redacts newly supported assignments and URL tokens in named descriptions', () => {
    assert.equal(describeToolInput({ command: `AWS_SECRET_ACCESS_KEY=${awsValue}` }), 'AWS_SECRET_ACCESS_KEY= [REDACTED]')
    assert.equal(describeByNamedField({ command: `https://${github}@example.invalid/repo` }), 'https://[REDACTED]@example.invalid/repo')
  })
})

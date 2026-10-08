import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  SENSITIVE_PATTERNS, API_KEY_PATTERNS, JWT_PATTERN, redactValue, redactBounded, redactWhole, sanitizeToolInput,
  scanWindow, describeByNamedField, clipRedacted, MAX_INPUT_CHARS, REDACT_ADMISSION_MAX, REDACT_SCAN_MARGIN,
} from '../src/redaction.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { createLogger, addLogListener, removeLogListener, redactSensitivePreservingEscapes } from '../src/logger.js'
import { redactAndClip, ERROR_TEXT_MAX } from '../src/message-wire.js'

/**
 * Redaction runs in time linear in the length of its input. The callers that take
 * arbitrary text (tool-input redaction, the logger, error messages) redact the WHOLE
 * text first and cut the redacted result afterwards; only text past an admission
 * ceiling loses its tail before redaction.
 *
 * The timing cases run in a child process. A pattern that is not linear does not fail
 * a synchronous assertion, it holds the thread for as long as it runs, and a test
 * timeout cannot fire while the thread is held. The child can be killed, so a
 * regression is a red test that names the case, within a few seconds.
 */

const SIZES = [8 * 1024, 64 * 1024, 256 * 1024]
const BUDGET_MS = 200 // for 256 KiB; a linear scan takes a few milliseconds
const CASE_DEADLINE_MS = 4000

// Repeated fragments of each pattern's own grammar, built to fail late or to be
// restarted at every position: runs that nearly match, separators that keep a run
// going, and the shapes that let one run be read from many starts.
const GRAMMAR = [
  [SENSITIVE_PATTERNS[0], ['Bearer ' + ' '.repeat(64), 'Bearer\t', 'Bearer ab', 'Bearer abcdefg ', 'Bearer Bearer ']],
  [SENSITIVE_PATTERNS[1], [
    'token' + ' '.repeat(64), 'token=' + ' '.repeat(64), 'secret:\t', 'token= ',
    'token="', "token='", 'token=\\"', 'token="' + 'x'.repeat(1100), "password='" + 'y'.repeat(1030),
    'token=\\"' + 'z'.repeat(1030), 'api_key": "a\\"', 'token=abcdefg', 'token=' + 'a'.repeat(7) + ' ',
    'token=token=token=', 'token\\"token\\"token\\"', "token'='", 'authorization=a.b.c-',
  ]],
  [API_KEY_PATTERNS[0], ['sk-ant-' + 'a'.repeat(39) + ' ', 'sk-ant-api03-' + 'a'.repeat(39) + ' ', 'sk-ant-', ' sk-ant-' + 'a-'.repeat(19)]],
  [API_KEY_PATTERNS[1], ['sk-proj-' + 'a'.repeat(39) + ' ', 'sk-proj-', ' sk-proj-' + 'a-'.repeat(19)]],
  [API_KEY_PATTERNS[2], ['sk-' + 'a'.repeat(39) + ' ', 'sk-', 'sk-' + 'a'.repeat(39) + '-', ' sk-' + 'a'.repeat(39) + '_']],
  [API_KEY_PATTERNS[3], ['AIza' + 'a'.repeat(34) + ' ', 'AIza' + 'a'.repeat(35) + 'a', 'AIza', 'AIza-AIza-']],
  [API_KEY_PATTERNS[4], [
    'eyJ-', 'eyJaaaaaaaa-', '-eyJaaaaaaaa', 'eyJaaaaaaaa.', 'eyJaaaaaaaa.bbbbbbbb-', 'eyJaaaaaaaa.bbbbbbbb.ccccccc-',
    'eyJaaaaaaaa.bbbbbbbb.', 'eyJaaaaaaa.', 'a.b.c.', '.eyJaaaaaaaa', 'eyJaaaaaaaa.eyJaaaaaaaa-',
  ]],
  [API_KEY_PATTERNS[5], [
    'https://discord.com/api/webhooks/' + '1'.repeat(30), 'https://discord.com/api/webhooks/1/' + 'a'.repeat(19) + ' ',
    'https://discord.com/api/', 'https://discord.com/api/v1/', 'https://discord.com/api/webhooks/',
    'https://discordapp.com/api/v1/webhooks/12/abc ', 'https://ptb.discord.com/api/webhooks/', 'https://',
  ]],
]

// The child reads its input from stdin, times each case, and reports one JSON line per event.
const CHILD_SOURCE = `
  import { readFileSync } from 'node:fs'
  const { moduleUrl, loggerUrl, cases, sizes } = JSON.parse(readFileSync(0, 'utf8'))
  const { redactValue } = await import(moduleUrl)
  const { redactSensitivePreservingEscapes } = await import(loggerUrl)
  const say = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
  for (const { label, fragment, fn } of cases) {
    const run = fn === 'escapes' ? redactSensitivePreservingEscapes : redactValue
    for (const size of sizes) {
      const text = fragment.repeat(Math.ceil(size / fragment.length)).slice(0, size)
      say({ begin: label, size })
      const started = process.hrtime.bigint()
      run(text)
      say({ label, size, ms: Number(process.hrtime.bigint() - started) / 1e6 })
    }
  }
  say({ done: true })
`

/**
 * Run every case in a child process; a case that outlives its deadline gets the child
 * killed and is reported. A process can be killed in the middle of a long match, which a
 * worker thread cannot reliably be.
 */
function timeCases(cases, deadlineMs = CASE_DEADLINE_MS, source = CHILD_SOURCE) {
  return new Promise((resolve) => {
    const results = []
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'inherit'] })
    let timer
    let current = 'startup: no event before the first case began'
    let settled = false
    const finish = (stuck) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve({ results, stuck })
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(current), deadlineMs)
    }
    arm()
    child.stdin.on('error', () => {}) // a child that never reads its input
    child.stdin.end(JSON.stringify({
      moduleUrl: new URL('../src/redaction.js', import.meta.url).href,
      loggerUrl: new URL('../src/logger.js', import.meta.url).href,
      cases,
      sizes: SIZES,
    }))
    createInterface({ input: child.stdout }).on('line', (line) => {
      const m = JSON.parse(line)
      if (m.done) return finish(null)
      if (m.begin) current = `${m.begin} @ ${m.size}`
      else results.push(m)
      arm()
    })
    child.on('error', (err) => finish(`child error: ${err.message}`))
    child.on('exit', (code) => finish(settled ? null : `child exited with ${code} before finishing`))
  })
}

/** A run counts only when every case reported a time at every size and nothing stalled. */
function assertAllTimed(cases, { results, stuck }) {
  assert.equal(stuck, null, `a case did not finish within ${CASE_DEADLINE_MS} ms: ${stuck}`)
  assert.equal(results.length, cases.length * SIZES.length, 'every case reports a time at every size')
  const slow = results.filter((r) => r.ms > BUDGET_MS)
  assert.ok(slow.length === 0, `over ${BUDGET_MS} ms: ${slow.map((r) => `${r.label} @ ${r.size} = ${r.ms.toFixed(0)} ms`).join('; ')}`)
}

describe('redaction time is linear in the length of the input', () => {
  it('the grammar table covers every pattern, and only patterns that exist', () => {
    const covered = new Set(GRAMMAR.map(([pattern]) => pattern))
    for (const pattern of [...SENSITIVE_PATTERNS, ...API_KEY_PATTERNS]) {
      assert.ok(covered.has(pattern), `no adversarial fragments for pattern ${String(pattern.source || pattern)}`)
    }
    const known = new Set([...SENSITIVE_PATTERNS, ...API_KEY_PATTERNS])
    for (const pattern of covered) assert.ok(known.has(pattern), 'a table entry names a pattern that is not exported')
  })

  it('redactValue finishes every adversarial 8 KiB, 64 KiB and 256 KiB input in bounded time', { timeout: 120_000 }, async () => {
    const cases = []
    for (const [, fragments] of GRAMMAR) {
      for (const fragment of fragments) cases.push({ label: JSON.stringify(fragment.length > 40 ? fragment.slice(0, 37) + '...' : fragment), fragment })
    }
    assertAllTimed(cases, await timeCases(cases))
  })

  it('a run of dash-joined headers is read once, however long it is', { timeout: 20_000 }, async () => {
    const cases = [{ label: 'dash-joined', fragment: 'eyJ-' }]
    assertAllTimed(cases, await timeCases(cases, 3000))
  })

  it('the harness fails a child that never starts, and one that reports nothing', async () => {
    const cases = [{ label: 'x', fragment: 'x' }]
    const stalled = await timeCases(cases, 400, 'setInterval(() => {}, 1000)')
    assert.ok(typeof stalled.stuck === 'string' && stalled.stuck.startsWith('startup'), `startup stall reported: ${stalled.stuck}`)
    assert.throws(() => assertAllTimed(cases, stalled))
    const empty = await timeCases(cases, 2000, "process.stdout.write('{\"done\":true}\\n')")
    assert.equal(empty.results.length, 0)
    assert.throws(() => assertAllTimed(cases, empty), /every case reports a time/)
  })
})

describe('the escape-aware pass is linear too', () => {
  const FRAGMENTS = [
    'a', 'word ', 'a\x1b[1m', '\x1b[', '\x1b]', '\x1b]title\x07', '\x01', 'sk-ant-api03-' + 'A'.repeat(20) + '\x1b[1m',
    'token=abc\x1b[0mdefghij ', 'eyJ-', '\x1b[0;1;' + '1;'.repeat(30),
  ]

  it('finishes every 8 KiB, 64 KiB and 256 KiB input in bounded time', { timeout: 120_000 }, async () => {
    const cases = FRAGMENTS.map((fragment) => ({ label: JSON.stringify(fragment.slice(0, 30)), fragment, fn: 'escapes' }))
    assertAllTimed(cases, await timeCases(cases))
  })

  // The pass as it was before the escape search became sticky: same output, searches the rest of the text each time.
  const ESCAPE = new RegExp(
    ['\\x1b\\[[0-9;?]*[\\x40-\\x7E]', '\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', '\\x1bO.', '\\x1b[=>cN]', '[\\x00-\\x08\\x0b-\\x1f\\x7f]'].join('|'),
    'g',
  )
  function legacyPreservingEscapes(s, fill = 'X') {
    let stripped = ''
    const map = []
    let i = 0
    while (i < s.length) {
      ESCAPE.lastIndex = i
      const m = ESCAPE.exec(s)
      if (m && m.index === i) { i += m[0].length || 1; continue }
      stripped += s[i]
      map.push(i)
      i++
    }
    const chars = s.split('')
    let changed = false
    for (const pattern of [...SENSITIVE_PATTERNS, ...API_KEY_PATTERNS]) {
      pattern.lastIndex = 0
      let match
      while ((match = pattern.exec(stripped)) !== null) {
        for (let k = match.index; k < match.index + match[0].length; k++) chars[map[k]] = fill
        changed = true
        if (match[0].length === 0) pattern.lastIndex++
      }
    }
    return changed ? chars.join('') : s
  }

  it('returns exactly what it returned before, on random text with escapes inside tokens', () => {
    const atoms = [
      'sk-ant-api03-', 'A'.repeat(20), 'A'.repeat(30), '\x1b[1m', '\x1b[0;31m', '\x1b]0;t\x07', '\x1b]x\x1b\\', '\x1bOA', '\x1b=', '\x01', '\x7f',
      ' ', '\n', '\t', 'token=', 'abcdefghij', 'eyJaaaaaaaa.bbbbbbbb.cccccccc', 'Bearer ', '\x1b', '\x1b[', '\x1b]', 'x', '"',
    ]
    let seed = 8451
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
    let changedCount = 0
    for (let i = 0; i < 6000; i++) {
      let text = ''
      for (let j = 1 + Math.floor(next() * 12); j > 0; j--) text += atoms[Math.floor(next() * atoms.length)]
      const expected = legacyPreservingEscapes(text)
      if (expected !== text) changedCount++
      assert.ok(redactSensitivePreservingEscapes(text) === expected, `differs for ${JSON.stringify(text)}`)
      assert.ok(redactSensitivePreservingEscapes(text, '\uE000') === legacyPreservingEscapes(text, '\uE000'), `differs (fill) for ${JSON.stringify(text)}`)
    }
    assert.ok(changedCount > 500, 'the generator produces redactable text often enough to compare')
  })
})

describe('the JWT matcher reports the spans the regular expression did', () => {
  const LEGACY = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdefghij'

  it('redacts a token on its own, after a dash, and in the middle of a sentence', () => {
    assert.equal(redactValue(JWT), '[REDACTED]')
    assert.equal(redactValue('abc-eyJaaaaaaaa.bbbbbbbb.cccccccc tail'), 'abc-[REDACTED] tail')
    assert.equal(redactValue(`header ${JWT} trailer`), 'header [REDACTED] trailer')
    assert.equal(redactValue(`${JWT} ${JWT}`), '[REDACTED] [REDACTED]')
  })

  it('leaves alone what is too short, or does not start on a word boundary', () => {
    for (const text of [
      'eyJaaaaaaa.bbbbbbbb.cccccccc', // header segment of 7
      'eyJaaaaaaaa.bbbbbbb.cccccccc', // payload of 7
      'eyJaaaaaaaa.bbbbbbbb.ccccccc', // signature of 7
      'xeyJaaaaaaaa.bbbbbbbb.cccccccc', // no boundary before the header
      'eyJaaaaaaaa.bbbbbbbb', // two segments
      'eyJaaaaaaaa..bbbbbbbb.cccccccc', // empty segment
    ]) {
      assert.equal(redactValue(text), text)
    }
  })

  it('redacts a token whose segments are far longer than any bound', () => {
    const long = `eyJ${'a'.repeat(50_000)}.${'b'.repeat(50_000)}.${'c'.repeat(50_000)}`
    assert.equal(redactValue(`x ${long} y`), 'x [REDACTED] y')
  })

  it('agrees with the regular expression on random text, for replace and for the exec loop', () => {
    const atoms = ['eyJ', 'a', 'aaaaaaaa', 'bbbbbbbbb', '.', '-', '_', ' ', 'x', '!', 'eyJaaaaaaaa.bbbbbbbb.cccccccc', 'Z', '0', '..', 'e', 'y', 'J']
    let seed = 20_261_008
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
    let withMatch = 0
    for (let i = 0; i < 20_000; i++) {
      let text = ''
      for (let j = 1 + Math.floor(next() * 14); j > 0; j--) text += atoms[Math.floor(next() * atoms.length)]
      const expected = text.replace(LEGACY, '[R]')
      if (expected !== text) withMatch++
      assert.ok(text.replace(JWT_PATTERN, '[R]') === expected, `replace differs for ${JSON.stringify(text)}`)
      const spans = (re) => {
        re.lastIndex = 0
        const out = []
        for (let m = re.exec(text); m; m = re.exec(text)) out.push(`${m.index}:${m[0]}`)
        return out.join('|')
      }
      assert.ok(spans(JWT_PATTERN) === spans(LEGACY), `exec loop differs for ${JSON.stringify(text)}`)
    }
    assert.ok(withMatch > 1000, 'the generator produces matching text often enough to compare')
  })
})

describe('the cut follows redaction, never precedes it', () => {
  const ANT_KEY = 'sk-ant-api03-' + 'A'.repeat(60)
  const shown = (out) => out.command ?? out.summary

  it('a long value is cut to the broadcast cap and marked, in bounded time', () => {
    const started = process.hrtime.bigint()
    const out = sanitizeToolInput({ command: 'word '.repeat(1_600_000) })
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    // The cut value no longer fits the broadcast cap once serialized, so the whole input is summarized.
    assert.equal(out._truncated, true)
    assert.ok(out.summary.endsWith('... [truncated]'), 'marked as cut')
    assert.ok(out.summary.length <= MAX_INPUT_CHARS + 20, 'cut to the cap')
    assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`)
  })

  it('keys that shrink the text do not let a token at the old scan edge through', () => {
    const prefix = `${ANT_KEY} `.repeat(50)
    const text = `${prefix}${'x'.repeat(12_272 - prefix.length)} eyJaaaaaaaa.bbbbbbbb.cccccccc tail`
    const out = shown(sanitizeToolInput({ command: text }))
    assert.ok(!out.includes('eyJ'), 'no part of the token is shown')
    assert.ok(!out.includes('sk-ant'), 'no part of a key is shown')
    assert.ok(out.includes('[REDACTED] tail'))
  })

  it('a token with a 3 KiB payload that straddles the cap is redacted whole', () => {
    const token = `eyJ${'H'.repeat(33)}.eyJ${'P'.repeat(3000)}.${'S'.repeat(43)}`
    const out = shown(sanitizeToolInput({ command: `${'k'.repeat(MAX_INPUT_CHARS - 31)} ${token} tail` }))
    assert.ok(!out.includes('eyJ'), 'no part of the token is shown')
    assert.ok(!out.includes('PPPP'))
  })

  it('a quoted secret that contains a space and straddles the cap is redacted whole', () => {
    const out = shown(sanitizeToolInput({ command: `${'x'.repeat(MAX_INPUT_CHARS - 25)} password="secret phrase extends past limit" tail` }))
    assert.ok(!out.includes('secret'), 'no part of the value is shown')
  })

  it('a value within the cap is returned exactly as before', () => {
    const value = `${'a'.repeat(100)} ${ANT_KEY} tail`
    assert.equal(sanitizeToolInput({ command: value }).command, `${'a'.repeat(100)} [REDACTED] tail`)
  })

  it('text past the admission ceiling is the one case that loses its tail first, and says so', () => {
    const out = sanitizeToolInput({ command: `sk-ant-api03-${'A'.repeat(REDACT_ADMISSION_MAX + 10)}` })
    assert.equal(out.command, '... [truncated]')
  })
})

describe('redactBounded and scanWindow', () => {
  const ANT_KEY = 'sk-ant-api03-' + 'A'.repeat(60)

  it('redacts all of a text that is within the ceiling, whatever its length', () => {
    const text = `${'word '.repeat(5000)}${ANT_KEY} tail`
    assert.equal(redactBounded(text, REDACT_ADMISSION_MAX), `${'word '.repeat(5000)}[REDACTED] tail`)
  })

  it('coerces a non-string, and returns nothing for nothing', () => {
    assert.equal(redactBounded(undefined), '')
    assert.equal(redactBounded(null), '')
    assert.equal(redactBounded(12345), '12345')
  })

  it('past the ceiling, drops the tail at whitespace and the last 2 KiB, so no piece of a key is kept', () => {
    // The key starts 20 characters before the ceiling: a plain cut would leave "sk-ant-api03-AAAAA".
    const pad = 'w '.repeat((REDACT_ADMISSION_MAX - 20) / 2)
    const cut = redactBounded(`${pad}${ANT_KEY} tail`)
    assert.ok(!cut.includes('sk-ant'), cut.slice(-40))
    assert.equal(cut, pad.slice(0, pad.length - 1 - REDACT_SCAN_MARGIN))
  })

  it('past the ceiling, drops a run that has no whitespace rather than half-keeping it', () => {
    assert.equal(redactBounded(`sk-ant-api03-${'A'.repeat(REDACT_ADMISSION_MAX + 10)}`), '')
  })

  it('a maximum is an output budget: the result is redacted whole, then sliced to it', () => {
    const text = `${ANT_KEY} ${'w '.repeat(5000)}`
    assert.equal(redactBounded(text, 30), '[REDACTED] w w w w w w w w w w')
    assert.equal(redactBounded(text, 100000), `[REDACTED] ${'w '.repeat(5000)}`)
  })

  it('clipRedacted keeps at most max characters less the final 2 KiB, then the marker', () => {
    assert.equal(clipRedacted('a'.repeat(10_000), 5000, '[m]'), 'a'.repeat(5000 - REDACT_SCAN_MARGIN) + '[m]')
    assert.equal(clipRedacted('a'.repeat(1000), 5000, '[m]'), '[m]')
    assert.equal(clipRedacted('abc', 2), '')
  })

  it('reports whether the tail was discarded', () => {
    assert.deepEqual(redactWhole('short', 100), { text: 'short', clipped: false })
    assert.deepEqual(redactWhole(`${'w'.repeat(90)} ${'z'.repeat(50)}`, 100), { text: 'w'.repeat(90), clipped: true })
  })

  it('scanWindow keeps text within the bound whole and backs up to whitespace past it', () => {
    assert.deepEqual(scanWindow('abc', 10), { text: 'abc', clipped: false })
    assert.deepEqual(scanWindow('ab cd\tef\ngh', 8), { text: 'ab cd', clipped: true })
    assert.deepEqual(scanWindow(`ab cd${'e'.repeat(50)}`, 20), { text: 'ab', clipped: true })
    assert.deepEqual(scanWindow('e'.repeat(50), 20), { text: '', clipped: true })
    assert.deepEqual(scanWindow('ab\rcd' + 'e'.repeat(50), 20), { text: 'ab', clipped: true })
  })
})

describe('error text keeps the redaction whole', () => {
  it('a quoted secret with a space that straddles the message budget is redacted before the cut', () => {
    const text = `${'x'.repeat(ERROR_TEXT_MAX - 25)} password="secret phrase extends past limit" trailing`
    const out = redactAndClip(text, ERROR_TEXT_MAX, '\n[truncated]')
    assert.ok(!out.includes('secret'), 'no part of the value is kept')
    assert.ok(out.endsWith('\n[truncated]'), 'marked as cut')
    assert.ok(out.length <= ERROR_TEXT_MAX)
  })

  it('a token that straddles the budget is redacted whole', () => {
    const token = `eyJ${'H'.repeat(33)}.eyJ${'P'.repeat(3000)}.${'S'.repeat(43)}`
    const out = redactAndClip(`${'k'.repeat(ERROR_TEXT_MAX - 31)} ${token} tail`, ERROR_TEXT_MAX, '\n[truncated]')
    assert.ok(!out.includes('eyJ'), 'no part of the token is kept')
  })
})

describe('the logger redacts the whole line, then cuts it', () => {
  function capture(message) {
    const entries = []
    const listener = (entry) => entries.push(entry)
    const quiet = mock.method(console, 'log', () => {})
    addLogListener(listener)
    try {
      createLogger('redaction-bounded-time').info(message)
    } finally {
      removeLogListener(listener)
      quiet.mock.restore()
    }
    return entries[0].message
  }
  const LIMIT = 64 * 1024

  it('a long line is cut to the line limit and marked, in bounded time', () => {
    const started = process.hrtime.bigint()
    const out = capture(`before ${'word '.repeat(400_000)} after`)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(out.startsWith('before word word'), 'the start of the line is kept')
    assert.ok(out.endsWith('... [truncated]'), 'marked as cut')
    assert.equal(out.length, LIMIT - REDACT_SCAN_MARGIN + '... [truncated]'.length)
    assert.ok(ms < BUDGET_MS * 2, `took ${ms.toFixed(0)} ms`)
  })

  it('a quoted secret with a space that straddles the limit does not show', () => {
    const out = capture(`${'x'.repeat(LIMIT - 25)} password="secret phrase extends past limit" trailing`)
    assert.ok(!out.includes('secret'), 'no part of the value is shown')
    assert.ok(out.endsWith('... [truncated]'))
  })

  it('a long line with no whitespace keeps its beginning', () => {
    const out = capture(`prefix:${'a'.repeat(LIMIT + 100)}`)
    assert.ok(out.startsWith('prefix:aaaa'), out.slice(0, 20))
    assert.equal(out.length, LIMIT - REDACT_SCAN_MARGIN + '... [truncated]'.length, 'the beginning, less only the final 2 KiB')
  })

  it('secrets in the kept part of a long line are redacted', () => {
    const out = capture(`key ${'sk-ant-api03-' + 'B'.repeat(60)} ${'word '.repeat(40_000)}`)
    assert.ok(out.startsWith('key [REDACTED] word'), out.slice(0, 40))
    assert.ok(!out.includes('sk-ant'))
  })

  it('a line within the limit is logged whole', () => {
    const line = `token=abcdefghijkl ${'word '.repeat(1000)}`
    assert.equal(capture(line), `token= [REDACTED] ${'word '.repeat(1000)}`)
  })

  it('a line past the admission ceiling loses its tail first, and says so', () => {
    const out = capture(`head ${'word '.repeat(REDACT_ADMISSION_MAX / 5 + 10)}`)
    assert.ok(out.startsWith('head word'))
    assert.ok(out.endsWith('... [truncated]'))
  })
})

describe('a fragment at a cut is never shown', () => {
  const ANT_KEY = 'sk-ant-api03-' + 'A'.repeat(60)
  const MARKER = '... [truncated]'
  // One key as long as the admission ceiling allows, then a quoted value that holds a space: the
  // ceiling cuts inside the value, and what is left of it ends `password="secret`.
  const OVER_CEILING = `sk-ant-api03-${'A'.repeat(REDACT_ADMISSION_MAX - 40)} password="secret phrase extends past limit" trailing`
  const shown = (out) => out.command ?? out.summary
  const logged = (message) => {
    const entries = []
    const listener = (entry) => entries.push(entry)
    const quiet = mock.method(console, 'log', () => {})
    addLogListener(listener)
    try {
      createLogger('redaction-bounded-time').info(message)
    } finally {
      removeLogListener(listener)
      quiet.mock.restore()
    }
    return entries[0].message
  }

  it('a quoted value cut by the admission ceiling does not show, in tool input', () => {
    const out = shown(sanitizeToolInput({ command: OVER_CEILING }))
    assert.ok(!out.includes('secret'), out.slice(0, 80))
    assert.ok(out.endsWith(MARKER))
  })

  it('a quoted value cut by the admission ceiling does not show, in the logger', () => {
    const out = logged(OVER_CEILING)
    assert.ok(!out.includes('secret'), out.slice(0, 80))
    assert.ok(out.endsWith(MARKER))
  })

  it('a quoted value cut by the admission ceiling does not show, in error text', () => {
    const out = redactAndClip(OVER_CEILING, ERROR_TEXT_MAX, '\n[truncated]')
    assert.ok(!out.includes('secret'), out.slice(0, 80))
    assert.ok(out.endsWith('\n[truncated]'))
  })

  it('a quoted value cut by the admission ceiling does not show, in a described field', () => {
    const out = describeByNamedField({ command: OVER_CEILING })
    assert.ok(!out.includes('secret'), out.slice(0, 80))
  })

  it('a quoted value cut by the admission ceiling does not show, in the saved permission description', () => {
    const history = new SessionMessageHistory()
    history.recordHistory('s1', 'permission_outcome', { requestId: 'p', tool: 'Bash', description: OVER_CEILING, outcome: 'allowed' })
    const [entry] = history.getHistory('s1')
    assert.ok(!entry.description.includes('secret'), entry.description.slice(0, 80))
  })

  // The key is glued to the text before it, so the key pattern (which wants a word boundary) does
  // not recognise it; the cut lands inside it.
  const glued = (budget) => `${'y'.repeat(budget - 20)}${ANT_KEY}${'z'.repeat(100)}`

  it('a key glued to the text before it, cut mid-key, leaves no fragment: tool input', () => {
    const out = shown(sanitizeToolInput({ command: glued(MAX_INPUT_CHARS) }))
    assert.ok(!out.includes('sk-ant'), out.slice(-60))
  })

  it('a key glued to the text before it, cut mid-key, leaves no fragment: logger', () => {
    assert.ok(!logged(glued(64 * 1024)).includes('sk-ant'))
  })

  it('a key glued to the text before it, cut mid-key, leaves no fragment: error text and described field', () => {
    assert.ok(!redactAndClip(glued(ERROR_TEXT_MAX), ERROR_TEXT_MAX, '\n[truncated]').includes('sk-ant'))
    assert.ok(!describeByNamedField({ command: glued(8192) }).includes('sk-ant'))
  })

  it('a glued key that is not cut is left as it was (the boundary rule is the pattern\'s, not the cut\'s)', () => {
    assert.equal(redactValue(`yyyy${ANT_KEY} z`), `yyyy${ANT_KEY} z`)
  })
})

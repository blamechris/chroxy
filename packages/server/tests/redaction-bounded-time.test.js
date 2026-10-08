import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import {
  SENSITIVE_PATTERNS, API_KEY_PATTERNS, JWT_PATTERN, redactValue, sanitizeToolInput, scanWindow, MAX_INPUT_CHARS,
} from '../src/redaction.js'
import { createLogger, addLogListener, removeLogListener } from '../src/logger.js'

/**
 * Redaction runs in time linear in the length of its input, and the two callers that
 * take arbitrary text (tool-input redaction and the logger) bound what they scan.
 *
 * The timing cases run in a worker thread. A pattern that is not linear does not fail
 * a synchronous assertion, it holds the thread for as long as it runs, and a test
 * timeout cannot fire while the thread is held. The worker can be terminated, so a
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

const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads')
  import(workerData.moduleUrl).then(({ redactValue }) => {
    for (const { label, fragment } of workerData.cases) {
      for (const size of workerData.sizes) {
        const text = fragment.repeat(Math.ceil(size / fragment.length)).slice(0, size)
        parentPort.postMessage({ begin: label, size })
        const started = process.hrtime.bigint()
        redactValue(text)
        parentPort.postMessage({ label, size, ms: Number(process.hrtime.bigint() - started) / 1e6 })
      }
    }
    parentPort.postMessage({ done: true })
  })
`

/** Run every case in a worker; a case that outlives its deadline ends the worker and is reported. */
function timeCases(cases, deadlineMs = CASE_DEADLINE_MS) {
  return new Promise((resolve) => {
    const results = []
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { moduleUrl: new URL('../src/redaction.js', import.meta.url).href, cases, sizes: SIZES },
    })
    let timer
    let current = null
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        worker.terminate()
        resolve({ results, stuck: current })
      }, deadlineMs)
    }
    arm()
    worker.on('message', (m) => {
      if (m.done) {
        clearTimeout(timer)
        worker.terminate()
        resolve({ results, stuck: null })
        return
      }
      if (m.begin) current = `${m.begin} @ ${m.size}`
      else results.push(m)
      arm()
    })
    worker.on('error', (err) => {
      clearTimeout(timer)
      resolve({ results, stuck: `worker error: ${err.message}` })
    })
  })
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
    const { results, stuck } = await timeCases(cases)
    assert.equal(stuck, null, `a case did not finish within ${CASE_DEADLINE_MS} ms: ${stuck}`)
    assert.equal(results.length, cases.length * SIZES.length, 'every case reports a time at every size')
    const slow = results.filter((r) => r.ms > BUDGET_MS)
    assert.ok(slow.length === 0, `over ${BUDGET_MS} ms: ${slow.map((r) => `${r.label} @ ${r.size} = ${r.ms.toFixed(0)} ms`).join('; ')}`)
  })

  it('a run of dash-joined headers is read once, however long it is', { timeout: 20_000 }, async () => {
    const { results, stuck } = await timeCases([{ label: 'dash-joined', fragment: 'eyJ-' }], 3000)
    assert.equal(stuck, null, `did not finish: ${stuck}`)
    assert.ok(results.every((r) => r.ms < BUDGET_MS), 'bounded at every size')
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

describe('tool-input redaction bounds what it scans', () => {
  const ANT_KEY = 'sk-ant-api03-' + 'A'.repeat(60)

  it('a long value is cut to the broadcast cap and marked, in bounded time', () => {
    const started = process.hrtime.bigint()
    const out = sanitizeToolInput({ command: 'eyJ-'.repeat(2_000_000) })
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    // The cut value no longer fits the broadcast cap once serialized, so the whole input is summarized.
    assert.equal(out._truncated, true)
    assert.ok(out.summary.endsWith('... [truncated]'), 'marked as cut')
    assert.ok(out.summary.length <= MAX_INPUT_CHARS + 20, 'cut to the cap')
    assert.ok(ms < BUDGET_MS, `took ${ms.toFixed(0)} ms`)
  })

  it('a value longer than the scan is marked as cut even when redaction shrinks it', () => {
    const out = sanitizeToolInput({ command: 'sk-ant-api03-' + 'A'.repeat(100_000) })
    assert.equal(out.command, '[REDACTED]... [truncated]')
  })

  it('a value just over the cap is redacted before it is cut', () => {
    const filler = 'a'.repeat(MAX_INPUT_CHARS - 60)
    const out = sanitizeToolInput({ command: `${filler} ${ANT_KEY} ${'z'.repeat(50_000)}` })
    assert.ok(!out.summary.includes('sk-ant'), 'no part of the key survives the cut')
    assert.ok(out.summary.includes('[REDACTED]'))
  })

  it('a value within the scan is returned exactly as before', () => {
    const value = `${'a'.repeat(100)} ${ANT_KEY} tail`
    assert.equal(sanitizeToolInput({ command: value }).command, `${'a'.repeat(100)} [REDACTED] tail`)
  })

  it('keeps the cut clear of the end of the scan, or drops the unsafe run past it', () => {
    assert.deepEqual(scanWindow('abc', 1, 10), { text: 'abc', clipped: false })
    assert.deepEqual(scanWindow('x'.repeat(9000), 10, 5000), { text: 'x'.repeat(5000), clipped: true })
    assert.deepEqual(scanWindow(`ab cd${'e'.repeat(5000)}`, 4000, 5000), { text: 'ab', clipped: true })
    assert.deepEqual(scanWindow('e'.repeat(9000), 4000, 5000), { text: '', clipped: true })
  })
})

describe('the logger bounds what it scans', () => {
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

  it('a long line is cut at whitespace inside the bound and marked, in bounded time', () => {
    const started = process.hrtime.bigint()
    const out = capture(`before ${'eyJ-'.repeat(500_000)} after`)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    assert.ok(out.startsWith('before'), 'the start of the line is kept')
    assert.ok(out.endsWith('... [truncated]'), 'marked as cut')
    assert.ok(out.length <= 64 * 1024 + 20, 'bounded')
    assert.ok(ms < BUDGET_MS * 2, `took ${ms.toFixed(0)} ms`)
  })

  it('a long line still has the secrets in its kept part redacted', () => {
    const out = capture(`key sk-ant-api03-${'B'.repeat(60)} ${'word '.repeat(40_000)}`)
    assert.ok(out.startsWith('key [REDACTED] word'), out.slice(0, 40))
    assert.ok(!out.includes('sk-ant'))
  })

  it('a line within the bound is logged whole', () => {
    const line = `token=abcdefghijkl ${'word '.repeat(1000)}`
    assert.equal(capture(line), `token= [REDACTED] ${'word '.repeat(1000)}`)
  })
})

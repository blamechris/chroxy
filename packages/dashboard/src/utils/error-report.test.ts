/** #9235 — the allowlist classifier is the privacy boundary for stored/copied error reports. */
import { describe, it, expect } from 'vitest'
import {
  classifyErrorMessage, normalizeStack, normalizeComponentStack, formatErrorReport,
  MESSAGE_OMITTED, ERROR_TEMPLATE_IDS, type ErrorReportEntry,
} from './error-report'

const OMIT = '[message omitted]'
const GHP = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}` // 36 alphanumerics after ghp_

// One positive case per template string: [name, template id, message].
const POSITIVE: Array<[string, string, string]> = [
  ['TypeError', 'read-props-of', "Cannot read properties of undefined (reading 'dimensions')"], // #9234
  ['TypeError', 'read-props-of', "Cannot read properties of null (reading 'a')"],
  ['TypeError', 'cannot-set-props-of', "Cannot set properties of undefined (setting 'x')"],
  ['TypeError', 'not-a-function', 'this.a.b is not a function'],
  ['TypeError', 'not-a-function', 'foo is not a function'],
  ['TypeError', 'not-a-constructor', 'Foo.Bar is not a constructor'],
  ['TypeError', 'not-iterable', 'items is not iterable'],
  ['ReferenceError', 'not-defined', 'foo is not defined'],
  ['ReferenceError', 'not-defined', "Can't find variable: foo"],
  ['ReferenceError', 'cannot-access-before-init', "Cannot access 'x' before initialization"],
  ['RangeError', 'max-call-stack', 'Maximum call stack size exceeded'],
  ['RangeError', 'max-call-stack', 'Maximum call stack size exceeded.'],
  ['InternalError', 'max-call-stack', 'too much recursion'],
  ['RangeError', 'invalid-array-length', 'Invalid array length'],
  ['RangeError', 'invalid-array-length', 'invalid array length'],
  ['TypeError', 'assignment-to-constant', 'Assignment to constant variable.'],
  ['TypeError', 'assignment-to-constant', "invalid assignment to const 'x'"],
  ['TypeError', 'cannot-convert-to-object', 'Cannot convert undefined or null to object'],
  ['TypeError', 'cannot-convert-to-object', "can't convert null to object"],
  ['SyntaxError', 'json-unexpected-end', 'Unexpected end of JSON input'],
  ['TypeError', 'not-an-object', "undefined is not an object (evaluating 'a.b.dimensions')"],
  ['TypeError', 'not-an-object', "null is not an object (evaluating 'x')"],
  ['TypeError', 'cannot-access-property', 'can\'t access property "dimensions", a.b is undefined'],
  ['ReferenceError', 'cannot-access-before-init', "can't access lexical declaration 'x' before initialization"],
  ['TypeError', 'fetch-failed', 'Failed to fetch'],
  ['TypeError', 'fetch-failed', 'Load failed'],
  ['TypeError', 'fetch-failed', 'NetworkError when attempting to fetch resource.'],
  ['Error', 'resize-observer-loop', 'ResizeObserver loop completed with undelivered notifications.'],
]

describe('classifyErrorMessage: templates', () => {
  it.each(POSITIVE)('%s / %s re-renders exactly: %s', (name, template, message) => {
    const r = classifyErrorMessage(name, message)
    expect(r.template).toBe(template)
    expect(r.text).toBe(message)
    // Idempotent: classified text re-validates to itself.
    expect(classifyErrorMessage(r.name, r.text)).toEqual(r)
  })

  it('every template id appears in the positive table (no untested template)', () => {
    const covered = new Set(POSITIVE.map(p => p[1]))
    expect(ERROR_TEMPLATE_IDS.filter(id => !covered.has(id))).toEqual([])
  })

  it('keeps only allowlisted names; anything else is Error', () => {
    expect(classifyErrorMessage('TypeError', 'Load failed').name).toBe('TypeError')
    expect(classifyErrorMessage('DOMException', 'Load failed').name).toBe('DOMException')
    expect(classifyErrorMessage('MySecretPayloadError', 'Load failed').name).toBe('Error')
    expect(classifyErrorMessage(undefined, 'Load failed').name).toBe('Error')
    expect(classifyErrorMessage('typeerror', 'Load failed').name).toBe('Error')
  })

  const BAD_SLOTS = ['a b', "a'b", 'a/b', 'a@b', 'a:b', 'a"b', '', '1abc', 'a-b', 'a.', '.a', 'a..b', 'a'.repeat(65), 'a.b.c.d.e']
  it.each(BAD_SLOTS)('a bad slot %j omits the whole message', (slot) => {
    for (const m of [
      `Cannot read properties of undefined (reading '${slot}')`,
      `${slot} is not a function`,
      `Cannot access '${slot}' before initialization`,
      `undefined is not an object (evaluating '${slot}')`,
    ]) {
      const r = classifyErrorMessage('TypeError', m)
      // 'a.b.c.d.e' is a valid *path* only up to 4 segments; as an id slot it is invalid too.
      expect(r.text, m).toBe(OMIT)
      expect(r.template).toBeNull()
    }
  })

  it('accepts exactly 64 chars and rejects 65, and 4 path segments but not 5', () => {
    expect(classifyErrorMessage('TypeError', `${'a'.repeat(64)} is not a function`).template).toBe('not-a-function')
    expect(classifyErrorMessage('TypeError', `${'a'.repeat(65)} is not a function`).template).toBeNull()
    expect(classifyErrorMessage('TypeError', 'a.b.c.d is not a function').template).toBe('not-a-function')
    expect(classifyErrorMessage('TypeError', 'a.b.c.d.e is not a function').template).toBeNull()
  })

  it('omits a template with trailing or leading extra text, or a newline', () => {
    const base = "Cannot read properties of undefined (reading 'dimensions')"
    for (const m of [`${base} PRIVATE`, `${base}\n`, `${base} `, `PRIVATE ${base}`, ` ${base}`, `${base}\nat x`, `Error: ${base}`]) {
      expect(classifyErrorMessage('TypeError', m).text, JSON.stringify(m)).toBe(OMIT)
    }
  })

  it('omits an over-long message and every non-string without throwing', () => {
    expect(classifyErrorMessage('TypeError', `${'a'.repeat(400)} is not a function`).text).toBe(OMIT)
    for (const v of [undefined, null, 5, {}, [], Symbol('s'), () => 1, { toString() { throw new Error('x') } }]) {
      expect(() => classifyErrorMessage(v, v)).not.toThrow()
      expect(classifyErrorMessage(v, v).text).toBe(OMIT)
    }
    expect(MESSAGE_OMITTED).toBe(OMIT)
  })

  it('masks a credential-shaped slot: a ghp_ token as the reading key', () => {
    const r = classifyErrorMessage('TypeError', `Cannot read properties of undefined (reading '${GHP}')`)
    expect(r.text).toBe("Cannot read properties of undefined (reading '[REDACTED]')")
    expect(r.template).toBe('read-props-of')
    expect(r.text).not.toContain('ghp_')
    // and in a path slot
    expect(classifyErrorMessage('TypeError', `a.${GHP} is not a function`).text).toBe('[REDACTED] is not a function')
    // the masked text re-validates to itself
    expect(classifyErrorMessage('TypeError', r.text)).toEqual(r)
  })
})

// ---------------------------------------------------------------------------
// The leak corpus
// ---------------------------------------------------------------------------

function realJsonParseMessage(): string {
  try { JSON.parse('PRIVATE SESSION CONTENT'); return '' } catch (e) { return (e as Error).message }
}
const B64 = btoa('MY_PRIVATE_PROMPT_BASE64')
const jsonParseMsg = realJsonParseMessage()

const CORPUS: string[] = [
  jsonParseMsg,
  `JSON.parse: unexpected character at line 1 column 1 of the JSON data PRIVATE SESSION CONTENT`,
  'data:text/plain,MY_PRIVATE_PROMPT',
  `data:text/plain;base64,${B64}`,
  "https://user:p'ass@host/a",
  '//user:p@ss@host/a?x=SECRET',
  'foo?x=SECRET',
  '#SECRET',
  'password=p%40ssw%2Frd',
  '%73%6b%2d%70%72%6f%6a%2dSECRETKEY123456789',
  'https%3A%2F%2Fhost%2Fa%3Fx%3DSECRET',
  'https:\\/\\/user:p@ss@host\\/a?x=SECRET',
  '\\/Users\\/alice\\/private\\/x.js',
  '\\u002fUsers\\u002falice\\u002fprivate.js',
  '/Users/Alice Smith/x.js',
  '/Users/alice',
  '/home/bob',
  'C:\\Users\\carol',
  '~alice/private/x.js',
  'file://server/share/private/x.js',
  '?challenge=:123456',
  'token=abcdef123456',
  'at file:///Users/alice/private.js:9:26',
  `https://user:${'Q'.repeat(2100)}@host/app.js:1:2`,
  `sk-proj-${'Z9'.repeat(40)}`,
]
const NEEDLES = [
  'PRIVATE SESSION', 'PRIVATE', 'MY_PRIVATE_PROMPT', B64, 'SECRET', 'p%40ssw', 'ssw%2Frd', 'p@ss', "p'ass", 'user:',
  'alice', 'Alice', 'bob', 'carol', '123456', 'abcdef', 'sk-proj', '%73%6b', 'QQQ', 'Users', '/home', 'host',
  'challenge', 'file:', 'data:', 'ZZ', 'Z9Z9',
]
// Needles that the JSON.parse message of THIS engine adds (it quotes a fragment of the payload).
const ENGINE_NEEDLES = jsonParseMsg ? [jsonParseMsg, 'PRIVATE'] : []

function assertNoLeak(label: string, out: string): void {
  for (const n of [...NEEDLES, ...ENGINE_NEEDLES]) {
    expect(out.includes(n), `${label} leaked ${JSON.stringify(n.slice(0, 40))}: ${out.slice(0, 200)}`).toBe(false)
  }
}

function everyShape(s: string): { label: string; out: string }[] {
  const shapes: { label: string; out: string }[] = []
  const msgs = [
    s,
    `Cannot read properties of undefined (reading '${s}')`,
    `${s} is not a function`,
    `Cannot access '${s}' before initialization`,
    `undefined is not an object (evaluating '${s}')`,
    `can't access property "${s}", a is undefined`,
    `Can't find variable: ${s}`,
  ]
  for (const m of msgs) {
    const r = classifyErrorMessage(s, m)
    shapes.push({ label: `message ${JSON.stringify(m.slice(0, 60))}`, out: `${r.name}|${r.template}|${r.text}` })
  }
  const stacks = [
    s, `TypeError: ${s}\n    at ${s}`, `at ${s}`, `at fn (${s}:1:2)`, `at ${s} (${s})`, `at async ${s} (http://localhost/a.js:1:2)`,
    `${s}@${s}`, `fn@${s}`, `${s}@http://localhost/a.js:1:2`, `at fn (http://${s}/a.js:1:2)`,
    `at fn (${s}\n)`, `  at ${s}  @  ${s}`, `${s} @ ${s}:1:2`,
  ]
  for (const st of stacks) {
    shapes.push({ label: `stack ${JSON.stringify(st.slice(0, 60))}`, out: normalizeStack(st).join('\n') })
    shapes.push({ label: `component ${JSON.stringify(st.slice(0, 60))}`, out: normalizeComponentStack(st).join('\n') })
  }
  const poisoned = {
    time: s, version: s, platform: s, category: s, count: s, name: s, message: s, stack: [s, `at ${s}`, `${s}@${s}`], componentStack: [s, `at ${s}`],
  } as unknown as ErrorReportEntry
  shapes.push({ label: 'report', out: formatErrorReport(poisoned) })
  return shapes
}

describe('Codex leak corpus', () => {
  it('the real JSON.parse message is non-empty and quotes the payload (the corpus is real)', () => {
    expect(jsonParseMsg.length).toBeGreaterThan(0)
    expect(classifyErrorMessage('SyntaxError', jsonParseMsg).text).toBe(OMIT)
  })

  it.each(CORPUS.map((c, i) => [i, c.slice(0, 40)] as const))('corpus %i (%s) leaks nothing through any path', (i) => {
    const s = CORPUS[i]!
    for (const { label, out } of everyShape(s)) assertNoLeak(label, out)
  })

  it('a frame named token=abcdef123456 and a sk-proj- function name become anonymous', () => {
    expect(normalizeStack('at token=abcdef123456 (http://localhost/a.js:1:2)')).toEqual(['<anonymous> @ a.js:1:2'])
    expect(normalizeStack(`at sk-proj-${'Z9'.repeat(40)} (http://localhost/a.js:1:2)`)).toEqual(['<anonymous> @ a.js:1:2'])
    expect(normalizeStack('token=abcdef123456@http://localhost/a.js:1:2')).toEqual(['<anonymous> @ a.js:1:2'])
  })

  it('a ghp_ frame name is masked', () => {
    expect(normalizeStack(`at ${GHP} (http://localhost/a.js:1:2)`)).toEqual(['[REDACTED] @ a.js:1:2'])
    expect(normalizeComponentStack(`at ${GHP} (x)`)).toEqual(['[REDACTED]'])
  })
})

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

describe('normalizeStack', () => {
  const URL = 'http://localhost:8765/dashboard/assets/index-abc123.js?v=1'

  it('normalises V8 frames and drops the header/message lines', () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'dimensions')",
      `    at fn (${URL}:12:34)`,
      `    at Object.render (${URL}:5:6)`,
      `    at async load (${URL}:7:8)`,
      `    at new Widget (${URL}:9:10)`,
      `    at ${URL}:1:2`,
    ].join('\n')
    expect(normalizeStack(stack)).toEqual([
      'fn @ index-abc123.js:12:34',
      'Object.render @ index-abc123.js:5:6',
      'load @ index-abc123.js:7:8',
      'Widget @ index-abc123.js:9:10',
      '<anonymous> @ index-abc123.js:1:2',
    ])
  })

  it('normalises JSC/SpiderMonkey frames', () => {
    const stack = `fn@${URL}:12:34\n@${URL}:1:2\nglobal code@${URL}:3:4 (not a frame: whitespace before the @)\nrender@[native code]\nObject.render@https://x.example/a/b/c.mjs:3:4`
    expect(normalizeStack(stack)).toEqual([
      'fn @ index-abc123.js:12:34',
      '<anonymous> @ index-abc123.js:1:2',
      'Object.render @ c.mjs:3:4',
    ])
  })

  it.each([
    'file:///Users/alice/private.js:9:26', 'data:text/javascript,alert(1):1:2', 'blob:http://localhost/abc-def:1:2',
    'chrome-extension://abc/content.js:1:2', 'http://localhost/a.js', 'http://localhost/a.js:1', 'http://localhost/a.js:x:2',
    'http://localhost/a.js:12345678:2', 'http://localhost/a.js:2:12345678', 'http://localhost/a.txt:1:2',
    'http://localhost/a%2Ejs:1:2', 'http://localhost/:1:2', 'http://a.js:1:2', 'ftp://h/a.js:1:2', `http://h/${'a'.repeat(90)}.js:1:2`,
    'HTTP://h/a.js:1:2', 'webpack-internal:///./a.js:1:2',
  ])('location %s is <unknown>', (loc) => {
    expect(normalizeStack(`at fn (${loc})`)).toEqual(['fn @ <unknown>'])
  })

  it('keeps the basename only: never userinfo, host, directories, query or fragment', () => {
    const out = normalizeStack("at fn (https://user:p'ass@host/dir/secret/app-1.js?x=SECRET#SECRET:1:2)")
    expect(out).toEqual(['fn @ app-1.js:1:2'])
    expect(normalizeStack('at fn (https://host/a.js#frag:1:2)')).toEqual(['fn @ a.js:1:2'])
  })

  it('caps the frame count (default 12, configurable)', () => {
    const stack = Array.from({ length: 50 }, (_, i) => `    at f${i} (http://localhost/a.js:${i + 1}:1)`).join('\n')
    expect(normalizeStack(stack)).toHaveLength(12)
    expect(normalizeStack(stack, { maxFrames: 3 })).toHaveLength(3)
    expect(normalizeStack(stack, { maxFrames: 0 })).toEqual([])
    expect(normalizeStack(stack, { maxFrames: Infinity })).toHaveLength(12)
  })

  it('only the first 200 lines are examined', () => {
    const stack = `${'noise\n'.repeat(200)}at fn (http://localhost/a.js:1:2)`
    expect(normalizeStack(stack)).toEqual([])
  })

  it('a truncated line never keeps a partial name or location', () => {
    const long = `at ${'a'.repeat(300)} (http://localhost/dashboard/assets/${'b'.repeat(400)}.js:1:2)`
    expect(normalizeStack(long)).toEqual(['<anonymous> @ <unknown>'])
    const longJsc = `fn@http://localhost/${'b'.repeat(600)}.js:1:2`
    expect(normalizeStack(longJsc)).toEqual(['<anonymous> @ <unknown>'])
    // a long non-frame line stays skipped
    expect(normalizeStack(`${'x'.repeat(2000)}`)).toEqual([])
  })

  it('non-strings and garbage do not throw', () => {
    for (const v of [undefined, null, 1, {}, [], Symbol('s'), '', '\n\n', '\u0000', 'at ', 'at (', '@', '@@@', ' @ ', ' @ :1:2']) {
      expect(() => normalizeStack(v)).not.toThrow()
    }
    expect(normalizeStack(undefined)).toEqual([])
    expect(normalizeStack({ stack: 'x' })).toEqual([])
  })

  it('is idempotent: normalising normalised output does not grow or change it', () => {
    const stack = [
      "TypeError: x", `at fn (http://localhost/a.js:1:2)`, 'at async Foo.bar (http://localhost/b.mjs:3:4)', 'at file:///x.js:1:1',
      `at ${GHP} (http://localhost/c.js:5:6)`, 'at token=abc (http://localhost/d.js:1:1)', `fn@http://localhost/e.js:7:8`,
    ].join('\n')
    const once = normalizeStack(stack)
    expect(once.length).toBeGreaterThan(3)
    const twice = normalizeStack(once.join('\n'))
    expect(twice).toEqual(once)
    expect(normalizeStack(twice.join('\n'))).toEqual(once)
  })
})

describe('normalizeComponentStack', () => {
  it('keeps component names only; drops location-only entries', () => {
    const stack = [
      '    at Foo (http://localhost/a.js:1:2)', '    at div', '    at Context.Provider', '    at http://localhost/a.js:1:2',
      '    at file:///Users/alice/x.js:1:2', '    Bar@http://localhost/a.js:1:2', '    at has space', '', 'free text line',
    ].join('\n')
    expect(normalizeComponentStack(stack)).toEqual(['Foo', 'div', 'Context.Provider', 'Bar'])
  })

  it('caps at 15 by default and honours maxFrames; ignores non-strings; is idempotent', () => {
    const stack = Array.from({ length: 40 }, (_, i) => `    at C${i}`).join('\n')
    const out = normalizeComponentStack(stack)
    expect(out).toHaveLength(15)
    expect(normalizeComponentStack(stack, { maxFrames: 2 })).toEqual(['C0', 'C1'])
    expect(normalizeComponentStack(out.join('\n'))).toEqual(out)
    for (const v of [undefined, null, 3, {}, []]) expect(normalizeComponentStack(v)).toEqual([])
  })

  it('drops a truncated line rather than keeping a partial name', () => {
    expect(normalizeComponentStack(`at ${'A'.repeat(600)}`)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Bounded time
// ---------------------------------------------------------------------------

describe('bounded time on 256 KiB adversarial input', () => {
  const SIZE = 256 * 1024
  const units = ['(', 'a.', '@', ':', '/', "'", 'at ', ' (', '?', 'a', ' ', '\n', 'http://', '.js:1:2)']
  it.each(units)('%j repeated', (unit) => {
    const big = unit.repeat(Math.ceil(SIZE / unit.length))
    const wraps = [
      big, `at fn (${big}`, `Cannot read properties of undefined (reading '${big}')`, `${big} is not a function`,
      `at fn (http://localhost/${big}.js:1:2)`, `${big}@${big}`,
    ]
    const t0 = performance.now()
    for (const w of wraps) {
      classifyErrorMessage('TypeError', w)
      normalizeStack(w)
      normalizeComponentStack(w)
    }
    formatErrorReport({
      time: big, version: big, platform: big, category: big, count: 1, name: big, message: big, stack: [big, big], componentStack: [big],
    } as unknown as ErrorReportEntry)
    expect(performance.now() - t0).toBeLessThan(5000)
  })

  it('a 256 KiB single-slot near-miss is rejected without scanning it', () => {
    const t0 = performance.now()
    expect(classifyErrorMessage('TypeError', `${'a.'.repeat(SIZE / 2)} is not a function`).text).toBe(OMIT)
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

describe('formatErrorReport', () => {
  const good: ErrorReportEntry = {
    time: Date.UTC(2026, 10, 26, 12, 0, 0),
    version: '0.11.10',
    platform: 'macos',
    category: 'render',
    count: 3,
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'dimensions')",
    stack: ['fn @ index-abc123.js:12:34', '<anonymous> @ <unknown>'],
    componentStack: ['Foo', 'Bar'],
  }

  it('renders only the allowed fields', () => {
    expect(formatErrorReport(good)).toBe([
      'Chroxy dashboard error report',
      'Time: 2026-11-26T12:00:00.000Z',
      'Version: 0.11.10',
      'Platform: macos',
      'Category: render',
      'Count: 3',
      'Error: TypeError',
      "Message: Cannot read properties of undefined (reading 'dimensions')",
      'Template: read-props-of',
      'Stack:',
      '  fn @ index-abc123.js:12:34',
      '  <anonymous> @ <unknown>',
      'Component stack:',
      '  Foo',
      '  Bar',
    ].join('\n'))
  })

  it('re-validation is stable: a report of its own stored fields is the same', () => {
    const r = classifyErrorMessage(good.name, good.message)
    const stored = { ...good, name: r.name, message: r.text, stack: normalizeStack((good.stack as string[]).join('\n')), componentStack: normalizeComponentStack((good.componentStack as string[]).join('\n')) }
    expect(formatErrorReport(stored)).toBe(formatErrorReport(good))
  })

  it('a poisoned stored entry reaches the clipboard without any secret', () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOP SECRET /Users/alice/private'
    const poisoned = {
      time: `2026-01-01T00:00:00Z ${secret}`,
      version: secret, platform: secret, category: secret, count: secret,
      name: `TypeError ${secret}`,
      message: `Cannot read properties of undefined (reading 'dimensions') ${secret}`,
      stack: [`TypeError: ${secret}`, `at fn (file:///Users/alice/private.js:1:2)`, `at ${secret}`],
      componentStack: `at ${secret}\nat Foo (/Users/alice/x.js:1:2)`,
    } as unknown as ErrorReportEntry
    const out = formatErrorReport(poisoned)
    for (const n of ['sk-ant', 'SECRET', 'alice', 'private', 'ABCDEFGH', 'file:']) expect(out.includes(n), n).toBe(false)
    expect(out).toContain('Message: [message omitted]')
    expect(out).toContain('Error: Error')
    expect(out).toContain('Time: unknown')
    expect(out).toContain('Count: 1')
    expect(out).toContain('  <anonymous> @ <unknown>')
    expect(out).toContain('  Foo')
  })

  it('a stored header line in the stack is not kept', () => {
    const out = formatErrorReport({ ...good, stack: "TypeError: PRIVATE header\nat fn (http://localhost/a.js:1:2)" })
    expect(out.includes('PRIVATE')).toBe(false)
    expect(out).toContain('  fn @ a.js:1:2')
  })

  it('never throws on non-object entries', () => {
    for (const v of [null, undefined, 5, 'x', []]) {
      expect(() => formatErrorReport(v as unknown as ErrorReportEntry)).not.toThrow()
    }
  })
})

/** #9235 — the allowlist classifier is the privacy boundary for stored/copied error reports. */
import { describe, it, expect } from 'vitest'
import {
  classifyErrorMessage, normalizeStack, normalizeComponentStack, formatErrorReport,
  MESSAGE_OMITTED, ERROR_TEMPLATE_PATTERNS, MAX_MESSAGE_CHARS, isWordShaped, type ErrorReportEntry, type StackOptions,
} from './error-report'

/** The dashboard's own loaded scripts: the ONLY basenames a location may keep. */
const ASSETS: ReadonlySet<string> = new Set([
  'index-abc123.js', 'a.js', 'b.mjs', 'c.mjs', 'c.js', 'd.js', 'e.js', 'app-1.js',
])
const ns = (stack: unknown, opts?: StackOptions) => normalizeStack(stack, { assetBasenames: ASSETS, ...opts })
const fr = (entry: ErrorReportEntry) => formatErrorReport(entry, { assetBasenames: ASSETS })

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
  ['ReferenceError', 'cannot-access-before-init', "Cannot access 'x' before initialization."], // JSC
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
  ['Error', 'resize-observer-loop', 'ResizeObserver loop limit exceeded'],
]

describe('classifyErrorMessage: templates', () => {
  it.each(POSITIVE)('%s / %s re-renders exactly: %s', (name, template, message) => {
    const r = classifyErrorMessage(name, message)
    expect(r.name).toBe(name)
    expect(r.template).toBe(template)
    expect(r.text).toBe(message)
    // Idempotent: classified text re-validates to itself.
    expect(classifyErrorMessage(r.name, r.text)).toEqual(r)
  })

  it('every template VARIANT (pattern string) has a positive row, not just every id', () => {
    const loose = (pattern: string) => new RegExp(`^${pattern
      .replace(/[\\^$.*+?()[\]|/]/g, '\\$&')
      .replace(/\{(?:id|path|key|nullish)\}/g, '.+')}$`)
    const uncovered = ERROR_TEMPLATE_PATTERNS.filter(([id, pattern]) =>
      !POSITIVE.some(([, tid, msg]) => tid === id && loose(pattern).test(msg)))
    expect(uncovered).toEqual([])
  })

  it('keeps only allowlisted names; anything else is Error', () => {
    expect(classifyErrorMessage('TypeError', 'Load failed').name).toBe('TypeError')
    expect(classifyErrorMessage('InternalError', 'too much recursion').name).toBe('InternalError')
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
    shapes.push({ label: `stack ${JSON.stringify(st.slice(0, 60))}`, out: ns(st).join('\n') })
    shapes.push({ label: `component ${JSON.stringify(st.slice(0, 60))}`, out: normalizeComponentStack(st).join('\n') })
  }
  const poisoned = {
    time: s, version: s, platform: s, category: s, count: s, name: s, message: s, stack: [s, `at ${s}`, `${s}@${s}`], componentStack: [s, `at ${s}`],
  } as unknown as ErrorReportEntry
  shapes.push({ label: 'report', out: fr(poisoned) })
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
    expect(ns('at token=abcdef123456 (http://localhost/a.js:1:2)')).toEqual(['<anonymous> @ a.js:1:2'])
    expect(ns(`at sk-proj-${'Z9'.repeat(40)} (http://localhost/a.js:1:2)`)).toEqual(['<anonymous> @ a.js:1:2'])
    expect(ns('token=abcdef123456@http://localhost/a.js:1:2')).toEqual(['<anonymous> @ a.js:1:2'])
  })

  it('a ghp_ frame name is masked', () => {
    expect(ns(`at ${GHP} (http://localhost/a.js:1:2)`)).toEqual(['[REDACTED] @ a.js:1:2'])
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
    expect(ns(stack)).toEqual([
      'fn @ index-abc123.js:12:34',
      'Object.render @ index-abc123.js:5:6',
      'load @ index-abc123.js:7:8',
      'Widget @ index-abc123.js:9:10',
      '<anonymous> @ index-abc123.js:1:2',
    ])
  })

  it('normalises JSC/SpiderMonkey frames', () => {
    const stack = `fn@${URL}:12:34\n@${URL}:1:2\nglobal code@${URL}:3:4 (not a frame: whitespace before the @)\nrender@[native code]\nObject.render@https://x.example/a/b/c.mjs:3:4`
    expect(ns(stack)).toEqual([
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
    expect(ns(`at fn (${loc})`)).toEqual(['fn @ <unknown>'])
  })

  it('keeps the basename only: never userinfo, host, directories, query or fragment', () => {
    const out = ns("at fn (https://user:p'ass@host/dir/secret/app-1.js?x=SECRET#SECRET:1:2)")
    expect(out).toEqual(['fn @ app-1.js:1:2'])
    expect(ns('at fn (https://host/a.js#frag:1:2)')).toEqual(['fn @ a.js:1:2'])
  })

  it('caps the frame count (default 12, configurable)', () => {
    const stack = Array.from({ length: 50 }, (_, i) => `    at f${i} (http://localhost/a.js:${i + 1}:1)`).join('\n')
    expect(ns(stack)).toHaveLength(12)
    expect(ns(stack, { maxFrames: 3 })).toHaveLength(3)
    expect(ns(stack, { maxFrames: 0 })).toEqual([])
    expect(ns(stack, { maxFrames: Infinity })).toHaveLength(12)
  })

  it('only the first 200 lines are examined', () => {
    const stack = `${'noise\n'.repeat(200)}at fn (http://localhost/a.js:1:2)`
    expect(ns(stack)).toEqual([])
  })

  it('a truncated line never keeps a partial name or location', () => {
    const long = `at ${'a'.repeat(300)} (http://localhost/dashboard/assets/${'b'.repeat(400)}.js:1:2)`
    expect(ns(long)).toEqual(['<anonymous> @ <unknown>'])
    const longJsc = `fn@http://localhost/${'b'.repeat(600)}.js:1:2`
    expect(ns(longJsc)).toEqual([]) // a truncated fn@loc cannot be verified: skipped
    // a long non-frame line stays skipped
    expect(ns(`${'x'.repeat(2000)}`)).toEqual([])
  })

  it('non-strings and garbage do not throw', () => {
    for (const v of [undefined, null, 1, {}, [], Symbol('s'), '', '\n\n', '\u0000', 'at ', 'at (', '@', '@@@', ' @ ', ' @ :1:2']) {
      expect(() => ns(v)).not.toThrow()
    }
    expect(ns(undefined)).toEqual([])
    expect(ns({ stack: 'x' })).toEqual([])
  })

  it('is idempotent: normalising normalised output does not grow or change it', () => {
    const stack = [
      "TypeError: x", `at fn (http://localhost/a.js:1:2)`, 'at async Foo.bar (http://localhost/b.mjs:3:4)', 'at file:///x.js:1:1',
      `at ${GHP} (http://localhost/c.js:5:6)`, 'at token=abc (http://localhost/d.js:1:1)', `fn@http://localhost/e.js:7:8`,
    ].join('\n')
    const once = ns(stack)
    expect(once.length).toBeGreaterThan(3)
    const twice = ns(once.join('\n'))
    expect(twice).toEqual(once)
    expect(ns(twice.join('\n'))).toEqual(once)
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
      ns(w)
      normalizeComponentStack(w)
    }
    fr({
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
    platform: 'tauri',
    category: 'render',
    count: 3,
    name: 'TypeError',
    message: "Cannot read properties of undefined (reading 'dimensions')",
    stack: ['fn @ index-abc123.js:12:34', '<anonymous> @ <unknown>'],
    componentStack: ['Foo', 'Bar'],
  }

  it('renders only the allowed fields', () => {
    expect(fr(good)).toBe([
      'Chroxy dashboard error report',
      'Time: 2026-11-26T12:00:00.000Z',
      'Version: 0.11.10',
      'Platform: tauri',
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
    const stored = { ...good, name: r.name, message: r.text, stack: ns((good.stack as string[]).join('\n')), componentStack: normalizeComponentStack((good.componentStack as string[]).join('\n')) }
    expect(fr(stored)).toBe(fr(good))
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
    const out = fr(poisoned)
    for (const n of ['sk-ant', 'SECRET', 'alice', 'private', 'ABCDEFGH', 'file:']) expect(out.includes(n), n).toBe(false)
    expect(out).toContain('Message: [message omitted]')
    expect(out).toContain('Error: Error')
    expect(out).toContain('Time: unknown')
    expect(out).toContain('Count: 1')
    expect(out).toContain('  <anonymous> @ <unknown>')
    expect(out).toContain('  Foo')
  })

  it('a stored header line in the stack is not kept', () => {
    const out = fr({ ...good, stack: "TypeError: PRIVATE header\nat fn (http://localhost/a.js:1:2)" })
    expect(out.includes('PRIVATE')).toBe(false)
    expect(out).toContain('  fn @ a.js:1:2')
  })

  it('never throws on non-object entries', () => {
    for (const v of [null, undefined, 5, 'x', []]) {
      expect(() => fr(v as unknown as ErrorReportEntry)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// #9235 PR 2 review fold-in (Codex BLOCK): red-before-fix cases
// ---------------------------------------------------------------------------

describe('R1: locations need the caller\'s asset set', () => {
  const TOKEN = `ghp_${'A'.repeat(36)}`
  it('no set, or an empty set, fails closed: every location is <unknown>', () => {
    const stack = 'at fn (http://localhost:8765/dashboard/assets/index-abc123.js?v=1:12:34)\nfn@http://localhost/a.js:1:2'
    expect(normalizeStack(stack)).toEqual(['fn @ <unknown>', 'fn @ <unknown>'])
    expect(normalizeStack(stack, { assetBasenames: new Set() })).toEqual(['fn @ <unknown>', 'fn @ <unknown>'])
    expect(ns(stack)).toEqual(['fn @ index-abc123.js:12:34', 'fn @ a.js:1:2'])
  })

  it('a token or a private name as a script basename from any host is dropped (raw URL branch)', () => {
    expect(ns(`at fn (https://anyhost/${TOKEN}.js:1:2)`)).toEqual(['fn @ <unknown>'])
    expect(ns('at fn (https://anyhost/patient-HIV-positive.js:1:2)')).toEqual(['fn @ <unknown>'])
  })

  it('the same names are dropped on the stored `name @ loc` branch', () => {
    expect(ns(`fn @ ${TOKEN}.js:1:2`)).toEqual(['fn @ <unknown>'])
    expect(ns('fn @ patient-HIV-positive.js:1:2')).toEqual(['fn @ <unknown>'])
    expect(ns('fn @ index-abc123.js:1:2')).toEqual(['fn @ index-abc123.js:1:2'])
  })

  it('still requires http(s) for a raw URL even when the basename is a member', () => {
    expect(ns('at fn (file:///x/a.js:1:2)')).toEqual(['fn @ <unknown>'])
    expect(ns('at fn (data:,/a.js:1:2)')).toEqual(['fn @ <unknown>'])
  })

  it('formatErrorReport applies the same set (and fails closed without it)', () => {
    const entry = { time: 0, version: '1.2.3', platform: 'web', category: 'render', count: 1, name: 'Error', message: 'x', stack: ['fn @ a.js:1:2'], componentStack: [] } as ErrorReportEntry
    expect(formatErrorReport(entry)).toContain('  fn @ <unknown>')
    expect(formatErrorReport(entry, { assetBasenames: ASSETS })).toContain('  fn @ a.js:1:2')
    expect(formatErrorReport({ ...entry, stack: [`fn @ ghp_${'A'.repeat(36)}.js:1:2`] }, { assetBasenames: ASSETS })).not.toContain('ghp_')
  })
})

describe('R2: closed header fields', () => {
  const entry = (over: Record<string, unknown>) => ({
    time: 0, version: '1.2.3', platform: 'web', category: 'render', count: 1, name: 'Error', message: 'x', stack: [], componentStack: [], ...over,
  }) as ErrorReportEntry

  it('a poisoned version/platform/category never reaches the report', () => {
    const out = fr(entry({ version: 'private-session-prompt', platform: 'private-session-prompt', category: 'private-session-prompt' }))
    expect(out.includes('private')).toBe(false)
    expect(out).toContain('Version: unknown')
    expect(out).toContain('Platform: unknown')
    expect(out).toContain('Category: unknown')
  })

  it.each(['tauri', 'web'])('platform %s is kept', (p) => expect(fr(entry({ platform: p }))).toContain(`Platform: ${p}`))
  it.each(['render', 'window-error', 'unhandled-rejection'])('category %s is kept', (c) => expect(fr(entry({ category: c }))).toContain(`Category: ${c}`))
  it.each(['macos', 'Tauri', 'web ', 'render2', 'error'])('anything outside the enums (%s) is unknown', (v) => {
    expect(fr(entry({ platform: v }))).toContain('Platform: unknown')
    expect(fr(entry({ category: v }))).toContain('Category: unknown')
  })

  it.each(['0.11.10', '1.2.3', '9999.9999.9999'])('release semver %s is kept', (v) => expect(fr(entry({ version: v }))).toContain(`Version: ${v}`))
  it.each(['1.2.3-beta', '1.2.3+build', '1.2', '12345.1.1', 'v1.2.3', '1.2.3 ', '1.2.3\nX'])('non-release version %j is unknown', (v) => {
    expect(fr(entry({ version: v }))).toContain('Version: unknown')
  })

  it.each(['2026-99-99T99:99:99Z', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z', 'not a date', '2026-01-01T00:00:00.5Z'])(
    'calendar-invalid or loose time %s is unknown', (t) => { expect(fr(entry({ time: t }))).toContain('Time: unknown') })
  it('a valid ISO time round-trips', () => {
    expect(fr(entry({ time: '2026-02-28T10:11:12Z' }))).toContain('Time: 2026-02-28T10:11:12.000Z')
    expect(fr(entry({ time: '2026-02-28T10:11:12.345Z' }))).toContain('Time: 2026-02-28T10:11:12.345Z')
  })
})

// ---------------------------------------------------------------------------
// The two corpora for the word-shape admission rule (#9235 PR 2, second review fold-in)
// ---------------------------------------------------------------------------

/** Deterministic PRNG (LCG): the corpora must not change between runs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = LOWER.toUpperCase()
const DIGIT = '0123456789'
function randomString(rnd: () => number, alphabet: string, n: number): string {
  let out = ''
  for (let i = 0; i < n; i++) out += alphabet.charAt(Math.floor(rnd() * alphabet.length))
  return out
}
function sample(seed: number, alphabet: string, n: number, count: number): string[] {
  const rnd = lcg(seed)
  return Array.from({ length: count }, () => randomString(rnd, alphabet, n))
}

const RANDOM_BODY = 'Qz7LmP3xVb9KdR2sTn5WcY8uHf4JgE6a'
const MUST_REDACT: string[] = [
  'ec4dcab55ef2997145102abb08905fa1', // hex
  'ghcKYWA3Kj6gqgDm3fWty_9DRBTHuBXSbOm5vEEcDy4', // base64url
  'zkzxQdaiQNTSpudgfgdFZRrdiB9W43FtbqregFYA', // AWS-secret shape
  '123e4567e89b12d3a456426614174000', // undashed UUID
  ...sample(101, LOWER + UPPER + DIGIT, 24, 8), // random base62, 24
  ...sample(102, LOWER + UPPER + DIGIT, 32, 8), // random base62, 32
  ...sample(103, LOWER + DIGIT, 24, 8), // random base36 lowercase, 24
  ...sample(104, LOWER + UPPER, 24, 8), // random mixed letters, 24
  ...['whsec_', 'shpat_', 'hf_', 'dckr_pat_', 'glsa_', 'rk_test_'].map(p => `${p}${RANDOM_BODY}`),
]

const MUST_KEEP: string[] = [
  'dimensions', 'handleSessionListUpdateResponse', 'SessionTabBarOverflowMenuItem', 'sendUtf8EncodedMessageToServer',
  'decodeBase64UrlToUint8Array', 'base64ToUint8ArrayBuffer', 'decodeUTF8ToUTF16ArrayBuffer', 'HTTP2StreamToHTTP1Message',
  'useMemoizedCallbackHookV3Wrapper9',
  '_private', '$el', 'i', 'x', '__proto__', 'onClick', 'setState', 'React', 'useEffect', 'ChatView', 'MessageBubble', 'ASIANMarketData',
  'npm_config_cache', 'handleSessionListUpdateResponseV2Handler', 'a_very_long_snake_case_identifier_name', 'useChatViewScrollRestoration',
  'this', 'undefined', 'getElementById', 'webpackJsonpCallback'
]

describe('word-shape rule: MUST-REDACT corpus', () => {
  it.each(MUST_REDACT.map(t => [t] as const))('%s is refused as a slot, a frame name and a component name', (tok) => {
    // A token that does not even start like an identifier never reaches the word-shape rule:
    // the template regex omits the whole message, the frame name becomes <anonymous>.
    const startsId = /^[A-Za-z_$]/.test(tok)
    expect(startsId ? isWordShaped(tok) : false).toBe(false)
    const outs = [
      classifyErrorMessage('TypeError', `${tok} is not a function`).text,
      classifyErrorMessage('TypeError', `a.${tok} is not a function`).text,
      classifyErrorMessage('TypeError', `Cannot read properties of undefined (reading '${tok}')`).text,
      ...ns(`at ${tok} (http://localhost/a.js:1:2)`), ...ns(`${tok}@http://localhost/a.js:1:2`), ...normalizeComponentStack(`at ${tok}`),
    ]
    for (const o of outs) expect(o.includes(tok), o).toBe(false)
    if (startsId) {
      expect(classifyErrorMessage('TypeError', `${tok} is not a function`).text).toBe('[REDACTED] is not a function')
      expect(ns(`at ${tok} (http://localhost/a.js:1:2)`)).toEqual(['[REDACTED] @ a.js:1:2'])
      expect(normalizeComponentStack(`at ${tok}`)).toEqual(['[REDACTED]'])
    }
  })

  it('statistically: random tokens almost never get in (fixed seeds, 2000 samples per class)', () => {
    // Only a token that starts like an identifier can reach the rule, so samples start with a letter.
    const slip = (alphabet: string, n: number, seed: number): number =>
      sample(seed, alphabet, n, 2000).map(t => `k${t.slice(1)}`).filter(isWordShaped).length / 2000
    expect(slip(LOWER + UPPER + DIGIT, 24, 201)).toBeLessThan(0.02)
    expect(slip(LOWER + UPPER + DIGIT, 32, 202)).toBeLessThan(0.01)
    expect(slip(LOWER + DIGIT, 24, 203)).toBeLessThan(0.06)
    expect(slip(LOWER + UPPER, 24, 204)).toBeLessThan(0.04)
    expect(slip(DIGIT + 'abcdef', 32, 205)).toBe(0)
    expect(slip(LOWER + UPPER + DIGIT + '_', 43, 206)).toBe(0)
  })
})

describe('word-shape rule: MUST-KEEP corpus', () => {
  it.each(MUST_KEEP.map(t => [t] as const))('%s is kept', (id) => {
    expect(isWordShaped(id)).toBe(true)
    expect(classifyErrorMessage('TypeError', `${id} is not a function`).text).toBe(`${id} is not a function`)
    expect(ns(`at ${id} (http://localhost/a.js:1:2)`)).toEqual([`${id} @ a.js:1:2`])
    expect(normalizeComponentStack(`at ${id}`)).toEqual([id])
  })
})

describe('word-shape rule: each clause', () => {
  it('length 40 is kept and 41 is refused', () => {
    expect(isWordShaped(`${'handle_'.repeat(5)}abcde`)).toBe(true) // 40
    expect(isWordShaped(`${'handle_'.repeat(5)}abcdef`)).toBe(false) // 41
    expect(isWordShaped('aeiou'.repeat(8))).toBe(false) // 40 chars but one 40-letter chunk
  })
  it('digits: at most 4 in total and no run longer than 3', () => {
    expect(isWordShaped('a1b2c3d4')).toBe(false) // 4 digits but 8 one-letter... short chunks
    expect(isWordShaped('utf8Value12')).toBe(true) // 3 digits
    expect(isWordShaped('base64Value')).toBe(true)
    expect(isWordShaped('value123')).toBe(true) // run of 3
    expect(isWordShaped('value1234')).toBe(false) // run of 4
    expect(isWordShaped('valueOne1Two2Three3Four4Five5')).toBe(false) // 5 digits in total
    expect(isWordShaped('valueOne1Two2Three3Four4')).toBe(true) // 4 in total
  })
  it('hex-only of 8 or more is refused (the hex rule), 7 is not', () => {
    expect(isWordShaped('deadbeef')).toBe(false)
    expect(isWordShaped('DEADBEEF')).toBe(false)
    expect(isWordShaped('facade')).toBe(true)
    expect(isWordShaped('abcdefab')).toBe(false)
  })
  it('the vowel rule: a 4+ letter lowercase chunk needs a vowel [aeiouy]', () => {
    expect(isWordShaped('zkzx')).toBe(false)
    expect(isWordShaped('myth')).toBe(true) // y counts
    expect(isWordShaped('fnc')).toBe(true) // 3 letters: exempt
    expect(isWordShaped('doBlkz')).toBe(false) // Blkz
  })
  it('a lowercase chunk is at most 14 and an uppercase-only chunk at most 5', () => {
    expect(isWordShaped('abcdefghijklmno'.replace(/[a-z]/g, 'a'))).toBe(false) // 15 letters
    expect(isWordShaped('internationally')).toBe(false) // 15
    expect(isWordShaped('internationa')).toBe(true) // 12
    expect(isWordShaped('HTTPS')).toBe(true)
    expect(isWordShaped('ASIANX')).toBe(false) // 6 uppercase
    expect(isWordShaped('HTTPStream')).toBe(true) // HTTP + Stream
  })
  it('at most 2 one-letter chunks, and at most 2 chunks of 1-2 letters in all', () => {
    expect(isWordShaped('aXbYc')).toBe(false)
    expect(isWordShaped('xA')).toBe(true)
    expect(isWordShaped('getElByIdOrNm')).toBe(false) // El By Id Or Nm: too many short fragments
  })
  it('a run of 5 consonants in a chunk is refused', () => {
    expect(isWordShaped('strengths')).toBe(false)
    expect(isWordShaped('length')).toBe(true)
  })
  it('non-identifier characters are refused', () => {
    for (const bad of ['', 'a-b', 'a b', 'a.b', "a'b", 'é']) expect(isWordShaped(bad), bad).toBe(false)
  })
})

describe('R3: credential markers inside identifiers', () => {
  const T36 = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
  const PREFIXED = [
    `ghp_${T36}_suffix`, `x_ghp_${T36}`, `gho_${T36}`, `ghu_${T36}`, `ghs_${T36}`, `ghr_${T36}`, 'github_pat_11ABCDEFG0abcdefghij_xyz',
    'AIzaSyAbcdefghij', 'AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE', 'sk_live_abc', 'sk_test_abc', 'rk_live_abc', 'rk_test_abc', 'pk_live_abc',
    'whsec_abc', 'shpat_abc', 'dckr_pat_abc', 'glsa_abc', `hf_${'a'.repeat(20)}`, `oauth_${'a'.repeat(16)}`, `npm_${'a'.repeat(20)}`,
  ]
  it.each(PREFIXED)('a slot containing %s is [REDACTED]', (id) => {
    const r = classifyErrorMessage('TypeError', `Cannot read properties of undefined (reading '${id}')`)
    expect(r.text).toBe("Cannot read properties of undefined (reading '[REDACTED]')")
    expect(classifyErrorMessage('TypeError', `${id} is not a function`).text).toBe('[REDACTED] is not a function')
    expect(ns(`at ${id} (http://localhost/a.js:1:2)`)).toEqual(['[REDACTED] @ a.js:1:2'])
    expect(normalizeComponentStack(`at ${id}`)).toEqual(['[REDACTED]'])
  })
  it('ya29. inside a dotted path is masked', () => {
    expect(classifyErrorMessage('TypeError', 'a.ya29.b is not a function').text).toBe('[REDACTED] is not a function')
  })
  it('shape-gated families keep ordinary names: npm_config_cache, oauth_token, hf_value, AKIA/ASIA words', () => {
    for (const id of ['npm_config_cache', 'oauth_token', 'hf_value', 'ASIANMarketData', 'AKIAlike']) {
      expect(classifyErrorMessage('TypeError', `${id} is not a function`).text, id).toBe(`${id} is not a function`)
    }
  })
})

describe('F3: layers that only a specific input can exercise', () => {
  it('(a) redactValue is load-bearing for slots: a word-shaped JWT in a path slot is masked by redaction alone', () => {
    const jwt = 'eyJhaaaaaaaa.zaaaaaaa.yaaaaaaa'
    expect(jwt.split('.').every(isWordShaped)).toBe(true) // the word-shape rule does NOT catch it
    expect(classifyErrorMessage('TypeError', `${jwt} is not a function`).text).toBe('[REDACTED] is not a function')
  })
  it('(b) redactValue is load-bearing for locations: a word-shaped JWT-like asset name is refused', () => {
    const base = 'eyJhaaaaaaaa.zaaaaaaa.yaaaaaaa.js'
    const set = new Set([base])
    expect(normalizeStack(`at fn (https://h/${base}:1:2)`, { assetBasenames: set })).toEqual(['fn @ <unknown>'])
    expect(normalizeStack(`fn @ ${base}:1:2`, { assetBasenames: set })).toEqual(['fn @ <unknown>'])
  })
  it('(c) a line longer than the cap whose first 513 chars look like a valid frame stays anonymous/unknown', () => {
    const core = ' (https://h/a.js:1:2)'
    const head = `at ${'f'.repeat(513 - 3 - core.length)}${core}`
    expect(head).toHaveLength(513)
    expect(ns(`${head}EXTRA`)).toEqual(['<anonymous> @ <unknown>'])
    expect(ns(head)).toEqual(['<anonymous> @ <unknown>']) // 513 is already past the 512 cap
    // a 512-char line is within the cap, so the location is read
    expect(ns(`at ${'f'.repeat(512 - 3 - core.length)}${core}`)).toEqual(['<anonymous> @ a.js:1:2'])
  })
  it('(d) whitespace before the @ is never a frame, even with a valid location after it', () => {
    expect(ns('Alice Smith@https://h/a.js:1:2')).toEqual([])
    expect(ns('Error: a@https://h/a.js:1:2')).toEqual([])
  })
  it('(e) the message cap is exactly the longest legal template; the next character cannot be a template', () => {
    const SLOT = { id: 'a'.repeat(64), key: 'a'.repeat(64), path: Array.from({ length: 4 }, () => 'a'.repeat(64)).join('.'), nullish: 'undefined' } as const
    const longest = ERROR_TEMPLATE_PATTERNS
      .map(([, pattern]) => pattern.replace(/\{(id|path|key|nullish)\}/g, (_, k: keyof typeof SLOT) => SLOT[k]))
      .reduce((a, b) => (b.length > a.length ? b : a))
    expect(longest.length).toBe(MAX_MESSAGE_CHARS)
    expect(classifyErrorMessage('TypeError', longest).template).not.toBeNull()
    expect(classifyErrorMessage('TypeError', `${longest}x`).template).toBeNull()
    expect(classifyErrorMessage('TypeError', `x${longest}`).template).toBeNull()
    // The cap is derived from the table, so it cannot be a stale hand-written number. It is
    // the regex's own upper bound, so no input exactly one over it can be accepted by the
    // regex alone: the cap guards the input size the regexes ever see, not a verdict.
    expect(MAX_MESSAGE_CHARS).toBeGreaterThan(300)
  })
})

describe('F4: JSC fn@loc needs a valid http(s) location with line:col', () => {
  it('rejects non-locations entirely (no frame at all)', () => {
    for (const line of ['alice@example.com', 'fn@[native code]', 'fn@http://h/a.js', 'fn@http://h/a.js:1', 'fn@file:///x/a.js:1:2', 'fn@ftp://h/a.js:1:2', 'fn@http://host:1:2', 'fn@', '@']) {
      expect(ns(line), line).toEqual([])
    }
  })
  it('a valid location outside the asset set is a frame with an unknown location', () => {
    expect(ns('fn@http://h/zz.js:1:2')).toEqual(['fn @ <unknown>'])
    expect(ns('@http://h/a.js:1:2')).toEqual(['<anonymous> @ a.js:1:2'])
  })
})

describe('F5: digit-only property keys', () => {
  it.each([
    ["Cannot read properties of undefined (reading '0')", 'read-props-of'],
    ["Cannot read properties of null (reading '4294967295')", 'read-props-of'],
    ["Cannot set properties of undefined (setting '12')", 'cannot-set-props-of'],
    ['can\'t access property "5", a.b is undefined', 'cannot-access-property'],
  ])('%s is kept', (message, template) => {
    const r = classifyErrorMessage('TypeError', message)
    expect(r.template).toBe(template)
    expect(r.text).toBe(message)
  })
  it.each([
    "Cannot read properties of undefined (reading '12345678901')", "Cannot read properties of undefined (reading '1a')",
    "Cannot read properties of undefined (reading '-1')", "Cannot read properties of undefined (reading '')", "Cannot read properties of undefined (reading '1.5')",
  ])('%s is omitted', (message) => {
    expect(classifyErrorMessage('TypeError', message).text).toBe(OMIT)
  })
  it('digit keys are only for key slots, not for function or variable names', () => {
    expect(classifyErrorMessage('TypeError', '0 is not a function').text).toBe(OMIT)
    expect(classifyErrorMessage('TypeError', "Cannot access '0' before initialization").text).toBe(OMIT)
  })
})

describe('D2: credential-bearing members of the asset set', () => {
  const MEMBERS = [
    'glpat-abcdefghij.js', 'xoxb-123-456.js', 'xoxp-123-456.js', 'xoxa-123-456.js', 'xoxs-123-456.js', 'sk-abcdef.js', 'sk-ant-abc.js',
    'sk-proj-abc.js', 'index-sk-abc.js', 'rk_test_abc.js', 'whsec_abc.js', 'ghp_abc.js', `npm_${'a'.repeat(20)}.js`, `AKIA${'A1'.repeat(8)}.js`,
  ]
  it.each(MEMBERS)('member %s becomes <unknown> on both branches', (base) => {
    const set = new Set([base])
    expect(normalizeStack(`at fn (https://h/${base}:1:2)`, { assetBasenames: set })).toEqual(['fn @ <unknown>'])
    expect(normalizeStack(`fn @ ${base}:1:2`, { assetBasenames: set })).toEqual(['fn @ <unknown>'])
  })
  it('legitimate bundler hashes are kept: the word-shape rule is NOT applied to basenames', () => {
    const set = new Set(['index-BkL3mZ9x.js', 'task-list-Qz7LmP3x.js', 'vendor-react-Zx9Qw3Er.js'])
    expect(normalizeStack('at fn (https://h/assets/index-BkL3mZ9x.js:1:2)', { assetBasenames: set })).toEqual(['fn @ index-BkL3mZ9x.js:1:2'])
    expect(normalizeStack('at fn (https://h/assets/task-list-Qz7LmP3x.js:1:2)', { assetBasenames: set })).toEqual(['fn @ task-list-Qz7LmP3x.js:1:2'])
    expect(normalizeStack('fn @ vendor-react-Zx9Qw3Er.js:1:2', { assetBasenames: set })).toEqual(['fn @ vendor-react-Zx9Qw3Er.js:1:2'])
  })
})

describe('R4: the [REDACTED] sentinel survives re-validation', () => {
  it('normalizeComponentStack accepts its own sentinel and is idempotent', () => {
    const once = normalizeComponentStack(`at ghp_${'A'.repeat(36)}\nat Foo`)
    expect(once).toEqual(['[REDACTED]', 'Foo'])
    expect(normalizeComponentStack(once.join('\n'))).toEqual(once)
  })
  it('formatErrorReport keeps the sentinel entry', () => {
    const out = fr({ time: 0, version: '1.2.3', platform: 'web', category: 'render', count: 1, name: 'Error', message: 'x', stack: [], componentStack: ['[REDACTED]', 'Foo'] })
    expect(out).toContain('  [REDACTED]\n  Foo')
  })
})

/**
 * Tests for shared tool-summary helpers (#4243).
 *
 * Pin the field-priority extraction (`command` → `file_path` → `path` →
 * `description`) so both the dashboard's `ToolBubble` and the mobile
 * `ToolBubble` derive the same collapsed-preview text from the same
 * partial-JSON / final-input shapes.
 */
import { describe, it, expect } from 'vitest'
import { getInputSummary, getPartialSummary } from './tool-summary'

describe('getPartialSummary (#4243)', () => {
  it('prefers `command` over body when the partial JSON parses', () => {
    const out = getPartialSummary('{"command":"rm -rf node_modules","description":"clean"}')
    expect(out).toBe('rm -rf node_modules')
  })

  it('prefers `file_path` when no `command`', () => {
    const out = getPartialSummary('{"file_path":"/etc/hosts","description":"read hosts"}')
    expect(out).toBe('/etc/hosts')
  })

  it('prefers `path` when no `command` and no `file_path`', () => {
    const out = getPartialSummary('{"path":"/tmp","description":"list"}')
    expect(out).toBe('/tmp')
  })

  it('falls back to `description` when no `command`/`file_path`/`path`', () => {
    const out = getPartialSummary('{"description":"do the thing"}')
    expect(out).toBe('do the thing')
  })

  it('returns null when the buffer is unparseable mid-stream', () => {
    // Caller renders the verbatim head when this returns null.
    expect(getPartialSummary('{"command":"rm -rf ')).toBeNull()
  })

  // #4655 — these used to return null and let the dashboard render
  // `inputPartial.slice(0, 100)` (raw JSON head) as the collapsed
  // preview. Now the generic-summary fallback kicks in so the bubble
  // never leaks raw JSON for unknown shapes (ToolSearch, MCP tools,
  // etc.). The priority-field path is still preferred when present.
  it('falls back to generic key:value summary when no priority field is a string (#4655)', () => {
    expect(getPartialSummary('{"foo":"bar"}')).toBe('foo: "bar"')
  })

  it('falls back to generic key:value summary when a priority field is present but not a string (#4655)', () => {
    // The non-string priority field is rendered like any other key —
    // we no longer special-case it as "missing".
    expect(getPartialSummary('{"command":42}')).toBe('command: 42')
  })

  it('returns null on null / non-object parses', () => {
    expect(getPartialSummary('null')).toBeNull()
    expect(getPartialSummary('"a plain string"')).toBeNull()
    expect(getPartialSummary('42')).toBeNull()
  })

  it('caps the returned summary at 100 chars', () => {
    const long = 'x'.repeat(500)
    const out = getPartialSummary(JSON.stringify({ command: long }))
    expect(out).not.toBeNull()
    expect(out!.length).toBe(100)
  })
})

describe('getInputSummary (#4243)', () => {
  it('returns "" for undefined / null input', () => {
    expect(getInputSummary(undefined)).toBe('')
  })

  it('truncates string input at 100 chars', () => {
    const long = 'x'.repeat(500)
    expect(getInputSummary(long)).toHaveLength(100)
  })

  it('prefers `command` over body for object input', () => {
    expect(getInputSummary({ command: 'ls -la', description: 'list' })).toBe('ls -la')
  })

  it('prefers `file_path` when no `command`', () => {
    expect(getInputSummary({ file_path: '/etc/hosts' })).toBe('/etc/hosts')
  })

  it('prefers `path` when no `command`/`file_path`', () => {
    expect(getInputSummary({ path: '/tmp' })).toBe('/tmp')
  })

  it('falls back to `description` when no `command`/`file_path`/`path`', () => {
    expect(getInputSummary({ description: 'a thing' })).toBe('a thing')
  })

  it('JSON.stringify-falls-back when the priority field is not a string', () => {
    // Matches dashboard behaviour for object-shaped priority fields.
    const out = getInputSummary({ command: { nested: 'thing' } })
    expect(out).toBe(JSON.stringify({ nested: 'thing' }).slice(0, 100))
  })

  it('caps object-derived summary at 100 chars', () => {
    const long = 'y'.repeat(500)
    expect(getInputSummary({ command: long })).toHaveLength(100)
  })
})

// #4648 — Read tool input shape from claude TUI is
// `{type:'text', file:{filePath:'/path'}}`. Pre-fix, none of the priority
// fields matched at the top level (filePath is camelCase + nested), so the
// summary was '' and ToolBubble fell through to raw JSON head, leaking
// `{"type":"text","file":{"filePath":...` as the collapsed preview. Fix
// adds `filePath` to PRIORITY_FIELDS and one-level walk into nested
// objects.
describe('nested priority-field walk (#4648 — Read tool input)', () => {
  it('getInputSummary extracts filePath from Read tool nested shape', () => {
    expect(getInputSummary({ type: 'text', file: { filePath: '/Users/foo/x.md' } })).toBe('/Users/foo/x.md')
  })

  it('getPartialSummary extracts filePath from Read tool nested shape', () => {
    const json = JSON.stringify({ type: 'text', file: { filePath: '/Users/foo/x.md' } })
    expect(getPartialSummary(json)).toBe('/Users/foo/x.md')
  })

  it('top-level filePath also works (not just nested)', () => {
    // Some tools may emit camelCase at the top level too — make sure adding
    // filePath to PRIORITY_FIELDS doesn't regress that path.
    expect(getInputSummary({ filePath: '/etc/hosts' })).toBe('/etc/hosts')
  })

  it('nested walk stops at one level (no recursion)', () => {
    // Pathological deep nesting must NOT be walked — bounded preview cost
    // is load-bearing on hot ToolBubble render path. #4655: the
    // generic-fallback now renders the top-level key as `{...}` so
    // unknown shapes never leak raw JSON; the nested filePath is
    // intentionally not extracted.
    const deep = { a: { b: { c: { filePath: '/should/not/match' } } } }
    expect(getInputSummary(deep)).toBe('a: {...}')
  })

  it('nested walk does not descend into arrays', () => {
    // #4655: same as above — the array renders as `[N]`, never
    // recursing into its elements to extract a nested filePath.
    const arr = { items: [{ filePath: '/should/not/match' }] }
    expect(getInputSummary(arr)).toBe('items: [1]')
  })

  it('top-level priority wins over nested priority', () => {
    // `command` at top level beats `filePath` nested — preserve documented
    // priority order (top-level pass runs first).
    expect(getInputSummary({ command: 'ls', file: { filePath: '/other' } })).toBe('ls')
  })

  it('nested walk caps at PREVIEW_MAX_LEN like top-level', () => {
    const long = 'z'.repeat(500)
    expect(getInputSummary({ file: { filePath: long } })).toHaveLength(100)
  })
})

// #4655 — generic-fallback summary for tools whose input shape has none
// of the PRIORITY_FIELDS. Pre-fix this fell through to raw JSON head
// (`{"matches":["AskUser..."],"query":"select:...","total_d...`) in the
// collapsed bubble — verified live during v0.9.24 dogfood for the
// ToolSearch tool. The class of bug grows with every new tool shape
// (MCP tools, custom user tools, future Anthropic tools) — extending
// PRIORITY_FIELDS per-tool is unbounded maintenance, hence the
// generic-fallback path.
describe('generic-fallback summary for unknown tool shapes (#4655)', () => {
  describe('getInputSummary', () => {
    it('renders ToolSearch input as compact key:value list', () => {
      // Real ToolSearch shape — no priority field, two top-level keys.
      // The collapsed bubble previously leaked the raw JSON head.
      expect(getInputSummary({ query: 'select:AskUserQuestion', max_results: 5 }))
        .toBe('query: "select:AskUserQuestion", max_results: 5')
    })

    it('renders MCP-style input with arbitrary keys as compact key:value list', () => {
      // MCP tool inputs follow per-server schemas; no allowlist can keep up.
      expect(getInputSummary({ url: 'https://example.com', timeout_ms: 5000 }))
        .toBe('url: "https://example.com", timeout_ms: 5000')
    })

    it('renders boolean and null values inline', () => {
      // Primitive rendering must cover the JSON value spectrum.
      expect(getInputSummary({ enabled: true, retries: 0, cursor: null }))
        .toBe('enabled: true, retries: 0, cursor: null')
    })

    it('renders nested objects as `{...}` placeholders, never raw JSON', () => {
      // A nested object in an unknown-shape input is the canonical leak
      // vector — must NOT inline-render its contents.
      const out = getInputSummary({ options: { recursive: true, follow: false }, name: 'scan' })
      expect(out).toBe('options: {...}, name: "scan"')
      // Defensively pin: no curly brace from a nested object payload should leak.
      expect(out).not.toContain('"recursive"')
    })

    it('renders arrays as `[N]` length placeholders', () => {
      expect(getInputSummary({ items: [1, 2, 3], action: 'sort' }))
        .toBe('items: [3], action: "sort"')
    })

    it('truncates long string values inside quotes so structure stays visible', () => {
      const long = 'a'.repeat(120)
      const out = getInputSummary({ query: long })
      // Quoted, truncated to 37 chars + ellipsis inside the quotes.
      expect(out).toBe(`query: "${'a'.repeat(37)}..."`)
    })

    it('caps the whole summary at PREVIEW_MAX_LEN (100 chars)', () => {
      // Many short keys whose combined render exceeds the budget —
      // later keys must be dropped, not truncated mid-value.
      const wide: Record<string, unknown> = {}
      for (let i = 0; i < 30; i++) wide[`k${i}`] = `v${i}`
      const out = getInputSummary(wide)
      expect(out.length).toBeLessThanOrEqual(100)
    })

    it('degrades to key-count summary when the first key:value would overflow', () => {
      // The first key is itself longer than the budget — fall back to a
      // plain "N keys: ..." listing so something useful still renders.
      const longKey = 'x'.repeat(150)
      const out = getInputSummary({ [longKey]: 'value', a: 1, b: 2 })
      expect(out.startsWith('3 keys: ')).toBe(true)
      expect(out.length).toBeLessThanOrEqual(100)
    })

    it('returns "" for an empty object (no keys to summarize)', () => {
      expect(getInputSummary({})).toBe('')
    })

    it('priority field wins over generic fallback even when both could apply', () => {
      // Regression guard: adding the generic fallback must not displace
      // the existing field-priority behaviour for known shapes.
      expect(getInputSummary({ command: 'ls', extra: 'meta' })).toBe('ls')
    })
  })

  describe('getPartialSummary', () => {
    it('renders parseable ToolSearch input via the generic fallback', () => {
      // The collapsed bubble must never leak raw JSON for unknown shapes —
      // this is the canonical regression fixture.
      const json = JSON.stringify({ query: 'select:AskUserQuestion', max_results: 5 })
      expect(getPartialSummary(json)).toBe('query: "select:AskUserQuestion", max_results: 5')
    })

    it('still returns null for mid-stream unparseable buffers', () => {
      // The Bash early-abort UX (#4063) depends on the verbatim-tail
      // fallback for mid-stream chunks — the generic fallback only
      // applies to fully-parsed structured objects.
      expect(getPartialSummary('{"query":"select:')).toBeNull()
    })

    it('returns null for parseable but empty object (nothing to summarize)', () => {
      expect(getPartialSummary('{}')).toBeNull()
    })
  })
})

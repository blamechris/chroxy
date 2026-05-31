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

  it('returns null when none of the priority fields are strings', () => {
    expect(getPartialSummary('{"foo":"bar"}')).toBeNull()
  })

  it('returns null when a priority field is present but not a string', () => {
    expect(getPartialSummary('{"command":42}')).toBeNull()
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
    // is load-bearing on hot ToolBubble render path.
    const deep = { a: { b: { c: { filePath: '/should/not/match' } } } }
    expect(getInputSummary(deep)).toBe('')
  })

  it('nested walk does not descend into arrays', () => {
    const arr = { items: [{ filePath: '/should/not/match' }] }
    expect(getInputSummary(arr)).toBe('')
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

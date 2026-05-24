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

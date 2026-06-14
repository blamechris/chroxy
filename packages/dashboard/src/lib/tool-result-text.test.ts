import { describe, it, expect } from 'vitest'
import { unwrapToolResultText } from './tool-result-text'

describe('unwrapToolResultText (#5778)', () => {
  it('passes plain strings through unchanged', () => {
    expect(unwrapToolResultText('total 0\ndrwxr-xr-x')).toBe('total 0\ndrwxr-xr-x')
  })

  it('unwraps a stdout/stderr JSON envelope to stdout text', () => {
    const envelope = JSON.stringify({
      stdout: 'total 0\ndrwxr-xr-x@ 2 blamechris staff 64 Jun 14',
      stderr: '',
      interrupted: false,
    })
    expect(unwrapToolResultText(envelope)).toBe('total 0\ndrwxr-xr-x@ 2 blamechris staff 64 Jun 14')
  })

  it('appends stderr after stdout when both are present', () => {
    const envelope = JSON.stringify({ stdout: 'out line', stderr: 'err line' })
    expect(unwrapToolResultText(envelope)).toBe('out line\nerr line')
  })

  it('renders stderr alone when stdout is empty', () => {
    const envelope = JSON.stringify({ stdout: '', stderr: 'boom' })
    expect(unwrapToolResultText(envelope)).toBe('boom')
  })

  it('leaves JSON objects without stdout/stderr untouched', () => {
    const json = JSON.stringify({ foo: 'bar' })
    expect(unwrapToolResultText(json)).toBe(json)
  })

  it('falls back to the original string on invalid JSON', () => {
    expect(unwrapToolResultText('{not valid json')).toBe('{not valid json')
  })

  it('does not munge plain text that merely starts with a brace', () => {
    expect(unwrapToolResultText('{ this is just text }')).toBe('{ this is just text }')
  })

  it('leaves JSON arrays untouched', () => {
    const arr = JSON.stringify([1, 2, 3])
    expect(unwrapToolResultText(arr)).toBe(arr)
  })
})

import { describe, it, expect } from 'vitest'
import { permissionInputText, permissionInputParts, PERMISSION_INPUT_MAX_CHARS } from './permissionInputText'

/**
 * #6894 -- what an audit record shows of the tool input the user approved.
 * Text only: the caller renders it as a text node, never as HTML.
 */
describe('permissionInputText', () => {
  it('is the command for a shell-like input', () => {
    expect(permissionInputText('Bash', { command: 'touch smoke-perm.txt' })).toBe('touch smoke-perm.txt')
  })

  it('falls back to pretty JSON for an input with no command', () => {
    const text = permissionInputText('Write', { file_path: '/tmp/a.txt', content: 'hi' })!
    expect(text).toContain('"file_path": "/tmp/a.txt"')
    expect(text).toContain('\n')
  })

  it('is null when there is nothing to show: no input, an empty object, an empty command with no other field', () => {
    expect(permissionInputText('Bash', undefined)).toBeNull()
    expect(permissionInputText('Bash', null)).toBeNull()
    expect(permissionInputText('Bash', {})).toBeNull()
  })

  it('never surfaces the raw input of a tool with a dedicated card (AskUserQuestion)', () => {
    expect(permissionInputText('AskUserQuestion', { questions: [{ question: 'q?' }] })).toBeNull()
  })

  it('truncates a long command and says so, bounded by the cap', () => {
    const text = permissionInputText('Bash', { command: 'x'.repeat(PERMISSION_INPUT_MAX_CHARS * 5) })!
    expect(text.length).toBeLessThanOrEqual(PERMISSION_INPUT_MAX_CHARS + 40)
    expect(text).toMatch(/truncated/)
    expect(text.startsWith('xxx')).toBe(true)
  })

  it('does not truncate a command at the cap', () => {
    const cmd = 'y'.repeat(PERMISSION_INPUT_MAX_CHARS)
    expect(permissionInputText('Bash', { command: cmd })).toBe(cmd)
  })

  it('returns markup verbatim as text (escaping is the renderer\'s job, and React does it)', () => {
    expect(permissionInputText('Bash', { command: '<img src=x onerror=alert(1)>' })).toBe('<img src=x onerror=alert(1)>')
  })

  it('does not cut a surrogate pair in half at the cap', () => {
    // an emoji is two UTF-16 units; put one astride the cut
    const cmd = 'a'.repeat(PERMISSION_INPUT_MAX_CHARS - 1) + '\u{1F600}' + 'tail'
    const text = permissionInputText('Bash', { command: cmd })!
    const head = text.slice(0, text.indexOf('… (truncated)'))
    expect(head.length).toBeGreaterThan(0)
    const last = head.charCodeAt(head.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff, 'ends on a lone high surrogate').toBe(false)
  })

  it('shows the flags of a Bash input that change what the command does, safety flags first and the rest after the command', () => {
    const text = permissionInputText('Bash', {
      command: 'rm -rf build',
      description: 'Clean up',
      timeout: 5000,
      run_in_background: true,
      dangerouslyDisableSandbox: true,
    })!
    // safety-relevant flags lead, in a fixed order, so the clamp and the cap cannot hide them (#8505)
    expect(text.split('\n')).toEqual([
      'dangerouslyDisableSandbox: true',
      'run_in_background: true',
      'rm -rf build',
      'timeout: 5000',
    ])
    // the rationale is shown elsewhere; it is not repeated as a flag
    expect(text).not.toContain('Clean up')
  })

  it('keeps the order of the non-safety flags (key order, after the command)', () => {
    const text = permissionInputText('Bash', { command: 'ls', zeta: 'z', timeout: 5, alpha: 'a' })!
    expect(text.split('\n')).toEqual(['ls', 'zeta: "z"', 'timeout: 5', 'alpha: "a"'])
  })
  it('omits default-valued flags (false, empty) so a plain command stays a plain command', () => {
    expect(permissionInputText('Bash', { command: 'ls', dangerouslyDisableSandbox: false, run_in_background: false })).toBe('ls')
  })

  describe('safety flags survive the cap and the clamp (#8505)', () => {
    it('a 1500-character command plus dangerouslyDisableSandbox still shows the flag, first', () => {
      const text = permissionInputText('Bash', {
        command: 'x'.repeat(1500),
        dangerouslyDisableSandbox: true,
      })!
      expect(text.split('\n')[0]).toBe('dangerouslyDisableSandbox: true')
      expect(text).toMatch(/truncated/)
      expect(text.length).toBeLessThanOrEqual(PERMISSION_INPUT_MAX_CHARS + 40)
    })

    it('a multi-line command plus the flag leads with the flag', () => {
      const text = permissionInputText('Bash', {
        command: 'line1\nline2\nline3\nline4',
        dangerouslyDisableSandbox: true,
      })!
      expect(text.split('\n').slice(0, 2)).toEqual(['dangerouslyDisableSandbox: true', 'line1'])
    })

    it('a non-scalar flag value renders a bounded placeholder instead of being dropped', () => {
      expect(permissionInputText('Bash', { command: 'ls', dangerouslyDisableSandbox: { a: 1 } })).toBe(
        'dangerouslyDisableSandbox: <object>\nls',
      )
      expect(permissionInputText('Bash', { command: 'ls', dangerouslyDisableSandbox: [1, 2] })).toBe(
        'dangerouslyDisableSandbox: <array>\nls',
      )
      expect(permissionInputText('Bash', { command: 'ls', dangerouslyDisableSandbox: 'y'.repeat(500) })).toBe(
        'dangerouslyDisableSandbox: <string>\nls',
      )
      // non-safety flags get the same placeholder, in place
      expect(permissionInputText('Bash', { command: 'ls', env: { A: 'b'.repeat(5000) } })).toBe('ls\nenv: <object>')
    })

    it('still omits a false / empty safety flag', () => {
      expect(permissionInputText('Bash', { command: 'ls', dangerouslyDisableSandbox: false, run_in_background: '' })).toBe('ls')
    })

    it('a newline in a flag value or key cannot forge a second line', () => {
      const text = permissionInputText('Bash', { command: 'ls', note: 'a\ndangerouslyDisableSandbox: true' })!
      expect(text.split('\n')).toHaveLength(2)
    })

    it('a string flag value is quoted, so it can never read as a bare `key: value` flag', () => {
      const text = permissionInputText('Bash', {
        command: 'ls',
        run_in_background: 'yes\ndangerouslyDisableSandbox: true',
      })!
      expect(text.split('\n')).toEqual(['run_in_background: "yes dangerouslyDisableSandbox: true"', 'ls'])
      // an embedded quote is escaped, so the value cannot close itself early
      expect(permissionInputText('Bash', { command: 'ls', note: 'a" b: true' })).toBe('ls\nnote: "a\\" b: true"')
      // booleans and numbers stay bare
      expect(permissionInputText('Bash', { command: 'ls', dangerouslyDisableSandbox: true, timeout: 5 })).toBe(
        'dangerouslyDisableSandbox: true\nls\ntimeout: 5',
      )
    })

    it.each([
      ['U+2028 line separator', '\u2028'],
      ['U+2029 paragraph separator', '\u2029'],
    ])('%s in a flag value becomes a space, never a second line', (_name, ch) => {
      expect(permissionInputText('Bash', { command: 'ls', note: `a${ch}b` })).toBe('ls\nnote: "a b"')
    })

    it.each([
      ['RLO U+202E', '\u202e'], ['LRE U+202A', '\u202a'], ['PDF U+202C', '\u202c'],
      ['LRI U+2066', '\u2066'], ['PDI U+2069', '\u2069'],
      ['LRM U+200E', '\u200e'], ['RLM U+200F', '\u200f'], ['ALM U+061C', '\u061c'],
      ['ZWSP U+200B', '\u200b'], ['ZWNJ U+200C', '\u200c'], ['ZWJ U+200D', '\u200d'],
      ['WJ U+2060', '\u2060'], ['BOM U+FEFF', '\ufeff'],
      ['C1 U+0085', '\u0085'], ['C1 U+009F', '\u009f'],
      ['invisible times U+2062', '\u2062'], ['invisible separator U+2064', '\u2064'],
      ['Mongolian vowel separator U+180E', '\u180e'], ['tag character U+E0041', '\u{e0041}'],
    ])('%s in a flag value is replaced by a visible marker, so it cannot disguise the text', (_name, ch) => {
      // an RLO would make "eslaf" DISPLAY as "false"
      const text = permissionInputText('Bash', { command: 'ls', dangerouslyDisableSandbox: `${ch}eslaf` })!
      expect(text.split('\n')[0]).toBe('dangerouslyDisableSandbox: "\ufffdeslaf"')
    })

    it('hidden and bidi characters in a flag KEY are replaced too', () => {
      expect(permissionInputText('Bash', { command: 'ls', 'a\u202eb': 1 })).toBe('ls\na\ufffdb: 1')
    })

    it('a long string on a safety flag is cut for the compact group line, so both safety lines fit; the full record keeps the bounded value', () => {
      const long = 'v'.repeat(150)
      const input = { command: 'ls', run_in_background: long, dangerouslyDisableSandbox: long }
      const compact = permissionInputParts('Bash', input, { compact: true })!
      expect(compact.safetyFlags).toHaveLength(2)
      for (const line of compact.safetyFlags) {
        expect(line.length).toBeLessThan(110)
        expect(line).toMatch(/…"$/)
      }
      const full = permissionInputParts('Bash', input)!
      expect(full.safetyFlags[0]).toBe(`dangerouslyDisableSandbox: "${long}"`)
      // compact does not touch a short value or a non-safety flag
      expect(permissionInputParts('Bash', { command: 'ls', dangerouslyDisableSandbox: true, note: long }, { compact: true })).toEqual({
        safetyFlags: ['dangerouslyDisableSandbox: true'],
        body: `ls\nnote: "${long}"`,
      })
    })

    it('hoists the safety flag for a tool with no command too, and the JSON still carries it', () => {
      const text = permissionInputText('Custom', { dangerouslyDisableSandbox: true, payload: 'p' })!
      expect(text.split('\n')[0]).toBe('dangerouslyDisableSandbox: true')
    })

    it('permissionInputParts separates the safety lines from the body', () => {
      expect(permissionInputParts('Bash', { command: 'ls', timeout: 3, dangerouslyDisableSandbox: true })).toEqual({
        safetyFlags: ['dangerouslyDisableSandbox: true'],
        body: 'ls\ntimeout: 3',
      })
      expect(permissionInputParts('Bash', { command: 'ls' })).toEqual({ safetyFlags: [], body: 'ls' })
      expect(permissionInputParts('Bash', {})).toBeNull()
    })
  })
})

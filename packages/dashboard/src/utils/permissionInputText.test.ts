import { describe, it, expect } from 'vitest'
import { permissionInputText, PERMISSION_INPUT_MAX_CHARS } from './permissionInputText'

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

  it('shows the flags of a Bash input that change what the command does, beside the command', () => {
    const text = permissionInputText('Bash', {
      command: 'rm -rf build',
      description: 'Clean up',
      dangerouslyDisableSandbox: true,
      run_in_background: true,
      timeout: 5000,
    })!
    expect(text.split('\n')[0]).toBe('rm -rf build')
    expect(text).toContain('dangerouslyDisableSandbox: true')
    expect(text).toContain('run_in_background: true')
    expect(text).toContain('timeout: 5000')
    // the rationale is shown elsewhere; it is not repeated as a flag
    expect(text).not.toContain('Clean up')
  })

  it('omits default-valued flags (false, empty) so a plain command stays a plain command', () => {
    expect(permissionInputText('Bash', { command: 'ls', dangerouslyDisableSandbox: false, run_in_background: false })).toBe('ls')
  })
})

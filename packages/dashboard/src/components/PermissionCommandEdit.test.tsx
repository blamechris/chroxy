/**
 * PermissionCommandEdit tests (#6773) — the editable Bash command field.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PermissionCommandEdit, isEditableCommandTool } from './PermissionCommandEdit'

afterEach(() => cleanup())

describe('isEditableCommandTool (#6773)', () => {
  it('Bash is editable', () => {
    expect(isEditableCommandTool('Bash')).toBe(true)
  })
  it('codex `shell` is NOT editable (codex owns command execution)', () => {
    expect(isEditableCommandTool('shell')).toBe(false)
  })
  it('non-command tools are not editable', () => {
    for (const t of ['Write', 'Edit', 'Read', 'Task', 'WebFetch']) {
      expect(isEditableCommandTool(t)).toBe(false)
    }
  })
})

describe('PermissionCommandEdit (#6773)', () => {
  it('renders the original command and emits null before any edit', () => {
    const onChange = vi.fn()
    render(<PermissionCommandEdit input={{ command: 'ls -a' }} onEditedInputChange={onChange} />)
    expect(screen.getByTestId('perm-command-input')).toHaveValue('ls -a')
    // The reset effect fires on mount → emits null (no edit yet).
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('emits { command } when edited, and null again when reverted to the original', () => {
    const onChange = vi.fn()
    render(<PermissionCommandEdit input={{ command: 'ls' }} onEditedInputChange={onChange} />)
    const editor = screen.getByTestId('perm-command-input')

    fireEvent.change(editor, { target: { value: 'ls -la' } })
    expect(onChange).toHaveBeenLastCalledWith({ command: 'ls -la' })
    expect(screen.getByTestId('perm-command-edited-hint')).toBeInTheDocument()

    fireEvent.change(editor, { target: { value: 'ls' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(screen.queryByTestId('perm-command-edited-hint')).not.toBeInTheDocument()
  })

  it('tolerates a missing command field (renders empty, emits null)', () => {
    const onChange = vi.fn()
    render(<PermissionCommandEdit input={{}} onEditedInputChange={onChange} />)
    expect(screen.getByTestId('perm-command-input')).toHaveValue('')
    expect(onChange).toHaveBeenLastCalledWith(null)
  })
})

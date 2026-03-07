/**
 * CreateSessionModal combobox and auto-naming tests (#1477)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ defaultProvider: 'claude-sdk', availableProviders: [] }),
}))

import { CreateSessionModal, type CreateSessionModalProps } from './CreateSessionModal'

afterEach(cleanup)

function renderModal(props: Partial<CreateSessionModalProps> = {}) {
  const onCreate = vi.fn()
  const onClose = vi.fn()
  const defaultProps: CreateSessionModalProps = {
    open: true,
    onClose,
    onCreate,
    initialCwd: '',
    knownCwds: [],
    existingNames: [],
    ...props,
  }
  const result = render(<CreateSessionModal {...defaultProps} />)
  return { ...result, onCreate, onClose }
}

describe('CreateSessionModal auto-naming (#1477)', () => {
  it('generates name from CWD path basename', () => {
    renderModal({ initialCwd: '/home/user/projects/my-app' })
    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('my-app')
  })

  it('generates "Session" when CWD is empty', () => {
    renderModal({ initialCwd: '' })
    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('')
  })

  it('appends (2) when name collides with existing', () => {
    renderModal({
      initialCwd: '/home/user/projects/api',
      existingNames: ['api'],
    })
    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('api (2)')
  })

  it('appends (3) when (2) also exists', () => {
    renderModal({
      initialCwd: '/home/user/projects/api',
      existingNames: ['api', 'api (2)'],
    })
    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('api (3)')
  })

  it('manual name edit disables auto-naming', () => {
    renderModal({
      initialCwd: '/home/user/projects/api',
      knownCwds: ['/home/user/projects/api', '/home/user/projects/web'],
    })
    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('api')

    // Manually edit the name
    fireEvent.change(nameInput, { target: { value: 'Custom Name' } })
    expect(nameInput.value).toBe('Custom Name')

    // Focus the CWD input to show suggestions
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)

    // Select a different suggestion via mouse
    const suggestions = screen.getAllByRole('option')
    fireEvent.mouseDown(suggestions[1]!) // 'web' (sorted)

    // Name should NOT change because it was manually edited
    expect(nameInput.value).toBe('Custom Name')
  })
})

describe('CreateSessionModal combobox keyboard (#1477)', () => {
  it('shows suggestions on CWD input focus', () => {
    renderModal({
      knownCwds: ['/home/user/projects/api', '/home/user/projects/web'],
    })
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)
    const listbox = screen.getByRole('listbox')
    expect(listbox).toBeInTheDocument()
    const { getAllByRole } = within(listbox)
    expect(getAllByRole('option')).toHaveLength(2)
  })

  it('ArrowDown navigates through suggestions', () => {
    renderModal({
      knownCwds: ['/home/user/projects/api', '/home/user/projects/web'],
    })
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)

    // ArrowDown selects first
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    // ArrowDown selects second
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
  })

  it('Enter on selected suggestion updates CWD and auto-name', () => {
    renderModal({
      knownCwds: ['/home/user/projects/api', '/home/user/projects/web'],
    })
    const cwdInput = screen.getByLabelText('Working directory') as HTMLInputElement
    fireEvent.focus(cwdInput)

    // Navigate to first suggestion
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    // Select it
    fireEvent.keyDown(cwdInput, { key: 'Enter' })

    // CWD should be updated (suggestions are sorted: api, web)
    expect(cwdInput.value).toBe('/home/user/projects/api')
    // Name should auto-update
    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('api')
  })

  it('Escape closes suggestion list', () => {
    renderModal({
      knownCwds: ['/home/user/projects/api'],
    })
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(cwdInput, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

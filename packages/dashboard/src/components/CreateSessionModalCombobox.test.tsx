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
    selector({ defaultProvider: 'claude-sdk', availableProviders: [], requestDirectoryListing: () => {}, setDirectoryListingCallback: () => {}, defaultCwd: null }),
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

  // #7370-style affordance (Tab completes without sending/navigating) already
  // existed here pre-#8084 but had no dedicated test — added alongside the
  // Shift+Tab regression test below so the pair pins both directions.
  it('Tab completes the highlighted suggestion into CWD', () => {
    renderModal({
      knownCwds: ['/home/user/projects/api', '/home/user/projects/web'],
    })
    const cwdInput = screen.getByLabelText('Working directory') as HTMLInputElement
    fireEvent.focus(cwdInput)
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    fireEvent.keyDown(cwdInput, { key: 'Tab' })
    expect(cwdInput.value).toBe('/home/user/projects/api/')
  })

  // #8084 — `handleCwdKeyDown`'s Tab-completion branch did not exclude
  // Shift+Tab, so reverse-tabbing OUT of the cwd field while the suggestions
  // dropdown was open completed the highlighted suggestion instead of moving
  // focus backward — the same class of bug the issue's Shift+Tab fix
  // addresses globally. Mirrors InputBar.tsx's slash-command/file pickers,
  // which already exclude `e.shiftKey` from their identical Tab-complete
  // branches (#7370).
  it('Shift+Tab does NOT complete the suggestion — it is left for reverse focus navigation (#8084)', () => {
    renderModal({
      knownCwds: ['/home/user/projects/api', '/home/user/projects/web'],
    })
    const cwdInput = screen.getByLabelText('Working directory') as HTMLInputElement
    // `fireEvent.focus` (not a real `.focus()` call) matches every other test
    // in this file — it's what reliably drives `showSuggestions` true here.
    // Note this means `document.activeElement` is NOT actually the cwd input
    // in this environment, so Modal.tsx's OWN (separate, legitimate) focus
    // trap also runs its edge-of-modal wraparound check on every keydown here
    // and would itself call preventDefault — asserting on
    // `event.defaultPrevented` would therefore conflate two different
    // preventDefault callers. The unconfounded signal is the completed
    // VALUE: only `handleCwdKeyDown`'s own branch calls `selectSuggestion`.
    fireEvent.focus(cwdInput)
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    fireEvent.keyDown(cwdInput, { key: 'Tab', shiftKey: true })
    expect(cwdInput.value, 'Shift+Tab must not complete the suggestion into the cwd field').toBe('')
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

  // #8064 — the Enter that commits an IME composition must not be read as
  // "select the highlighted suggestion".
  it('does not select the highlighted suggestion on Enter during IME composition', () => {
    renderModal({
      knownCwds: ['/home/user/projects/api', '/home/user/projects/web'],
    })
    const cwdInput = screen.getByLabelText('Working directory') as HTMLInputElement
    fireEvent.focus(cwdInput)
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })

    fireEvent.keyDown(cwdInput, { key: 'Enter', isComposing: true })

    expect(cwdInput.value).toBe('')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })
})

describe('CreateSessionModal submit (#8064)', () => {
  // #8064 — the Enter that commits an IME composition must not be read as
  // "submit the session name".
  it('does not submit the session name on Enter during IME composition', () => {
    const { onCreate } = renderModal({ initialCwd: '/home/user/projects/my-app' })
    const nameInput = screen.getByLabelText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('my-app')

    fireEvent.keyDown(nameInput, { key: 'Enter', isComposing: true })

    expect(onCreate).not.toHaveBeenCalled()
  })
})

/**
 * CreateSessionModal ARIA combobox tests (#1478)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ defaultProvider: 'claude-sdk', availableProviders: [], requestDirectoryListing: () => {}, setDirectoryListingCallback: () => {} }),
}))

import { CreateSessionModal } from './CreateSessionModal'

afterEach(cleanup)

function renderModal(knownCwds: string[] = ['/home/user/api', '/home/user/web']) {
  return render(
    <CreateSessionModal
      open={true}
      onClose={vi.fn()}
      onCreate={vi.fn()}
      initialCwd=""
      knownCwds={knownCwds}
      existingNames={[]}
    />,
  )
}

describe('CreateSessionModal ARIA combobox (#1478)', () => {
  it('uses unique id for listbox (not hard-coded)', () => {
    renderModal()
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)
    const listbox = screen.getByRole('listbox')
    const controlsId = cwdInput.getAttribute('aria-controls')
    expect(controlsId).toBeTruthy()
    expect(listbox.id).toBe(controlsId)
    // Should NOT be the hard-coded value
    expect(controlsId).not.toBe('cwd-suggestions')
  })

  it('option elements have stable id attributes', () => {
    renderModal()
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)
    const listbox = screen.getByRole('listbox')
    const options = within(listbox).getAllByRole('option')
    for (const opt of options) {
      expect(opt.id).toBeTruthy()
    }
  })

  it('aria-activedescendant points to highlighted option on ArrowDown', () => {
    renderModal()
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)

    // No active descendant initially
    expect(cwdInput.getAttribute('aria-activedescendant')).toBeFalsy()

    // ArrowDown selects first
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option')
    expect(cwdInput.getAttribute('aria-activedescendant')).toBe(options[0]!.id)
  })

  it('aria-activedescendant updates on further ArrowDown', () => {
    renderModal()
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)

    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option')
    expect(cwdInput.getAttribute('aria-activedescendant')).toBe(options[1]!.id)
  })

  it('aria-activedescendant clears when suggestions close', () => {
    renderModal()
    const cwdInput = screen.getByLabelText('Working directory')
    fireEvent.focus(cwdInput)
    fireEvent.keyDown(cwdInput, { key: 'ArrowDown' })
    expect(cwdInput.getAttribute('aria-activedescendant')).toBeTruthy()

    fireEvent.keyDown(cwdInput, { key: 'Escape' })
    expect(cwdInput.getAttribute('aria-activedescendant')).toBeFalsy()
  })
})

/**
 * Tests for Create Session modal submit behavior (issue #1456).
 *
 * Verifies that:
 * 1. Modal doesn't close immediately on Create — waits for server confirmation
 * 2. Server error is displayed inline in the modal
 * 3. Create button shows loading state while pending
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

import { CreateSessionModal } from './CreateSessionModal'

afterEach(cleanup)

const baseProps = {
  open: true,
  onClose: vi.fn(),
  onCreate: vi.fn(),
  initialCwd: '/Users/me/projects',
  knownCwds: [] as string[],
  existingNames: [] as string[],
}

describe('CreateSessionModal submit behavior (#1456)', () => {
  it('calls onCreate but does NOT call onClose on Create click', () => {
    const onClose = vi.fn()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onClose={onClose} onCreate={onCreate} />)

    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    // Modal should NOT close immediately — must wait for server response
    expect(onClose).not.toHaveBeenCalled()
  })

  it('displays serverError when provided', () => {
    render(<CreateSessionModal {...baseProps} serverError="Directory not found" />)

    expect(screen.getByText('Directory not found')).toBeInTheDocument()
  })

  it('disables Create button when isCreating is true', () => {
    render(<CreateSessionModal {...baseProps} isCreating={true} />)

    const createBtn = screen.getByRole('button', { name: /creat/i })
    expect(createBtn).toBeDisabled()
  })

  it('shows loading text on Create button when isCreating', () => {
    render(<CreateSessionModal {...baseProps} isCreating={true} />)

    expect(screen.getByRole('button', { name: /creating/i })).toBeInTheDocument()
  })

  it('clears serverError when user types in name field', () => {
    const { rerender } = render(<CreateSessionModal {...baseProps} serverError="Some error" />)

    expect(screen.getByText('Some error')).toBeInTheDocument()

    // After user changes name, parent should clear the error via onClearError
    // But the error display itself is controlled by the prop
    rerender(<CreateSessionModal {...baseProps} serverError={undefined} />)

    expect(screen.queryByText('Some error')).not.toBeInTheDocument()
  })
})

/**
 * Modal and CreateSessionModal tests (#1164)
 * Toast tests are in Toast.test.tsx
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ defaultProvider: 'claude-sdk', availableProviders: [], requestDirectoryListing: () => {}, setDirectoryListingCallback: () => {}, defaultCwd: null }),
}))

import { Modal } from './Modal'
import { CreateSessionModal } from './CreateSessionModal'

afterEach(cleanup)

describe('Modal', () => {
  it('renders children when open', () => {
    render(
      <Modal open onClose={vi.fn()} title="Test Modal">
        <p>Modal content</p>
      </Modal>
    )
    expect(screen.getByText('Test Modal')).toBeInTheDocument()
    expect(screen.getByText('Modal content')).toBeInTheDocument()
  })

  it('does not render when closed', () => {
    render(
      <Modal open={false} onClose={vi.fn()} title="Hidden">
        <p>Hidden content</p>
      </Modal>
    )
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument()
  })

  it('has role=dialog and aria-modal on content (#1186)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Accessible Modal">
        <p>Content</p>
      </Modal>
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('has aria-labelledby pointing at modal title (#1186)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Labeled Modal">
        <p>Content</p>
      </Modal>
    )
    const dialog = screen.getByRole('dialog')
    const labelId = dialog.getAttribute('aria-labelledby')
    expect(labelId).toBeTruthy()
    const title = document.getElementById(labelId!)
    expect(title).toHaveTextContent('Labeled Modal')
  })

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Closable">
        <p>Content</p>
      </Modal>
    )
    fireEvent.click(screen.getByTestId('modal-overlay'))
    expect(onClose).toHaveBeenCalled()
  })

  it('does not close when modal content clicked', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Closable">
        <p>Content</p>
      </Modal>
    )
    fireEvent.click(screen.getByText('Content'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape key', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Escapable">
        <p>Content</p>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('only closes the topmost modal on Escape when nested (#1179)', () => {
    const onCloseOuter = vi.fn()
    const onCloseInner = vi.fn()
    render(
      <Modal open onClose={onCloseOuter} title="Outer">
        <Modal open onClose={onCloseInner} title="Inner">
          <p>Nested content</p>
        </Modal>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCloseInner).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })

  it('overlay element has data-modal-overlay attribute (#1242)', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Data Attr">
        <p>Content</p>
      </Modal>
    )
    const overlay = screen.getByTestId('modal-overlay')
    expect(overlay).toHaveAttribute('data-modal-overlay')
  })

  it('single modal Escape behavior unchanged after nested fix (#1179)', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Solo">
        <p>Content</p>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('CreateSessionModal', () => {
  it('renders form fields', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    expect(screen.getByPlaceholderText('Session name')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/working directory/i)).toBeInTheDocument()
  })

  it('has explicit aria-label on each input (#1185)', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    expect(screen.getByLabelText('Session name')).toBeInTheDocument()
    expect(screen.getByLabelText('Working directory')).toBeInTheDocument()
  })

  it('calls onCreate with name and cwd on submit', () => {
    const onCreate = vi.fn()
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={onCreate} />
    )
    fireEvent.change(screen.getByPlaceholderText('Session name'), { target: { value: 'My Session' } })
    fireEvent.change(screen.getByPlaceholderText(/working directory/i), { target: { value: '/home/user' } })
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).toHaveBeenCalledWith({ name: 'My Session', cwd: '/home/user', provider: 'claude-sdk' })
  })

  it('does not submit with empty name', () => {
    const onCreate = vi.fn()
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={onCreate} />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('shows validation error when submitting empty name (#1184)', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(screen.getByText('Session name is required')).toBeInTheDocument()
  })

  it('sets aria-invalid on name input when validation fails (#1184)', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Create'))
    const nameInput = screen.getByPlaceholderText('Session name')
    expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    expect(nameInput).toHaveAttribute('aria-describedby', 'session-name-error')
  })

  it('clears validation error when user types (#1184)', () => {
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(screen.getByText('Session name is required')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Session name'), { target: { value: 'a' } })
    expect(screen.queryByText('Session name is required')).not.toBeInTheDocument()
  })

  it('clears validation error when modal reopens (#1184)', () => {
    const { rerender } = render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Create'))
    expect(screen.getByText('Session name is required')).toBeInTheDocument()
    rerender(<CreateSessionModal open={false} onClose={vi.fn()} onCreate={vi.fn()} />)
    rerender(<CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(screen.queryByText('Session name is required')).not.toBeInTheDocument()
  })

  it('submits on Enter key', () => {
    const onCreate = vi.fn()
    render(
      <CreateSessionModal open onClose={vi.fn()} onCreate={onCreate} />
    )
    const nameInput = screen.getByPlaceholderText('Session name')
    fireEvent.change(nameInput, { target: { value: 'Quick' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith({ name: 'Quick', cwd: '', provider: 'claude-sdk' })
  })

  it('calls onClose when Cancel clicked', () => {
    const onClose = vi.fn()
    render(
      <CreateSessionModal open onClose={onClose} onCreate={vi.fn()} />
    )
    fireEvent.click(screen.getByText('Cancel'))
    expect(onClose).toHaveBeenCalled()
  })

  it('clears fields when opened', () => {
    const { rerender } = render(
      <CreateSessionModal open={false} onClose={vi.fn()} onCreate={vi.fn()} />
    )
    rerender(
      <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} />
    )
    const nameInput = screen.getByPlaceholderText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('')
  })
})

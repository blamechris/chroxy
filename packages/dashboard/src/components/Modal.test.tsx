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

  it('does not close on backdrop click when closeOnBackdrop is false (#5779)', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Sticky" closeOnBackdrop={false}>
        <p>Content</p>
      </Modal>
    )
    fireEvent.click(screen.getByTestId('modal-overlay'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes on Escape when closeOnBackdrop is false (#5779)', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="Sticky" closeOnBackdrop={false}>
        <p>Content</p>
      </Modal>
    )
    fireEvent.keyDown(document, { key: 'Escape' })
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

  it('ignores an Escape already in flight when it opened, then handles a fresh one (#8703)', () => {
    const onClose = vi.fn()
    // Created BEFORE the modal mounts: its timeStamp precedes the listener's attach.
    const inFlight = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    // Guarantee the clock has advanced so the comparison is not a same-tick tie.
    const t0 = performance.now(); while (performance.now() - t0 < 5) { /* spin */ }
    render(<Modal open onClose={onClose} title="T"><div>c</div></Modal>)
    document.dispatchEvent(inFlight)
    expect(onClose).not.toHaveBeenCalled()
    const t1 = performance.now(); while (performance.now() - t1 < 5) { /* spin */ }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // #9374: jsdom stamps events from Date.now(); that clock drifts against
  // performance.timeOrigin + performance.now() over a long-lived worker. A fresh
  // Escape fired right after open must close the modal whichever way it drifts,
  // and an event stamped before the open must still be ignored.
  describe.each([
    ['3ms behind', -3],
    ['10ms behind', -10],
    ['3ms ahead', 3],
  ])('with Date.now() %s the real clock (#9374)', (_label, skew) => {
    afterEach(() => { vi.restoreAllMocks() })

    it('closes on a fresh Escape fired immediately after open', () => {
      const realNow = Date.now.bind(Date)
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
      const onClose = vi.fn()
      render(<Modal open onClose={onClose} title="T"><div>c</div></Modal>)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('still ignores an Escape stamped before the open', () => {
      const realNow = Date.now.bind(Date)
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew)
      const onClose = vi.fn()
      const inFlight = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      const t0 = performance.now(); while (performance.now() - t0 < 5) { /* spin */ }
      render(<Modal open onClose={onClose} title="T"><div>c</div></Modal>)
      document.dispatchEvent(inFlight)
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  it('a repeat Escape does not close, a fresh press does (#9243)', () => {
    const onClose = vi.fn()
    render(<Modal open onClose={onClose} title="T"><div>c</div></Modal>)
    const t0 = performance.now(); while (performance.now() - t0 < 5) { /* spin */ }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a new onClose identity does not re-stamp the open time (#8703)', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(<Modal open onClose={first} title="T"><div>c</div></Modal>)
    const t0 = performance.now(); while (performance.now() - t0 < 5) { /* spin */ }
    // Created after the open, before the re-render.
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    const t1 = performance.now(); while (performance.now() - t1 < 5) { /* spin */ }
    rerender(<Modal open onClose={second} title="T"><div>c</div></Modal>)
    document.dispatchEvent(ev)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('closing then re-opening re-stamps: an Escape created before the re-open is ignored (#8703)', () => {
    const onClose = vi.fn()
    const { rerender } = render(<Modal open onClose={onClose} title="T"><div>c</div></Modal>)
    rerender(<Modal open={false} onClose={onClose} title="T"><div>c</div></Modal>)
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    const t0 = performance.now(); while (performance.now() - t0 < 5) { /* spin */ }
    rerender(<Modal open onClose={onClose} title="T"><div>c</div></Modal>)
    document.dispatchEvent(ev)
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

  it('focuses first focusable element when opened (#2659)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Focus Trap">
        <button>First</button>
        <button>Second</button>
      </Modal>
    )
    expect(document.activeElement).toBe(screen.getByText('First'))
  })

  it('Tab from last focusable wraps to first (#2659)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Focus Trap">
        <button>First</button>
        <button>Last</button>
      </Modal>
    )
    const last = screen.getByText('Last')
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('First'))
  })

  it('Shift+Tab from first focusable wraps to last (#2659)', () => {
    render(
      <Modal open onClose={vi.fn()} title="Focus Trap">
        <button>First</button>
        <button>Last</button>
      </Modal>
    )
    const first = screen.getByText('First')
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('Last'))
  })

  it('restores focus to previously-focused element on close (#2659)', () => {
    const trigger = document.createElement('button')
    trigger.textContent = 'Trigger'
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    const { rerender } = render(
      <Modal open onClose={vi.fn()} title="Restore">
        <button>Inside</button>
      </Modal>
    )
    expect(document.activeElement).toBe(screen.getByText('Inside'))
    rerender(
      <Modal open={false} onClose={vi.fn()} title="Restore">
        <button>Inside</button>
      </Modal>
    )
    expect(document.activeElement).toBe(trigger)
    document.body.removeChild(trigger)
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

  it('does not close (or discard input) on backdrop click (#5779)', () => {
    const onClose = vi.fn()
    render(
      <CreateSessionModal open onClose={onClose} onCreate={vi.fn()} />
    )
    fireEvent.change(screen.getByPlaceholderText('Session name'), { target: { value: 'In progress' } })
    fireEvent.click(screen.getByTestId('modal-overlay'))
    expect(onClose).not.toHaveBeenCalled()
    // The typed value survives the stray outside click.
    const nameInput = screen.getByPlaceholderText('Session name') as HTMLInputElement
    expect(nameInput.value).toBe('In progress')
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

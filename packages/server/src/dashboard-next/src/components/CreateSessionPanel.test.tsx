/**
 * CreateSessionPanel — inline session creation form for the sidebar.
 *
 * Unlike CreateSessionModal, this is an inline panel that slides down
 * inside the sidebar (no overlay/modal). Pre-fills CWD from repo path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CreateSessionPanel } from './CreateSessionPanel'

afterEach(cleanup)

const defaultProps = {
  cwd: '/Users/me/projects/my-app',
  models: [
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    { id: 'claude-opus-4', label: 'Opus 4' },
  ],
  permissionModes: [
    { id: 'default', label: 'Default' },
    { id: 'plan', label: 'Plan Mode' },
  ],
  onCreate: vi.fn(),
  onCancel: vi.fn(),
}

describe('CreateSessionPanel', () => {
  it('renders with data-testid', () => {
    render(<CreateSessionPanel {...defaultProps} />)
    expect(screen.getByTestId('create-session-panel')).toBeInTheDocument()
  })

  it('shows CWD pre-filled', () => {
    render(<CreateSessionPanel {...defaultProps} />)
    const cwdInput = screen.getByLabelText(/working directory/i) as HTMLInputElement
    expect(cwdInput.value).toBe('/Users/me/projects/my-app')
  })

  it('shows model selector with available models', () => {
    render(<CreateSessionPanel {...defaultProps} />)
    const select = screen.getByLabelText(/model/i)
    expect(select).toBeInTheDocument()
    expect(screen.getByText('Sonnet 4.5')).toBeInTheDocument()
    expect(screen.getByText('Opus 4')).toBeInTheDocument()
  })

  it('shows permission mode selector', () => {
    render(<CreateSessionPanel {...defaultProps} />)
    const select = screen.getByLabelText(/permission/i)
    expect(select).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.getByText('Plan Mode')).toBeInTheDocument()
  })

  it('calls onCreate with cwd, model, and permissionMode on submit', () => {
    const onCreate = vi.fn()
    render(<CreateSessionPanel {...defaultProps} onCreate={onCreate} />)

    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    expect(onCreate).toHaveBeenCalledWith({
      cwd: '/Users/me/projects/my-app',
      model: 'claude-sonnet-4-5',
      permissionMode: 'default',
    })
  })

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn()
    render(<CreateSessionPanel {...defaultProps} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('hides model selector when no models available', () => {
    render(<CreateSessionPanel {...defaultProps} models={[]} />)
    expect(screen.queryByLabelText(/model/i)).not.toBeInTheDocument()
  })

  it('hides permission selector when no modes available', () => {
    render(<CreateSessionPanel {...defaultProps} permissionModes={[]} />)
    expect(screen.queryByLabelText(/permission/i)).not.toBeInTheDocument()
  })

  it('omits model and permissionMode from onCreate when lists are empty', () => {
    const onCreate = vi.fn()
    render(<CreateSessionPanel {...defaultProps} models={[]} permissionModes={[]} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    expect(onCreate).toHaveBeenCalledWith({ cwd: '/Users/me/projects/my-app' })
    const data = onCreate.mock.calls[0]![0]
    expect(data).not.toHaveProperty('model')
    expect(data).not.toHaveProperty('permissionMode')
  })

  it('submits on Enter key from any field', () => {
    const onCreate = vi.fn()
    render(<CreateSessionPanel {...defaultProps} onCreate={onCreate} />)

    // Enter on CWD input
    fireEvent.keyDown(screen.getByLabelText(/working directory/i), { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledTimes(1)

    // Enter on model select
    fireEvent.keyDown(screen.getByLabelText(/model/i), { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledTimes(2)
  })

  it('cancels on Escape key from any field', () => {
    const onCancel = vi.fn()
    render(<CreateSessionPanel {...defaultProps} onCancel={onCancel} />)

    // Escape on permission select
    fireEvent.keyDown(screen.getByLabelText(/permission/i), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('applies className prop', () => {
    render(<CreateSessionPanel {...defaultProps} className="my-custom-class" />)
    expect(screen.getByTestId('create-session-panel')).toHaveClass('my-custom-class')
  })
})

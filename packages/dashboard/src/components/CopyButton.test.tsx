import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { CopyButton } from './CopyButton'
import { writeText } from '../utils/clipboard'
import { useConnectionStore } from '../store/connection'

vi.mock('../utils/clipboard', () => ({ writeText: vi.fn() }))
const mockWriteText = vi.mocked(writeText)

describe('CopyButton (#6631)', () => {
  beforeEach(() => {
    mockWriteText.mockReset()
  })
  afterEach(() => {
    cleanup()
  })

  it('renders an accessible copy button', () => {
    render(<CopyButton content="hello world" />)
    const btn = screen.getByTestId('msg-copy-button')
    expect(btn).toHaveAttribute('aria-label', 'Copy response')
    expect(btn).not.toHaveAttribute('data-copied')
  })

  it('copies the content to the clipboard on click and shows the copied state', async () => {
    mockWriteText.mockResolvedValue(true)
    render(<CopyButton content="the full response text" />)
    fireEvent.click(screen.getByTestId('msg-copy-button'))
    expect(mockWriteText).toHaveBeenCalledWith('the full response text')
    await waitFor(() => expect(screen.getByTestId('msg-copy-button')).toHaveAttribute('data-copied', 'true'))
    expect(screen.getByTestId('msg-copy-button')).toHaveAttribute('aria-label', 'Copied')
    // a11y: the success is announced through a polite live region
    expect(screen.getByRole('status')).toHaveTextContent('Copied')
  })

  it('surfaces a warning toast and does NOT show copied when the clipboard write fails', async () => {
    mockWriteText.mockResolvedValue(false)
    const addServerError = vi.spyOn(useConnectionStore.getState(), 'addServerError').mockImplementation(() => {})
    render(<CopyButton content="x" />)
    fireEvent.click(screen.getByTestId('msg-copy-button'))
    await waitFor(() => expect(addServerError).toHaveBeenCalledWith(expect.stringContaining('Failed to copy'), undefined, 'warning'))
    expect(screen.getByTestId('msg-copy-button')).not.toHaveAttribute('data-copied')
    addServerError.mockRestore()
  })

  it('stops the click from propagating to parent handlers', () => {
    mockWriteText.mockResolvedValue(true)
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <CopyButton content="x" />
      </div>,
    )
    fireEvent.click(screen.getByTestId('msg-copy-button'))
    expect(parentClick).not.toHaveBeenCalled()
  })
})

/**
 * InputBar + ReconnectBanner tests (#1162)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { InputBar } from './InputBar'
import { ReconnectBanner } from './ReconnectBanner'

afterEach(cleanup)

describe('InputBar', () => {
  it('renders textarea and send button', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(screen.getByTestId('send-button')).toBeInTheDocument()
  })

  it('calls onSend with input text on send button click', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('clears input after sending', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('send-button'))
    expect(textarea.value).toBe('')
  })

  it('sends on Cmd+Enter', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'test' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(onSend).toHaveBeenCalledWith('test')
  })

  it('does not send on plain Enter (allows newline)', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: 'test' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('calls onInterrupt on Escape', () => {
    const onInterrupt = vi.fn()
    render(<InputBar onSend={vi.fn()} onInterrupt={onInterrupt} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'Escape' })
    expect(onInterrupt).toHaveBeenCalled()
  })

  it('disables input when disabled prop is true', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} disabled />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(screen.getByTestId('send-button')).toBeDisabled()
  })

  it('does not send empty input', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send whitespace-only input', () => {
    const onSend = vi.fn()
    render(<InputBar onSend={onSend} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('send-button'))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows interrupt button when isStreaming', () => {
    render(
      <InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isStreaming />
    )
    expect(screen.getByTestId('interrupt-button')).toBeInTheDocument()
  })

  it('shows placeholder text', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} placeholder="Ask Claude..." />)
    expect(screen.getByPlaceholderText('Ask Claude...')).toBeInTheDocument()
  })

  it('has aria-label on textarea (#1171)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.getByLabelText('Message input')).toBeInTheDocument()
  })

  it('has aria-label on send button (#1171)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    expect(screen.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send message')
  })

  it('has aria-label on interrupt button (#1171)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} isStreaming />)
    expect(screen.getByTestId('interrupt-button')).toHaveAttribute('aria-label', 'Stop generation')
  })

  it('has aria-describedby linking to keyboard shortcut hints (#1226)', () => {
    render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
    const textarea = screen.getByRole('textbox')
    const describedBy = textarea.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const hint = document.getElementById(describedBy!)
    expect(hint).toBeInTheDocument()
    expect(hint!.textContent).toMatch(/Cmd\/Ctrl.*Enter.*send/i)
    expect(hint!.textContent).toMatch(/Escape.*interrupt/i)
  })

  it('derives max height from getComputedStyle instead of hardcoded lineHeight (#1172)', () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = vi.fn().mockReturnValue({
      lineHeight: '24px',
      paddingTop: '8px',
      paddingBottom: '8px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
      boxSizing: 'border-box',
    })

    try {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

      // Mock scrollHeight to exceed the 5-line max
      Object.defineProperty(textarea, 'scrollHeight', { value: 300, configurable: true })
      fireEvent.change(textarea, { target: { value: 'a\nb\nc\nd\ne\nf\ng' } })

      // Max should be 5 lines * 24px + 8+8 padding + 1+1 border = 138px (border-box)
      const height = parseInt(textarea.style.height, 10)
      expect(height).toBe(138)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
  })

  it('adjusts height for border-box sizing (#1246)', () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = vi.fn().mockReturnValue({
      lineHeight: '24px',
      paddingTop: '8px',
      paddingBottom: '8px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
      boxSizing: 'border-box',
    })

    try {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

      // scrollHeight = 100 (includes padding but not border)
      Object.defineProperty(textarea, 'scrollHeight', { value: 100, configurable: true })
      fireEvent.change(textarea, { target: { value: 'hello' } })

      // border-box: style.height = scrollHeight + borderY = 100 + 2 = 102
      const height = parseInt(textarea.style.height, 10)
      expect(height).toBe(102)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
  })

  it('adjusts height for content-box sizing (#1246)', () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = vi.fn().mockReturnValue({
      lineHeight: '24px',
      paddingTop: '8px',
      paddingBottom: '8px',
      borderTopWidth: '1px',
      borderBottomWidth: '1px',
      boxSizing: 'content-box',
    })

    try {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

      // scrollHeight = 100 (includes padding but not border)
      Object.defineProperty(textarea, 'scrollHeight', { value: 100, configurable: true })
      fireEvent.change(textarea, { target: { value: 'hello' } })

      // content-box: style.height = scrollHeight - paddingY = 100 - 16 = 84
      const height = parseInt(textarea.style.height, 10)
      expect(height).toBe(84)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
  })

  it('falls back to defaults when getComputedStyle returns non-numeric values (#1172)', () => {
    const originalGetComputedStyle = window.getComputedStyle
    window.getComputedStyle = vi.fn().mockReturnValue({
      lineHeight: 'normal',
      paddingTop: '',
      paddingBottom: '',
      borderTopWidth: '',
      borderBottomWidth: '',
    })

    try {
      render(<InputBar onSend={vi.fn()} onInterrupt={vi.fn()} />)
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

      Object.defineProperty(textarea, 'scrollHeight', { value: 300, configurable: true })
      fireEvent.change(textarea, { target: { value: 'a\nb\nc\nd\ne\nf\ng' } })

      // Fallback: 5 lines * 20px + 0 padding + 0 border = 100px
      const height = parseInt(textarea.style.height, 10)
      expect(height).toBe(100)
    } finally {
      window.getComputedStyle = originalGetComputedStyle
    }
  })
})

describe('ReconnectBanner', () => {
  it('renders when visible', () => {
    render(<ReconnectBanner visible attempt={1} maxAttempts={8} onRetry={vi.fn()} />)
    expect(screen.getByTestId('reconnect-banner')).toBeInTheDocument()
  })

  it('does not render when not visible', () => {
    render(<ReconnectBanner visible={false} attempt={1} maxAttempts={8} onRetry={vi.fn()} />)
    expect(screen.queryByTestId('reconnect-banner')).not.toBeInTheDocument()
  })

  it('shows attempt count', () => {
    render(<ReconnectBanner visible attempt={3} maxAttempts={8} onRetry={vi.fn()} />)
    expect(screen.getByText(/attempt 3\/8/i)).toBeInTheDocument()
  })

  it('calls onRetry when retry button clicked', () => {
    const onRetry = vi.fn()
    render(<ReconnectBanner visible attempt={1} maxAttempts={8} onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId('retry-button'))
    expect(onRetry).toHaveBeenCalled()
  })

  it('has role=status for polite screen reader announcement (#1171)', () => {
    render(<ReconnectBanner visible attempt={1} maxAttempts={8} onRetry={vi.fn()} />)
    const banner = screen.getByTestId('reconnect-banner')
    expect(banner).toHaveAttribute('role', 'status')
  })

  it('shows custom message', () => {
    render(
      <ReconnectBanner
        visible
        attempt={1}
        maxAttempts={8}
        message="Server restarting..."
        onRetry={vi.fn()}
      />
    )
    expect(screen.getByText(/Server restarting/)).toBeInTheDocument()
  })
})

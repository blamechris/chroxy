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

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { StartupErrorScreen } from './StartupErrorScreen'

describe('StartupErrorScreen', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the error message', () => {
    render(<StartupErrorScreen error="Port 9222 already in use" logs={null} onRetry={() => {}} />)
    expect(screen.getByText(/Port 9222 already in use/)).toBeTruthy()
  })

  it('renders server logs when available', () => {
    const logs = [
      '[INFO] Starting server on port 9222...',
      '[ERROR] EADDRINUSE: address already in use',
      '[ERROR] Server failed to start',
    ]
    render(<StartupErrorScreen error="Server failed" logs={logs} onRetry={() => {}} />)

    expect(screen.getByTestId('startup-error-logs')).toBeTruthy()
    expect(screen.getByText(/EADDRINUSE/)).toBeTruthy()
    expect(screen.getByText(/Starting server on port 9222/)).toBeTruthy()
  })

  it('does not render log section when logs are null', () => {
    render(<StartupErrorScreen error="Unknown error" logs={null} onRetry={() => {}} />)
    expect(screen.queryByTestId('startup-error-logs')).toBeNull()
  })

  it('does not render log section when logs are empty', () => {
    render(<StartupErrorScreen error="Unknown error" logs={[]} onRetry={() => {}} />)
    expect(screen.queryByTestId('startup-error-logs')).toBeNull()
  })

  it('calls onRetry when retry button is clicked', () => {
    const onRetry = vi.fn()
    render(<StartupErrorScreen error="Server failed" logs={null} onRetry={onRetry} />)

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('renders a heading indicating startup failure', () => {
    render(<StartupErrorScreen error="Crash" logs={null} onRetry={() => {}} />)
    expect(screen.getByText(/Server Failed to Start/i)).toBeTruthy()
  })
})

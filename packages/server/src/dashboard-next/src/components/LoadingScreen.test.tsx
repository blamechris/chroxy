import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { LoadingScreen } from './LoadingScreen'

afterEach(cleanup)

describe('LoadingScreen', () => {
  it('renders spinner and logo', () => {
    render(<LoadingScreen stage={1} statusText="Starting..." />)
    expect(screen.getByTestId('loading-screen')).toBeInTheDocument()
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument()
    expect(screen.getByText('Chroxy')).toBeInTheDocument()
  })

  it('shows status text', () => {
    render(<LoadingScreen stage={1} statusText="Establishing tunnel..." />)
    expect(screen.getByText('Establishing tunnel...')).toBeInTheDocument()
  })

  it('marks completed stages with checkmark', () => {
    render(<LoadingScreen stage={3} statusText="Almost ready..." />)
    const stages = screen.getAllByRole('listitem')
    // Stage 1 and 2 should be done (have checkmark class)
    expect(stages[0]).toHaveClass('done')
    expect(stages[1]).toHaveClass('done')
    // Stage 3 should be active
    expect(stages[2]).toHaveClass('active')
  })

  it('displays QR code when provided', () => {
    const qrSvg = '<svg><rect width="100" height="100"/></svg>'
    render(<LoadingScreen stage={3} statusText="Ready!" qrSvg={qrSvg} />)
    expect(screen.getByTestId('qr-container')).toBeInTheDocument()
  })

  it('shows open dashboard button when QR is displayed', () => {
    render(
      <LoadingScreen
        stage={3}
        statusText="Ready!"
        qrSvg="<svg/>"
        onOpenDashboard={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /open dashboard/i })).toBeInTheDocument()
  })

  it('calls onOpenDashboard when button clicked', () => {
    const onOpen = vi.fn()
    render(
      <LoadingScreen
        stage={3}
        statusText="Ready!"
        qrSvg="<svg/>"
        onOpenDashboard={onOpen}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /open dashboard/i }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('hides startup stages when QR is shown', () => {
    render(<LoadingScreen stage={3} statusText="Ready!" qrSvg="<svg/>" />)
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })
})

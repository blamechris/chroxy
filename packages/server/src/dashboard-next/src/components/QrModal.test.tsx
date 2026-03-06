/**
 * QrModal — modal displaying QR code for mobile app pairing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { QrModal } from './QrModal'

afterEach(cleanup)

describe('QrModal', () => {
  it('does not render when closed', () => {
    render(<QrModal open={false} onClose={vi.fn()} qrSvg={null} loading={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders modal when open', () => {
    render(<QrModal open={true} onClose={vi.fn()} qrSvg={null} loading={false} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows loading spinner when loading', () => {
    render(<QrModal open={true} onClose={vi.fn()} qrSvg={null} loading={true} />)
    expect(screen.getByTestId('qr-loading')).toBeInTheDocument()
  })

  it('renders QR SVG when available', () => {
    const svg = '<svg><rect width="10" height="10"/></svg>'
    render(<QrModal open={true} onClose={vi.fn()} qrSvg={svg} loading={false} />)
    const container = screen.getByTestId('qr-svg-container')
    expect(container.innerHTML).toContain('<svg>')
  })

  it('shows error message when error prop is set', () => {
    render(<QrModal open={true} onClose={vi.fn()} qrSvg={null} loading={false} error="No tunnel available" />)
    expect(screen.getByText('No tunnel available')).toBeInTheDocument()
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(<QrModal open={true} onClose={onClose} qrSvg={null} loading={false} />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn()
    render(<QrModal open={true} onClose={onClose} qrSvg={null} loading={false} />)
    fireEvent.click(screen.getByTestId('modal-overlay'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows pairing instruction text', () => {
    const svg = '<svg><rect/></svg>'
    render(<QrModal open={true} onClose={vi.fn()} qrSvg={svg} loading={false} />)
    expect(screen.getByText(/Scan with Chroxy app/)).toBeInTheDocument()
  })

  it('closes on Escape key (#1549)', () => {
    const onClose = vi.fn()
    render(<QrModal open={true} onClose={onClose} qrSvg={null} loading={false} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('has aria-modal="true" on dialog (#1549)', () => {
    render(<QrModal open={true} onClose={vi.fn()} qrSvg={null} loading={false} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('has data-modal-overlay attribute on backdrop (#1549)', () => {
    render(<QrModal open={true} onClose={vi.fn()} qrSvg={null} loading={false} />)
    expect(screen.getByTestId('modal-overlay')).toHaveAttribute('data-modal-overlay')
  })
})

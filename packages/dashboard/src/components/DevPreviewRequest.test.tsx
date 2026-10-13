import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { DevPreviewRequest } from './DevPreviewRequest'
afterEach(cleanup)
describe('explicit preview request', () => {
  it('shows HTTP limitations and separates request from consent', () => {
    const open = vi.fn(() => true), close = vi.fn()
    render(<DevPreviewRequest onOpen={open} onClose={close} />)
    fireEvent.click(screen.getByText('Preview HTTP service'))
    expect(screen.getByText(/HTTP only; no WebSockets/)).toBeInTheDocument()
    expect(screen.getByText(/public URL adds no authentication/)).toBeInTheDocument()
    const request = screen.getByRole('button', { name: 'Request preview consent' })
    expect(request).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Preview service port'), { target: { value: '3100' } })
    fireEvent.click(request)
    expect(open).toHaveBeenCalledExactlyOnceWith(3100)
    expect(screen.getByRole('status')).toHaveTextContent('Review the consent prompt')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preview' }))
    expect(close).toHaveBeenCalledExactlyOnceWith(3100)
  })
  it('reports failed admission without claiming a sent request', () => {
    render(<DevPreviewRequest onOpen={() => false} />)
    fireEvent.click(screen.getByText('Preview HTTP service'))
    fireEvent.change(screen.getByLabelText('Preview service port'), { target: { value: '3100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request preview consent' }))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('not sent')
  })
  it('retains original-port cancellation after editing and follows terminal status', () => {
    const close = vi.fn()
    const { rerender } = render(<DevPreviewRequest onOpen={() => true} onClose={close} />)
    fireEvent.change(screen.getByLabelText('Preview service port'), { target: { value: '3100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request preview consent' }))
    fireEvent.change(screen.getByLabelText('Preview service port'), { target: { value: '4100' } })
    expect(screen.getByRole('button', { name: 'Request preview consent' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preview' }))
    expect(close).toHaveBeenCalledExactlyOnceWith(3100)
    for (const state of ['opening', 'active', 'closing', 'closed', 'denied', 'failed'] as const) {
      rerender(<DevPreviewRequest onOpen={() => true} onClose={close} requests={[{ port: 3100, requestId: 'r1', state, reason: `Preview ${state}` }]} />)
      expect(screen.getByRole('status')).toHaveTextContent(`Preview ${state}`)
      if (['closed', 'denied', 'failed'].includes(state)) {
        expect(screen.queryByRole('button', { name: /Cancel preview|Close preview/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Request preview consent' })).not.toBeDisabled()
      }
    }
  })
  it('permits fresh consent after a connection change clears the old request', () => {
    const open = () => true
    const { rerender } = render(<DevPreviewRequest onOpen={open} requests={[{ port: 3100, requestId: 'r1', state: 'awaiting_consent' }]} />)
    fireEvent.change(screen.getByLabelText('Preview service port'), { target: { value: '3100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request preview consent' }))
    expect(screen.getByRole('button', { name: 'Cancel preview' })).toBeInTheDocument()
    rerender(<DevPreviewRequest onOpen={open} requests={[]} />)
    expect(screen.queryByRole('button', { name: 'Cancel preview' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Request preview consent' })).not.toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('unconfirmed')
  })

})

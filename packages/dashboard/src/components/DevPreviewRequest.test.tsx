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

})

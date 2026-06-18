/**
 * PendingPairRequests — host-level pairing-approval surface (#5510, epic #5509).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { PendingPairRequests } from './PendingPairRequests'
import type { ServerPairPendingMessage } from '@chroxy/protocol'

afterEach(cleanup)

function req(over: Partial<ServerPairPendingMessage> = {}): ServerPairPendingMessage {
  return {
    type: 'pair_pending',
    requestId: 'r1',
    deviceName: 'Pixel 8',
    verifyCode: '123456',
    expiresAt: Date.now() + 120_000,
    ...over,
  }
}

describe('PendingPairRequests (#5510)', () => {
  it('renders nothing when there are no requests', () => {
    const { container } = render(
      <PendingPairRequests requests={[]} onApprove={vi.fn()} onDeny={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the device name and verify code', () => {
    render(<PendingPairRequests requests={[req()]} onApprove={vi.fn()} onDeny={vi.fn()} />)
    expect(screen.getByTestId('pair-request-device').textContent).toBe('Pixel 8')
    expect(screen.getByTestId('pair-request-code').textContent).toBe('123456')
  })

  it('renders attacker-controlled deviceName as plain text (no HTML injection)', () => {
    render(
      <PendingPairRequests
        requests={[req({ deviceName: '<img src=x onerror=alert(1)>' })]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    const el = screen.getByTestId('pair-request-device')
    // React escapes — the text content is the literal string, no <img> element.
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(el.querySelector('img')).toBeNull()
  })

  it('fires onApprove / onDeny with the requestId', () => {
    const onApprove = vi.fn()
    const onDeny = vi.fn()
    render(<PendingPairRequests requests={[req()]} onApprove={onApprove} onDeny={onDeny} />)
    fireEvent.click(screen.getByTestId('pair-request-approve'))
    expect(onApprove).toHaveBeenCalledWith('r1')
    fireEvent.click(screen.getByTestId('pair-request-deny'))
    expect(onDeny).toHaveBeenCalledWith('r1')
  })

  it('stacks multiple requests', () => {
    render(
      <PendingPairRequests
        requests={[req({ requestId: 'a' }), req({ requestId: 'b' })]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    )
    expect(screen.getByTestId('pair-request-a')).toBeTruthy()
    expect(screen.getByTestId('pair-request-b')).toBeTruthy()
  })
})

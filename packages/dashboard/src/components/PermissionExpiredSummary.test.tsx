/**
 * PermissionExpiredSummary component tests (#7365).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { PermissionExpiredSummary } from './PermissionExpiredSummary'

afterEach(cleanup)

describe('PermissionExpiredSummary (#7365)', () => {
  it('renders the count and the tool names', () => {
    render(<PermissionExpiredSummary count={2} tools={['Bash', 'Write']} firstRequestId="req-1" />)
    const summary = screen.getByTestId('permission-expired-summary')
    expect(summary).toHaveTextContent('2 permissions expired without a response')
    expect(summary).toHaveTextContent('Bash, Write')
  })

  it('singularizes "permission" for a count of 1', () => {
    render(<PermissionExpiredSummary count={1} tools={['Bash']} firstRequestId="req-1" />)
    expect(screen.getByTestId('permission-expired-summary')).toHaveTextContent('1 permission expired without a response')
  })

  it('deduplicates repeated tool names', () => {
    render(<PermissionExpiredSummary count={2} tools={['Bash', 'Bash']} firstRequestId="req-1" />)
    const text = screen.getByTestId('permission-expired-summary-text').textContent ?? ''
    expect(text.match(/Bash/g)).toHaveLength(1)
  })

  it('renders a working jump link targeting the first expired prompt\'s element', () => {
    // The real anchor the per-prompt marker exposes (PermissionPrompt.tsx's
    // `id={`perm-desc-${requestId}`}`) — simulated here without mounting the
    // full prompt component.
    const target = document.createElement('div')
    target.id = 'perm-desc-req-1'
    target.scrollIntoView = vi.fn()
    document.body.appendChild(target)

    render(<PermissionExpiredSummary count={1} tools={['Bash']} firstRequestId="req-1" />)
    const link = screen.getByTestId('permission-expired-summary-jump')
    expect(link).toHaveAttribute('href', '#perm-desc-req-1')

    fireEvent.click(link)
    expect(target.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }))

    document.body.removeChild(target)
  })

  it('does not throw when the jump target is not currently mounted (windowed out)', () => {
    render(<PermissionExpiredSummary count={1} tools={['Bash']} firstRequestId="req-missing" />)
    const link = screen.getByTestId('permission-expired-summary-jump')
    expect(() => fireEvent.click(link)).not.toThrow()
  })
})

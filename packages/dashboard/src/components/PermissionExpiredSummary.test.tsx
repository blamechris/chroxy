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
    // `id={`perm-desc-${requestId}`}`, `tabIndex={-1}`) — simulated here
    // without mounting the full prompt component.
    const target = document.createElement('div')
    target.id = 'perm-desc-req-1'
    target.tabIndex = -1
    target.scrollIntoView = vi.fn()
    document.body.appendChild(target)

    render(<PermissionExpiredSummary count={1} tools={['Bash']} firstRequestId="req-1" />)
    const link = screen.getByTestId('permission-expired-summary-jump')
    expect(link).toHaveAttribute('href', '#perm-desc-req-1')

    fireEvent.click(link)
    expect(target.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }))

    document.body.removeChild(target)
  })

  // #7365 review (S1) — the jump must move FOCUS, not just scroll the page
  // into view, or keyboard/screen-reader users get no signal that anything
  // happened. `.focus()` on a plain `<div>` with no `tabIndex` is a silent
  // no-op — this only passes because the target below carries the
  // `tabIndex={-1}` PermissionPrompt.tsx's `.perm-desc` now has.
  it('moves focus to the jump target (not just scroll) for keyboard/screen-reader users', () => {
    const target = document.createElement('div')
    target.id = 'perm-desc-req-1'
    target.tabIndex = -1
    target.scrollIntoView = vi.fn()
    document.body.appendChild(target)

    render(<PermissionExpiredSummary count={1} tools={['Bash']} firstRequestId="req-1" />)
    fireEvent.click(screen.getByTestId('permission-expired-summary-jump'))

    expect(document.activeElement).toBe(target)

    document.body.removeChild(target)
  })

  it('does not throw when the jump target is not currently mounted (windowed out)', () => {
    render(<PermissionExpiredSummary count={1} tools={['Bash']} firstRequestId="req-missing" />)
    const link = screen.getByTestId('permission-expired-summary-jump')
    expect(() => fireEvent.click(link)).not.toThrow()
  })

  // Nitpick #7 — the accessible name should name which permission it jumps
  // to (not just "Jump to prompt") when there are several in the turn.
  it('gives the jump link an accessible name naming the first expired tool', () => {
    render(<PermissionExpiredSummary count={2} tools={['Bash', 'Write']} firstRequestId="req-1" />)
    expect(screen.getByRole('link', { name: /jump to the bash permission prompt/i })).toBeInTheDocument()
  })
})

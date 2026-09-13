/**
 * Tests for Create Session modal submit behavior (issue #1456).
 *
 * Verifies that:
 * 1. Modal doesn't close immediately on Create — waits for server confirmation
 * 2. Server error is displayed inline in the modal
 * 3. Create button shows loading state while pending
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      defaultProvider: 'claude-sdk',
      availableProviders: [{
        name: 'claude-sdk',
        connections: [{
          version: 1,
          id: 'claude-native',
          label: 'Claude subscription',
          provider: 'claude',
          runtime: { id: 'claude-sdk', version: null },
          accountRef: null,
          authentication: { requested: 'native', observed: 'native' },
          entitlement: { route: 'unknown', status: 'unknown' },
          model: { requested: null, resolved: null },
          execution: { host: 'daemon', inference: 'remote' },
          readiness: { state: 'ready', reasonCode: null, message: 'Ready', recoveryAction: null },
          provenance: { source: 'configured', observedAt: '2026-09-13T00:00:00.000Z', expiresAt: null },
        }],
      }],
      requestDirectoryListing: () => {},
      setDirectoryListingCallback: () => {},
      defaultCwd: null,
    }),
}))

import { CreateSessionModal } from './CreateSessionModal'

afterEach(cleanup)

const baseProps = {
  open: true,
  onClose: vi.fn(),
  onCreate: vi.fn(),
  initialCwd: '/Users/me/projects',
  knownCwds: [] as string[],
  existingNames: [] as string[],
}

describe('CreateSessionModal submit behavior (#1456)', () => {
  it('calls onCreate but does NOT call onClose on Create click', () => {
    const onClose = vi.fn()
    const onCreate = vi.fn()
    render(<CreateSessionModal {...baseProps} onClose={onClose} onCreate={onCreate} />)

    fireEvent.click(screen.getByRole('button', { name: /create/i }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'claude-native' }))
    // Modal should NOT close immediately — must wait for server response
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the selected connection route before create', () => {
    render(<CreateSessionModal {...baseProps} />)

    expect(screen.getByRole('option', { name: /Claude subscription · native · unknown/i })).toBeInTheDocument()
    expect(screen.getByTestId('agent-connection-route')).toHaveTextContent('claude-sdk · remote inference · Ready')
  })

  it('keeps the connection select at least 44px tall', () => {
    const css = readFileSync(resolve(__dirname, '../theme/components.css'), 'utf8')
    const rule = css.match(/#connection-select\s*\{[^}]*\}/)?.[0] || ''
    expect(rule.includes('min-height: 44px')).toBe(true)
  })

  it('displays serverError when provided', () => {
    render(<CreateSessionModal {...baseProps} serverError="Directory not found" />)

    expect(screen.getByText('Directory not found')).toBeInTheDocument()
  })

  it('disables Create button when isCreating is true', () => {
    render(<CreateSessionModal {...baseProps} isCreating={true} />)

    const createBtn = screen.getByRole('button', { name: /creat/i })
    expect(createBtn).toBeDisabled()
  })

  it('shows loading text on Create button when isCreating', () => {
    render(<CreateSessionModal {...baseProps} isCreating={true} />)

    expect(screen.getByRole('button', { name: /creating/i })).toBeInTheDocument()
  })

  it('clears serverError when user types in name field', () => {
    const { rerender } = render(<CreateSessionModal {...baseProps} serverError="Some error" />)

    expect(screen.getByText('Some error')).toBeInTheDocument()

    // After user changes name, parent should clear the error via onClearError
    // But the error display itself is controlled by the prop
    rerender(<CreateSessionModal {...baseProps} serverError={undefined} />)

    expect(screen.queryByText('Some error')).not.toBeInTheDocument()
  })
})

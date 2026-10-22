/**
 * #8303 — New Session says when the prefilled cwd is not browsable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

let probeBrowsable: boolean | null = null

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [], probeBrowsable }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      defaultProvider: 'claude-sdk',
      availableProviders: [],
      requestDirectoryListing: vi.fn(),
      setDirectoryListingCallback: vi.fn(),
      defaultCwd: null,
    }),
}))

import { CreateSessionModal } from './CreateSessionModal'

afterEach(() => {
  cleanup()
  probeBrowsable = null
})

function renderModal(initialCwd = '/tmp/fixture') {
  return render(
    <CreateSessionModal open onClose={vi.fn()} onCreate={vi.fn()} initialCwd={initialCwd} knownCwds={[]} existingNames={[]} />,
  )
}

describe('CreateSessionModal not-browsable note (#8303)', () => {
  it('shows the note when the probe says Browse refuses the prefilled cwd', () => {
    probeBrowsable = false
    renderModal()
    expect(screen.getByTestId('cwd-not-browsable-note')).toBeInTheDocument()
  })

  it('shows no note when the cwd is browsable', () => {
    probeBrowsable = true
    renderModal()
    expect(screen.queryByTestId('cwd-not-browsable-note')).toBeNull()
  })

  it('shows no note while the probe is unresolved', () => {
    probeBrowsable = null
    renderModal()
    expect(screen.queryByTestId('cwd-not-browsable-note')).toBeNull()
  })
})

/**
 * #5553 — CreateSessionModal preset disclosure: when the chosen cwd has a
 * resolved preset, a compact indicator surfaces it (never invisible injection),
 * and expanding it reveals the read-only preamble/seed text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

type Preset = {
  source: 'daemon' | 'repo'
  active: boolean
  trustState: 'trusted' | 'pending'
  enabled: boolean
  preamble: string
  seed: string
  preambleLength: number
  seedLength: number
  capped: boolean
  repoPath: string | null
}

let presetForCwd: Preset | null | undefined = undefined

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      defaultProvider: 'claude-sdk',
      availableProviders: [],
      requestDirectoryListing: () => {},
      setDirectoryListingCallback: () => {},
      defaultCwd: null,
      requestSessionPreset: () => true,
      sessionPresetSnapshots: { '/Users/me/projects': presetForCwd } as Record<string, Preset | null>,
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

describe('CreateSessionModal preset disclosure (#5553)', () => {
  it('shows nothing when the cwd has no preset', () => {
    presetForCwd = null
    render(<CreateSessionModal {...baseProps} />)
    expect(screen.queryByTestId('repo-preset-disclosure')).toBeNull()
  })

  it('discloses an active preset with the preamble char count', () => {
    presetForCwd = {
      source: 'daemon', active: true, trustState: 'trusted', enabled: true,
      preamble: 'P'.repeat(312), seed: 'S'.repeat(40), preambleLength: 312, seedLength: 40, capped: false, repoPath: '/Users/me/projects',
    }
    render(<CreateSessionModal {...baseProps} />)
    const summary = screen.getByTestId('repo-preset-summary')
    expect(summary.textContent).toMatch(/preamble 312 chars/)
    expect(summary.textContent).toMatch(/seed 40 chars/)
  })

  it('expands to show the read-only preamble + seed text', () => {
    presetForCwd = {
      source: 'repo', active: true, trustState: 'trusted', enabled: true,
      preamble: 'USE PNPM NOT NPM', seed: 'read docs first', preambleLength: 16, seedLength: 15, capped: false, repoPath: '/Users/me/projects',
    }
    render(<CreateSessionModal {...baseProps} />)
    fireEvent.click(screen.getByTestId('repo-preset-summary'))
    expect(screen.getByTestId('repo-preset-preamble').textContent).toBe('USE PNPM NOT NPM')
    expect(screen.getByTestId('repo-preset-seed').textContent).toBe('read docs first')
  })

  it('flags a pending preset as awaiting review', () => {
    presetForCwd = {
      source: 'repo', active: false, trustState: 'pending', enabled: true,
      preamble: 'CHECKED IN', seed: '', preambleLength: 10, seedLength: 0, capped: false, repoPath: '/Users/me/projects',
    }
    render(<CreateSessionModal {...baseProps} />)
    expect(screen.getByTestId('repo-preset-summary').textContent).toMatch(/pending review/)
  })
})

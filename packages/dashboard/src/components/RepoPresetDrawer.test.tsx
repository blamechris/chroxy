/**
 * #5553 — RepoPresetDrawer: renders the resolved preset, edits the daemon
 * override, and exposes Approve for a pending repo-local preset.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

type FullPreset = {
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

const calls = {
  requestSessionPreset: vi.fn(),
  setSessionPresetOverride: vi.fn(),
  approveSessionPreset: vi.fn(),
  revokeSessionPreset: vi.fn(),
}

let snapshot: FullPreset | null | undefined = undefined

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      ...calls,
      sessionPresetSnapshots: { '/repo/x': snapshot } as Record<string, FullPreset | null>,
    }),
}))

import { RepoPresetDrawer } from './RepoPresetDrawer'

afterEach(cleanup)
beforeEach(() => {
  calls.requestSessionPreset.mockClear()
  calls.setSessionPresetOverride.mockClear()
  calls.approveSessionPreset.mockClear()
  calls.revokeSessionPreset.mockClear()
  snapshot = undefined
})

function renderDrawer() {
  return render(<RepoPresetDrawer repoPath="/repo/x" repoName="x" onClose={() => {}} />)
}

describe('RepoPresetDrawer (#5553)', () => {
  it('requests the preset on open', () => {
    renderDrawer()
    expect(calls.requestSessionPreset).toHaveBeenCalledWith('/repo/x')
  })

  it('hydrates the editor from the resolved snapshot', () => {
    snapshot = {
      source: 'daemon', active: true, trustState: 'trusted', enabled: true,
      preamble: 'USE PNPM', seed: 'start here', preambleLength: 8, seedLength: 10, capped: false, repoPath: '/repo/x',
    }
    renderDrawer()
    expect((screen.getByTestId('repo-preset-preamble-input') as HTMLTextAreaElement).value).toBe('USE PNPM')
    expect((screen.getByTestId('repo-preset-seed-input') as HTMLTextAreaElement).value).toBe('start here')
  })

  it('Save writes the daemon override with the edited fields', () => {
    snapshot = {
      source: 'daemon', active: true, trustState: 'trusted', enabled: true,
      preamble: 'A', seed: '', preambleLength: 1, seedLength: 0, capped: false, repoPath: '/repo/x',
    }
    renderDrawer()
    fireEvent.change(screen.getByTestId('repo-preset-preamble-input'), { target: { value: 'NEW PREAMBLE' } })
    fireEvent.click(screen.getByTestId('repo-preset-save'))
    expect(calls.setSessionPresetOverride).toHaveBeenCalledWith('/repo/x', {
      preamble: 'NEW PREAMBLE', seed: '', enabled: true,
    })
  })

  it('Save with both fields empty clears the override', () => {
    snapshot = null
    renderDrawer()
    fireEvent.click(screen.getByTestId('repo-preset-save'))
    expect(calls.setSessionPresetOverride).toHaveBeenCalledWith('/repo/x', null)
  })

  it('shows Approve for a pending repo-local preset and calls approve', () => {
    snapshot = {
      source: 'repo', active: false, trustState: 'pending', enabled: true,
      preamble: 'CHECKED IN', seed: '', preambleLength: 10, seedLength: 0, capped: false, repoPath: '/repo/x',
    }
    renderDrawer()
    expect(screen.getByTestId('repo-preset-trust-state').textContent).toBe('pending')
    expect(screen.getByTestId('repo-preset-pending-note')).toBeTruthy()
    fireEvent.click(screen.getByTestId('repo-preset-approve'))
    expect(calls.approveSessionPreset).toHaveBeenCalledWith('/repo/x')
  })

  it('shows Revoke for a trusted repo-local preset', () => {
    snapshot = {
      source: 'repo', active: true, trustState: 'trusted', enabled: true,
      preamble: 'CHECKED IN', seed: '', preambleLength: 10, seedLength: 0, capped: false, repoPath: '/repo/x',
    }
    renderDrawer()
    fireEvent.click(screen.getByTestId('repo-preset-revoke'))
    expect(calls.revokeSessionPreset).toHaveBeenCalledWith('/repo/x')
  })
})

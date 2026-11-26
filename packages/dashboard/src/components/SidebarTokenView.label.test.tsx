/**
 * #8944 — the untracked note names providers from the shared registry label
 * source (`getProviderLabel`), never from a string typed into the component.
 *
 * The label function is replaced here with one that returns a value no
 * hardcoded copy could contain, so a component that spells "Claude Code (TUI)"
 * itself goes red.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import type { SessionInfo, CumulativeUsage } from '@chroxy/store-core'

vi.mock('@chroxy/store-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chroxy/store-core')>()
  return { ...actual, getProviderLabel: (name: string) => `REGISTRY-LABEL(${name})` }
})

import { SidebarTokenView } from './SidebarTokenView'

afterEach(() => {
  cleanup()
})

function usage(turnsBilled: number): CumulativeUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    turnsBilled,
  }
}

function session(id: string, provider: string, turnsBilled: number): SessionInfo {
  return {
    sessionId: id,
    name: id,
    cwd: '/tmp',
    type: 'cli',
    hasTerminal: false,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: 0,
    conversationId: null,
    provider,
    cumulativeUsage: usage(turnsBilled),
  } as SessionInfo
}

describe('untracked row tooltip label (#8944)', () => {
  it('names the provider from the registry label, not a hardcoded string', () => {
    render(<SidebarTokenView sessions={[session('tui', 'claude-tui', 1)]} />)
    fireEvent.click(screen.getByTestId('sidebar-token-view-provider-claude-tui-untracked'))
    const tip =
      screen.getByTestId('sidebar-token-view-provider-claude-tui-untracked-popover').textContent ?? ''
    expect(tip.includes('REGISTRY-LABEL(claude-tui)')).toBe(true)
    expect(tip.includes('TUI')).toBe(false)
  })
})

describe('untracked note label (#8944)', () => {
  it('names an all-untracked workspace from the registry label', () => {
    render(<SidebarTokenView sessions={[session('tui', 'claude-tui', 1)]} />)
    const note = screen.getByTestId('sidebar-token-view-untracked-note').textContent ?? ''
    expect(note.includes('REGISTRY-LABEL(claude-tui)')).toBe(true)
    expect(note.includes('Claude Code (TUI)')).toBe(false)
  })

  it('names a mixed workspace from the registry label', () => {
    render(
      <SidebarTokenView
        sessions={[session('tui', 'claude-tui', 1), session('sdk', 'claude-sdk', 2)]}
      />,
    )
    const note = screen.getByTestId('sidebar-token-view-untracked-note').textContent ?? ''
    expect(note.includes('REGISTRY-LABEL(claude-tui)')).toBe(true)
    expect(note.includes('Claude Code (TUI)')).toBe(false)
  })

  it('names the not-yet-measured workspace from the registry label', () => {
    render(
      <SidebarTokenView
        sessions={[session('tui', 'claude-tui', 1), session('sdk', 'claude-sdk', 0)]}
      />,
    )
    const note = screen.getByTestId('sidebar-token-view-untracked-note').textContent ?? ''
    expect(note.includes('REGISTRY-LABEL(claude-tui)')).toBe(true)
    expect(note.includes('Claude Code (TUI)')).toBe(false)
  })
})

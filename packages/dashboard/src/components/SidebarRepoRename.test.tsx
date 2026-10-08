/**
 * Sidebar repo-group inline rename (#7330) — component level.
 *
 * The App-level flow (menu → rename → persistence across remount) is covered in
 * App.test.tsx; these pin the Sidebar's own contract: what it hands
 * `onRenameRepo` and when.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { Sidebar, type SidebarProps, type RepoNode } from './Sidebar'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      serverRegistry: [],
      activeServerId: null,
      connectionPhase: 'disconnected',
      addServer: vi.fn(),
      removeServer: vi.fn(),
      switchServer: vi.fn(),
      sessionStates: {},
    }),
}))

afterEach(cleanup)

const PATH = '/p/fixture'

function repos(name = 'fixture'): RepoNode[] {
  return [{ path: PATH, name, defaultName: 'fixture', source: 'auto', exists: true, activeSessions: [], resumableSessions: [] }]
}

function setup(props: Partial<SidebarProps> = {}) {
  const onRenameRepo = vi.fn()
  const base: SidebarProps = {
    repos: repos(),
    activeSessionId: null,
    isOpen: true,
    width: 240,
    filter: '',
    serverStatus: 'connected',
    tunnelUrl: null,
    connectedClients: [],
    activePrimaryClientId: null,
    onFilterChange: vi.fn(),
    onSessionClick: vi.fn(),
    onResumeSession: vi.fn(),
    onNewSession: vi.fn(),
    onToggle: vi.fn(),
    onContextMenu: vi.fn(),
    onRenameRepo,
    ...props,
  }
  const utils = render(<Sidebar {...base} />)
  const request = (nonce = 1) => utils.rerender(
    <Sidebar {...base} repoRenameRequest={{ path: PATH, nonce }} onRepoRenameRequestHandled={base.onRepoRenameRequestHandled} />,
  )
  return { onRenameRepo, request, ...utils }
}

const input = () => screen.getByTestId(`repo-rename-input-${PATH}`) as HTMLInputElement

describe('Sidebar repo-group rename (#7330)', () => {
  it('a rename request opens the focused input, prefilled with the current label, and is consumed once', () => {
    const handled = vi.fn()
    const { request } = setup({ onRepoRenameRequestHandled: handled })
    request()
    expect(input().value).toBe('fixture')
    expect(document.activeElement).toBe(input())
    expect(handled).toHaveBeenCalledTimes(1)
  })

  it('a request for an unknown path is dropped (and still reported handled)', () => {
    const handled = vi.fn()
    const { rerender } = setup({ onRepoRenameRequestHandled: handled })
    rerender(<Sidebar {...{
      repos: repos(), activeSessionId: null, isOpen: true, width: 240, filter: '', serverStatus: 'connected' as const,
      tunnelUrl: null, connectedClients: [], activePrimaryClientId: null, onFilterChange: vi.fn(), onSessionClick: vi.fn(),
      onResumeSession: vi.fn(), onNewSession: vi.fn(), onToggle: vi.fn(), onContextMenu: vi.fn(), onRenameRepo: vi.fn(),
      repoRenameRequest: { path: '/nope', nonce: 1 }, onRepoRenameRequestHandled: handled,
    }} />)
    expect(screen.queryByTestId(`repo-rename-input-${PATH}`)).toBeNull()
    expect(handled).toHaveBeenCalledTimes(1)
  })

  it('Enter commits the trimmed text', () => {
    const { onRenameRepo, request } = setup()
    request()
    fireEvent.change(input(), { target: { value: '  My repo ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onRenameRepo).toHaveBeenCalledTimes(1)
    expect(onRenameRepo).toHaveBeenCalledWith(PATH, 'My repo')
  })

  it('a blank name commits "" so the derived label is restored', () => {
    const { onRenameRepo, request } = setup({ repos: repos('Custom') })
    request()
    fireEvent.change(input(), { target: { value: '   ' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onRenameRepo).toHaveBeenCalledWith(PATH, '')
  })

  it('typing the derived label back clears the override rather than pinning it', () => {
    const { onRenameRepo, request } = setup({ repos: repos('Custom') })
    request()
    fireEvent.change(input(), { target: { value: 'fixture' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onRenameRepo).toHaveBeenCalledWith(PATH, '')
  })

  it('unchanged text commits nothing', () => {
    const { onRenameRepo, request } = setup()
    request()
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(onRenameRepo).not.toHaveBeenCalled()
  })

  it('Escape cancels, and the blur that follows does not commit', () => {
    const { onRenameRepo, request } = setup()
    request()
    fireEvent.change(input(), { target: { value: 'Nope' } })
    fireEvent.keyDown(input(), { key: 'Escape' })
    fireEvent.blur(screen.getByTestId(`sidebar-repo-${PATH}`))
    expect(screen.queryByTestId(`repo-rename-input-${PATH}`)).toBeNull()
    expect(onRenameRepo).not.toHaveBeenCalled()
  })

  it('blur commits (click-away behaves like the tab rename)', () => {
    const { onRenameRepo, request } = setup()
    request()
    fireEvent.change(input(), { target: { value: 'Away' } })
    fireEvent.blur(input())
    expect(onRenameRepo).toHaveBeenCalledWith(PATH, 'Away')
  })

  it('Enter then blur commits exactly once', () => {
    const { onRenameRepo, request } = setup()
    request()
    fireEvent.change(input(), { target: { value: 'Once' } })
    const el = input()
    fireEvent.keyDown(el, { key: 'Enter' })
    fireEvent.blur(el)
    expect(onRenameRepo).toHaveBeenCalledTimes(1)
  })

  it('the rename input meets the 44px tap-target floor through the real stylesheet', () => {
    const style = document.createElement('style')
    style.textContent = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
    document.head.appendChild(style)
    try {
      const { request } = setup()
      request()
      const min = Number.parseFloat(getComputedStyle(input()).minHeight)
      expect(min >= 44, `min-height resolved to ${min}`).toBe(true)
    } finally {
      style.remove()
    }
  })
})

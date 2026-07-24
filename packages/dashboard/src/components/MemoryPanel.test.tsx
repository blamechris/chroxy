/**
 * MemoryPanel — tests for the dashboard memory panel (#6867, epic #6760).
 *
 * Mirrors the FileBrowserPanel.test.tsx mocking idiom: the store is mocked
 * with a mutable state getter so tests can simulate a `memory_stack_result`
 * having landed by mutating the module-level state and re-rendering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryPanel } from './MemoryPanel'
import type { MemoryFileDescriptor, MemoryStackEntry } from '../store/types'

const mockRequestMemoryRead = vi.fn()

let mockConnectionPhase: string = 'connected'
let mockEntries: MemoryStackEntry[] | null = null
let mockFile: MemoryFileDescriptor | null = null
let mockError: string | null = null
let mockLoading = false
let mockActiveSessionId: string | null = 's1'

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: unknown) => unknown) =>
    selector({
      connectionPhase: mockConnectionPhase,
      requestMemoryRead: mockRequestMemoryRead,
      memoryStackEntries: mockEntries,
      memoryStackFile: mockFile,
      memoryStackError: mockError,
      memoryStackLoading: mockLoading,
      activeSessionId: mockActiveSessionId,
    }),
}))

afterEach(() => cleanup())

beforeEach(() => {
  vi.clearAllMocks()
  mockConnectionPhase = 'connected'
  mockEntries = null
  mockFile = null
  mockError = null
  mockLoading = false
  mockActiveSessionId = 's1'
})

const GLOBAL_ENTRY: MemoryStackEntry = {
  path: '/home/me/.claude/CLAUDE.md',
  exists: true,
  content: '# Global notes\n\nSome global guidance.',
  truncated: false,
  skipped: false,
  error: null,
  scope: 'global',
  importedFrom: null,
}

const PROJECT_ENTRY: MemoryStackEntry = {
  path: '/repo/CLAUDE.md',
  exists: true,
  content: '# Project notes',
  truncated: false,
  skipped: false,
  error: null,
  scope: 'project',
  importedFrom: null,
}

const LOCAL_ENTRY_MISSING: MemoryStackEntry = {
  path: '/repo/CLAUDE.local.md',
  exists: false,
  content: null,
  truncated: false,
  skipped: false,
  error: null,
  scope: 'local',
  importedFrom: null,
}

describe('MemoryPanel', () => {
  it('requests the memory stack on mount', () => {
    render(<MemoryPanel />)
    expect(mockRequestMemoryRead).toHaveBeenCalledOnce()
  })

  it('shows a loading state before the first reply', () => {
    mockLoading = true
    render(<MemoryPanel />)
    expect(screen.getByTestId('memory-loading')).toBeTruthy()
  })

  it('renders the stack in precedence order (global, project, local)', () => {
    mockEntries = [GLOBAL_ENTRY, PROJECT_ENTRY, LOCAL_ENTRY_MISSING]
    render(<MemoryPanel />)
    const badges = screen.getAllByText(/Global|Project|Local/)
    expect(badges.map((el) => el.textContent)).toEqual(['Global', 'Project', 'Local'])
  })

  it('shows a missing file as "Not present" rather than hiding it', () => {
    mockEntries = [GLOBAL_ENTRY, PROJECT_ENTRY, LOCAL_ENTRY_MISSING]
    render(<MemoryPanel />)
    const localRow = screen.getByTestId('memory-entry-2')
    expect(localRow.textContent).toContain('Not present')
    expect(localRow.textContent).toContain('/repo/CLAUDE.local.md')
    // A missing entry has no content to expand — the toggle must be disabled.
    expect(screen.getByTestId('memory-entry-toggle-2')).toBeDisabled()
  })

  it('shows a skipped @import entry with its skip reason instead of hiding it', () => {
    mockEntries = [
      {
        path: '/home/me/.claude/.credentials.json',
        exists: false,
        content: null,
        truncated: false,
        skipped: true,
        error: 'Outside allowed memory roots — read skipped',
        scope: 'import',
        importedFrom: '/repo/CLAUDE.md',
      },
    ]
    render(<MemoryPanel />)
    expect(screen.getByTestId('memory-entry-0').textContent).toContain('Skipped')
    expect(screen.getByTestId('memory-entry-error-0').textContent).toBe(
      'Outside allowed memory roots — read skipped',
    )
  })

  it('expands an entry to reveal its content on click', () => {
    mockEntries = [PROJECT_ENTRY]
    render(<MemoryPanel />)
    expect(screen.queryByTestId('memory-entry-content-0')).toBeNull()
    fireEvent.click(screen.getByTestId('memory-entry-toggle-0'))
    expect(screen.getByTestId('memory-entry-content-0').textContent).toContain('Project notes')
  })

  // #6996 review — an entry whose file exists but whose content is empty (or
  // whitespace-only) must still be shown as PRESENT (honest provenance — an
  // empty CLAUDE.md is not the same as a missing one), but must NOT offer a
  // dead expand affordance that opens to nothing.
  it('shows an existing-but-empty entry as present without an expand affordance', () => {
    mockEntries = [{ ...PROJECT_ENTRY, content: '   \n\t  ' }]
    render(<MemoryPanel />)
    const row = screen.getByTestId('memory-entry-0')
    expect(row.textContent).toContain('Present')
    const toggle = screen.getByTestId('memory-entry-toggle-0')
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(screen.queryByTestId('memory-entry-content-0')).toBeNull()
  })

  it('still allows expanding a non-empty entry (regression guard alongside the empty-content fix)', () => {
    mockEntries = [PROJECT_ENTRY]
    render(<MemoryPanel />)
    expect(screen.getByTestId('memory-entry-toggle-0')).not.toBeDisabled()
  })

  it('renders entry content escaped — a <script> tag never executes and appears as text', () => {
    mockEntries = [
      { ...PROJECT_ENTRY, content: 'Notes: <script>window.__xss = true</script> after' },
    ]
    const { container } = render(<MemoryPanel />)
    fireEvent.click(screen.getByTestId('memory-entry-toggle-0'))
    // The sanitized markdown pipeline must never leave a live <script> element
    // in the DOM, and the global flag it would have set must never be defined.
    expect(container.querySelector('script')).toBeNull()
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined()
    // The literal text still appears (escaped), proving the content wasn't
    // silently dropped — only rendered inert.
    expect(container.textContent).toContain('after')
  })

  it('renders the auto-generated MEMORY.md as a separate browsable section', () => {
    mockEntries = [PROJECT_ENTRY]
    mockFile = {
      path: '/home/me/.claude/projects/repo/memory/MEMORY.md',
      exists: true,
      content: '# Auto memory',
      truncated: false,
      skipped: false,
      error: null,
    }
    render(<MemoryPanel />)
    const section = screen.getByTestId('memory-file-section')
    expect(section.textContent).toContain('MEMORY.md')
    expect(section.textContent).toContain('/home/me/.claude/projects/repo/memory/MEMORY.md')
  })

  it('shows the MEMORY.md section as present without an expand affordance when its content is blank', () => {
    mockEntries = [PROJECT_ENTRY]
    mockFile = {
      path: '/home/me/.claude/projects/repo/memory/MEMORY.md',
      exists: true,
      content: '',
      truncated: false,
      skipped: false,
      error: null,
    }
    render(<MemoryPanel />)
    const section = screen.getByTestId('memory-file-section')
    expect(section.textContent).toContain('Present')
    expect(screen.getByTestId('memory-file-toggle')).toBeDisabled()
  })

  it('surfaces a request-level error state instead of crashing', () => {
    mockError = 'Memory is not available in this mode'
    expect(() => render(<MemoryPanel />)).not.toThrow()
    expect(screen.getByTestId('memory-stack-error').textContent).toBe(
      'Memory is not available in this mode',
    )
    // The stack itself must not render while a request-level error is set.
    expect(screen.queryByTestId('memory-stack')).toBeNull()
  })

  it('refresh button re-requests the stack', () => {
    mockEntries = [PROJECT_ENTRY]
    render(<MemoryPanel />)
    mockRequestMemoryRead.mockClear()
    fireEvent.click(screen.getByTestId('memory-refresh-btn'))
    expect(mockRequestMemoryRead).toHaveBeenCalledOnce()
  })

  // #6996 review — CRITICAL regression guard: memory_read has no
  // client-supplied sessionId (the server scopes it to the caller's active
  // session cwd), so a switch to a different session must never leave the
  // PREVIOUS session's stack on screen. switchSession() (store/connection.ts)
  // resets memoryStackEntries/File/Error/Loading to null on every switch;
  // this test proves the panel actually re-fetches for the new session
  // *while it stays mounted* (no unmount/remount — the same MemoryPanel
  // instance persists across the rerender, exactly as it would if the panel
  // is open and the user clicks a different session tab) rather than relying
  // on App.tsx's incidental unmount/remount around session switches.
  it('re-fetches when the active session changes while the panel stays mounted, instead of showing stale entries', () => {
    mockActiveSessionId = 's1'
    mockEntries = [PROJECT_ENTRY]
    const { rerender } = render(<MemoryPanel />)
    expect(screen.getByText('/repo/CLAUDE.md')).toBeTruthy()
    mockRequestMemoryRead.mockClear()

    // Simulate switchSession('s2'): the store resets the memory-stack fields
    // to null/false and flips activeSessionId — same component instance,
    // no unmount.
    mockActiveSessionId = 's2'
    mockEntries = null
    mockFile = null
    mockError = null
    mockLoading = false
    rerender(<MemoryPanel />)

    // The previous session's entry must be gone immediately (store already
    // cleared it) ...
    expect(screen.queryByText('/repo/CLAUDE.md')).toBeNull()
    // ... and the panel must have fired a fresh request for the new session
    // rather than sitting blank waiting for a mount effect that will never
    // re-run.
    expect(mockRequestMemoryRead).toHaveBeenCalledOnce()
  })
})

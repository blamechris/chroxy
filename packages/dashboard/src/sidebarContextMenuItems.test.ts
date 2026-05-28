/**
 * sidebarContextMenuItems tests (#4045, #4249).
 *
 * The resumable branch is the headline coverage here — #4249 was a silent
 * dead-click bug: Sidebar fired `onContextMenu` for resumable rows but App's
 * builder returned `[]`, so SessionContextMenu rendered nothing and the
 * browser's native menu was swallowed. These tests pin that the resumable
 * branch now yields a real menu (Resume + Copy ID + Open in Finder) and
 * that activating each item invokes the matching callback.
 *
 * The `session` / `repo` branches keep their existing #4045 contracts —
 * after extracting the builder out of App.tsx the per-branch wiring is
 * unit-testable without a render tree.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SessionInfo, ConversationSummary } from '@chroxy/store-core'
import {
  buildSidebarContextMenuItems,
  type BuildSidebarContextMenuItemsArgs,
} from './sidebarContextMenuItems'

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1',
    name: 'Test',
    cwd: '/home/user/projects/api',
    type: 'cli',
    hasTerminal: true,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: Date.now(),
    conversationId: null,
    provider: 'claude-sdk',
    ...overrides,
  } as SessionInfo
}

function makeConversation(
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    conversationId: 'conv-123',
    project: '/home/user/projects/api',
    projectName: 'api',
    modifiedAt: '2026-03-01',
    modifiedAtMs: Date.parse('2026-03-01'),
    sizeBytes: 1024,
    preview: 'Fix auth bug',
    cwd: '/home/user/projects/api',
    ...overrides,
  }
}

function makeArgs(
  overrides: Partial<BuildSidebarContextMenuItemsArgs> = {},
): BuildSidebarContextMenuItemsArgs {
  return {
    target: { type: 'resumable', conversationId: 'conv-123' },
    sessions: [],
    conversationHistory: [makeConversation()],
    isTauri: false,
    createSession: vi.fn(),
    resumeConversation: vi.fn(),
    revealInFinder: vi.fn(() => Promise.resolve()),
    onRevealError: vi.fn(),
    copyToClipboard: vi.fn(),
    openCreateSessionAt: vi.fn(),
    confirmCloseSession: vi.fn(),
    ...overrides,
  }
}

describe('buildSidebarContextMenuItems', () => {
  describe('resumable branch (#4249)', () => {
    it('returns a non-empty menu — fixes the silent dead-click', () => {
      const items = buildSidebarContextMenuItems(makeArgs())
      expect(items.length).toBeGreaterThan(0)
      // Visible items (those with onClick) must also be > 0 — empty
      // visibleItems is what SessionContextMenu uses to decide to render
      // nothing.
      const visible = items.filter(i => typeof i.onClick === 'function')
      expect(visible.length).toBeGreaterThan(0)
    })

    it('includes Resume Conversation, Copy Conversation ID, and Open in Finder', () => {
      const items = buildSidebarContextMenuItems(makeArgs({ isTauri: true }))
      const labels = items.map(i => i.label)
      expect(labels).toContain('Resume Conversation')
      expect(labels).toContain('Copy Conversation ID')
      expect(labels).toContain('Open in Finder')
    })

    it('Resume calls resumeConversation with the conversationId and cwd from history', () => {
      const resumeConversation = vi.fn()
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'resumable', conversationId: 'conv-123' },
          conversationHistory: [makeConversation({ cwd: '/home/user/projects/web' })],
          resumeConversation,
        }),
      )
      const resume = items.find(i => i.id === 'resume')
      resume?.onClick?.()
      expect(resumeConversation).toHaveBeenCalledWith('conv-123', '/home/user/projects/web')
    })

    it('Resume passes undefined cwd when conversation is not in history', () => {
      const resumeConversation = vi.fn()
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'resumable', conversationId: 'unknown-conv' },
          conversationHistory: [],
          resumeConversation,
        }),
      )
      const resume = items.find(i => i.id === 'resume')
      // Resume should still be enabled even without history — the server
      // can fall back to the cwd recorded in the JSONL transcript.
      expect(typeof resume?.onClick).toBe('function')
      resume?.onClick?.()
      expect(resumeConversation).toHaveBeenCalledWith('unknown-conv', undefined)
    })

    it('Resume passes undefined cwd when conversation record has null cwd', () => {
      const resumeConversation = vi.fn()
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'resumable', conversationId: 'conv-123' },
          conversationHistory: [makeConversation({ cwd: null })],
          resumeConversation,
        }),
      )
      items.find(i => i.id === 'resume')?.onClick?.()
      expect(resumeConversation).toHaveBeenCalledWith('conv-123', undefined)
    })

    it('Copy Conversation ID calls copyToClipboard with the conversationId', () => {
      const copyToClipboard = vi.fn()
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'resumable', conversationId: 'conv-abc' },
          copyToClipboard,
        }),
      )
      items.find(i => i.id === 'copy-id')?.onClick?.()
      expect(copyToClipboard).toHaveBeenCalledWith('conv-abc')
    })

    it('Open in Finder is gated off when not running under Tauri', () => {
      const items = buildSidebarContextMenuItems(makeArgs({ isTauri: false }))
      const reveal = items.find(i => i.id === 'reveal')
      // The item still exists in the array but with no onClick —
      // SessionContextMenu filters items without an onClick at render time.
      expect(reveal).toBeDefined()
      expect(reveal?.onClick).toBeUndefined()
    })

    it('Open in Finder is gated off under Tauri when no cwd is known', () => {
      const items = buildSidebarContextMenuItems(
        makeArgs({
          isTauri: true,
          target: { type: 'resumable', conversationId: 'no-history' },
          conversationHistory: [],
        }),
      )
      const reveal = items.find(i => i.id === 'reveal')
      expect(reveal?.onClick).toBeUndefined()
    })

    it('Open in Finder calls revealInFinder with the conversation cwd when Tauri + cwd', () => {
      const revealInFinder = vi.fn(() => Promise.resolve())
      const items = buildSidebarContextMenuItems(
        makeArgs({
          isTauri: true,
          conversationHistory: [makeConversation({ cwd: '/some/path' })],
          revealInFinder,
        }),
      )
      items.find(i => i.id === 'reveal')?.onClick?.()
      expect(revealInFinder).toHaveBeenCalledWith('/some/path')
    })

    it('Open in Finder reports failure through onRevealError instead of unhandled rejection', async () => {
      const onRevealError = vi.fn()
      const revealInFinder = vi.fn(() => Promise.reject(new Error('boom')))
      const items = buildSidebarContextMenuItems(
        makeArgs({ isTauri: true, revealInFinder, onRevealError }),
      )
      items.find(i => i.id === 'reveal')?.onClick?.()
      // vi.waitFor flushes microtasks until the assertion passes; sturdier
      // than counting `await Promise.resolve()` ticks if the promise chain
      // ever grows.
      await vi.waitFor(() => {
        expect(onRevealError).toHaveBeenCalledTimes(1)
      })
      expect(onRevealError.mock.calls[0]![0]).toContain('boom')
    })

    it('returns [] when target.conversationId is missing', () => {
      // Defensive guard — the Sidebar always passes a conversationId for
      // resumable rows, but the builder should not produce a menu with
      // undefined-id items if the target is malformed.
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'resumable' /* no conversationId */ },
        }),
      )
      expect(items).toEqual([])
    })
  })

  describe('session branch (#4045 contract)', () => {
    it('returns [] when the session id no longer matches any live session', () => {
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'session', sessionId: 'ghost' },
          sessions: [],
        }),
      )
      expect(items).toEqual([])
    })

    it('Duplicate calls createSession with the session fields', () => {
      const createSession = vi.fn()
      const session = makeSession({ sessionId: 's42', name: 'API', worktree: true })
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'session', sessionId: 's42' },
          sessions: [session],
          createSession,
        }),
      )
      items.find(i => i.id === 'duplicate')?.onClick?.()
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'API', cwd: '/home/user/projects/api', worktree: true }),
      )
    })

    it('Close calls confirmCloseSession (not destroySession directly)', () => {
      // The session-row Close goes through the App-level confirm wrapper so
      // the window.confirm prompt fires; tests pin that the builder still
      // delegates to that wrapper rather than the raw destroy action.
      const confirmCloseSession = vi.fn()
      const session = makeSession({ sessionId: 's42' })
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'session', sessionId: 's42' },
          sessions: [session],
          confirmCloseSession,
        }),
      )
      items.find(i => i.id === 'close')?.onClick?.()
      expect(confirmCloseSession).toHaveBeenCalledWith('s42')
    })

    it('Close item is flagged destructive with a separator above', () => {
      const session = makeSession({ sessionId: 's42' })
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'session', sessionId: 's42' },
          sessions: [session],
        }),
      )
      const close = items.find(i => i.id === 'close')
      expect(close?.destructive).toBe(true)
      expect(close?.separatorAbove).toBe(true)
    })
  })

  describe('repo branch (#4045 contract)', () => {
    it('returns [] when target.path is missing', () => {
      const items = buildSidebarContextMenuItems(
        makeArgs({ target: { type: 'repo' /* no path */ } }),
      )
      expect(items).toEqual([])
    })

    it('New Session Here calls openCreateSessionAt with the repo path', () => {
      const openCreateSessionAt = vi.fn()
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'repo', path: '/home/user/projects/api' },
          openCreateSessionAt,
        }),
      )
      items.find(i => i.id === 'new-session')?.onClick?.()
      expect(openCreateSessionAt).toHaveBeenCalledWith('/home/user/projects/api')
    })

    it('Open in Finder is gated off when not running under Tauri', () => {
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'repo', path: '/home/user/projects/api' },
          isTauri: false,
        }),
      )
      expect(items.find(i => i.id === 'reveal')?.onClick).toBeUndefined()
    })

    it('Open in Finder reveals the repo path under Tauri', () => {
      const revealInFinder = vi.fn(() => Promise.resolve())
      const items = buildSidebarContextMenuItems(
        makeArgs({
          target: { type: 'repo', path: '/home/user/projects/api' },
          isTauri: true,
          revealInFinder,
        }),
      )
      items.find(i => i.id === 'reveal')?.onClick?.()
      expect(revealInFinder).toHaveBeenCalledWith('/home/user/projects/api')
    })
  })

  it('returns [] for an unknown target type', () => {
    const items = buildSidebarContextMenuItems(
      // @ts-expect-error — intentional bad type to verify the fall-through
      makeArgs({ target: { type: 'unknown' } }),
    )
    expect(items).toEqual([])
  })
})

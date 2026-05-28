/**
 * Builder for the sidebar right-click context menu items (#4045, #4249).
 *
 * Extracted from `App.tsx` so the branch logic per `ContextMenuTarget.type`
 * is pure and unit-testable without bootstrapping the whole App tree. The
 * useMemo inside App.tsx now just calls this with the live dependencies.
 *
 * Per-branch items:
 *   - `session` — Duplicate Session, Open in Finder (Tauri+cwd), Close Session
 *   - `repo`    — New Session Here, Open in Finder (Tauri)
 *   - `resumable` (#4249) — Resume Conversation, Copy Conversation ID,
 *     Open in Finder (Tauri+cwd). cwd is looked up from `conversationHistory`
 *     so the resume + reveal actions point at the same project the
 *     conversation lived in.
 *
 * Capability-gated items use a falsy `onClick` so `SessionContextMenu`
 * filters them at render time (no caller-side filtering needed).
 */
import type { SessionInfo, ConversationSummary } from '@chroxy/store-core'
import type { ContextMenuItem } from './components/SessionContextMenu'
import type { ContextMenuTarget } from './components/Sidebar'

export interface BuildSidebarContextMenuItemsArgs {
  /** Current right-click target. */
  target: ContextMenuTarget
  /** Live sessions list (for the `session` branch lookup). */
  sessions: SessionInfo[]
  /** Conversation history (for the `resumable` branch cwd lookup). */
  conversationHistory: ConversationSummary[]
  /** True when running under the Tauri desktop shell. */
  isTauri: boolean

  // Action dependencies — passed in so the helper stays pure. Mirrors the
  // shape of ConnectionStore.createSession so App.tsx can pass the store
  // method through unchanged.
  createSession: (opts: {
    name: string
    cwd?: string
    provider?: string
    model?: string
    permissionMode?: string
    worktree?: boolean
    environmentId?: string
    skipPermissions?: boolean
  }) => void
  destroySession: (sessionId: string) => void
  resumeConversation: (conversationId: string, cwd?: string) => void
  revealInFinder: (path: string) => Promise<unknown>
  /** Surface a Rust-side reveal failure as a toast (matches App.tsx pattern). */
  onRevealError: (message: string) => void
  /** Imperative copy-to-clipboard helper (callable from a sync click). */
  copyToClipboard: (text: string) => void
  /** Open the CreateSessionModal at a given cwd (for the repo branch). */
  openCreateSessionAt: (cwd: string) => void
  /** Wrapper around `destroySession` that prompts the user first. */
  confirmCloseSession: (sessionId: string) => void
}

export function buildSidebarContextMenuItems(
  args: BuildSidebarContextMenuItemsArgs,
): ContextMenuItem[] {
  const {
    target,
    sessions,
    conversationHistory,
    isTauri,
    createSession,
    resumeConversation,
    revealInFinder,
    onRevealError,
    copyToClipboard,
    openCreateSessionAt,
    confirmCloseSession,
  } = args

  // Reveal helper that mirrors the App.tsx error-toast pattern so each
  // branch isn't repeating the same try/catch shim.
  const reveal = (path: string) => {
    revealInFinder(path).catch((err: unknown) => {
      onRevealError(
        `Failed to reveal in Finder: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  if (target.type === 'session' && target.sessionId) {
    const session = sessions.find(s => s.sessionId === target.sessionId)
    if (!session) return []
    return [
      {
        id: 'duplicate',
        label: 'Duplicate Session',
        onClick: () => {
          createSession({
            name: session.name,
            cwd: session.cwd || undefined,
            provider: session.provider,
            model: session.model || undefined,
            permissionMode: session.permissionMode || undefined,
            worktree: session.worktree,
          })
        },
      },
      {
        id: 'reveal',
        label: 'Open in Finder',
        onClick: isTauri && session.cwd ? () => reveal(session.cwd) : undefined,
      },
      {
        id: 'close',
        label: 'Close Session',
        destructive: true,
        separatorAbove: true,
        onClick: () => confirmCloseSession(session.sessionId),
      },
    ]
  }

  if (target.type === 'repo' && target.path) {
    const repoPath = target.path
    return [
      {
        id: 'new-session',
        label: 'New Session Here',
        onClick: () => openCreateSessionAt(repoPath),
      },
      {
        id: 'reveal',
        label: 'Open in Finder',
        onClick: isTauri ? () => reveal(repoPath) : undefined,
      },
    ]
  }

  if (target.type === 'resumable' && target.conversationId) {
    // #4249: prior to this, the resumable branch fell through to `return []`
    // which left SessionContextMenu rendering nothing while still swallowing
    // the browser's native menu — a silent dead-click on the row.
    const conversationId = target.conversationId
    const conv = conversationHistory.find(c => c.conversationId === conversationId)
    // cwd is opportunistic: a conversation row can be shown for a project
    // whose history record we haven't fetched yet. The resume call still
    // works server-side without cwd (the server falls back to the project
    // recorded in the JSONL transcript) — we only pass cwd along when we
    // already have it.
    const cwd = conv?.cwd ?? undefined
    return [
      {
        id: 'resume',
        label: 'Resume Conversation',
        onClick: () => resumeConversation(conversationId, cwd),
      },
      {
        id: 'copy-id',
        label: 'Copy Conversation ID',
        onClick: () => copyToClipboard(conversationId),
      },
      {
        id: 'reveal',
        label: 'Open in Finder',
        onClick: isTauri && cwd ? () => reveal(cwd) : undefined,
      },
    ]
  }

  return []
}

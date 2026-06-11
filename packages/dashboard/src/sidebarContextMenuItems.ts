/**
 * Builder for the sidebar right-click context menu items (#4045, #4249).
 *
 * Extracted from `App.tsx` so the branch logic per `ContextMenuTarget.type`
 * is pure and unit-testable without bootstrapping the whole App tree. The
 * useMemo inside App.tsx now just calls this with the live dependencies.
 *
 * Per-branch items:
 *   - `session` — Duplicate Session, Copy transcript (#5547), Summarize & start
 *     new session (#5547), Open in Finder (Tauri+cwd), Close Session
 *   - `repo`    — New Session Here, Summarize & start new session targeting the
 *     group's most-recent session (or one item per live session when several,
 *     #5547), Open in Finder (Tauri)
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
  resumeConversation: (conversationId: string, cwd?: string) => void
  revealInFinder: (path: string) => Promise<unknown>
  /** Surface a Rust-side reveal failure as a toast (matches App.tsx pattern). */
  onRevealError: (message: string) => void
  /** Imperative copy-to-clipboard helper (callable from a sync click). */
  copyToClipboard: (text: string) => void
  /** Open the CreateSessionModal at a given cwd (for the repo branch). */
  openCreateSessionAt: (cwd: string) => void
  /**
   * #5547: copy a SPECIFIC session's transcript to the clipboard. The sidebar
   * action must work for any session, not just the active one, so this reads
   * the target session's messages from the store and formats + copies them.
   */
  copySessionTranscript: (sessionId: string) => void
  /**
   * #5547: summarize a session server-side, then open the create-session modal
   * with the session's cwd prefilled and the brief seeded EDITABLE in the
   * composer. Async (awaits the model call); the caller surfaces progress +
   * errors. Never auto-sends.
   */
  summarizeAndCreateSession: (sessionId: string) => void
  /**
   * Wrapper around the store's `destroySession` that prompts the user first
   * (the session-row Close action must not destroy without confirmation).
   */
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
    copySessionTranscript,
    summarizeAndCreateSession,
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
        // #5547: Copy transcript from the right-click menu so it works without
        // switching to the session first (the header overflow only copies the
        // ACTIVE session's transcript).
        id: 'copy-transcript',
        label: 'Copy transcript',
        onClick: () => copySessionTranscript(session.sessionId),
      },
      {
        // #5547: cross-session /compact — server-side summary seeded editable
        // into a fresh create-session composer.
        id: 'summarize',
        label: 'Summarize & start new session',
        onClick: () => summarizeAndCreateSession(session.sessionId),
      },
      {
        id: 'reveal',
        label: 'Open in Finder',
        onClick: isTauri && session.cwd ? () => reveal(session.cwd) : undefined,
      },
      {
        // #4268: Copy path — uses the renderer-side clipboard so it works
        // in both Tauri and browser dashboard. Gated off when the session
        // has no cwd; visible-items filter drops the entry in that case.
        id: 'copy-path',
        label: 'Copy path',
        onClick: session.cwd ? () => copyToClipboard(session.cwd as string) : undefined,
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
    // #5547: the group's live sessions, most-recent first. The repo group is
    // keyed by cwd, so sessions sharing this cwd belong to the group. A single
    // live session gets one "Summarize…" item targeting it; several get one
    // item per session (a simple in-menu picker) so the operator disambiguates
    // which conversation to carry forward.
    const groupSessions = sessions
      .filter(s => s.cwd === repoPath)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    const soleSession = groupSessions.length === 1 ? groupSessions[0] : null
    const summarizeItems: ContextMenuItem[] = soleSession
      ? [{
          id: 'summarize',
          label: 'Summarize & start new session',
          onClick: () => summarizeAndCreateSession(soleSession.sessionId),
        }]
      : groupSessions.map((s, i) => ({
          id: `summarize-${s.sessionId}`,
          label: `Summarize "${s.name}" & start new session`,
          separatorAbove: i === 0,
          onClick: () => summarizeAndCreateSession(s.sessionId),
        }))
    return [
      {
        id: 'new-session',
        label: 'New Session Here',
        onClick: () => openCreateSessionAt(repoPath),
      },
      ...summarizeItems,
      {
        id: 'reveal',
        label: 'Open in Finder',
        separatorAbove: summarizeItems.length > 0,
        onClick: isTauri ? () => reveal(repoPath) : undefined,
      },
      {
        // #4268: Copy path for repo group headers — repo nodes always
        // carry a path (it's how Sidebar groups sessions), so this item
        // is never capability-gated off.
        id: 'copy-path',
        label: 'Copy path',
        onClick: () => copyToClipboard(repoPath),
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

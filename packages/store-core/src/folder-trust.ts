/**
 * Shared per-folder trust logic for the mobile app and the web dashboard.
 *
 * A session folder can carry project settings that make the agent run commands.
 * The daemon reports whether they are loaded (`folder_trust_state`) and answers a
 * trust change with `folder_trust_result` (or an `error` envelope). These are the
 * pure pieces both clients share: frame -> entry, which session a reply belongs
 * to, the outgoing request, and the text both banners show. No store or socket
 * access lives here.
 */
import type { ServerFolderTrustStateMessage } from '@chroxy/protocol'

/** One session's `folder_trust_state`, kept as the wire frame minus its type/sessionId. */
export type FolderTrustEntry = Pick<
  ServerFolderTrustStateMessage,
  'status' | 'summary' | 'digest' | 'appliesFrom' | 'launchedWithProject'
>

type FolderTrustSummary = NonNullable<FolderTrustEntry['summary']>

/** Shown when a refusal carries no reason of its own. */
export const FOLDER_TRUST_FALLBACK_ERROR = 'The trust change could not be applied'

/** Error codes the daemon uses for a refused trust change start with this. */
const FOLDER_TRUST_ERROR_PREFIX = 'FOLDER_TRUST_'

/** The state frame as a session id plus the entry to store; null without a usable session id. */
export function folderTrustEntryFromFrame(
  msg: ServerFolderTrustStateMessage,
): { sessionId: string; entry: FolderTrustEntry } | null {
  if (typeof msg.sessionId !== 'string' || !msg.sessionId) return null
  const { type: _type, sessionId, ...entry } = msg
  return { sessionId, entry }
}

function sessionForRequestId(pendingBySession: Record<string, string>, requestId: string): string | undefined {
  return Object.keys(pendingBySession).find((id) => pendingBySession[id] === requestId)
}

/**
 * The session a `folder_trust_result` settles. Matched by `requestId`, so a reply
 * never settles a newer request of the same session. A reply without one falls
 * back to the session it names; a requestId that matches nothing settles nothing.
 */
export function findFolderTrustReplySession(
  pendingBySession: Record<string, string>,
  reply: { requestId?: string; sessionId?: string },
): string | null {
  if (typeof reply.requestId === 'string' && reply.requestId) {
    return sessionForRequestId(pendingBySession, reply.requestId) ?? null
  }
  return typeof reply.sessionId === 'string' && reply.sessionId ? reply.sessionId : null
}

/**
 * The session an `error` envelope belongs to, or null when it is not a trust error.
 * An error tied to a trust request settles THAT request whatever its code; one that
 * matches no request lands on the session the frame names only for a
 * `FOLDER_TRUST_` code. It never lands on another session.
 */
export function findFolderTrustErrorSession(
  pendingBySession: Record<string, string>,
  err: { requestId?: string; code?: string; sessionId?: string },
): string | null {
  const code = typeof err.code === 'string' ? err.code : ''
  const named = code.startsWith(FOLDER_TRUST_ERROR_PREFIX) && typeof err.sessionId === 'string' ? err.sessionId : null
  if (typeof err.requestId === 'string' && err.requestId) {
    return sessionForRequestId(pendingBySession, err.requestId) ?? named
  }
  return named
}

export type FolderTrustRequest =
  | { type: 'trust_folder'; sessionId: string; requestId: string; digest: string }
  | { type: 'untrust_folder'; sessionId: string; requestId: string }

/** The wire message for a trust change; null when it cannot be formed (no session, or no digest to approve). */
export function buildFolderTrustRequest(
  type: 'trust_folder' | 'untrust_folder',
  sessionId: string,
  requestId: string,
  digest?: string,
): FolderTrustRequest | null {
  if (!sessionId) return null
  if (type === 'untrust_folder') return { type, sessionId, requestId }
  if (!digest) return null
  return { type, sessionId, requestId, digest }
}

/** When a trust change takes effect, or null when there is nothing to say. */
export function folderTrustAppliesFromText(appliesFrom: FolderTrustEntry['appliesFrom']): string | null {
  if (appliesFrom === 'next_turn') return 'Applies from the next turn'
  if (appliesFrom === 'restart') return 'Restart the session to apply'
  return null
}

/** The command line an MCP server entry would run (or its url / transport when it has no command). */
export function folderTrustMcpCommandLine(
  server: FolderTrustSummary['mcpServers'][number],
): string {
  return [server.command ?? server.url ?? server.type ?? '', ...(server.args ?? [])].filter(Boolean).join(' ')
}

/** "3 agent files, 1 skill file, 0 command files". */
export function folderTrustCountsText(counts: FolderTrustSummary['counts']): string {
  const noun = (n: number) => (n === 1 ? 'file' : 'files')
  return `${counts.agents} agent ${noun(counts.agents)}, ${counts.skills} skill ${noun(counts.skills)}, ${counts.commands} command ${noun(counts.commands)}`
}

/** Whether the counts line is worth showing. */
export function folderTrustHasFileCounts(counts: FolderTrustSummary['counts']): boolean {
  return counts.agents > 0 || counts.skills > 0 || counts.commands > 0
}

/**
 * Whether the owner can approve this reviewed snapshot: it needs the summary and its
 * digest, and a folder that could be reviewed completely.
 */
export function canTrustFolderSnapshot(entry: FolderTrustEntry): boolean {
  return Boolean(entry.summary && entry.digest && !entry.summary.untrustable)
}

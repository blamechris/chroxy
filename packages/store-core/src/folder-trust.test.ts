import { describe, it, expect } from 'vitest'
import type { ServerFolderTrustStateMessage } from '@chroxy/protocol'
import {
  FOLDER_TRUST_FALLBACK_ERROR,
  folderTrustEntryFromFrame,
  findFolderTrustReplySession,
  findFolderTrustErrorSession,
  buildFolderTrustRequest,
  folderTrustAppliesFromText,
  folderTrustMcpCommandLine,
  folderTrustCountsText,
  folderTrustHasFileCounts,
  canTrustFolderSnapshot,
  type FolderTrustEntry,
} from './folder-trust'

const DIGEST = 'a'.repeat(64)
const summary = (over: Record<string, unknown> = {}): NonNullable<FolderTrustEntry['summary']> => ({
  files: [], mcpServers: [], hooks: [], statusLine: [], enabledPlugins: [],
  counts: { agents: 0, skills: 0, commands: 0 }, warnings: [],
  hasCommandBearingFiles: false, untrustable: false, ...over,
})

describe('folderTrustEntryFromFrame', () => {
  it('drops type and sessionId and keeps the rest', () => {
    const frame = { type: 'folder_trust_state', sessionId: 's1', status: 'untrusted', digest: DIGEST, appliesFrom: 'next_turn', launchedWithProject: true } as ServerFolderTrustStateMessage
    expect(folderTrustEntryFromFrame(frame)).toEqual({
      sessionId: 's1',
      entry: { status: 'untrusted', digest: DIGEST, appliesFrom: 'next_turn', launchedWithProject: true },
    })
  })
  it('returns null for an empty or non-string session id', () => {
    expect(folderTrustEntryFromFrame({ type: 'folder_trust_state', sessionId: '', status: 'trusted', appliesFrom: 'n/a' } as ServerFolderTrustStateMessage)).toBeNull()
    expect(folderTrustEntryFromFrame({ type: 'folder_trust_state', sessionId: 5, status: 'trusted', appliesFrom: 'n/a' } as unknown as ServerFolderTrustStateMessage)).toBeNull()
  })
})

describe('findFolderTrustReplySession', () => {
  const pending = { a: 'req-a', b: 'req-b' }
  it('matches by requestId', () => {
    expect(findFolderTrustReplySession(pending, { requestId: 'req-b', sessionId: 'a' })).toBe('b')
  })
  it('returns null when a requestId matches nothing, even if the session is pending', () => {
    expect(findFolderTrustReplySession(pending, { requestId: 'stale', sessionId: 'a' })).toBeNull()
  })
  it('falls back to the named session without a requestId', () => {
    expect(findFolderTrustReplySession(pending, { sessionId: 'a' })).toBe('a')
    expect(findFolderTrustReplySession({}, { sessionId: 'zzz' })).toBe('zzz')
  })
  it('treats an empty requestId as absent', () => {
    expect(findFolderTrustReplySession(pending, { requestId: '', sessionId: 'b' })).toBe('b')
  })
  it('returns null with neither requestId nor a usable session', () => {
    expect(findFolderTrustReplySession(pending, {})).toBeNull()
    expect(findFolderTrustReplySession(pending, { sessionId: '' })).toBeNull()
  })
})

describe('findFolderTrustErrorSession', () => {
  const pending = { a: 'req-a' }
  it('matches the pending request whatever the code', () => {
    expect(findFolderTrustErrorSession(pending, { requestId: 'req-a', code: 'INVALID_MESSAGE' })).toBe('a')
  })
  it('prefers the pending request over the frame session', () => {
    expect(findFolderTrustErrorSession(pending, { requestId: 'req-a', code: 'FOLDER_TRUST_FORBIDDEN', sessionId: 'other' })).toBe('a')
  })
  it('falls back to the frame session for a FOLDER_TRUST_ code when the requestId matches nothing', () => {
    expect(findFolderTrustErrorSession(pending, { requestId: 'nope', code: 'FOLDER_TRUST_CHANGED', sessionId: 's9' })).toBe('s9')
  })
  it('ignores an unmatched requestId on a non-trust code', () => {
    expect(findFolderTrustErrorSession(pending, { requestId: 'nope', code: 'INVALID_MESSAGE', sessionId: 's9' })).toBeNull()
  })
  it('without a requestId, names the session only for a FOLDER_TRUST_ code', () => {
    expect(findFolderTrustErrorSession(pending, { code: 'FOLDER_TRUST_FORBIDDEN', sessionId: 's9' })).toBe('s9')
    expect(findFolderTrustErrorSession(pending, { code: 'SOMETHING_ELSE', sessionId: 's9' })).toBeNull()
  })
  it('returns null for a trust code that names no session, or has no code', () => {
    expect(findFolderTrustErrorSession(pending, { code: 'FOLDER_TRUST_FORBIDDEN' })).toBeNull()
    expect(findFolderTrustErrorSession(pending, { sessionId: 's9' })).toBeNull()
    expect(findFolderTrustErrorSession(pending, {})).toBeNull()
  })
})

describe('buildFolderTrustRequest', () => {
  it('builds a trust request with the digest', () => {
    expect(buildFolderTrustRequest('trust_folder', 's1', 'r1', DIGEST)).toEqual({ type: 'trust_folder', sessionId: 's1', requestId: 'r1', digest: DIGEST })
  })
  it('refuses a trust request without a digest or session', () => {
    expect(buildFolderTrustRequest('trust_folder', 's1', 'r1')).toBeNull()
    expect(buildFolderTrustRequest('trust_folder', 's1', 'r1', '')).toBeNull()
    expect(buildFolderTrustRequest('trust_folder', '', 'r1', DIGEST)).toBeNull()
  })
  it('builds an untrust request without a digest, even if one is passed', () => {
    expect(buildFolderTrustRequest('untrust_folder', 's1', 'r1', DIGEST)).toEqual({ type: 'untrust_folder', sessionId: 's1', requestId: 'r1' })
  })
  it('refuses an untrust request without a session', () => {
    expect(buildFolderTrustRequest('untrust_folder', '', 'r1')).toBeNull()
  })
})

describe('display helpers', () => {
  it('appliesFrom text', () => {
    expect(folderTrustAppliesFromText('next_turn')).toBe('Applies from the next turn')
    expect(folderTrustAppliesFromText('restart')).toBe('Restart the session to apply')
    expect(folderTrustAppliesFromText('n/a')).toBeNull()
  })
  it('mcp command line falls back command -> url -> type and appends args', () => {
    expect(folderTrustMcpCommandLine({ file: 'f', name: 'n', command: 'npx', args: ['-y', 'x'] })).toBe('npx -y x')
    expect(folderTrustMcpCommandLine({ file: 'f', name: 'n', url: 'https://h/mcp', type: 'http' })).toBe('https://h/mcp')
    expect(folderTrustMcpCommandLine({ file: 'f', name: 'n', type: 'sse' })).toBe('sse')
    expect(folderTrustMcpCommandLine({ file: 'f', name: 'n' })).toBe('')
  })
  it('counts sentence uses singular for exactly one', () => {
    expect(folderTrustCountsText({ agents: 1, skills: 2, commands: 0 })).toBe('1 agent file, 2 skill files, 0 command files')
  })
  it('hasFileCounts is true when any count is positive', () => {
    expect(folderTrustHasFileCounts({ agents: 0, skills: 0, commands: 0 })).toBe(false)
    expect(folderTrustHasFileCounts({ agents: 0, skills: 0, commands: 1 })).toBe(true)
  })
  it('canTrustFolderSnapshot needs summary, digest and a trustable folder', () => {
    const base = { status: 'untrusted', appliesFrom: 'next_turn' } as const
    expect(canTrustFolderSnapshot({ ...base, summary: summary(), digest: DIGEST })).toBe(true)
    expect(canTrustFolderSnapshot({ ...base, summary: summary() })).toBe(false)
    expect(canTrustFolderSnapshot({ ...base, digest: DIGEST })).toBe(false)
    expect(canTrustFolderSnapshot({ ...base, summary: summary({ untrustable: true }), digest: DIGEST })).toBe(false)
  })
  it('exposes the fallback error text', () => {
    expect(FOLDER_TRUST_FALLBACK_ERROR).toBe('The trust change could not be applied')
  })
})

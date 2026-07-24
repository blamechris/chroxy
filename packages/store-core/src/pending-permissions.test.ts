import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './types'
import {
  isLivePermissionPrompt,
  firstLivePermissionPrompt,
  livePermissionPrompts,
  countLivePermissionPrompts,
  derivePendingPermissionSessions,
  derivePendingPermissionCounts,
  totalPendingPermissions,
  selectNextPendingSession,
  pathMatchesViewer,
  findPendingWriteForFile,
} from './pending-permissions'

const NOW = 1_000_000

function prompt(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    type: 'prompt',
    content: 'Bash: ls',
    tool: 'Bash',
    requestId: 'req-1',
    expiresAt: NOW + 60_000,
    timestamp: NOW,
    ...over,
  }
}

function states(map: Record<string, ChatMessage[]>): Record<string, { messages: ChatMessage[] }> {
  const out: Record<string, { messages: ChatMessage[] }> = {}
  for (const id in map) out[id] = { messages: map[id]! }
  return out
}

describe('isLivePermissionPrompt', () => {
  it('is true only for a live, unanswered permission prompt', () => {
    expect(isLivePermissionPrompt(prompt(), NOW)).toBe(true)
    expect(isLivePermissionPrompt(prompt({ answered: 'allow' }), NOW)).toBe(false)
    expect(isLivePermissionPrompt(prompt({ expiresAt: NOW - 1 }), NOW)).toBe(false)
    expect(isLivePermissionPrompt(prompt({ requestId: undefined }), NOW)).toBe(false)
    expect(isLivePermissionPrompt(prompt({ expiresAt: undefined }), NOW)).toBe(false)
    expect(isLivePermissionPrompt({ id: 't', type: 'response', content: '', timestamp: NOW }, NOW)).toBe(false)
  })
})

describe('firstLivePermissionPrompt / livePermissionPrompts / countLivePermissionPrompts', () => {
  const msgs = [
    prompt({ id: 'answered', requestId: 'r-ans', answered: 'allow' }),
    { id: 'sys', type: 'system' as const, content: 'note', timestamp: NOW },
    prompt({ id: 'live-1', requestId: 'r1' }),
    prompt({ id: 'live-2', requestId: 'r2' }),
    prompt({ id: 'expired', requestId: 'r-exp', expiresAt: NOW - 1 }),
  ]
  it('first returns the earliest live prompt', () => {
    expect(firstLivePermissionPrompt(msgs, NOW)?.requestId).toBe('r1')
    expect(firstLivePermissionPrompt([prompt({ answered: 'deny' })], NOW)).toBeNull()
  })
  it('live returns all live prompts in order', () => {
    expect(livePermissionPrompts(msgs, NOW).map((m) => m.requestId)).toEqual(['r1', 'r2'])
  })
  it('count returns the number of live prompts', () => {
    expect(countLivePermissionPrompts(msgs, NOW)).toBe(2)
    expect(countLivePermissionPrompts([], NOW)).toBe(0)
  })
})

describe('derivePendingPermissionSessions (#5667)', () => {
  it('flags a session with a live unanswered permission prompt', () => {
    expect(derivePendingPermissionSessions(states({ s1: [prompt()] }), NOW)).toEqual({ s1: true })
  })
  it('does NOT flag answered / expired / AskUserQuestion', () => {
    expect(derivePendingPermissionSessions(states({ s1: [prompt({ answered: 'allow' })] }), NOW)).toEqual({})
    expect(derivePendingPermissionSessions(states({ s1: [prompt({ expiresAt: NOW - 1 })] }), NOW)).toEqual({})
    const aukq = prompt({ requestId: undefined, expiresAt: undefined, options: [{ label: 'A', value: 'a' }] })
    expect(derivePendingPermissionSessions(states({ s1: [aukq] }), NOW)).toEqual({})
  })
  it('flags only the sessions that actually have a live prompt', () => {
    const result = derivePendingPermissionSessions(
      states({
        active: [prompt({ id: 'a', answered: 'allow' })],
        bg1: [{ ...prompt({ id: 'b' }), type: 'response', content: 'hi' }, prompt({ id: 'c' })],
        bg2: [prompt({ id: 'd', expiresAt: NOW - 5 })],
      }),
      NOW,
    )
    expect(result).toEqual({ bg1: true })
  })
})

describe('derivePendingPermissionCounts (#5693)', () => {
  it('counts multiple live prompts in one session and omits zero-pending sessions', () => {
    const counts = derivePendingPermissionCounts(
      states({
        s1: [prompt({ id: 'a', requestId: 'r-a' }), prompt({ id: 'b', requestId: 'r-b' })],
        s2: [prompt({ id: 'c', requestId: 'r-c' })],
        s3: [prompt({ id: 'd', requestId: 'r-d', answered: 'allow' })],
        s4: [],
      }),
      NOW,
    )
    expect(counts).toEqual({ s1: 2, s2: 1 })
  })
  it('stays consistent with the boolean derive', () => {
    const s = states({ s1: [prompt({ id: 'a' })], s2: [prompt({ id: 'b', answered: 'allow' })] })
    expect(derivePendingPermissionSessions(s, NOW)).toEqual({ s1: true })
    expect(Object.keys(derivePendingPermissionCounts(s, NOW))).toEqual(['s1'])
  })
})

describe('totalPendingPermissions (#5693)', () => {
  it('sums counts across sessions', () => {
    expect(totalPendingPermissions({ s1: 2, s2: 1 })).toBe(3)
    expect(totalPendingPermissions({})).toBe(0)
  })
})

describe('selectNextPendingSession (#5693)', () => {
  const order = ['a', 'b', 'c', 'd']
  it('returns null when nothing is pending', () => {
    expect(selectNextPendingSession(order, {}, 'a')).toBeNull()
    expect(selectNextPendingSession([], { a: 1 }, 'a')).toBeNull()
  })
  it('jumps to the next pending session AFTER the active tab, in tab order', () => {
    expect(selectNextPendingSession(order, { b: 1, d: 2 }, 'a')).toBe('b')
    expect(selectNextPendingSession(order, { b: 1, d: 2 }, 'b')).toBe('d')
  })
  it('wraps around cyclically', () => {
    expect(selectNextPendingSession(order, { a: 1 }, 'd')).toBe('a')
  })
  it('returns the active tab when it is the only pending one (no-op focus)', () => {
    expect(selectNextPendingSession(order, { b: 3 }, 'b')).toBe('b')
  })
  it('scans from the start when the active id is not in the list', () => {
    expect(selectNextPendingSession(order, { c: 1 }, 'unknown')).toBe('c')
    expect(selectNextPendingSession(order, { c: 1 }, null)).toBe('c')
  })
})

// #6859 (IDE P3.3 follow-up of #6857/#6544) — viewer↔pending-write correlation,
// hoisted out of two byte-identical copies previously in the dashboard's and
// app's ViewerPreWriteReview.tsx (each had its own describe blocks for these
// same assertions; ported here verbatim as the single source of truth).

describe('pathMatchesViewer (#6859)', () => {
  it('matches identical absolute paths', () => {
    expect(pathMatchesViewer('/a/b/c.ts', '/a/b/c.ts')).toBe(true)
  })
  it('tail-matches an absolute file_path against a workspace-relative selection', () => {
    expect(pathMatchesViewer('/root/pkg/src/x.ts', 'src/x.ts')).toBe(true)
    expect(pathMatchesViewer('/root/pkg/src/x.ts', './src/x.ts')).toBe(true)
  })
  it('normalizes backslashes before comparing (Windows-style paths)', () => {
    expect(pathMatchesViewer('C:\\root\\pkg\\src\\x.ts', 'C:/root/pkg/src/x.ts')).toBe(true)
    expect(pathMatchesViewer('C:\\root\\pkg\\src\\x.ts', 'src/x.ts')).toBe(true)
    expect(pathMatchesViewer('C:\\root\\pkg\\src\\x.ts', './src/x.ts')).toBe(true)
  })
  it('does not match unrelated files or when either side is empty', () => {
    expect(pathMatchesViewer('/a/b/x.ts', '/a/b/y.ts')).toBe(false)
    expect(pathMatchesViewer(null, '/a/b/x.ts')).toBe(false)
    expect(pathMatchesViewer('/a/b/x.ts', null)).toBe(false)
    expect(pathMatchesViewer(undefined, '/a/b/x.ts')).toBe(false)
  })
})

describe('findPendingWriteForFile (#6859)', () => {
  const NOW2 = Date.now()
  const FILE = '/home/dev/project/src/app.ts'
  // Mirrors each client's local PreWriteDiffReview.isReviewableTool — injected
  // as a predicate rather than hoisted, since which tools get a diff review is
  // a presentation concern owned by each client's PreWriteDiffReview.tsx.
  const isReviewableTool = (tool: string) => tool === 'Write' || tool === 'Edit'

  function editPrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'perm-1',
      type: 'prompt',
      content: 'Edit: change app.ts',
      tool: 'Edit',
      requestId: 'req-1',
      toolInput: { file_path: FILE, old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
      expiresAt: NOW2 + 60_000,
      timestamp: NOW2,
      ...overrides,
    }
  }

  it('finds a live Edit/Write targeting the viewed file', () => {
    expect(findPendingWriteForFile([editPrompt()], FILE, NOW2, isReviewableTool)?.requestId).toBe('req-1')
  })

  it('ignores expired, answered, non-reviewable, or non-matching prompts', () => {
    expect(findPendingWriteForFile([editPrompt({ expiresAt: NOW2 - 1 })], FILE, NOW2, isReviewableTool)).toBeNull()
    expect(findPendingWriteForFile([editPrompt({ answered: 'allow' })], FILE, NOW2, isReviewableTool)).toBeNull()
    expect(findPendingWriteForFile([editPrompt({ tool: 'Bash' })], FILE, NOW2, isReviewableTool)).toBeNull()
    expect(findPendingWriteForFile([editPrompt()], '/other/file.ts', NOW2, isReviewableTool)).toBeNull()
    expect(findPendingWriteForFile([editPrompt()], null, NOW2, isReviewableTool)).toBeNull()
  })

  it('returns the FIRST live reviewable Write/Edit matching the file, skipping earlier non-matches', () => {
    const msgs = [
      editPrompt({ id: 'p-bash', requestId: 'r-bash', tool: 'Bash', toolInput: { command: 'ls' } }),
      editPrompt({ id: 'p-other-file', requestId: 'r-other', toolInput: { file_path: '/other/file.ts' } }),
      editPrompt({ id: 'p-match-1', requestId: 'r-match-1' }),
      editPrompt({ id: 'p-match-2', requestId: 'r-match-2' }),
    ]
    expect(findPendingWriteForFile(msgs, FILE, NOW2, isReviewableTool)?.requestId).toBe('r-match-1')
  })

  it('honors the injected isReviewableTool predicate (a client that only reviews Write, not Edit)', () => {
    const writeOnly = (tool: string) => tool === 'Write'
    expect(findPendingWriteForFile([editPrompt()], FILE, NOW2, writeOnly)).toBeNull()
    expect(
      findPendingWriteForFile(
        [editPrompt({ tool: 'Write', toolInput: { file_path: FILE, content: 'x' } })],
        FILE,
        NOW2,
        writeOnly,
      )?.tool,
    ).toBe('Write')
  })

  it('respects `now` for staleness — a prompt live at an earlier `now` is expired at a later one', () => {
    const msgs = [editPrompt({ expiresAt: NOW2 + 100 })]
    expect(findPendingWriteForFile(msgs, FILE, NOW2, isReviewableTool)?.requestId).toBe('req-1')
    expect(findPendingWriteForFile(msgs, FILE, NOW2 + 101, isReviewableTool)).toBeNull()
  })
})

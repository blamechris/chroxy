/**
 * ViewerPreWriteReview (#6544, IDE P3.3 feature A) — the editable pre-write diff
 * surfaced ON THE FILE VIEWER. Covers the pure correlation helpers, that a live
 * reviewable write for the open file renders the proposed diff, that dropping a
 * hunk routes the narrowed content through the #6543 `editedInput` seam on
 * Approve, that a plain Approve sends no edit, that Deny never carries an edit,
 * and the gates (features.ide off, no matching write, resolved, disconnected).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  ViewerPreWriteReview,
  pathMatchesViewer,
  findPendingWriteForFile,
} from './ViewerPreWriteReview'
import type { ChatMessage, PermissionDecision } from '../store/types'

// ---- store mock (only the connection store is mocked; PreWriteDiffReview and
// the store-core helpers run for real so the diff/hunk mechanics are exercised).
type MockStore = {
  serverCapabilities: { ide?: boolean }
  activeSessionId: string | null
  sessionStates: Record<string, { messages: ChatMessage[] }>
  resolvedPermissions: Record<string, PermissionDecision>
  permissionInputs: Record<string, unknown>
  requestPermissionInput: (requestId: string) => boolean
  sendPermissionResponse: (
    requestId: string,
    decision: PermissionDecision,
    editedInput?: Record<string, string> | null,
  ) => unknown
  connectionPhase: string
}

const mockRequestPermissionInput = vi.fn(() => true)
const mockSendPermissionResponse = vi.fn(() => 'sent')

let mockState: MockStore
function resetStore(overrides: Partial<MockStore> = {}) {
  mockState = {
    serverCapabilities: { ide: true },
    activeSessionId: 's1',
    sessionStates: { s1: { messages: [] } },
    resolvedPermissions: {},
    permissionInputs: {},
    requestPermissionInput: mockRequestPermissionInput,
    sendPermissionResponse: mockSendPermissionResponse,
    connectionPhase: 'connected',
    ...overrides,
  }
}

vi.mock('../store/connection', () => ({
  useConnectionStore: <T,>(selector: (s: MockStore) => T): T => selector(mockState),
}))

const FILE = '/home/dev/project/src/app.ts'

/** A live (unexpired, unanswered) Edit permission targeting FILE. */
function editPrompt(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'perm-1',
    type: 'prompt',
    content: 'Edit: change app.ts',
    tool: 'Edit',
    requestId: 'req-1',
    toolInput: { file_path: FILE, old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
    expiresAt: Date.now() + 60_000,
    timestamp: Date.now(),
    ...overrides,
  }
}

/** The pulled full input the server returns for `get_permission_input`. */
function pulledEdit() {
  return {
    'req-1': {
      type: 'permission_input',
      requestId: 'req-1',
      found: true,
      tool: 'Edit',
      input: { file_path: FILE, old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
    },
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('pathMatchesViewer', () => {
  it('matches identical absolute paths', () => {
    expect(pathMatchesViewer('/a/b/c.ts', '/a/b/c.ts')).toBe(true)
  })
  it('tail-matches an absolute file_path against a workspace-relative selection', () => {
    expect(pathMatchesViewer('/root/pkg/src/x.ts', 'src/x.ts')).toBe(true)
    expect(pathMatchesViewer('/root/pkg/src/x.ts', './src/x.ts')).toBe(true)
  })
  it('does not match unrelated files or when either side is empty', () => {
    expect(pathMatchesViewer('/a/b/x.ts', '/a/b/y.ts')).toBe(false)
    expect(pathMatchesViewer(null, '/a/b/x.ts')).toBe(false)
    expect(pathMatchesViewer('/a/b/x.ts', null)).toBe(false)
  })
})

describe('findPendingWriteForFile', () => {
  const now = Date.now()
  it('finds a live Edit/Write targeting the viewed file', () => {
    expect(findPendingWriteForFile([editPrompt()], FILE, now)?.requestId).toBe('req-1')
  })
  it('ignores expired, answered, non-reviewable, or non-matching prompts', () => {
    expect(findPendingWriteForFile([editPrompt({ expiresAt: now - 1 })], FILE, now)).toBeNull()
    expect(findPendingWriteForFile([editPrompt({ answered: 'allow' })], FILE, now)).toBeNull()
    expect(findPendingWriteForFile([editPrompt({ tool: 'Bash' })], FILE, now)).toBeNull()
    expect(findPendingWriteForFile([editPrompt()], '/other/file.ts', now)).toBeNull()
    expect(findPendingWriteForFile([editPrompt()], null, now)).toBeNull()
  })
})

describe('ViewerPreWriteReview', () => {
  it('renders the proposed diff when a live write targets the open file', () => {
    resetStore({ sessionStates: { s1: { messages: [editPrompt()] } }, permissionInputs: pulledEdit() })
    render(<ViewerPreWriteReview filePath={FILE} />)
    expect(screen.getByTestId('viewer-prewrite-review')).toBeTruthy()
    expect(screen.getByTestId('prewrite-diff-review')).toBeTruthy()
  })

  it('pulls the full tool input when it has not been fetched yet', () => {
    resetStore({ sessionStates: { s1: { messages: [editPrompt()] } }, permissionInputs: {} })
    render(<ViewerPreWriteReview filePath={FILE} />)
    expect(mockRequestPermissionInput).toHaveBeenCalledWith('req-1')
    expect(screen.getByTestId('viewer-prewrite-loading')).toBeTruthy()
  })

  it('Approve with no edits sends a plain allow (editedInput null)', () => {
    resetStore({ sessionStates: { s1: { messages: [editPrompt()] } }, permissionInputs: pulledEdit() })
    render(<ViewerPreWriteReview filePath={FILE} />)
    fireEvent.click(screen.getByTestId('viewer-prewrite-approve'))
    expect(mockSendPermissionResponse).toHaveBeenCalledWith('req-1', 'allow', null)
  })

  it('dropping a hunk routes the narrowed content through editedInput on Approve', () => {
    resetStore({ sessionStates: { s1: { messages: [editPrompt()] } }, permissionInputs: pulledEdit() })
    render(<ViewerPreWriteReview filePath={FILE} />)
    // Edit diffs old→new; dropping the only hunk reverts new_string to old_string.
    fireEvent.click(screen.getAllByTestId('hunk-toggle')[0]!)
    fireEvent.click(screen.getByTestId('viewer-prewrite-approve'))
    expect(mockSendPermissionResponse).toHaveBeenCalledWith('req-1', 'allow', { new_string: 'a\nb\nc' })
  })

  it('Deny never carries an editedInput even after dropping a hunk', () => {
    resetStore({ sessionStates: { s1: { messages: [editPrompt()] } }, permissionInputs: pulledEdit() })
    render(<ViewerPreWriteReview filePath={FILE} />)
    fireEvent.click(screen.getAllByTestId('hunk-toggle')[0]!)
    fireEvent.click(screen.getByTestId('viewer-prewrite-deny'))
    expect(mockSendPermissionResponse).toHaveBeenCalledWith('req-1', 'deny', null)
  })

  it('renders nothing when features.ide is off', () => {
    resetStore({
      serverCapabilities: { ide: false },
      sessionStates: { s1: { messages: [editPrompt()] } },
      permissionInputs: pulledEdit(),
    })
    const { container } = render(<ViewerPreWriteReview filePath={FILE} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when no live write targets the open file', () => {
    resetStore({ sessionStates: { s1: { messages: [editPrompt()] } }, permissionInputs: pulledEdit() })
    const { container } = render(<ViewerPreWriteReview filePath="/some/other/file.ts" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing once the request is resolved locally', () => {
    resetStore({
      sessionStates: { s1: { messages: [editPrompt()] } },
      permissionInputs: pulledEdit(),
      resolvedPermissions: { 'req-1': 'allow' },
    })
    const { container } = render(<ViewerPreWriteReview filePath={FILE} />)
    expect(container.firstChild).toBeNull()
  })

  it('disables the buttons and shows a hint while disconnected', () => {
    resetStore({
      sessionStates: { s1: { messages: [editPrompt()] } },
      permissionInputs: pulledEdit(),
      connectionPhase: 'reconnecting',
    })
    render(<ViewerPreWriteReview filePath={FILE} />)
    expect((screen.getByTestId('viewer-prewrite-approve') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('viewer-prewrite-disconnected')).toBeTruthy()
    fireEvent.click(screen.getByTestId('viewer-prewrite-approve'))
    expect(mockSendPermissionResponse).not.toHaveBeenCalled()
  })
})

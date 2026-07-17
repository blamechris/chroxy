/**
 * Store-level tests for the S-3c mutating orchestration senders (#6691). The
 * load-bearing contract: wire-or-nothing — nothing is put on the wire (and no
 * pending entry is written) unless the socket is OPEN; each send tags a
 * requestId and records a pending action keyed by it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'p', secretKey: 's' })),
  deriveSharedKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'salt'), deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0, DIRECTION_SERVER: 1,
}))
vi.mock('./persistence', () => ({
  loadPersistedState: vi.fn(() => null), loadSessionList: vi.fn(() => []),
  loadAllSessionMessages: vi.fn(() => ({})), persistSessionMessages: vi.fn(),
  persistViewMode: vi.fn(), persistActiveSession: vi.fn(), persistTerminalBuffer: vi.fn(),
  persistSessionList: vi.fn(), persistActiveServer: vi.fn(), loadPersistedActiveServer: vi.fn(() => null),
  clearPersistedState: vi.fn(), clearPersistedTerminalBuffer: vi.fn(), setServerScope: vi.fn(),
  clearPersistedSession: vi.fn(),
}))

import { useConnectionStore } from './connection'

function openSocket() {
  const sent: unknown[] = []
  const socket = { send: (d: string) => sent.push(JSON.parse(d)), readyState: WebSocket.OPEN, close: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as WebSocket
  return { socket, sent }
}

describe('orchestration mutating senders (#6691 S-3c)', () => {
  beforeEach(() => {
    useConnectionStore.setState({ socket: null, orchestrationPendingActions: {} })
  })

  it('returns null and sends nothing when the socket is closed', () => {
    const s = useConnectionStore.getState()
    expect(s.startOrchestrationRun({ cwd: '/repo', preset: 'repo-audit' })).toBeNull()
    expect(s.sendOrchestrationGateResponse('r', 'g', 'approve')).toBeNull()
    expect(s.sendOrchestrationRunAction('r', 'cancel')).toBeNull()
    expect(s.sendOrchestrationRunAnnotate('r', { verdictQuality: 'x' })).toBeNull()
    expect(Object.keys(useConnectionStore.getState().orchestrationPendingActions)).toHaveLength(0)
  })

  it('startOrchestrationRun needs a cwd AND (preset OR epicPrompt)', () => {
    const { socket } = openSocket()
    useConnectionStore.setState({ socket })
    const s = useConnectionStore.getState()
    expect(s.startOrchestrationRun({ cwd: '', preset: 'repo-audit' })).toBeNull()
    expect(s.startOrchestrationRun({ cwd: '/repo' })).toBeNull() // neither preset nor epic
  })

  it('a successful start puts the message on the wire and records a pending entry', () => {
    const { socket, sent } = openSocket()
    useConnectionStore.setState({ socket })
    const reqId = useConnectionStore.getState().startOrchestrationRun({ cwd: '/repo', preset: 'repo-audit', budgetUsd: 5, autoApprovePlan: true })
    expect(reqId).toMatch(/^orch-start-/)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'orchestration_run_start', cwd: '/repo', preset: 'repo-audit', budgetUsd: 5, autoApprovePlan: true, requestId: reqId })
    const pending = useConnectionStore.getState().orchestrationPendingActions[reqId!]
    expect(pending).toMatchObject({ kind: 'start' })
  })

  it('gate response / run action / annotate all tag a requestId + pending entry', () => {
    const { socket, sent } = openSocket()
    useConnectionStore.setState({ socket })
    const s = useConnectionStore.getState()
    const g = s.sendOrchestrationGateResponse('run_1', 'g1', 'approve', undefined, 12)
    const a = s.sendOrchestrationRunAction('run_1', 'pause')
    const n = s.sendOrchestrationRunAnnotate('run_1', { baselineSessionId: 'sess_x' })
    expect(sent.map((m) => (m as { type: string }).type)).toEqual([
      'orchestration_gate_response', 'orchestration_run_action', 'orchestration_run_annotate',
    ])
    expect(sent[0]).toMatchObject({ runId: 'run_1', gateId: 'g1', decision: 'approve', budgetUsd: 12 })
    expect(sent[1]).toMatchObject({ runId: 'run_1', action: 'pause' })
    expect(sent[2]).toMatchObject({ runId: 'run_1', baselineSessionId: 'sess_x' })
    const pend = useConnectionStore.getState().orchestrationPendingActions
    expect(pend[g!]).toMatchObject({ kind: 'gate_response' })
    expect(pend[a!]).toMatchObject({ kind: 'pause' })
    expect(pend[n!]).toMatchObject({ kind: 'annotate' })
  })

  it('annotate needs at least one of baseline / verdictQuality', () => {
    const { socket } = openSocket()
    useConnectionStore.setState({ socket })
    expect(useConnectionStore.getState().sendOrchestrationRunAnnotate('run_1', {})).toBeNull()
  })
})

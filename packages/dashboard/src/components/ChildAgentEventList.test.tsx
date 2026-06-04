/**
 * ChildAgentEventList tests — #5016
 *
 * Covers both the pure reducer (`__reduceEventsForTest`) and the
 * rendered output. The reducer carries the load-bearing logic
 * (per-tool row construction, stream_delta concatenation, defensive
 * synthesis on out-of-order tool_result) so most assertions live there.
 * Render tests focus on what users see: collapsed by default, expands
 * on click, surfaces input summary + result text.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ChildAgentEventList, __reduceEventsForTest } from './ChildAgentEventList'
import type { PermissionDecision } from '../store/types'

// #5061 — the component reads `resolvedPermissions` and calls
// `sendPermissionResponse` from the connection store. Mock it so the
// nested permission affordance can be tested without booting Zustand.
type MockStore = {
  resolvedPermissions: Record<string, PermissionDecision>
  sendPermissionResponse: (requestId: string, decision: PermissionDecision) => void
}
const sendPermissionResponseMock = vi.fn()
let mockStoreState: MockStore = {
  resolvedPermissions: {},
  sendPermissionResponse: sendPermissionResponseMock,
}
vi.mock('../store/connection', () => ({
  useConnectionStore: <T,>(selector: (s: MockStore) => T): T => selector(mockStoreState),
}))

afterEach(() => {
  cleanup()
  sendPermissionResponseMock.mockReset()
  mockStoreState = {
    resolvedPermissions: {},
    sendPermissionResponse: sendPermissionResponseMock,
  }
})

describe('reduceEvents (#5016)', () => {
  it('builds one row per child tool_start, in arrival order', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read', input: { file_path: '/a' } } },
      { type: 'tool_start', payload: { toolUseId: 'c2', tool: 'Bash', input: { command: 'ls' } } },
    ])
    expect(out.tools).toHaveLength(2)
    expect(out.tools[0]?.toolUseId).toBe('c1')
    expect(out.tools[0]?.toolName).toBe('Read')
    expect(out.tools[1]?.toolUseId).toBe('c2')
    expect(out.tools[1]?.toolName).toBe('Bash')
  })

  it('accumulates tool_input_delta partialJson onto the matching row', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { type: 'tool_input_delta', payload: { toolUseId: 'c1', partialJson: '{"file_path":' } },
      { type: 'tool_input_delta', payload: { toolUseId: 'c1', partialJson: '"/a"}' } },
    ])
    expect(out.tools[0]?.inputPartial).toBe('{"file_path":"/a"}')
  })

  it('marks a row resolved when tool_result arrives, captures result text', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { type: 'tool_result', payload: { toolUseId: 'c1', result: 'hello\nworld' } },
    ])
    expect(out.tools[0]?.hasResult).toBe(true)
    expect(out.tools[0]?.result).toBe('hello\nworld')
  })

  it('concatenates stream_delta chunks into assistantText', () => {
    const out = __reduceEventsForTest([
      { type: 'stream_delta', payload: { delta: 'Hello ' } },
      { type: 'stream_delta', payload: { delta: 'world.' } },
    ])
    expect(out.assistantText).toBe('Hello world.')
    expect(out.tools).toHaveLength(0)
  })

  it('inserts a blank-line boundary when stream_delta messageId changes', () => {
    // Multi-round Tasks fire stream_delta on multiple child messageIds.
    // Without a boundary, the two paragraphs would fuse mid-sentence.
    const out = __reduceEventsForTest([
      { type: 'stream_delta', payload: { messageId: 'r1', delta: 'First.' } },
      { type: 'stream_delta', payload: { messageId: 'r2', delta: 'Second.' } },
    ])
    expect(out.assistantText).toBe('First.\n\nSecond.')
  })

  it('does not insert a boundary on the very first stream_delta', () => {
    const out = __reduceEventsForTest([
      { type: 'stream_delta', payload: { messageId: 'r1', delta: 'Hi.' } },
    ])
    expect(out.assistantText).toBe('Hi.')
  })

  it('synthesises a row when tool_result arrives without a preceding tool_start', () => {
    // Defensive against a child race where the events arrive out of order.
    const out = __reduceEventsForTest([
      { type: 'tool_result', payload: { toolUseId: 'cX', result: 'oops' } },
    ])
    expect(out.tools).toHaveLength(1)
    expect(out.tools[0]?.toolUseId).toBe('cX')
    expect(out.tools[0]?.hasResult).toBe(true)
  })

  it('ignores tool_input_delta for an unknown toolUseId (pre-tool_start race)', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_input_delta', payload: { toolUseId: 'unknown', partialJson: 'x' } },
    ])
    expect(out.tools).toHaveLength(0)
  })

  it('ignores stream_delta chunks without a string delta', () => {
    const out = __reduceEventsForTest([
      { type: 'stream_delta', payload: { delta: null } },
      { type: 'stream_delta', payload: {} },
      { type: 'stream_delta', payload: { delta: 'good' } },
    ])
    expect(out.assistantText).toBe('good')
  })

  it('ignores unknown event types (forward-compat against future server emits)', () => {
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { type: 'something_new', payload: { foo: 'bar' } },
    ])
    expect(out.tools).toHaveLength(1)
    expect(out.assistantText).toBe('')
    expect(out.permissions).toHaveLength(0)
  })

  it('replays of tool_start preserve resolved state on the row', () => {
    // A defensive replay (e.g. broadcast retry) must not reset hasResult.
    const out = __reduceEventsForTest([
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
      { type: 'tool_result', payload: { toolUseId: 'c1', result: 'done' } },
      { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
    ])
    expect(out.tools).toHaveLength(1)
    expect(out.tools[0]?.hasResult).toBe(true)
    expect(out.tools[0]?.result).toBe('done')
  })

  // #5061 — child permission_request / permission_resolved relay.
  it('surfaces one permission row per child permission_request', () => {
    const out = __reduceEventsForTest([
      { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash', description: 'run ls' } },
    ])
    expect(out.permissions).toHaveLength(1)
    expect(out.permissions[0]?.requestId).toBe('p1')
    expect(out.permissions[0]?.tool).toBe('Bash')
    expect(out.permissions[0]?.description).toBe('run ls')
    expect(out.permissions[0]?.serverDecision).toBeUndefined()
  })

  it('ignores a permission_request without a string requestId', () => {
    const out = __reduceEventsForTest([
      { type: 'permission_request', payload: { tool: 'Bash' } },
    ])
    expect(out.permissions).toHaveLength(0)
  })

  it('settles a permission row when permission_resolved relays a decision', () => {
    const out = __reduceEventsForTest([
      { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
      { type: 'permission_resolved', payload: { requestId: 'p1', decision: 'deny' } },
    ])
    expect(out.permissions).toHaveLength(1)
    expect(out.permissions[0]?.serverDecision).toBe('deny')
  })

  it('synthesises a permission row when permission_resolved arrives first (out-of-order relay)', () => {
    const out = __reduceEventsForTest([
      { type: 'permission_resolved', payload: { requestId: 'pX', decision: 'allow' } },
    ])
    expect(out.permissions).toHaveLength(1)
    expect(out.permissions[0]?.requestId).toBe('pX')
    expect(out.permissions[0]?.serverDecision).toBe('allow')
  })

  it('treats a permission_resolved without a decision as denied', () => {
    const out = __reduceEventsForTest([
      { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
      { type: 'permission_resolved', payload: { requestId: 'p1' } },
    ])
    expect(out.permissions[0]?.serverDecision).toBe('denied')
  })

  it('replayed permission_request preserves a prior server resolution', () => {
    const out = __reduceEventsForTest([
      { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
      { type: 'permission_resolved', payload: { requestId: 'p1', decision: 'allow' } },
      { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
    ])
    expect(out.permissions).toHaveLength(1)
    expect(out.permissions[0]?.serverDecision).toBe('allow')
  })
})

describe('ChildAgentEventList render (#5016)', () => {
  it('renders nothing when the events array is empty', () => {
    const { container } = render(
      <ChildAgentEventList events={[]} parentToolUseId="tu-parent-1" />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows the Subagent progress header and per-tool rows', () => {
    render(
      <ChildAgentEventList
        events={[
          { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read', input: { file_path: '/a' } } },
          { type: 'tool_result', payload: { toolUseId: 'c1', result: 'hello' } },
        ]}
        parentToolUseId="tu-parent-2"
      />,
    )
    expect(screen.getByTestId('child-agent-events-header')).toHaveTextContent('Subagent progress')
    expect(screen.getByTestId('child-agent-tool-c1')).toBeInTheDocument()
    expect(screen.getByTestId('child-agent-tool-input-c1')).toHaveTextContent('/a')
  })

  it('rows start collapsed; clicking a row expands the result', () => {
    render(
      <ChildAgentEventList
        events={[
          { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
          { type: 'tool_result', payload: { toolUseId: 'c1', result: 'hello' } },
        ]}
        parentToolUseId="tu-parent-3"
      />,
    )
    expect(screen.queryByTestId('child-agent-tool-result-c1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('child-agent-tool-c1'))
    expect(screen.getByTestId('child-agent-tool-result-c1')).toHaveTextContent('hello')
  })

  it('surfaces a pulse marker on rows that have not resolved yet', () => {
    render(
      <ChildAgentEventList
        events={[
          { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
        ]}
        parentToolUseId="tu-parent-4"
      />,
    )
    expect(screen.getByTestId('child-agent-tool-pulse-c1')).toBeInTheDocument()
  })

  it('renders the child stream text block when stream_delta arrived', () => {
    render(
      <ChildAgentEventList
        events={[
          { type: 'stream_delta', payload: { delta: 'Hello ' } },
          { type: 'stream_delta', payload: { delta: 'world.' } },
        ]}
        parentToolUseId="tu-parent-5"
      />,
    )
    expect(screen.getByTestId('child-agent-stream-text-tu-parent-5'))
      .toHaveTextContent('Hello world.')
  })

  it('clicking a row does not propagate (parent ToolBubble must not collapse)', () => {
    const onContainerClick = () => {
      throw new Error('outer onClick should not fire')
    }
    render(
      <div onClick={onContainerClick} role="presentation">
        <ChildAgentEventList
          events={[
            { type: 'tool_start', payload: { toolUseId: 'c1', tool: 'Read' } },
            { type: 'tool_result', payload: { toolUseId: 'c1', result: 'hello' } },
          ]}
          parentToolUseId="tu-parent-6"
        />
      </div>,
    )
    fireEvent.click(screen.getByTestId('child-agent-tool-c1'))
    // No throw — stopPropagation is working.
  })
})

describe('ChildAgentEventList nested permission affordance (#5061)', () => {
  it('renders a permission row with Allow / Deny buttons', () => {
    render(
      <ChildAgentEventList
        events={[
          { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash', description: 'run ls' } },
        ]}
        parentToolUseId="tu-parent-perm-1"
      />,
    )
    expect(screen.getByTestId('child-agent-permission-p1')).toHaveTextContent('Bash')
    expect(screen.getByTestId('child-agent-permission-p1')).toHaveTextContent('run ls')
    expect(screen.getByTestId('child-agent-permission-allow-p1')).toBeInTheDocument()
    expect(screen.getByTestId('child-agent-permission-deny-p1')).toBeInTheDocument()
  })

  it('mounts even when there are no tool rows or stream text', () => {
    // A child whose only event is a permission_request must still render
    // (the parent ToolBubble mounts us because childAgentEvents is non-empty).
    const { container } = render(
      <ChildAgentEventList
        events={[
          { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
        ]}
        parentToolUseId="tu-parent-perm-2"
      />,
    )
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByTestId('child-agent-permission-p1')).toBeInTheDocument()
  })

  it('Allow calls sendPermissionResponse with allow', () => {
    render(
      <ChildAgentEventList
        events={[
          { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
        ]}
        parentToolUseId="tu-parent-perm-3"
      />,
    )
    fireEvent.click(screen.getByTestId('child-agent-permission-allow-p1'))
    expect(sendPermissionResponseMock).toHaveBeenCalledWith('p1', 'allow')
  })

  it('Deny calls sendPermissionResponse with deny', () => {
    render(
      <ChildAgentEventList
        events={[
          { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
        ]}
        parentToolUseId="tu-parent-perm-4"
      />,
    )
    fireEvent.click(screen.getByTestId('child-agent-permission-deny-p1'))
    expect(sendPermissionResponseMock).toHaveBeenCalledWith('p1', 'deny')
  })

  it('shows answered state (no buttons) when the store has a recorded decision', () => {
    mockStoreState.resolvedPermissions = { p1: 'allow' }
    render(
      <ChildAgentEventList
        events={[
          { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
        ]}
        parentToolUseId="tu-parent-perm-5"
      />,
    )
    expect(screen.getByTestId('child-agent-permission-answer-p1')).toHaveTextContent('Allowed')
    expect(screen.queryByTestId('child-agent-permission-allow-p1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('child-agent-permission-deny-p1')).not.toBeInTheDocument()
  })

  it('shows Denied answered state from a server permission_resolved relay', () => {
    render(
      <ChildAgentEventList
        events={[
          { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
          { type: 'permission_resolved', payload: { requestId: 'p1', decision: 'deny' } },
        ]}
        parentToolUseId="tu-parent-perm-6"
      />,
    )
    expect(screen.getByTestId('child-agent-permission-answer-p1')).toHaveTextContent('Denied')
    expect(screen.queryByTestId('child-agent-permission-allow-p1')).not.toBeInTheDocument()
  })

  it('clicking a permission button does not propagate to the parent bubble', () => {
    const onContainerClick = () => {
      throw new Error('outer onClick should not fire')
    }
    render(
      <div onClick={onContainerClick} role="presentation">
        <ChildAgentEventList
          events={[
            { type: 'permission_request', payload: { requestId: 'p1', tool: 'Bash' } },
          ]}
          parentToolUseId="tu-parent-perm-7"
        />
      </div>,
    )
    fireEvent.click(screen.getByTestId('child-agent-permission-allow-p1'))
    // No throw — stopPropagation is working.
  })
})

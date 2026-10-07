/**
 * #7353 — dismissing an expired permission must not erase the record that a
 * tool call was requested and dropped.
 *
 * Runs against the REAL dashboard store (PermissionPrompt.test.tsx mocks it with
 * a non-reactive stub), so it proves the whole chain: the Dismiss click ->
 * `dismissExpiredPermission` -> the reactive selector -> the collapsed record,
 * and that the prompt MESSAGE and the pending counters are untouched by it.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'
import { PermissionPrompt } from './PermissionPrompt'
import { useConnectionStore } from '../store/connection'
import { derivePendingPermissionCounts } from '../utils/pendingPermissions'
import { createEmptyConnectionScope } from '../store/utils'

const NOW = 1_700_000_000_000

function prompt(requestId: string, tool: string, content: string, expiresAt: number): ChatMessage {
  return { id: `m-${requestId}`, type: 'prompt', content, tool, requestId, expiresAt, timestamp: 0 } as ChatMessage
}

const EXPIRED = prompt('req-exp', 'Bash', 'Bash: Commit the restructured fix', NOW - 1_000)
const LIVE = prompt('req-live', 'Write', 'Write: /tmp/x', NOW + 60_000)

function messages(): ChatMessage[] {
  return useConnectionStore.getState().sessionStates['s1']!.messages
}

function renderExpired() {
  return render(
    <PermissionPrompt
      requestId="req-exp"
      tool="Bash"
      description="Commit the restructured fix"
      remainingMs={0}
      onRespond={() => {}}
    />,
  )
}

beforeEach(() => {
  useConnectionStore.setState({
    ...createEmptyConnectionScope(),
    connectionPhase: 'connected',
    activeSessionId: 's1',
    sessions: [],
    sessionStates: {
      s1: { messages: [EXPIRED, LIVE] },
    } as unknown as ReturnType<typeof useConnectionStore.getState>['sessionStates'],
  })
})

afterEach(cleanup)

describe('dismissing an expired permission keeps a record (#7353)', () => {
  it('collapses the card to a compact line naming the tool and description, with no controls', () => {
    renderExpired()
    expect(screen.getByTestId('perm-expired-info')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss expired permission' }))

    const record = screen.getByTestId('perm-dropped-record')
    expect(record).toHaveTextContent('Permission expired')
    expect(record).toHaveTextContent('Bash')
    expect(record).toHaveTextContent('Commit the restructured fix')
    expect(record).toHaveTextContent('dropped')
    // The actionable card is gone: nothing clickable is left on the page.
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByTestId('permission-prompt')).not.toBeInTheDocument()
    expect(screen.queryByTestId('perm-expired-info')).not.toBeInTheDocument()
  })

  it('leaves the prompt message in the session transcript', () => {
    const before = messages()
    renderExpired()
    fireEvent.click(screen.getByText('Dismiss'))

    expect(messages()).toBe(before)
    expect(messages().find((m) => m.requestId === 'req-exp')).toBeDefined()
    expect(useConnectionStore.getState().dismissedExpiredPermissions).toEqual({ 'req-exp': true })
  })

  it('does not change the pending-permission counters (the expired prompt was already not pending)', () => {
    const counts = () => derivePendingPermissionCounts(useConnectionStore.getState().sessionStates, NOW)
    expect(counts()).toEqual({ s1: 1 })
    renderExpired()
    fireEvent.click(screen.getByText('Dismiss'))
    // Still exactly the one LIVE prompt; dismissing neither added nor removed pending state.
    expect(counts()).toEqual({ s1: 1 })
  })

  it('stays collapsed when the prompt remounts (tab switch)', () => {
    const first = renderExpired()
    fireEvent.click(screen.getByText('Dismiss'))
    first.unmount()

    renderExpired()
    expect(screen.getByTestId('perm-dropped-record')).toBeInTheDocument()
    expect(screen.queryByText('Dismiss')).not.toBeInTheDocument()
  })

  it('only collapses the dismissed prompt, not a sibling expired prompt', () => {
    render(
      <>
        <PermissionPrompt requestId="req-exp" tool="Bash" description="one" remainingMs={0} onRespond={() => {}} />
        <PermissionPrompt requestId="req-other" tool="Write" description="two" remainingMs={0} onRespond={() => {}} />
      </>,
    )
    fireEvent.click(screen.getAllByText('Dismiss')[0]!)
    expect(screen.getAllByTestId('perm-dropped-record')).toHaveLength(1)
    expect(screen.getAllByTestId('perm-expired-info')).toHaveLength(1)
  })

  it('is dropped with the connection scope (requestIds belong to the old connection)', () => {
    useConnectionStore.getState().dismissExpiredPermission('req-exp')
    expect(useConnectionStore.getState().dismissedExpiredPermissions).toEqual({ 'req-exp': true })
    useConnectionStore.setState({ ...createEmptyConnectionScope() })
    expect(useConnectionStore.getState().dismissedExpiredPermissions).toEqual({})
  })
})

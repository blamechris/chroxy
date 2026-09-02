/**
 * EnvironmentPanel — the Destroy affordance: live-session escalation (#7568,
 * building on the #7552 count + the #7562 server refusal).
 *
 * #7552 first wired `{env.sessions.length} connected` and flatly DISABLED the
 * Destroy button while sessions were live ("Disconnect all sessions first").
 * That was a dead end: the operator could see there were sessions but had no
 * way to act, and the server refuses the send regardless (#7562). #7568
 * replaces the flat disable with an escalation — Destroy is always clickable,
 * and the live-session branch NAMES the attached sessions and offers a "Force
 * destroy" that cascades (`destroyEnvironment(id, true)`).
 *
 * This file pins the UI half against the SERVER-SHAPED payload (so the count
 * cannot be neutered to a hardcode), and — critically — that ONLY the force
 * path sends `force: true`; the empty-env plain path sends none. The server
 * half is pinned in packages/server/tests/environment-destroy-live-sessions.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { EnvironmentPanel } from './EnvironmentPanel'

const requestEnvironments = vi.fn()
const destroyEnvironment = vi.fn()
const createEnvironment = vi.fn()

let environments: any[] = []

// The production component reads `environments` via `useShallow`. Stub the hook
// to the identity function (the same move ActivityIndicator's tests make, #4336)
// so the mocked store below stays a plain selector call — and so the component
// does not pull a SECOND React instance in through zustand's own resolution.
vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: unknown) => fn,
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: any) =>
    selector({
      environments,
      requestEnvironments,
      destroyEnvironment,
      createEnvironment,
      connectionPhase: 'connected',
      sessionCwd: '/tmp',
    }),
}))

/**
 * One element of the `environment_list` payload, in the shape the SERVER sends
 * (`EnvironmentManager.list()` round-tripped through the wire schema in
 * packages/protocol/src/schemas/server/environment.ts), not a shape invented
 * here — the point of the fix is that `sessions` now carries real ids.
 */
function serverEnv(sessions: string[]) {
  return {
    id: 'env-1',
    name: 'my-project',
    cwd: '/home/user/project',
    image: 'node:22-slim',
    containerId: 'abcdef0123456789',
    containerUser: 'chroxy',
    containerCliPath: '/usr/local',
    status: 'running',
    sessions,
    createdAt: '2026-08-30T00:00:00.000Z',
    memoryLimit: '2g',
    cpuLimit: '2',
    compose: null,
    composeProject: null,
  }
}

afterEach(() => cleanup())
beforeEach(() => {
  vi.clearAllMocks()
  environments = []
})

describe('EnvironmentPanel Destroy escalation (#7568)', () => {
  it('a LIVE-session environment offers a force-destroy naming the sessions', () => {
    const sessId = '4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a88'
    environments = [serverEnv([sessId])]
    render(<EnvironmentPanel />)

    const destroy = screen.getByRole('button', { name: 'Destroy' })
    // #7568: no longer flatly disabled — the operator can escalate.
    expect(destroy).toBeEnabled()
    expect(screen.getByText('1 connected')).toBeInTheDocument()

    // Clicking opens the live-session confirm — NOT the plain one — and names
    // the session so the operator knows what force would tear down.
    fireEvent.click(destroy)
    expect(screen.queryByText('Destroy this environment?')).not.toBeInTheDocument()
    expect(screen.getByTestId('env-force-confirm-env-1')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(sessId))).toBeInTheDocument()
    // Nothing sent until the operator confirms the cascade.
    expect(destroyEnvironment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Force destroy' }))
    expect(destroyEnvironment).toHaveBeenCalledWith('env-1', true)
  })

  it('cancelling the force confirm sends nothing', () => {
    environments = [serverEnv(['sess-a'])]
    render(<EnvironmentPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(destroyEnvironment).not.toHaveBeenCalled()
    expect(screen.queryByTestId('env-force-confirm-env-1')).not.toBeInTheDocument()
  })

  it('the count is the real length, not a boolean or a hardcode', () => {
    environments = [serverEnv(['sess-a', 'sess-b', 'sess-c'])]
    render(<EnvironmentPanel />)
    expect(screen.getByText('3 connected')).toBeInTheDocument()
  })

  it('an EMPTY environment destroys WITHOUT force — the negative control', () => {
    // The critical assertion: the plain path must NOT pass force:true. Without
    // this, a build that sent force unconditionally would still pass the
    // live-session test above (the "check that denies everything" inverse —
    // here, a force that escalates everything).
    environments = [serverEnv([])]
    render(<EnvironmentPanel />)

    const destroy = screen.getByRole('button', { name: 'Destroy' })
    expect(destroy).toBeEnabled()
    expect(destroy).toHaveAttribute('title', 'Destroy environment')
    expect(screen.getByText('0 connected')).toBeInTheDocument()

    fireEvent.click(destroy)
    // The plain confirm, not the force one.
    expect(screen.getByText('Destroy this environment?')).toBeInTheDocument()
    expect(screen.queryByTestId('env-force-confirm-env-1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(destroyEnvironment).toHaveBeenCalledWith('env-1')
    // Not force:true — the mock recorded exactly one arg.
    expect(destroyEnvironment).toHaveBeenCalledTimes(1)
    expect(destroyEnvironment.mock.calls[0]).toEqual(['env-1'])
  })
})

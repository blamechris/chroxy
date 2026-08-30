/**
 * EnvironmentPanel — the Destroy guard (#7552).
 *
 * `EnvironmentPanel` renders `{env.sessions.length} connected` and gates its
 * Destroy button on `disabled={env.sessions.length > 0}` with the tooltip
 * "Disconnect all sessions first". Before #7552 nothing on the server ever put
 * a session id into `EnvironmentInfo.sessions`, so that gate could never engage:
 * an environment was ALWAYS destroyable, including out from under the live
 * sessions running inside it — docs/false-safety-guards.md's class ("a
 * precondition that is false, so the body never runs") rendered as UI.
 *
 * The server half is fixed and pinned in
 * packages/server/tests/environment-session-wiring.test.js. This file pins the
 * UI half against the SERVER-SHAPED payload, so the guard cannot be quietly
 * neutered from the dashboard side either — e.g. by dropping the `disabled`
 * prop, or by rendering a hardcoded count.
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

describe('EnvironmentPanel Destroy guard (#7552)', () => {
  it('an environment with a LIVE session cannot be destroyed', () => {
    environments = [serverEnv(['4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a88'])]
    render(<EnvironmentPanel />)

    const destroy = screen.getByRole('button', { name: 'Destroy' })
    expect(destroy).toBeDisabled()
    expect(destroy).toHaveAttribute('title', 'Disconnect all sessions first')
    expect(screen.getByText('1 connected')).toBeInTheDocument()

    // The gate is real, not just an attribute: clicking must not open the
    // confirm row that leads to `destroyEnvironment`.
    fireEvent.click(destroy)
    expect(screen.queryByText('Destroy this environment?')).not.toBeInTheDocument()
    expect(destroyEnvironment).not.toHaveBeenCalled()
  })

  it('the count is the real length, not a boolean or a hardcode', () => {
    environments = [serverEnv(['sess-a', 'sess-b', 'sess-c'])]
    render(<EnvironmentPanel />)
    expect(screen.getByText('3 connected')).toBeInTheDocument()
  })

  it('an EMPTY environment is destroyable — the negative control', () => {
    // Without this, every assertion above would still pass on a build that
    // disabled Destroy unconditionally, which is a different bug wearing the
    // same green ("a check that denies everything").
    environments = [serverEnv([])]
    render(<EnvironmentPanel />)

    const destroy = screen.getByRole('button', { name: 'Destroy' })
    expect(destroy).toBeEnabled()
    expect(destroy).toHaveAttribute('title', 'Destroy environment')
    expect(screen.getByText('0 connected')).toBeInTheDocument()

    fireEvent.click(destroy)
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(destroyEnvironment).toHaveBeenCalledWith('env-1')
  })
})

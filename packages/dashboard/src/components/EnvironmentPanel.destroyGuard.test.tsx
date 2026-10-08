/**
 * EnvironmentPanel — the Destroy affordance: live-session escalation (#7568,
 * building on the #7552 count + the #7562 server refusal).
 *
 * #7594: the escalation follows the daemon's REFUSAL, not the card's local
 * `env.sessions` (which only moves on an `environment_list` broadcast, and a
 * refusal sends none). The first Destroy attempt is always the plain, refusable
 * one; Force appears only once the store has recorded a refusal for the card.
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
const dismissEnvironmentDestroyRefusal = vi.fn()

let environments: any[] = []
// #7594: the live-session refusals the daemon answered, keyed by environment id.
let environmentDestroyRefusals: Record<string, string[]> = {}
// #8407: environment ids with an unanswered destroy_environment.
let environmentDestroyingIds: Set<string> = new Set()

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
      environmentDestroyRefusals,
      environmentDestroyingIds,
      dismissEnvironmentDestroyRefusal,
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
  environmentDestroyRefusals = {}
  environmentDestroyingIds = new Set()
})

describe('EnvironmentPanel Destroy escalation (#7568, #7594)', () => {
  it('a refusal REVEALS Force even though the local env.sessions is empty (the live-session race)', () => {
    // A session attached after the last environment_list, so this card's roster
    // says 0. The daemon's refusal is the authority: it names the live session.
    const sessId = '4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a88'
    environments = [serverEnv([])]
    environmentDestroyRefusals = { 'env-1': [sessId] }
    render(<EnvironmentPanel />)

    expect(screen.getByText('0 connected')).toBeInTheDocument()
    expect(screen.getByTestId('env-force-confirm-env-1')).toBeInTheDocument()
    // Names the sessions from the refusal payload, not from env.sessions.
    expect(screen.getByText(new RegExp(sessId))).toBeInTheDocument()
    // Nothing sent until the operator confirms the cascade.
    expect(destroyEnvironment).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Force destroy' }))
    expect(destroyEnvironment).toHaveBeenCalledWith('env-1', true)
  })

  it('stale env.sessions does NOT route Destroy to a force — the first attempt is the plain destroy', () => {
    // The card still lists a session that has since exited. No refusal has come
    // back, so there is nothing to escalate: Destroy -> plain confirm -> plain
    // (refusable) destroy, exactly as for an empty environment.
    environments = [serverEnv(['sess-gone'])]
    render(<EnvironmentPanel />)

    const destroy = screen.getByRole('button', { name: 'Destroy' })
    expect(destroy).toHaveAttribute('title', 'Destroy environment')
    fireEvent.click(destroy)
    expect(screen.getByText('Destroy this environment?')).toBeInTheDocument()
    expect(screen.queryByTestId('env-force-confirm-env-1')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force destroy' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(destroyEnvironment).toHaveBeenCalledTimes(1)
    expect(destroyEnvironment.mock.calls[0]).toEqual(['env-1'])
  })

  it('a refusal for ANOTHER environment does not reveal Force on this card', () => {
    environments = [serverEnv([])]
    environmentDestroyRefusals = { 'env-other': ['sess-a'] }
    render(<EnvironmentPanel />)
    expect(screen.queryByTestId('env-force-confirm-env-1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Destroy' })).toBeInTheDocument()
  })

  it('cancelling the force confirm sends nothing and forgets the refusal', () => {
    environments = [serverEnv([])]
    environmentDestroyRefusals = { 'env-1': ['sess-a'] }
    render(<EnvironmentPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(destroyEnvironment).not.toHaveBeenCalled()
    expect(dismissEnvironmentDestroyRefusal).toHaveBeenCalledWith('env-1')
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

describe('EnvironmentPanel destroy in flight (#8407)', () => {
  it('a Force in flight shows a pending state, not a clickable plain Destroy', () => {
    // destroyEnvironment(id, true) clears the refusal and marks the id pending.
    environments = [serverEnv(['sess-a'])]
    environmentDestroyingIds = new Set(['env-1'])
    render(<EnvironmentPanel />)

    expect(screen.getByTestId('env-destroying-env-1')).toHaveTextContent('Destroying')
    // Nothing on the card can send a second (plain) destroy meanwhile.
    expect(screen.queryByRole('button', { name: 'Destroy' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Force destroy' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('env-force-confirm-env-1')).not.toBeInTheDocument()
  })

  it('the pending state is per environment', () => {
    environments = [serverEnv([])]
    environmentDestroyingIds = new Set(['env-other'])
    render(<EnvironmentPanel />)
    expect(screen.queryByTestId('env-destroying-env-1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Destroy' })).toBeInTheDocument()
  })

  it('a new refusal wins once the pending state has cleared', () => {
    environments = [serverEnv([])]
    environmentDestroyRefusals = { 'env-1': ['sess-a'] }
    render(<EnvironmentPanel />)
    expect(screen.queryByTestId('env-destroying-env-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('env-force-confirm-env-1')).toBeInTheDocument()
  })

  it('an inherited member name is not a refusal (id "constructor")', () => {
    environments = [{ ...serverEnv([]), id: 'constructor' }]
    render(<EnvironmentPanel />)
    expect(screen.queryByTestId('env-force-confirm-constructor')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Destroy' })).toBeInTheDocument()
  })
})

describe('EnvironmentPanel plain confirm resets once answered (#8407)', () => {
  it('after Yes the confirm row is closed, so a non-refusal answer lands on a plain Destroy', () => {
    environments = [serverEnv([])]
    const { rerender } = render(<EnvironmentPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(destroyEnvironment).toHaveBeenCalledWith('env-1')
    // The store's mock does not move on its own; rerender is the next frame.
    rerender(<EnvironmentPanel />)
    // Not left on the "Destroy this environment?" prompt for a request already sent.
    expect(screen.queryByText('Destroy this environment?')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Destroy' })).toBeInTheDocument()
  })
})

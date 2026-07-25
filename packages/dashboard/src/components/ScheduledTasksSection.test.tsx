/**
 * ScheduledTasksSection (#6871) — the Scheduled tasks tab.
 *
 * The assertions here are mostly about HONESTY rather than layout, because this
 * panel controls unattended agent execution:
 *   - every engine-emittable last-run status renders as its own distinct tag
 *   - a never-run / paused / refused / timed-out / skipped / quarantined task can
 *     NEVER render as healthy (no `data-accent="ok"`)
 *   - the scheduler-disabled banner is prominent whenever the gate is closed, and
 *     `restartRequired` is called out in BOTH directions
 *   - a task whose provider the engine refuses is flagged, and the create form
 *     warns BEFORE saving (including the blank → daemon-default case)
 *   - malformed / partial payloads degrade instead of crashing the panel
 *
 * The store is mocked (codebase convention) so the test drives plain state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { SCHEDULED_TASK_HEALTH_TAGS } from '@chroxy/protocol'

const requestTasksMock = vi.fn(() => true)
const selectTaskMock = vi.fn()
const sendActionMock = vi.fn(() => 'sched-action-1')
const setGateMock = vi.fn(() => 'sched-gate-1')
let storeState: Record<string, unknown> = {}

function resetStore(over: Record<string, unknown> = {}) {
  requestTasksMock.mockClear(); selectTaskMock.mockClear(); sendActionMock.mockClear(); setGateMock.mockClear()
  storeState = {
    connectionPhase: 'connected',
    scheduledTasks: null,
    scheduledTasksLoading: false,
    scheduledTaskPendingActions: {},
    scheduledTaskActionResults: {},
    selectedScheduledTaskId: null,
    requestScheduledTasks: requestTasksMock,
    selectScheduledTask: selectTaskMock,
    sendScheduledTaskAction: sendActionMock,
    setSchedulerEnabled: setGateMock,
    ...over,
  }
}

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    typeof selector === 'function' ? selector(storeState) : storeState,
}))

// Imported after the mock so the component picks it up.
const { ScheduledTasksSection } = await import('./ScheduledTasksSection')

const GATE_ON = { enabled: true, engineArmed: true, restartRequired: false, source: 'config' as const }
const GATE_OFF = { enabled: false, engineArmed: false, restartRequired: false, source: 'default' as const }

function mkTask(over: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    name: 'nightly sweep',
    enabled: true,
    prompt: 'run the nightly sweep',
    target: {},
    cadence: { kind: 'cron', expression: '0 9 * * *' },
    nextRun: 1900000000000,
    lastRun: { at: 1800000000000, status: 'success' },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    providerRefusal: null,
    effectiveProvider: 'claude-sdk',
    effectivePermissionMode: 'approve',
    permissionModeClamped: false,
    quarantined: false,
    ...over,
  }
}

function mkSnapshot(over: Record<string, unknown> = {}) {
  return {
    type: 'scheduled_tasks',
    requestId: null,
    generatedAt: new Date(1900000000000).toISOString(),
    scheduler: GATE_ON,
    schedulableProviders: ['claude-sdk', 'deepseek'],
    defaultProvider: 'claude-sdk',
    defaultProviderRefusal: null,
    tasks: [mkTask()],
    ...over,
  }
}

beforeEach(() => resetStore())
afterEach(() => cleanup())

describe('ScheduledTasksSection — the enable gate is always surfaced', () => {
  it('says DISABLED prominently when the gate is closed, and warns tasks will not fire', () => {
    resetStore({ scheduledTasks: mkSnapshot({ scheduler: GATE_OFF }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-headline').textContent).toContain('DISABLED')
    expect(screen.getByTestId('sched-gate-banner').getAttribute('data-accent')).toBe('bad')
    expect(screen.getByTestId('sched-gate-detail').textContent).toMatch(/will NOT fire/)
    // The exact remediation, so an operator does not have to hunt for it.
    expect(screen.getByTestId('sched-gate-detail').textContent).toMatch(/features\.scheduler/)
    expect(screen.getByTestId('sched-gate-detail').textContent).toMatch(/restart the daemon/)
  })

  it('says ENABLED when the gate is open and the engine agrees', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-headline').textContent).toContain('ENABLED')
    expect(screen.getByTestId('sched-gate-banner').getAttribute('data-accent')).toBe('ok')
    expect(screen.queryByTestId('sched-gate-restart')).toBeNull()
  })

  it('renders the banner even before any snapshot lands, defaulting to DISABLED', () => {
    // Absence must read as OFF (the safe direction), never as enabled.
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-headline').textContent).toContain('DISABLED')
  })

  it('calls out restartRequired when the gate is ON but nothing is armed', () => {
    resetStore({
      scheduledTasks: mkSnapshot({
        scheduler: { enabled: true, engineArmed: false, restartRequired: true, source: 'config' },
      }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    const restart = screen.getByTestId('sched-gate-restart')
    expect(restart.textContent).toMatch(/Restart required/)
    expect(restart.textContent).toMatch(/nothing will fire/)
  })

  it('calls out the DANGEROUS direction: gate off but the engine is still firing', () => {
    resetStore({
      scheduledTasks: mkSnapshot({
        scheduler: { enabled: false, engineArmed: true, restartRequired: true, source: 'config' },
      }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-restart').textContent).toMatch(/still armed and WILL keep firing/)
  })

  it('explains an env-forced gate and disables the toggle (config cannot override it)', () => {
    resetStore({
      scheduledTasks: mkSnapshot({
        scheduler: { enabled: true, engineArmed: true, restartRequired: false, source: 'env' },
      }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-env').textContent).toMatch(/CHROXY_ENABLE_SCHEDULER/)
    expect((screen.getByTestId('sched-gate-toggle') as HTMLButtonElement).disabled).toBe(true)
  })

  it('the toggle sends the gate mutation', () => {
    resetStore({ scheduledTasks: mkSnapshot({ scheduler: GATE_OFF }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-gate-toggle'))
    expect(setGateMock).toHaveBeenCalledWith(true)
  })

  it('surfaces a rejected gate mutation inline', () => {
    resetStore({
      scheduledTasks: mkSnapshot({ scheduler: GATE_OFF }),
      scheduledTaskActionResults: {
        'sched-gate-1': { ok: false, error: 'Pairing-issued tokens cannot…', at: 1 },
      },
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-gate-toggle'))
    expect(screen.getByTestId('sched-gate-error').textContent).toMatch(/Pairing-issued tokens/)
  })
})

describe('ScheduledTasksSection — honest per-task status', () => {
  const CASES: Array<[string, Record<string, unknown>, string, string]> = [
    // [ label, task overrides, expected tag, expected accent ]
    ['success', { lastRun: { at: 1, status: 'success' } }, 'OK', 'ok'],
    ['error', { lastRun: { at: 1, status: 'error' } }, 'ERROR', 'bad'],
    ['refused', { lastRun: { at: 1, status: 'refused' } }, 'REFUSED', 'bad'],
    ['timeout', { lastRun: { at: 1, status: 'timeout' } }, 'TIMEOUT', 'bad'],
    ['skipped', { lastRun: { at: 1, status: 'skipped' } }, 'SKIPPED', 'warn'],
    ['never run', { lastRun: null }, 'NEVER RUN', 'warn'],
    ['paused', { enabled: false }, 'PAUSED', 'warn'],
  ]

  it('renders every engine-emittable status as its own distinct tag', () => {
    const seen = new Set<string>()
    for (const [label, over, tag, accent] of CASES) {
      resetStore({ scheduledTasks: mkSnapshot({ tasks: [mkTask(over)] }) })
      const { unmount } = render(<ScheduledTasksSection now={() => 1900000000000} />)
      const chip = screen.getByTestId('sched-health-task-1')
      expect(chip.textContent, label).toContain(tag)
      expect(chip.getAttribute('data-accent'), label).toBe(accent)
      expect(SCHEDULED_TASK_HEALTH_TAGS).toContain(tag)
      seen.add(tag)
      unmount()
    }
    // Distinctness: 7 cases produced 7 different tags.
    expect(seen.size).toBe(CASES.length)
  })

  it('NEVER styles a not-healthy task as healthy', () => {
    for (const [label, over, tag] of CASES) {
      if (tag === 'OK') continue
      resetStore({ scheduledTasks: mkSnapshot({ tasks: [mkTask(over)] }) })
      const { unmount } = render(<ScheduledTasksSection now={() => 1900000000000} />)
      expect(screen.getByTestId('sched-health-task-1').getAttribute('data-accent'), label).not.toBe('ok')
      unmount()
    }
  })

  it('a QUARANTINED task never reads as healthy even with a success lastRun', () => {
    resetStore({
      scheduledTasks: mkSnapshot({
        tasks: [mkTask({ quarantined: true, lastRun: { at: 1, status: 'success' } })],
      }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    const chip = screen.getByTestId('sched-health-task-1')
    expect(chip.getAttribute('data-accent')).toBe('bad')
    expect(chip.textContent).toContain('QUARANTINED')
  })

  it('surfaces the quarantine explanation the engine persisted', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({
        tasks: [mkTask({
          quarantined: true,
          lastRun: { at: 1, status: 'refused', error: 'quarantined until daemon restart: disk full' },
        })],
      }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    const note = screen.getByTestId('sched-detail-quarantined')
    expect(note.textContent).toMatch(/will not fire again until the daemon\s+restarts/)
    expect(note.textContent).toMatch(/disk full/)
  })

  it('a paused task shows no next-run time (it is not scheduled to fire)', () => {
    resetStore({ scheduledTasks: mkSnapshot({ tasks: [mkTask({ enabled: false })] }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toMatch(/paused/)
  })

  it('shows the next-run time for an enabled task', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).not.toMatch(/paused/)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toMatch(/next:/)
  })
})

describe('ScheduledTasksSection — engine refusals are surfaced', () => {
  it('flags a task the engine will refuse, verbatim, in the row and the detail', () => {
    const refusal = "provider 'claude-tui' routes permission prompts through the permission hook…"
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({ tasks: [mkTask({ providerRefusal: refusal, effectiveProvider: 'claude-tui' })] }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-refusal-task-1').textContent).toMatch(/will not fire/)
    expect(screen.getByTestId('sched-detail-refusal').textContent).toContain(refusal)
  })

  it('reports the CLAMPED permission mode and that it was clamped down', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({
        tasks: [mkTask({
          target: { permissionMode: 'auto' },
          effectivePermissionMode: 'approve',
          permissionModeClamped: true,
        })],
      }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    const cell = screen.getByTestId('sched-detail-permission')
    expect(cell.textContent).toMatch(/approve/)
    expect(cell.textContent).toMatch(/clamped down from "auto"/)
  })

  it('does not claim a clamp when the mode was honoured', () => {
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-detail-permission').textContent).not.toMatch(/clamped/)
  })

  it('warns at CREATE time when the blank provider resolves to a refused default', () => {
    const refusal = "provider 'claude-tui' routes permission prompts through the permission hook. It is also the daemon DEFAULT…"
    resetStore({ scheduledTasks: mkSnapshot({ defaultProvider: 'claude-tui', defaultProviderRefusal: refusal }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    // No provider typed → the daemon default applies → the server's reason shows.
    expect(screen.getByTestId('sched-form-provider-warning').textContent).toContain(refusal)
  })

  it('warns at CREATE time when a typed provider is not in the schedulable set', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    fireEvent.change(screen.getByTestId('sched-form-provider'), { target: { value: 'gemini' } })
    const warn = screen.getByTestId('sched-form-provider-warning')
    expect(warn.textContent).toMatch(/refuses provider 'gemini'/)
    expect(warn.textContent).toMatch(/claude-sdk, deepseek/)
  })

  it('does NOT warn for a provider the engine accepts', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    fireEvent.change(screen.getByTestId('sched-form-provider'), { target: { value: 'deepseek' } })
    expect(screen.queryByTestId('sched-form-provider-warning')).toBeNull()
  })

  it('always states the unattended permission posture on the create form', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    expect(screen.getByTestId('sched-form-permission-note').textContent).toMatch(/never auto-approve/)
  })
})

describe('ScheduledTasksSection — CRUD reachability', () => {
  it('create sends a create action with the composed cadence', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    fireEvent.change(screen.getByTestId('sched-form-prompt'), { target: { value: 'do the thing' } })
    fireEvent.change(screen.getByTestId('sched-form-cron'), { target: { value: '30 2 * * *' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(sendActionMock).toHaveBeenCalledWith('create', {
      task: expect.objectContaining({
        prompt: 'do the thing',
        cadence: { kind: 'cron', expression: '30 2 * * *' },
      }),
    })
  })

  it('an interval cadence is converted to everyMs', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    fireEvent.change(screen.getByTestId('sched-form-prompt'), { target: { value: 'p' } })
    fireEvent.change(screen.getByTestId('sched-form-cadence-kind'), { target: { value: 'interval' } })
    fireEvent.change(screen.getByTestId('sched-form-interval'), { target: { value: '15' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(sendActionMock).toHaveBeenCalledWith('create', {
      task: expect.objectContaining({ cadence: { kind: 'interval', everyMs: 900000 } }),
    })
  })

  it('submit stays disabled without a prompt', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    expect((screen.getByTestId('sched-form-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('pause / resume are reachable from the detail panel', () => {
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-toggle-enabled').textContent).toBe('Pause')
    fireEvent.click(screen.getByTestId('sched-toggle-enabled'))
    expect(sendActionMock).toHaveBeenCalledWith('pause', { taskId: 'task-1' })
  })

  it('a paused task offers Resume', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({ tasks: [mkTask({ enabled: false })] }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-toggle-enabled'))
    expect(sendActionMock).toHaveBeenCalledWith('resume', { taskId: 'task-1' })
  })

  it('delete requires confirmation before it sends', () => {
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-delete'))
    expect(sendActionMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('sched-delete-confirm'))
    expect(sendActionMock).toHaveBeenCalledWith('delete', { taskId: 'task-1' })
  })

  it('edit opens the form seeded from the task and sends an update', () => {
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-edit'))
    expect((screen.getByTestId('sched-form-prompt') as HTMLTextAreaElement).value).toBe('run the nightly sweep')
    expect((screen.getByTestId('sched-form-cron') as HTMLInputElement).value).toBe('0 9 * * *')
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(sendActionMock).toHaveBeenCalledWith('update', expect.objectContaining({ taskId: 'task-1' }))
  })

  it('a failed mutation is reported inline rather than silently dropped', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot(),
      scheduledTaskActionResults: { 'sched-action-1': { ok: false, error: 'cadence.expression: invalid cron', at: 1 } },
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-toggle-enabled'))
    expect(screen.getByTestId('sched-detail-action-error').textContent).toMatch(/invalid cron/)
  })

  it('buttons disable while a mutation is in flight', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot(),
      scheduledTaskPendingActions: { 'sched-action-1': { kind: 'pause', taskId: 'task-1', at: 1 } },
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-toggle-enabled'))
    expect((screen.getByTestId('sched-delete') as HTMLButtonElement).disabled).toBe(true)
  })

  it('mutating controls are disabled while disconnected', () => {
    resetStore({
      connectionPhase: 'reconnecting',
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot(),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect((screen.getByTestId('sched-new') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('sched-delete') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('sched-gate-toggle') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ScheduledTasksSection — list / empty / error states', () => {
  it('distinguishes not-loaded from loading from genuinely empty', () => {
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-empty').textContent).toMatch(/Not loaded yet/)
    cleanup()

    resetStore({ scheduledTasksLoading: true })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-empty').textContent).toMatch(/Loading/)
    cleanup()

    resetStore({ scheduledTasks: mkSnapshot({ tasks: [] }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-empty').textContent).toMatch(/No scheduled tasks/)
  })

  it('renders a degraded snapshot error', () => {
    resetStore({
      scheduledTasks: mkSnapshot({ tasks: [], error: { code: 'SCHEDULER_REGISTRY_UNAVAILABLE', message: 'no registry' } }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-error').textContent).toMatch(/SCHEDULER_REGISTRY_UNAVAILABLE: no registry/)
  })

  it('refresh re-requests the snapshot', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-refresh'))
    expect(requestTasksMock).toHaveBeenCalled()
  })

  it('selecting a row calls selectScheduledTask', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-row-task-1'))
    expect(selectTaskMock).toHaveBeenCalledWith('task-1')
  })

  it('clears a selection whose task no longer exists', () => {
    resetStore({ selectedScheduledTaskId: 'gone', scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(selectTaskMock).toHaveBeenCalledWith(null)
  })
})

describe('ScheduledTasksSection — malformed payloads degrade, never crash', () => {
  it('survives a task with a missing/garbage cadence', () => {
    for (const cadence of [undefined, null, {}, { kind: 'bogus' }, 'nope', []]) {
      resetStore({ scheduledTasks: mkSnapshot({ tasks: [mkTask({ cadence })] }) })
      const { unmount } = render(<ScheduledTasksSection now={() => 1900000000000} />)
      expect(screen.getByTestId('sched-row-task-1')).toBeTruthy()
      unmount()
    }
  })

  it('survives non-finite / missing timestamps', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({
        tasks: [mkTask({ nextRun: null, lastRun: { at: Number.NaN, status: 'error' } })],
      }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-detail-next').textContent).toContain('—')
    expect(screen.getByTestId('sched-health-task-1').textContent).toContain('ERROR')
  })

  it('survives a snapshot with no scheduler block (defaults to DISABLED)', () => {
    resetStore({ scheduledTasks: mkSnapshot({ scheduler: undefined }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-headline').textContent).toContain('DISABLED')
  })

  it('survives a snapshot with a non-array tasks field', () => {
    resetStore({ scheduledTasks: mkSnapshot({ tasks: undefined }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-empty')).toBeTruthy()
  })

  it('survives an unnamed task and a missing target', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({ tasks: [mkTask({ name: null, target: undefined })] }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    // Falls back to a short id rather than rendering "null".
    expect(screen.getByTestId('sched-row-name-task-1').textContent).toBe('task-1')
  })

  it('an unrecognized future lastRun status renders as ERROR, not as healthy', () => {
    resetStore({ scheduledTasks: mkSnapshot({ tasks: [mkTask({ lastRun: { at: 1, status: 'some_new_status' } })] }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    const chip = screen.getByTestId('sched-health-task-1')
    expect(chip.textContent).toContain('ERROR')
    expect(chip.getAttribute('data-accent')).toBe('bad')
  })
})

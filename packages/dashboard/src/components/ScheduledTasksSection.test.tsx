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
    scheduledTasksError: null,
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

  // #6871 review round 2 (finding 3). This test previously asserted the banner
  // read "DISABLED" before any snapshot landed, with the rationale "absence must
  // read as OFF (the safe direction)". It was pinning the wrong behaviour: that
  // rationale is only sound for `enabled`, and the banner's DISABLED copy also
  // asserts "will NOT fire" plus "Enable via features.scheduler" — a positive
  // factual claim about a daemon we have not read, and precisely the copy the C2
  // fix removed for being false while an armed engine kept firing.
  it('reads UNKNOWN before any snapshot lands, and claims NOTHING about firing', () => {
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    const headline = screen.getByTestId('sched-gate-headline').textContent!
    const detail = screen.getByTestId('sched-gate-detail').textContent!
    expect(headline).toContain('UNKNOWN')
    expect(headline).not.toContain('DISABLED')
    expect(headline).not.toContain('ENABLED')
    // The two phrases that would be unfounded assertions on zero data.
    expect(detail).not.toMatch(/will NOT fire/)
    expect(detail).not.toMatch(/Enable via features\.scheduler/)
    expect(detail).toMatch(/unknown/i)
  })

  it('offers no gate toggle while the state is UNKNOWN', () => {
    // Both "Enable" and "Disable" describe a flip FROM a state we have not read.
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    const toggle = screen.getByTestId('sched-gate-toggle') as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    expect(toggle.textContent).not.toBe('Enable')
    expect(toggle.textContent).not.toBe('Disable')
  })

  it('a permanently-refused (pairing-bound) client sees UNKNOWN, not DISABLED', () => {
    // SCHEDULER_FORBIDDEN_BOUND_CLIENT never yields a snapshot for this client, so
    // the fallback state is what it sees forever — it must not be a false denial.
    resetStore({
      scheduledTasks: null,
      scheduledTasksLoading: false,
      scheduledTasksError: 'Bound clients may not read the host scheduled-task registry.',
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-headline').textContent).toContain('UNKNOWN')
    expect(screen.getByTestId('sched-gate-detail').textContent).not.toMatch(/will NOT fire/)
    expect(screen.getByTestId('sched-read-error').textContent).toMatch(/Bound clients/)
  })

  it('a snapshot MISSING its scheduler block also reads UNKNOWN rather than DISABLED', () => {
    // Same reasoning: no gate data is no gate data, whatever the reason.
    resetStore({ scheduledTasks: mkSnapshot({ scheduler: undefined }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-headline').textContent).toContain('UNKNOWN')
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

    // THE assertion that was missing, and the one that would have caught the
    // contradiction: the banner must not simultaneously deny that tasks fire.
    // The restart line alone was asserted, so nothing noticed that the bold
    // headline and first paragraph said the opposite — and the false half is the
    // skimmable half.
    expect(screen.getByTestId('sched-gate-detail').textContent).not.toMatch(/will NOT fire/)
  })

  // #6871 review (C2): the copy is keyed on BOTH `enabled` and `engineArmed`, so
  // all four combinations are pinned — a regression in any one of them is the
  // panel lying about whether unattended execution is happening.
  describe('the banner never contradicts the runtime state (all four states)', () => {
    it('gate OFF + engine ARMED — leads with STILL FIRING and points at a restart', () => {
      resetStore({
        scheduledTasks: mkSnapshot({
          scheduler: { enabled: false, engineArmed: true, restartRequired: true, source: 'config' },
        }),
      })
      render(<ScheduledTasksSection now={() => 1900000000000} />)
      const headline = screen.getByTestId('sched-gate-headline').textContent!
      const detail = screen.getByTestId('sched-gate-detail').textContent!
      expect(headline).toMatch(/STILL FIRING/)
      expect(detail).toMatch(/STILL FIRING/)
      // The remediation must be RESTART, never "enable the thing that is already
      // running" — the old copy sent the operator at their own problem.
      expect(detail).toMatch(/[Rr]estart the daemon/)
      expect(detail).not.toMatch(/will NOT fire/)
      expect(detail).not.toMatch(/Enable via features\.scheduler/)
      // And the button must not imply the scheduler is currently stopped.
      expect(screen.getByTestId('sched-gate-toggle').textContent).toBe('Re-enable')
    })

    it('gate OFF + engine NOT armed — "saved but will NOT fire" is correct here, and kept', () => {
      resetStore({ scheduledTasks: mkSnapshot({ scheduler: GATE_OFF }) })
      render(<ScheduledTasksSection now={() => 1900000000000} />)
      const detail = screen.getByTestId('sched-gate-detail').textContent!
      expect(screen.getByTestId('sched-gate-headline').textContent).toBe('Scheduled execution: DISABLED')
      expect(detail).toMatch(/will NOT fire/)
      expect(detail).toMatch(/features\.scheduler/)
      expect(screen.getByTestId('sched-gate-toggle').textContent).toBe('Enable')
    })

    it('gate ON + engine NOT armed — says nothing is firing yet and a restart starts it', () => {
      resetStore({
        scheduledTasks: mkSnapshot({
          scheduler: { enabled: true, engineArmed: false, restartRequired: true, source: 'config' },
        }),
      })
      render(<ScheduledTasksSection now={() => 1900000000000} />)
      const headline = screen.getByTestId('sched-gate-headline').textContent!
      const detail = screen.getByTestId('sched-gate-detail').textContent!
      expect(headline).toMatch(/ENGINE NOT ARMED/)
      expect(detail).toMatch(/nothing is firing yet/)
      expect(detail).toMatch(/[Rr]estart the daemon/)
      // Must NOT claim tasks are firing automatically — that was the mirror-image
      // contradiction (N1), failing safe but still wrong.
      expect(detail).not.toMatch(/Due tasks fire automatically/)
    })

    it('gate ON + engine ARMED — the plain enabled copy, no restart line', () => {
      resetStore({ scheduledTasks: mkSnapshot() })
      render(<ScheduledTasksSection now={() => 1900000000000} />)
      expect(screen.getByTestId('sched-gate-headline').textContent).toBe('Scheduled execution: ENABLED')
      expect(screen.getByTestId('sched-gate-detail').textContent).toMatch(/Due tasks fire automatically/)
      expect(screen.queryByTestId('sched-gate-restart')).toBeNull()
      expect(screen.getByTestId('sched-gate-toggle').textContent).toBe('Disable')
    })
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
    // #7038 — a deliberate operator Stop. `warn`, not `bad`: the whole point of
    // giving it its own status is that it is NOT a crash, and a chip styled
    // identically to ERROR would say "crash" all over again.
    ['interrupted', { lastRun: { at: 1, status: 'interrupted' } }, 'INTERRUPTED', 'warn'],
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
    // Distinctness: every case produced a different tag.
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

  it('survives a snapshot with no scheduler block (reads UNKNOWN, claims nothing)', () => {
    // #6871 review round 2 (finding 3): was "defaults to DISABLED". Degrading to a
    // denial is the one direction that can mislead an operator about unattended
    // execution, so absent gate data now reads UNKNOWN.
    resetStore({ scheduledTasks: mkSnapshot({ scheduler: undefined }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-gate-headline').textContent).toContain('UNKNOWN')
    expect(screen.getByTestId('sched-gate-detail').textContent).not.toMatch(/will NOT fire/)
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

/**
 * #6871 review (C3) — an out-of-Date-range `once` cadence must not crash.
 *
 * `new Date(1e16).toISOString()` throws RangeError, and the offending call sat in
 * a `useState` initializer — i.e. it threw DURING RENDER, so the nearest boundary
 * was the ROOT one and the whole dashboard (chat, terminal, everything) was
 * replaced by the error fallback until a page reload.
 *
 * The value is reachable without hand-editing the registry: it is finite, so the
 * store's old `once` arm accepted it, and a microsecond/nanosecond epoch typo
 * produces exactly this. Note `toLocaleString()` returns "Invalid Date" rather
 * than throwing, which is why the list path was already safe and this was not.
 */
describe('ScheduledTasksSection — an unrenderable `once` cadence degrades instead of crashing', () => {
  const OUT_OF_RANGE = 1e16

  it('renders the task in the list without throwing', () => {
    resetStore({
      scheduledTasks: mkSnapshot({ tasks: [mkTask({ cadence: { kind: 'once', at: OUT_OF_RANGE }, nextRun: OUT_OF_RANGE })] }),
    })
    expect(() => render(<ScheduledTasksSection now={() => 1900000000000} />)).not.toThrow()
    expect(screen.getByTestId('sched-row-task-1')).toBeTruthy()
    // An em dash, not a crash and not a bogus date.
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toContain('—')
  })

  it('survives clicking Edit, and says the stored run-at could not be read', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({ tasks: [mkTask({ cadence: { kind: 'once', at: OUT_OF_RANGE } })] }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    // This is the click that took the dashboard down.
    expect(() => fireEvent.click(screen.getByTestId('sched-edit'))).not.toThrow()
    expect(screen.getByTestId('sched-form-modal')).toBeTruthy()
    // Empty field rather than a thrown RangeError...
    expect((screen.getByTestId('sched-form-once') as HTMLInputElement).value).toBe('')
    // ...plus an explicit affordance, so an empty field is not mistaken for
    // "this task had no scheduled time".
    expect(screen.getByTestId('sched-form-once-invalid')).toBeTruthy()
  })

  it('a VALID once cadence still seeds the datetime-local field', () => {
    // The guard must not have broken the normal path.
    const at = Date.UTC(2026, 6, 24, 9, 30)
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({ tasks: [mkTask({ cadence: { kind: 'once', at } })] }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-edit'))
    expect((screen.getByTestId('sched-form-once') as HTMLInputElement).value).toBe('2026-07-24T09:30')
    expect(screen.queryByTestId('sched-form-once-invalid')).toBeNull()
  })
})

/**
 * #6871 review — the form must not be able to wedge itself.
 *
 * The wire caps `prompt` at 32768 and ws-server answers an over-cap message with
 * an `INVALID_MESSAGE` frame that carries NO `requestId`, so the pending entry
 * could never be released by correlation: submit sat on "Saving…" and Cancel was
 * `disabled={inFlight}`, leaving Esc as the only way out.
 */
describe('ScheduledTasksSection — the form cannot wedge', () => {
  it('caps every input at the wire schema bound, so an over-cap message is never composed', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    expect((screen.getByTestId('sched-form-prompt') as HTMLTextAreaElement).maxLength).toBe(32768)
    expect((screen.getByTestId('sched-form-name') as HTMLInputElement).maxLength).toBe(256)
    expect((screen.getByTestId('sched-form-provider') as HTMLInputElement).maxLength).toBe(128)
    expect((screen.getByTestId('sched-form-model') as HTMLInputElement).maxLength).toBe(256)
    expect((screen.getByTestId('sched-form-cwd') as HTMLInputElement).maxLength).toBe(4096)
    expect((screen.getByTestId('sched-form-cron') as HTMLInputElement).maxLength).toBe(256)
  })

  it('leaves Cancel ENABLED while a mutation is in flight', () => {
    // Abandoning the form sends nothing and the mutation is not optimistic, so
    // this is always safe — and it is the only escape when a rejection frame
    // arrives with no requestId to release the pending entry.
    resetStore({
      scheduledTasks: mkSnapshot(),
      scheduledTaskPendingActions: { 'sched-action-1': { kind: 'create', taskId: null, at: 1 } },
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect((screen.getByTestId('sched-form-cancel') as HTMLButtonElement).disabled).toBe(false)
  })
})

/** #6871 review (S1) — a failed READ surfaces a reason rather than a dead spinner. */
describe('ScheduledTasksSection — a failed read is visible', () => {
  it('renders the read error and re-enables Refresh', () => {
    resetStore({
      scheduledTasks: mkSnapshot(),
      scheduledTasksLoading: false,
      scheduledTasksError: 'No response from the daemon — the scheduler request timed out. Refresh to retry.',
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-read-error').textContent).toMatch(/timed out/)
    expect((screen.getByTestId('sched-refresh') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('sched-refresh').textContent).toBe('Refresh')
  })

  it('shows no read error when the last read succeeded', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.queryByTestId('sched-read-error')).toBeNull()
  })
})

/**
 * #7026 — a task that CANNOT FIRE must not present as if it will.
 *
 * The shared health derivation answers "how did the last run go?", not "will
 * this fire?". So a task whose `lastRun.status === 'success'` rendered a green
 * `OK` chip and a live `next: <future timestamp>` while nothing was firing at
 * all — the red gate banner above it was the only contradicting signal, and it
 * is the one an operator skims past.
 *
 * The predicate is `engineArmed`, the RUNTIME truth, NOT the persisted `enabled`
 * flag. Keying on the saved flag would repeat the C2 mistake in miniature: with
 * the gate saved DISABLED on a still-armed engine the tasks below ARE about to
 * fire, and blanking their next-run time would be false in exactly the
 * dangerous direction.
 */
describe('ScheduledTasksSection — a task that cannot fire never reads as live (#7026)', () => {
  const LIVE = new Date(1900000000000).toLocaleString()
  const GATE_SAVED_OFF_STILL_ARMED = {
    enabled: false, engineArmed: true, restartRequired: true, source: 'config' as const,
  }
  const GATE_SAVED_ON_NOT_ARMED = {
    enabled: true, engineArmed: false, restartRequired: true, source: 'config' as const,
  }

  // POSITIVE CONTROL for the whole block: on the very same task, with the engine
  // armed, the chip IS green and the next-run cell IS the live timestamp.
  // Without it every "not ok" / "no timestamp" assertion below would pass for
  // free on a fixture that never took effect.
  it('POSITIVE CONTROL: with the engine armed the same task is green with a live next-run time', () => {
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot({ scheduler: GATE_ON }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-health-task-1').getAttribute('data-accent')).toBe('ok')
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toContain(LIVE)
    expect(screen.getByTestId('sched-detail-next').textContent).toContain(LIVE)
  })

  it('does not style a successful task green while no engine is armed', () => {
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot({ scheduler: GATE_OFF }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    const row = screen.getByTestId('sched-health-task-1')
    expect(row.getAttribute('data-accent')).not.toBe('ok')
    expect(screen.getByTestId('sched-detail-health').getAttribute('data-accent')).not.toBe('ok')
    // The CLI-identical TAG is untouched — only the styling degrades, exactly
    // the shape quarantine already uses.
    expect(row.textContent).toContain('OK')
  })

  it('replaces the next-run timestamp with a reason in BOTH the row and the detail', () => {
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot({ scheduler: GATE_OFF }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    for (const id of ['sched-row-next-task-1', 'sched-detail-next']) {
      const cell = screen.getByTestId(id)
      expect(cell.textContent, id).not.toContain(LIVE)
      expect(cell.textContent, id).toContain('—')
      expect(cell.textContent, id).toMatch(/scheduler .*not running/i)
    }
  })

  it('says the same thing when the gate is SAVED ON but no engine is armed yet', () => {
    // Nothing fires until the daemon restarts, so a live timestamp is just as
    // false here as with the flag off.
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot({ scheduler: GATE_SAVED_ON_NOT_ARMED }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).not.toContain(LIVE)
    expect(screen.getByTestId('sched-health-task-1').getAttribute('data-accent')).not.toBe('ok')
  })

  it('KEEPS the live next-run time when the gate is saved OFF but the engine is STILL FIRING', () => {
    // The dangerous state. These tasks really are about to run unattended;
    // blanking the time (or greying the chip) would understate that.
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot({ scheduler: GATE_SAVED_OFF_STILL_ARMED }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toContain(LIVE)
    expect(screen.getByTestId('sched-detail-next').textContent).toContain(LIVE)
    expect(screen.getByTestId('sched-health-task-1').getAttribute('data-accent')).toBe('ok')
  })

  it('a REFUSED task shows no live next-run time and no green chip, even with the engine armed', () => {
    const refusal = "provider 'claude-tui' routes permission prompts through the permission hook…"
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({ tasks: [mkTask({ providerRefusal: refusal })] }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).not.toContain(LIVE)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toMatch(/will not fire/)
    expect(screen.getByTestId('sched-health-task-1').getAttribute('data-accent')).not.toBe('ok')
    expect(screen.getByTestId('sched-detail-next').textContent).toMatch(/will not fire/)
  })

  it('claims nothing about firing when the gate is UNKNOWN', () => {
    // No snapshot gate = we have not read the daemon. Asserting "not running"
    // here would be the same zero-data claim the banner refuses to make.
    resetStore({ selectedScheduledTaskId: 'task-1', scheduledTasks: mkSnapshot({ scheduler: undefined }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).not.toMatch(/not running/i)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toContain(LIVE)
  })

  it('a PAUSED task still says paused (the task-level reason wins)', () => {
    resetStore({ scheduledTasks: mkSnapshot({ scheduler: GATE_OFF, tasks: [mkTask({ enabled: false })] }) })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toMatch(/paused/)
  })

  // The FOURTH way a listed task silently never runs, and the one the first cut
  // of this fix missed. `_quarantine()` (scheduler.js) writes only `lastRun`; the
  // store then RECOMPUTES `nextRun` from the cadence, so the record keeps a real
  // future timestamp while `_tick()` skips the task on `_quarantined.has(id)`
  // until the daemon restarts. The chip was already `bad` via the long-standing
  // `quarantined` degrade — it is the next-run cell that kept claiming a fire
  // time, which is precisely the presentation #7026 exists to stop.
  it('a QUARANTINED task shows no live next-run time, in BOTH the row and the detail', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({
        scheduler: GATE_ON,
        tasks: [mkTask({
          quarantined: true,
          lastRun: { at: 1800000000000, status: 'refused', error: 'quarantined until daemon restart: its run outcome could not be recorded' },
        })],
      }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    // POSITIVE CONTROL: the fixture took effect — the quarantine degrade is live.
    expect(screen.getByTestId('sched-health-task-1').getAttribute('data-accent')).toBe('bad')
    for (const id of ['sched-row-next-task-1', 'sched-detail-next']) {
      const cell = screen.getByTestId(id)
      expect(cell.textContent, id).not.toContain(LIVE)
      expect(cell.textContent, id).toMatch(/quarantined/i)
    }
  })

  it('POSITIVE CONTROL: the same task un-quarantined keeps its live next-run time', () => {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({ scheduler: GATE_ON, tasks: [mkTask({ quarantined: false })] }),
    })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    expect(screen.getByTestId('sched-row-next-task-1').textContent).toContain(LIVE)
  })
})

/**
 * #7049 — the edit form must send PATCH semantics, not a full round-trip of the
 * snapshot it was seeded from.
 *
 * Two losses come out of the same shape. The store REPLACES `target` wholesale
 * (`scheduled-task-store.js`: `if ('target' in patch) next.target = …`), so a
 * complete `target` bag built by a form with no `permissionMode` input erased a
 * stored one on ANY unrelated save. And every text field is seeded from the
 * CLAMPED wire snapshot, so echoing it back persisted the shortened value.
 *
 * The fix is NOT a new input for `permissionMode` (that is a product decision,
 * #6761) — it is to stop sending fields the operator did not touch.
 */
describe('ScheduledTasksSection — the edit form sends only what the operator changed (#7049)', () => {
  const STORED_TARGET = { provider: 'claude-sdk', permissionMode: 'plan' }
  // Exactly the wire cap: this is what `clampWire` PROJECTS a longer stored name
  // down to, which is what the form is seeded with. The full stored value is
  // longer and this surface can never see it.
  const LONG_NAME = 'n'.repeat(256)

  function openEdit(over: Record<string, unknown> = {}) {
    resetStore({
      selectedScheduledTaskId: 'task-1',
      scheduledTasks: mkSnapshot({ tasks: [mkTask({ target: STORED_TARGET, ...over })] }),
    })
    view = render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-edit'))
  }

  // Re-render the section in place (the modal is NOT remounted), so an open form
  // sees a refreshed `task` prop exactly as it would when the daemon re-emits the
  // snapshot. The mocked store is a plain object, so a bare mutation of it would
  // never reach the tree — hence the explicit rerender.
  let view: ReturnType<typeof render> | null = null
  const rerenderSection = () => {
    view?.rerender(<ScheduledTasksSection now={() => 1900000000000} />)
  }

  const lastPatch = () => {
    const calls = sendActionMock.mock.calls
    const call = calls[calls.length - 1] as unknown as [string, Record<string, unknown>]
    expect(call[0]).toBe('update')
    return call[1].task as Record<string, unknown>
  }

  it('omits `target` entirely on an unrelated save, so a stored permissionMode survives', () => {
    openEdit()
    fireEvent.change(screen.getByTestId('sched-form-prompt'), { target: { value: 'a different prompt' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    const patch = lastPatch()
    expect(patch.prompt).toBe('a different prompt')
    expect('target' in patch).toBe(false)
  })

  it('POSITIVE CONTROL: editing a target field DOES send target, carrying permissionMode through', () => {
    // Without this the assertion above would also pass on a form that simply
    // never sends `target` at all — a different bug.
    openEdit()
    fireEvent.change(screen.getByTestId('sched-form-model'), { target: { value: 'opus' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(lastPatch().target).toEqual({ provider: 'claude-sdk', model: 'opus', permissionMode: 'plan' })
  })

  it('does not write a clamped name back truncated when the operator did not touch it', () => {
    openEdit({ name: LONG_NAME })
    fireEvent.change(screen.getByTestId('sched-form-prompt'), { target: { value: 'p2' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect('name' in lastPatch()).toBe(false)
  })

  it('POSITIVE CONTROL: an edited name IS sent', () => {
    openEdit({ name: LONG_NAME })
    fireEvent.change(screen.getByTestId('sched-form-name'), { target: { value: 'renamed' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(lastPatch().name).toBe('renamed')
  })

  it('omits an untouched prompt and an untouched cadence', () => {
    openEdit()
    fireEvent.change(screen.getByTestId('sched-form-name'), { target: { value: 'renamed' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    const patch = lastPatch()
    expect('prompt' in patch).toBe(false)
    expect('cadence' in patch).toBe(false)
  })

  it('POSITIVE CONTROL: an edited cadence IS sent', () => {
    openEdit()
    fireEvent.change(screen.getByTestId('sched-form-cron'), { target: { value: '30 2 * * *' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(lastPatch().cadence).toEqual({ kind: 'cron', expression: '30 2 * * *' })
  })

  it('preserves an interval `anchor` the form does not own', () => {
    // Same defect class: a field the form cannot express must not be destroyed
    // by a save that never mentioned it.
    openEdit({ cadence: { kind: 'interval', everyMs: 3600000, anchor: 1700000000000 } })
    fireEvent.change(screen.getByTestId('sched-form-name'), { target: { value: 'renamed' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect('cadence' in lastPatch()).toBe(false)

    cleanup()
    openEdit({ cadence: { kind: 'interval', everyMs: 3600000, anchor: 1700000000000 } })
    fireEvent.change(screen.getByTestId('sched-form-interval'), { target: { value: '15' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(lastPatch().cadence).toEqual({ kind: 'interval', everyMs: 900000, anchor: 1700000000000 })
  })

  it('clearing a target field still clears it', () => {
    openEdit()
    fireEvent.change(screen.getByTestId('sched-form-provider'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(lastPatch().target).toEqual({ permissionMode: 'plan' })
  })

  it('CREATE is unaffected — it still sends the complete payload it composed', () => {
    resetStore({ scheduledTasks: mkSnapshot() })
    render(<ScheduledTasksSection now={() => 1900000000000} />)
    fireEvent.click(screen.getByTestId('sched-new'))
    fireEvent.change(screen.getByTestId('sched-form-prompt'), { target: { value: 'do the thing' } })
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    expect(sendActionMock).toHaveBeenCalledWith('create', {
      task: {
        name: null,
        prompt: 'do the thing',
        cadence: { kind: 'cron', expression: '0 9 * * *' },
        target: {},
      },
    })
  })

  /**
   * The seed must survive a SNAPSHOT REFRESH landing while the modal is open.
   *
   * The daemon re-emits the whole `scheduled_tasks` snapshot after every accepted
   * mutation from ANY client, so `selected` — and therefore this modal's `task`
   * prop — is a fresh object mid-edit. Re-deriving the seed on that render points
   * "did the operator change this?" at the NEW server value, and every field the
   * operator never touched then differs from its seed and is sent: the exact
   * whole-bag write-back, with a stale value, that patch semantics exists to
   * stop. The seed has to be captured once for the LIFE of the modal.
   */
  it('keeps its seed across a snapshot refresh, so an untouched field is still omitted', () => {
    openEdit({ name: LONG_NAME })
    fireEvent.change(screen.getByTestId('sched-form-prompt'), { target: { value: 'p2' } })
    // Another client renames the task; the daemon re-emits the snapshot.
    storeState.scheduledTasks = mkSnapshot({
      tasks: [mkTask({ target: STORED_TARGET, name: 'renamed elsewhere' })],
    })
    rerenderSection()
    fireEvent.click(screen.getByTestId('sched-form-submit'))
    const patch = lastPatch()
    // POSITIVE CONTROL: the fixture took effect — the edit the operator DID make
    // is in the patch, so an empty/absent patch cannot be why `name` is missing.
    expect(patch.prompt).toBe('p2')
    expect('name' in patch).toBe(false)
    expect('target' in patch).toBe(false)
  })

  it('POSITIVE CONTROL: the refreshed prop is genuinely delivered to the open modal', () => {
    // Without this, the assertion above would also pass on a rerender that never
    // reached the modal at all — a fixture that did nothing.
    openEdit({ name: 'nightly sweep' })
    storeState.scheduledTasks = mkSnapshot({
      tasks: [mkTask({ target: STORED_TARGET, name: 'renamed elsewhere' })],
    })
    rerenderSection()
    expect(screen.getByTestId('sched-detail-name').textContent).toBe('renamed elsewhere')
  })
})

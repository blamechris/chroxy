/**
 * #6894 -- a resolved prompt collapses to the compact record, and a record given
 * a `detail` expands to the full text, the decision and the session (mobile's
 * answered pill expands to its card the same way).
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { PermissionOutcomeRecord, permissionDecisionLabel } from './PermissionOutcomeRecord'
import { ChatExpandContext, type ChatExpandRegistry } from './chatExpandRegistry'

afterEach(cleanup)

const LONG = 'Do you want to allow npm registry lookup after waiting for propagation? '.repeat(4).trim()

function renderRecord(over: Partial<React.ComponentProps<typeof PermissionOutcomeRecord>> = {}) {
  return render(
    <PermissionOutcomeRecord
      requestId="req-1"
      tool="shell"
      description={LONG}
      outcome="allowed"
      {...over}
    />,
  )
}

describe('PermissionOutcomeRecord -- expandable (#6894)', () => {
  it('has no expand control without a detail (the dismissed-expired line stays plain)', () => {
    renderRecord()
    expect(screen.queryByTestId('perm-record-toggle')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('with a detail it shows the compact line plus a collapsed expand control', () => {
    renderRecord({ detail: { decision: 'allow' } })
    const toggle = screen.getByTestId('perm-record-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('perm-outcome-record')).toHaveTextContent('Permission allowed')
    expect(screen.queryByTestId('perm-record-detail')).not.toBeInTheDocument()
  })

  it('expanding shows the full, unclamped description, the decision and the session; collapsing hides them', () => {
    renderRecord({ detail: { decision: 'allowSession', sessionLabel: 'codex-1 · Codex' } })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    const detail = screen.getByTestId('perm-record-detail')
    expect(detail).toHaveTextContent(LONG)
    expect(detail).toHaveTextContent('Allowed for session')
    expect(detail).toHaveTextContent('codex-1 · Codex')
    expect(screen.getByTestId('perm-record-toggle')).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    expect(screen.queryByTestId('perm-record-detail')).not.toBeInTheDocument()
  })

  it('the expanded view never offers an action: no Allow / Deny, no countdown', () => {
    renderRecord({ detail: { decision: 'deny' }, outcome: 'denied' })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    expect(screen.getByTestId('perm-record-detail')).toHaveTextContent('Denied')
    expect(screen.queryByText('Allow')).not.toBeInTheDocument()
    expect(screen.queryByText('Deny')).not.toBeInTheDocument()
    expect(screen.queryByTestId('perm-countdown')).not.toBeInTheDocument()
    // The only button is the expand control.
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('aria-controls only points at an id that exists: absent while collapsed, the detail once expanded', () => {
    renderRecord({ detail: { decision: 'allow' } })
    const toggle = screen.getByTestId('perm-record-toggle')
    expect(toggle.hasAttribute('aria-controls')).toBe(false)
    fireEvent.click(toggle)
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBe(screen.getByTestId('perm-record-detail'))
  })

  it('keeps the perm-desc anchor the expired-summary jump link lands on', () => {
    renderRecord({ detail: { decision: 'allow' } })
    expect(document.getElementById('perm-desc-req-1')).not.toBeNull()
  })

  it('remembers its expand state across a remount through the chat expand registry (virtualized rows)', () => {
    function Host({ registry }: { registry: ChatExpandRegistry }) {
      return (
        <ChatExpandContext.Provider value={registry}>
          <PermissionOutcomeRecord requestId="req-1" tool="shell" description="d" outcome="allowed" detail={{ decision: 'allow' }} />
        </ChatExpandContext.Provider>
      )
    }
    const store = new Map<string, boolean>()
    const registry: ChatExpandRegistry = {
      get: (k) => store.get(k),
      set: (k, v) => { if (v) store.set(k, true); else store.delete(k) },
    }
    const first = render(<Host registry={registry} />)
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    first.unmount()
    render(<Host registry={registry} />)
    expect(screen.getByTestId('perm-record-detail')).toBeInTheDocument()
  })
})

describe('PermissionOutcomeRecord -- what was approved (#6894)', () => {
  it('expanded, shows the tool input (the command) as well as the description', () => {
    renderRecord({ tool: 'Bash', description: 'Touch smoke file', detail: { decision: 'allow', toolInput: { command: 'touch smoke-perm.txt' } } })
    expect(screen.queryByTestId('perm-record-input')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    expect(screen.getByTestId('perm-record-input')).toHaveTextContent('touch smoke-perm.txt')
    expect(screen.getByTestId('perm-record-detail')).toHaveTextContent('Touch smoke file')
  })

  it('a 1500-character command plus dangerouslyDisableSandbox shows the flag first in the record detail (#8505)', () => {
    renderRecord({ detail: { decision: 'allow', toolInput: { command: 'x'.repeat(1500), dangerouslyDisableSandbox: true } } })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    const box = screen.getByTestId('perm-record-input')
    expect(box.textContent!.startsWith('dangerouslyDisableSandbox: true\n')).toBe(true)
    expect(box.querySelector('[data-testid="perm-input-flag"]')).toHaveTextContent('dangerouslyDisableSandbox: true')
    expect(box.textContent).toMatch(/truncated/)
  })

  it('a multi-line command plus the flag shows the flag in the record detail (#8505)', () => {
    renderRecord({ detail: { decision: 'allow', toolInput: { command: 'a\nb\nc\nd', dangerouslyDisableSandbox: true } } })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    expect(screen.getByTestId('perm-record-input').textContent!.startsWith('dangerouslyDisableSandbox: true\na')).toBe(true)
  })

  it('a non-scalar flag value shows the placeholder in the record detail (#8505)', () => {
    renderRecord({ detail: { decision: 'allow', toolInput: { command: 'ls', dangerouslyDisableSandbox: [1] } } })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    expect(screen.getByTestId('perm-input-flag')).toHaveTextContent('dangerouslyDisableSandbox: <array>')
  })

  it('renders the input as TEXT: markup in a command creates no element', () => {
    renderRecord({ detail: { decision: 'allow', toolInput: { command: '<img src=x onerror=alert(1)><b>bold</b>' } } })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    const box = screen.getByTestId('perm-record-input')
    expect(box.textContent).toBe('<img src=x onerror=alert(1)><b>bold</b>')
    expect(box.querySelector('img, b')).toBeNull()
  })

  it('bounds a huge command and marks the cut', () => {
    renderRecord({ detail: { decision: 'allow', toolInput: { command: 'z'.repeat(50_000) } } })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    const text = screen.getByTestId('perm-record-input').textContent!
    expect(text.length).toBeLessThan(2000)
    expect(text).toMatch(/truncated/)
  })

  it('shows no input block without a tool input (a replayed record carries none)', () => {
    renderRecord({ detail: { decision: 'allow' } })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    expect(screen.getByTestId('perm-record-detail')).toBeInTheDocument()
    expect(screen.queryByTestId('perm-record-input')).not.toBeInTheDocument()
  })

  it('never shows the raw input of an AskUserQuestion', () => {
    renderRecord({ tool: 'AskUserQuestion', detail: { decision: 'allow', toolInput: { questions: [{ question: 'secret?' }] } } })
    fireEvent.click(screen.getByTestId('perm-record-toggle'))
    expect(screen.queryByTestId('perm-record-input')).not.toBeInTheDocument()
  })

  it('wraps long unbroken text instead of overflowing (css contract)', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
    const rule = /\.perm-record-input[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/white-space:\s*pre-wrap/)
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
  })
})

describe('permissionDecisionLabel', () => {
  it('names each decision token the way the live card did', () => {
    expect(permissionDecisionLabel('deny')).toBe('Denied')
    expect(permissionDecisionLabel('allowSession')).toBe('Allowed for session')
    expect(permissionDecisionLabel('allowAlways')).toBe('Always allowed (project)')
    expect(permissionDecisionLabel('allow')).toBe('Allowed')
  })
})

describe('expand control tap target (#6894, CLAUDE.md 44pt floor)', () => {
  beforeAll(() => {
    const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
  })

  it('the record expand control resolves a >= 44px min-height through the real cascade', () => {
    renderRecord({ detail: { decision: 'allow' } })
    const h = Number.parseFloat(getComputedStyle(screen.getByTestId('perm-record-toggle')).minHeight)
    expect(h).toBeGreaterThanOrEqual(44)
  })
})

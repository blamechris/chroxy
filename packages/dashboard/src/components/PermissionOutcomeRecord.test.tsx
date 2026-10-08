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

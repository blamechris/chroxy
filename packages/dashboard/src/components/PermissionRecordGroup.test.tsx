/**
 * #6894 -- a run of identical resolved permission prompts renders as ONE compact
 * line with a count, expandable to the individual records.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { PermissionRecordGroup } from './PermissionRecordGroup'
import { PermissionOutcomeRecord } from './PermissionOutcomeRecord'
import { ChatExpandContext, type ChatExpandRegistry } from './chatExpandRegistry'

afterEach(cleanup)

function members() {
  return (
    <>
      {['a', 'b', 'c'].map((id) => (
        <PermissionOutcomeRecord key={id} requestId={`req-${id}`} tool="shell" description="npm registry lookup" outcome="allowed" />
      ))}
    </>
  )
}

function renderGroup(over: Partial<React.ComponentProps<typeof PermissionRecordGroup>> = {}) {
  return render(
    <PermissionRecordGroup
      groupId="permission-group-a"
      requestIds={['req-a', 'req-b', 'req-c']}
      tool="shell"
      description="npm registry lookup"
      outcome="allowed"
      count={3}
      renderMembers={members}
      {...over}
    />,
  )
}

describe('PermissionRecordGroup (#6894)', () => {
  it('is one compact line: outcome, tool, description and the count', () => {
    renderGroup()
    const group = screen.getByTestId('perm-group')
    expect(group).toHaveTextContent('Permission allowed')
    expect(group).toHaveTextContent('shell')
    expect(group).toHaveTextContent('npm registry lookup')
    expect(screen.getByTestId('perm-group-count')).toHaveTextContent('×3')
    expect(group.getAttribute('data-count')).toBe('3')
    expect(group.getAttribute('data-outcome')).toBe('allowed')
    // collapsed: none of the members is mounted
    expect(screen.queryByTestId('perm-group-members')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('perm-outcome-record')).toHaveLength(0)
  })

  it('expanding reveals every member record; collapsing hides them again', () => {
    renderGroup()
    const toggle = screen.getByTestId('perm-group-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByTestId('perm-group-members')
    expect(within(list).getAllByTestId('perm-outcome-record')).toHaveLength(3)
    fireEvent.click(toggle)
    expect(screen.queryByTestId('perm-group-members')).not.toBeInTheDocument()
  })

  it('the toggle names what it does and how many it covers', () => {
    renderGroup()
    expect(screen.getByTestId('perm-group-toggle').getAttribute('aria-label')).toMatch(/3.*shell/i)
  })

  it('keeps EVERY member\'s perm-desc jump anchor exactly once, collapsed or expanded', () => {
    renderGroup()
    const count = (id: string) => document.querySelectorAll(`[id="perm-desc-${id}"]`).length
    // Collapsed: the first member's anchor is the toggle; the others are empty
    // anchors next to it, so the expired summary's "Jump to prompt" lands on the
    // group line whichever member it names.
    for (const id of ['req-a', 'req-b', 'req-c']) expect(count(id), `collapsed ${id}`).toBe(1)
    expect(screen.getByTestId('perm-group-toggle').id).toBe('perm-desc-req-a')
    fireEvent.click(screen.getByTestId('perm-group-toggle'))
    // Expanded: each member record carries its own; the group adds none (no duplicate ids).
    for (const id of ['req-a', 'req-b', 'req-c']) expect(count(id), `expanded ${id}`).toBe(1)
    expect(within(screen.getByTestId('perm-group-members')).getAllByTestId('perm-outcome-record')[1]!.querySelector('#perm-desc-req-b')).not.toBeNull()
  })

  it('a collapsed-group anchor is focusable, so the jump link can move focus onto the group', () => {
    renderGroup()
    const anchor = document.getElementById('perm-desc-req-c')!
    expect(anchor.getAttribute('tabindex')).toBe('-1')
    anchor.focus()
    expect(document.activeElement).toBe(anchor)
  })

  it('has no Allow / Deny: a group is never actionable', () => {
    renderGroup()
    fireEvent.click(screen.getByTestId('perm-group-toggle'))
    expect(screen.queryByText('Allow')).not.toBeInTheDocument()
    expect(screen.queryByText('Deny')).not.toBeInTheDocument()
  })

  it('uses the same wording as the single record for an expired / stopped group', () => {
    const { unmount } = renderGroup({ outcome: 'expired' })
    expect(screen.getByTestId('perm-group')).toHaveTextContent('Permission expired')
    expect(screen.getByTestId('perm-group')).toHaveTextContent('dropped')
    unmount()
    renderGroup({ outcome: 'stopped' })
    expect(screen.getByTestId('perm-group')).toHaveTextContent('Permission stopped')
    expect(screen.getByTestId('perm-group')).toHaveTextContent('not run')
  })

  it('remembers its expand state across a remount through the chat expand registry', () => {
    const store = new Map<string, boolean>()
    const registry: ChatExpandRegistry = {
      get: (k) => store.get(k),
      set: (k, v) => { if (v) store.set(k, true); else store.delete(k) },
    }
    const ui = (
      <ChatExpandContext.Provider value={registry}>
        <PermissionRecordGroup
          groupId="permission-group-a" requestIds={['req-a', 'req-b', 'req-c']} tool="shell" description="d"
          outcome="allowed" count={3} renderMembers={members}
        />
      </ChatExpandContext.Provider>
    )
    const first = render(ui)
    fireEvent.click(screen.getByTestId('perm-group-toggle'))
    first.unmount()
    render(ui)
    expect(screen.getByTestId('perm-group-members')).toBeInTheDocument()
  })
})

describe('group toggle tap target (#6894, CLAUDE.md 44pt floor)', () => {
  beforeAll(() => {
    const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
  })

  it('the group toggle resolves a >= 44px min-height through the real cascade', () => {
    renderGroup()
    const h = Number.parseFloat(getComputedStyle(screen.getByTestId('perm-group-toggle')).minHeight)
    expect(h).toBeGreaterThanOrEqual(44)
  })
})

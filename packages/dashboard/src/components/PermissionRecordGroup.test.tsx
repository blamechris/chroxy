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

  it('shows the shared tool input on the group line (the members are identical in it)', () => {
    renderGroup({ toolInput: { command: 'touch smoke-perm.txt' } })
    expect(screen.getByTestId('perm-group-input')).toHaveTextContent('touch smoke-perm.txt')
  })

  it('a 1500-character command plus dangerouslyDisableSandbox shows the flag on the collapsed group line, styled apart (#8505)', () => {
    renderGroup({ toolInput: { command: 'x'.repeat(1500), dangerouslyDisableSandbox: true } })
    const line = screen.getByTestId('perm-group-input')
    const flag = within(line).getByTestId('perm-input-flag')
    expect(flag).toHaveTextContent('dangerouslyDisableSandbox: true')
    // first in the line, so the two-line clamp keeps it
    expect(line.textContent!.startsWith('dangerouslyDisableSandbox: true')).toBe(true)
  })

  it('a multi-line command plus the flag shows the flag on the group line (#8505)', () => {
    renderGroup({ toolInput: { command: 'a\nb\nc\nd', dangerouslyDisableSandbox: true } })
    expect(screen.getByTestId('perm-group-input').textContent!.startsWith('dangerouslyDisableSandbox: true\na')).toBe(true)
  })

  it('a non-scalar flag value shows the placeholder on the group line (#8505)', () => {
    renderGroup({ toolInput: { command: 'ls', dangerouslyDisableSandbox: { a: 1 } } })
    expect(screen.getByTestId('perm-input-flag')).toHaveTextContent('dangerouslyDisableSandbox: <object>')
  })

  it('a long safety-flag string is cut on the group line so both safety flags fit; the record detail keeps it (#8505)', () => {
    const long = 'v'.repeat(150)
    renderGroup({ toolInput: { command: 'ls', run_in_background: long, dangerouslyDisableSandbox: long } })
    const flags = within(screen.getByTestId('perm-group-input')).getAllByTestId('perm-input-flag')
    expect(flags).toHaveLength(2)
    for (const f of flags) expect(f.textContent!.length).toBeLessThan(110)
  })

  it('a plain command has no flag element', () => {
    renderGroup({ toolInput: { command: 'ls' } })
    expect(screen.queryByTestId('perm-input-flag')).not.toBeInTheDocument()
  })

  it('the flag styling is a token color plus weight, never a raw color literal (css contract)', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../theme/components.css'), 'utf-8')
    const rule = (/\.perm-input-flag\s*\{([^}]*)\}/.exec(css)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(rule).toMatch(/color:\s*var\(--[a-z-]+\)/)
    expect(rule).toMatch(/font-weight:\s*(bold|[6-9]00)/)
    // defence in depth against bidi reordering of the flag text
    expect(rule).toMatch(/unicode-bidi:\s*isolate/)
    for (const sel of ['perm-group-input', 'perm-record-input']) {
      const box = (new RegExp(`\\.${sel}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '')
      expect(box, sel).toMatch(/unicode-bidi:\s*isolate/)
    }
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  })

  it('renders the group-line input as text, not markup', () => {
    renderGroup({ toolInput: { command: '<b>x</b>' } })
    expect(screen.getByTestId('perm-group-input').querySelector('b')).toBeNull()
  })

  it('has no input line when the members carry none (replayed history)', () => {
    renderGroup()
    expect(screen.queryByTestId('perm-group-input')).not.toBeInTheDocument()
  })

  it('aria-controls only points at an id that exists: absent while collapsed, the members list once expanded', () => {
    renderGroup()
    const toggle = screen.getByTestId('perm-group-toggle')
    expect(toggle.hasAttribute('aria-controls')).toBe(false)
    fireEvent.click(toggle)
    const target = toggle.getAttribute('aria-controls')!
    expect(document.getElementById(target)).toBe(screen.getByTestId('perm-group-members'))
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

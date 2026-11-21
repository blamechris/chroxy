/**
 * FolderTrustBanner: the banner for an untrusted folder, the review dialog, and
 * the indicator for a trusted one. Each claim has a control (the opposite state).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { FolderTrustBanner } from './FolderTrustBanner'
import type { FolderTrustEntry } from '../store/types'

afterEach(() => { cleanup() })

const summary: NonNullable<FolderTrustEntry['summary']> = {
  files: [{ path: '/p/.mcp.json' }, { path: '/p/.claude/settings.json' }, { path: '/p/.claude/agents/a.md', linkTarget: '/shared/a.md' }],
  mcpServers: [{ file: '/p/.mcp.json', name: 'github', command: 'npx', args: ['-y', 'server-github'], envKeys: ['GITHUB_TOKEN'] }],
  hooks: [{ file: '/p/.claude/settings.json', event: 'PreToolUse', commands: ['echo checking'] }],
  statusLine: [{ file: '/p/.claude/settings.json', command: 'status.sh' }],
  enabledPlugins: [{ file: '/p/.claude/settings.json', plugin: 'tools@market' }],
  counts: { agents: 2, skills: 1, commands: 0 },
  warnings: [],
  hasCommandBearingFiles: true,
  untrustable: false,
}
const digest = 'a'.repeat(64)
const untrusted: FolderTrustEntry = { status: 'untrusted', summary, digest, appliesFrom: 'restart' }
const trusted: FolderTrustEntry = { status: 'trusted', summary, digest, appliesFrom: 'next_turn' }

const props = (over = {}) => ({ entry: untrusted, onTrust: vi.fn(), onUntrust: vi.fn(), ...over })

describe('<FolderTrustBanner> untrusted', () => {
  it('shows the banner with a Review button and no dialog', () => {
    render(<FolderTrustBanner {...props()} />)
    expect(screen.getByTestId('folder-trust-banner')).toHaveTextContent("This folder's project settings are not loaded.")
    expect(screen.getByTestId('folder-trust-review')).toBeInTheDocument()
    expect(screen.queryByTestId('folder-trust-dialog')).toBeNull()
  })

  it('Review opens a dialog listing servers with command and args, hooks, status line, plugins, counts and paths', () => {
    render(<FolderTrustBanner {...props()} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    const dialog = screen.getByTestId('folder-trust-dialog')
    expect(within(dialog).getByTestId('folder-trust-mcp-server')).toHaveTextContent('github')
    expect(within(dialog).getByTestId('folder-trust-mcp-server')).toHaveTextContent('npx -y server-github')
    expect(within(dialog).getByTestId('folder-trust-mcp-server')).toHaveTextContent('GITHUB_TOKEN')
    expect(within(dialog).getByTestId('folder-trust-hook')).toHaveTextContent('PreToolUse')
    expect(within(dialog).getByTestId('folder-trust-hook')).toHaveTextContent('echo checking')
    expect(within(dialog).getByTestId('folder-trust-status-line')).toHaveTextContent('status.sh')
    expect(within(dialog).getByTestId('folder-trust-plugin')).toHaveTextContent('tools@market')
    expect(within(dialog).getByTestId('folder-trust-counts')).toHaveTextContent('2 agent files, 1 skill file, 0 command files')
    expect(within(dialog).getAllByTestId('folder-trust-file').map((n) => n.querySelector('code')?.textContent)).toEqual(summary.files.map((f) => f.path))
    expect(within(dialog).getByTestId('folder-trust-link')).toHaveTextContent('→ /shared/a.md')
  })

  it('the dialog carries the warning line and when the change applies', () => {
    render(<FolderTrustBanner {...props()} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    expect(screen.getByTestId('folder-trust-warning')).toHaveTextContent('Trusting this folder lets these settings run, along with the code they point to.')
    expect(screen.getByTestId('folder-trust-applies')).toHaveTextContent('Restart the session to apply')
  })

  it('says "Applies from the next turn" for a claude-sdk session', () => {
    render(<FolderTrustBanner {...props({ entry: { ...untrusted, appliesFrom: 'next_turn' } })} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    expect(screen.getByTestId('folder-trust-applies')).toHaveTextContent('Applies from the next turn')
  })

  it('Trust this folder calls onTrust; Cancel closes without trusting', () => {
    const onTrust = vi.fn()
    render(<FolderTrustBanner {...props({ onTrust })} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    fireEvent.click(screen.getByTestId('folder-trust-cancel'))
    expect(onTrust).not.toHaveBeenCalled()
    expect(screen.queryByTestId('folder-trust-dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    fireEvent.click(screen.getByTestId('folder-trust-confirm'))
    expect(onTrust).toHaveBeenCalledTimes(1)
    expect(onTrust).toHaveBeenCalledWith(digest)
  })

  it('disables Trust while a change is in flight and shows a failure reason', () => {
    render(<FolderTrustBanner {...props({ pending: true, error: 'The trust change could not be saved' })} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    expect(screen.getByTestId('folder-trust-confirm')).toBeDisabled()
    expect(screen.getByTestId('folder-trust-error')).toHaveTextContent('The trust change could not be saved')
  })

  it('closes the dialog once the folder becomes trusted', () => {
    const { rerender } = render(<FolderTrustBanner {...props()} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    expect(screen.getByTestId('folder-trust-dialog')).toBeInTheDocument()
    rerender(<FolderTrustBanner {...props({ entry: trusted })} />)
    expect(screen.queryByTestId('folder-trust-dialog')).toBeNull()
  })

  it('the controls meet the 44px tap-target floor', () => {
    render(<FolderTrustBanner {...props()} />)
    expect(screen.getByTestId('folder-trust-review')).toHaveStyle({ minHeight: '44px', minWidth: '44px' })
  })
})

describe('<FolderTrustBanner> snapshot', () => {
  const newer: FolderTrustEntry = { ...untrusted, digest: 'd'.repeat(64), summary: { ...summary, files: [{ path: '/p/.mcp.json' }, { path: '/p/NEW.md' }] } }

  it('renders from the snapshot taken at Review and sends THAT digest', () => {
    const onTrust = vi.fn()
    const { rerender } = render(<FolderTrustBanner {...props({ onTrust })} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    rerender(<FolderTrustBanner {...props({ onTrust, entry: newer })} />)
    expect(screen.getAllByTestId('folder-trust-file').map((n) => n.querySelector('code')?.textContent)).toEqual(summary.files.map((f) => f.path))
    expect(screen.getByTestId('folder-trust-changed')).toHaveTextContent('This folder changed since you opened it. Review again.')
    expect(screen.getByTestId('folder-trust-confirm')).toBeDisabled()
    fireEvent.click(screen.getByTestId('folder-trust-confirm'))
    expect(onTrust).not.toHaveBeenCalled()
  })

  it('Reload takes a new snapshot, re-enables Trust, and sends the new digest', () => {
    const onTrust = vi.fn()
    const { rerender } = render(<FolderTrustBanner {...props({ onTrust })} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    rerender(<FolderTrustBanner {...props({ onTrust, entry: newer })} />)
    fireEvent.click(screen.getByTestId('folder-trust-reload'))
    expect(screen.queryByTestId('folder-trust-changed')).toBeNull()
    expect(screen.getAllByTestId('folder-trust-file')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('folder-trust-confirm'))
    expect(onTrust).toHaveBeenCalledWith(newer.digest)
  })

  it('a state with the SAME digest arriving while the dialog is open is not a change', () => {
    const { rerender } = render(<FolderTrustBanner {...props()} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    rerender(<FolderTrustBanner {...props({ entry: { ...untrusted } })} />)
    expect(screen.queryByTestId('folder-trust-changed')).toBeNull()
    expect(screen.getByTestId('folder-trust-confirm')).not.toBeDisabled()
  })
})

describe('<FolderTrustBanner> running sessions', () => {
  it('says project settings stay loaded in a running session that launched with them, when not trusted', () => {
    render(<FolderTrustBanner {...props({ entry: { ...untrusted, launchedWithProject: true } })} />)
    expect(screen.getByTestId('folder-trust-still-loaded')).toHaveTextContent('Project settings stay loaded in this running session until it restarts')
  })

  it.each([[false], [undefined]])('says nothing of the kind when launchedWithProject is %s', (launchedWithProject) => {
    render(<FolderTrustBanner {...props({ entry: { ...untrusted, launchedWithProject } })} />)
    expect(screen.queryByTestId('folder-trust-still-loaded')).toBeNull()
  })

  it('does not show it for a trusted folder', () => {
    render(<FolderTrustBanner {...props({ entry: { ...trusted, launchedWithProject: true } })} />)
    expect(screen.queryByTestId('folder-trust-still-loaded')).toBeNull()
  })
})

describe('<FolderTrustBanner> trusted', () => {
  it('shows a small indicator with Stop trusting, and no banner', () => {
    const onUntrust = vi.fn()
    render(<FolderTrustBanner {...props({ entry: trusted, onUntrust })} />)
    expect(screen.queryByTestId('folder-trust-banner')).toBeNull()
    expect(screen.getByTestId('folder-trust-trusted')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('folder-trust-untrust'))
    expect(onUntrust).toHaveBeenCalledTimes(1)
  })
})

describe('<FolderTrustBanner> what can be trusted', () => {
  const open = (entry: FolderTrustEntry) => {
    render(<FolderTrustBanner {...props({ entry })} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
  }

  it('hides Trust this folder when there is no summary or no digest (a session-bound client)', () => {
    open({ status: 'untrusted', appliesFrom: 'restart' })
    expect(screen.queryByTestId('folder-trust-confirm')).toBeNull()
    expect(screen.queryByTestId('folder-trust-warning')).toBeNull()
    expect(screen.getByTestId('folder-trust-readonly')).toBeInTheDocument()
    cleanup()
    open({ status: 'untrusted', summary, appliesFrom: 'restart' })
    expect(screen.queryByTestId('folder-trust-confirm')).toBeNull()
  })

  it('hides Trust this folder for a folder that could not be reviewed completely, and shows why', () => {
    open({ ...untrusted, summary: { ...summary, untrustable: true, warnings: ['Cannot review this folder: /p/x: not a regular file'] } })
    expect(screen.queryByTestId('folder-trust-confirm')).toBeNull()
    expect(screen.getByTestId('folder-trust-warnings')).toHaveTextContent('not a regular file')
  })

  it('a folder too large to review says so', () => {
    open({ ...untrusted, summary: { ...summary, untrustable: true, warnings: ['This folder is too large to review (more than 20000 directories)'] } })
    expect(screen.getByTestId('folder-trust-warnings')).toHaveTextContent('This folder is too large to review (more than 20000 directories)')
    expect(screen.queryByTestId('folder-trust-confirm')).toBeNull()
  })

  it('a folder with nothing command-bearing says so, and can still be trusted', () => {
    open({ ...untrusted, summary: { ...summary, files: [], mcpServers: [], hooks: [], statusLine: [], enabledPlugins: [], counts: { agents: 0, skills: 0, commands: 0 }, hasCommandBearingFiles: false } })
    expect(screen.getByTestId('folder-trust-no-commands')).toHaveTextContent("No commands found; trusting loads this folder's CLAUDE.md, rules and other project settings.")
    expect(screen.getByTestId('folder-trust-confirm')).toBeInTheDocument()
  })

  it('surfaces the "N more not shown" and size warnings in the dialog', () => {
    open({ ...untrusted, summary: { ...summary, warnings: ['10 more MCP servers not shown', 'Folder tree too large to scan fully: nested skills beyond 5000 directories are not covered'] } })
    const warnings = screen.getByTestId('folder-trust-warnings')
    expect(warnings).toHaveTextContent('10 more MCP servers not shown')
    expect(warnings).toHaveTextContent('nested skills beyond 5000 directories')
    expect(screen.getByTestId('folder-trust-confirm')).toBeInTheDocument()
  })
})

describe('<FolderTrustBanner> nothing to show', () => {
  it.each([
    ['no state yet', undefined],
    ['a provider that does not run claude', { ...untrusted, appliesFrom: 'n/a' } as FolderTrustEntry],
  ])('renders nothing for %s', (_label, entry) => {
    const { container } = render(<FolderTrustBanner {...props({ entry })} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('FolderTrustBanner dialog layout', () => {
  it('scrolls the summary inside the dialog so the buttons stay reachable', () => {
    render(<FolderTrustBanner {...props()} />)
    fireEvent.click(screen.getByTestId('folder-trust-review'))
    const scroll = screen.getByTestId('folder-trust-summary-scroll')
    expect(scroll.style.overflowY).toBe('auto')
    expect(scroll.style.maxHeight).not.toBe('')
    // The buttons are outside the scrolling area.
    expect(within(scroll).queryByTestId('folder-trust-confirm')).toBeNull()
    expect(screen.getByTestId('folder-trust-confirm')).toBeInTheDocument()
  })
})

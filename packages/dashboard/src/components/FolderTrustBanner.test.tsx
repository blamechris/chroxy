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
  files: ['/p/.mcp.json', '/p/.claude/settings.json'],
  mcpServers: [{ file: '/p/.mcp.json', name: 'github', command: 'npx', args: ['-y', 'server-github'], envKeys: ['GITHUB_TOKEN'] }],
  hooks: [{ file: '/p/.claude/settings.json', event: 'PreToolUse', commands: ['echo checking'] }],
  statusLine: [{ file: '/p/.claude/settings.json', command: 'status.sh' }],
  enabledPlugins: [{ file: '/p/.claude/settings.json', plugin: 'tools@market' }],
  counts: { agents: 2, skills: 1, commands: 0 },
  warnings: [],
}
const untrusted: FolderTrustEntry = { status: 'untrusted', summary, appliesFrom: 'restart' }
const trusted: FolderTrustEntry = { status: 'trusted', summary, appliesFrom: 'next_turn' }

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
    expect(within(dialog).getAllByTestId('folder-trust-file').map((n) => n.textContent)).toEqual(summary.files)
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

describe('<FolderTrustBanner> nothing to show', () => {
  it.each([
    ['none', { status: 'none', appliesFrom: 'next_turn' } as FolderTrustEntry],
    ['no state yet', undefined],
    ['a provider that does not run claude', { ...untrusted, appliesFrom: 'n/a' } as FolderTrustEntry],
  ])('renders nothing for %s', (_label, entry) => {
    const { container } = render(<FolderTrustBanner {...props({ entry })} />)
    expect(container).toBeEmptyDOMElement()
  })
})

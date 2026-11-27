import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const writeTextMock = vi.hoisted(() => vi.fn<(t: string) => Promise<boolean>>())
vi.mock('../utils/clipboard', () => ({ writeText: writeTextMock }))

import { DiagnosticsSettingsSection } from './DiagnosticsSettingsSection'
import { __resetErrorHistoryForTests, readErrorHistory, recordDashboardError } from '../utils/error-history'

const propError = (prop: string) => new TypeError(`Cannot read properties of undefined (reading '${prop}')`)

beforeEach(() => {
  localStorage.clear()
  __resetErrorHistoryForTests()
  writeTextMock.mockReset()
})
afterEach(cleanup)

describe('DiagnosticsSettingsSection', () => {
  it('shows the empty state and the privacy note', () => {
    render(<DiagnosticsSettingsSection />)
    expect(screen.getByTestId('diagnostics-empty')).toBeInTheDocument()
    expect(screen.getByTestId('diagnostics-section')).toHaveTextContent(
      'Stored only in this browser. Messages are kept only when they match known engine error templates; nothing is uploaded.',
    )
    expect(screen.queryByTestId('diagnostics-clear')).not.toBeInTheDocument()
  })

  it('lists entries with time, category, message, count and version', () => {
    recordDashboardError({ category: 'window-error', error: propError('dimensions') })
    recordDashboardError({ category: 'window-error', error: propError('dimensions') })
    recordDashboardError({ category: 'unhandled-rejection', error: 'PRIVATE' })
    render(<DiagnosticsSettingsSection />)
    const list = screen.getByTestId('diagnostics-list')
    expect(list.querySelectorAll('li')).toHaveLength(2)
    expect(list).toHaveTextContent("TypeError: Cannot read properties of undefined (reading 'dimensions')")
    expect(list).toHaveTextContent('Window error')
    expect(list).toHaveTextContent('Unhandled rejection')
    expect(list).toHaveTextContent('[message omitted]')
    expect(list).not.toHaveTextContent('PRIVATE')
    const first = readErrorHistory().find(e => e.template === 'read-props-of')!
    expect(screen.getByTestId(`diagnostics-count-${first.id}`)).toHaveTextContent('×2')
    expect(list.querySelector('time')!.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('selecting an entry shows its stack and the exact report preview', () => {
    recordDashboardError({ category: 'window-error', error: propError('dimensions') })
    render(<DiagnosticsSettingsSection />)
    const id = readErrorHistory()[0]!.id
    expect(screen.queryByTestId('diagnostics-report')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId(`diagnostics-select-${id}`))
    expect(screen.getByTestId('diagnostics-stack')).toBeInTheDocument()
    const preview = screen.getByTestId('diagnostics-report').textContent!
    expect(preview).toMatch(/^Chroxy dashboard error report\n/)
    expect(preview).toContain("Message: Cannot read properties of undefined (reading 'dimensions')")
    expect(preview).toContain('Category: window-error')
    fireEvent.click(screen.getByTestId(`diagnostics-select-${id}`))
    expect(screen.queryByTestId('diagnostics-report')).not.toBeInTheDocument()
  })

  it('Copy report copies exactly the preview text', async () => {
    writeTextMock.mockResolvedValue(true)
    recordDashboardError({ category: 'render', error: propError('dimensions'), componentStack: '\n    at Chart\n    at App' })
    render(<DiagnosticsSettingsSection />)
    fireEvent.click(screen.getByTestId(`diagnostics-select-${readErrorHistory()[0]!.id}`))
    const preview = screen.getByTestId('diagnostics-report').textContent!
    fireEvent.click(screen.getByTestId('diagnostics-copy'))
    await waitFor(() => expect(screen.getByTestId('diagnostics-copy-status')).toHaveTextContent('Copied'))
    expect(writeTextMock).toHaveBeenCalledTimes(1)
    expect(writeTextMock.mock.calls[0]![0]).toBe(preview)
    expect(preview).toContain('Component stack:')
  })

  it('reports a failed copy', async () => {
    writeTextMock.mockResolvedValue(false)
    recordDashboardError({ category: 'window-error', error: propError('dimensions') })
    render(<DiagnosticsSettingsSection />)
    fireEvent.click(screen.getByTestId(`diagnostics-select-${readErrorHistory()[0]!.id}`))
    fireEvent.click(screen.getByTestId('diagnostics-copy'))
    await waitFor(() => expect(screen.getByTestId('diagnostics-copy-status')).toHaveTextContent('Copy failed'))
  })

  it('Clear history empties the list and the storage', () => {
    recordDashboardError({ category: 'window-error', error: propError('dimensions') })
    render(<DiagnosticsSettingsSection />)
    fireEvent.click(screen.getByTestId('diagnostics-clear'))
    expect(screen.getByTestId('diagnostics-empty')).toBeInTheDocument()
    expect(readErrorHistory()).toEqual([])
  })

  it('updates live when a new error is recorded', () => {
    render(<DiagnosticsSettingsSection />)
    expect(screen.getByTestId('diagnostics-empty')).toBeInTheDocument()
    act(() => recordDashboardError({ category: 'window-error', error: propError('dimensions') }))
    expect(screen.getByTestId('diagnostics-list').querySelectorAll('li')).toHaveLength(1)
  })

  it('never renders a poisoned stored message raw', () => {
    const now = new Date().toISOString()
    localStorage.setItem('chroxy_error_history_v1', JSON.stringify([{
      id: 'abc123', time: now, firstTime: now, count: 1, category: 'render', platform: 'web', version: '1.0.0',
      name: 'Error', template: 'x', text: 'PRIVATE SESSION CONTENT', stack: ['PRIVATE'], componentStack: ['PRIVATE x'],
    }]))
    render(<DiagnosticsSettingsSection />)
    fireEvent.click(screen.getByTestId('diagnostics-select-abc123'))
    expect(screen.getByTestId('diagnostics-section').textContent).not.toContain('PRIVATE')
  })
})

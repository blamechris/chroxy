/**
 * ControlRoomView (#5253) — the Control Room two-tab shell.
 *
 * Covers: both tabs render, the repos tab is the default, clicking a tab swaps
 * the active section, the choice is persisted to localStorage and restored on
 * the next mount, a stale/garbage persisted value degrades to the default, and
 * onInvestigate is forwarded to the repo section.
 *
 * The two child sections each read the zustand store; stub them so this test
 * only exercises the tab shell.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('./ControlRoomSection', () => ({
  ControlRoomSection: ({ onInvestigate }: { onInvestigate?: unknown }) => (
    <div data-testid="stub-repos" data-has-investigate={onInvestigate ? 'yes' : 'no'}>repos</div>
  ),
}))
vi.mock('./RunnerStatusSection', () => ({
  RunnerStatusSection: () => <div data-testid="stub-runners">runners</div>,
}))

import { ControlRoomView } from './ControlRoomView'

const KEY = 'chroxy_cr_tab'

beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)

describe('ControlRoomView', () => {
  it('renders both tabs and defaults to the repos section', () => {
    render(<ControlRoomView />)
    expect(screen.getByTestId('cr-tab-repos')).toBeTruthy()
    expect(screen.getByTestId('cr-tab-runners')).toBeTruthy()
    expect(screen.getByTestId('stub-repos')).toBeTruthy()
    expect(screen.queryByTestId('stub-runners')).toBeNull()
    expect(screen.getByTestId('cr-tab-repos').getAttribute('aria-selected')).toBe('true')
  })

  it('switches to the runners section when its tab is clicked, and persists it', () => {
    render(<ControlRoomView />)
    fireEvent.click(screen.getByTestId('cr-tab-runners'))
    expect(screen.getByTestId('stub-runners')).toBeTruthy()
    expect(screen.queryByTestId('stub-repos')).toBeNull()
    expect(screen.getByTestId('cr-tab-runners').getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem(KEY)).toBe('runners')
  })

  it('restores the persisted tab on the next mount', () => {
    localStorage.setItem(KEY, 'runners')
    render(<ControlRoomView />)
    expect(screen.getByTestId('stub-runners')).toBeTruthy()
  })

  it('degrades a garbage persisted value to the default tab', () => {
    localStorage.setItem(KEY, 'bogus')
    render(<ControlRoomView />)
    expect(screen.getByTestId('stub-repos')).toBeTruthy()
  })

  it('forwards onInvestigate to the repo section', () => {
    render(<ControlRoomView onInvestigate={() => {}} />)
    expect(screen.getByTestId('stub-repos').getAttribute('data-has-investigate')).toBe('yes')
  })

  it('honours an explicit initialTab override', () => {
    render(<ControlRoomView initialTab="runners" />)
    expect(screen.getByTestId('stub-runners')).toBeTruthy()
  })
})

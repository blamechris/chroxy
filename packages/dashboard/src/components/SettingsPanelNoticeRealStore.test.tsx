/**
 * #8277 — REAL connection store (not the mock the sibling suites use): the
 * dismissal in Settings must clear the notice New Session reads.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SettingsPanel } from './SettingsPanel'
import { SessionDefaultsNoticeBanner } from './CreateSessionModal'
import { useConnectionStore } from '../store/connection'

afterEach(() => {
  cleanup()
  useConnectionStore.setState({ sessionDefaultsNotice: null })
})

describe('migration notice dismissal across surfaces (real store, #8277)', () => {
  it('dismissing in Settings clears it for New Session', () => {
    useConnectionStore.setState({
      sessionDefaultsNotice: { model: 'opus-4-6' },
      availableProviders: [{ name: 'claude-sdk' }] as never,
      defaultProvider: 'claude-sdk',
    })
    render(
      <>
        <SettingsPanel isOpen onClose={() => {}} />
        <div data-testid="new-session"><SessionDefaultsNoticeBanner provider="claude-sdk" /></div>
      </>,
    )
    expect(screen.getAllByTestId('session-defaults-notice')).toHaveLength(2)
    fireEvent.click(screen.getAllByTestId('session-defaults-notice-dismiss')[0]!)
    expect(useConnectionStore.getState().sessionDefaultsNotice).toBeNull()
    expect(screen.queryAllByTestId('session-defaults-notice')).toHaveLength(0)
  })
})

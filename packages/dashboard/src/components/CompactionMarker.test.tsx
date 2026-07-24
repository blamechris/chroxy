/**
 * CompactionMarker component tests (#6768).
 *
 * Covers the "Context compacted" marker rendered for a parsed
 * compact_boundary SDK/CLI event — token delta, duration, and
 * manual-vs-auto trigger, plus the graceful-degradation paths when the
 * SDK/CLI itself omitted a sub-field.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CompactionMarker } from './CompactionMarker'
import type { CompactBoundaryMeta } from '../store/types'

afterEach(cleanup)

describe('CompactionMarker (#6768)', () => {
  it('renders the token delta, duration, and trigger for a well-formed auto-compaction', () => {
    const meta: CompactBoundaryMeta = {
      trigger: 'auto',
      preTokens: 128_000,
      postTokens: 12_000,
      durationMs: 2_500,
    }
    render(<CompactionMarker meta={meta} />)
    const marker = screen.getByTestId('compaction-marker')
    expect(marker).toHaveTextContent('Context compacted')
    expect(marker).toHaveTextContent('128,000 → 12,000 tokens')
    expect(marker).toHaveTextContent('2s')
    expect(marker).toHaveTextContent('auto')
  })

  it('labels a manual /compact distinctly from auto-compaction', () => {
    const meta: CompactBoundaryMeta = {
      trigger: 'manual',
      preTokens: 50_000,
      postTokens: 8_000,
      durationMs: 1_000,
    }
    render(<CompactionMarker meta={meta} />)
    expect(screen.getByTestId('compaction-marker')).toHaveTextContent('manual')
  })

  it('omits the token clause when both counts are unknown, without crashing', () => {
    const meta: CompactBoundaryMeta = { trigger: 'auto', preTokens: null, postTokens: null, durationMs: null }
    render(<CompactionMarker meta={meta} />)
    const marker = screen.getByTestId('compaction-marker')
    expect(marker).toHaveTextContent('Context compacted')
    expect(marker).not.toHaveTextContent('tokens')
  })

  it('renders "?" for a single missing token count rather than dropping the whole clause', () => {
    const meta: CompactBoundaryMeta = { trigger: 'auto', preTokens: 90_000, postTokens: null, durationMs: null }
    render(<CompactionMarker meta={meta} />)
    expect(screen.getByTestId('compaction-marker')).toHaveTextContent('90,000 → ? tokens')
  })
})

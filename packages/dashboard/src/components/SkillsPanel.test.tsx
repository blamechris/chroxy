/**
 * SkillsPanel tests — manual-skill toggles for #3209.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SkillsPanel, type SkillsPanelProps } from './SkillsPanel'

afterEach(cleanup)

const NOOP = () => {}

function renderPanel(overrides: Partial<SkillsPanelProps> = {}) {
  const props: SkillsPanelProps = {
    skills: undefined,
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    onClose: NOOP,
    ...overrides,
  }
  return render(<SkillsPanel {...props} />)
}

describe('SkillsPanel (#3209)', () => {
  it('renders an empty state when no skills are loaded', () => {
    renderPanel({ skills: [] })
    expect(screen.getByTestId('skills-panel-empty')).toBeInTheDocument()
  })

  it('renders an empty state when skills is undefined (pre-list_skills)', () => {
    renderPanel({ skills: undefined })
    expect(screen.getByTestId('skills-panel-empty')).toBeInTheDocument()
  })

  it('separates auto and manual skills under distinct headings', () => {
    renderPanel({
      skills: [
        { name: 'auto-1', activation: 'auto', active: true },
        { name: 'manual-1', activation: 'manual', active: false },
      ],
    })
    // Auto skill renders without a checkbox (read-only).
    expect(screen.getByTestId('skill-item-auto-1')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-toggle-auto-1')).toBeNull()
    // Manual skill renders with a checkbox.
    expect(screen.getByTestId('skill-toggle-manual-1')).toBeInTheDocument()
  })

  it('reflects active=true as a checked checkbox', () => {
    renderPanel({
      skills: [{ name: 'manual-on', activation: 'manual', active: true }],
    })
    const cb = screen.getByTestId('skill-toggle-manual-on') as HTMLInputElement
    expect(cb.checked).toBe(true)
  })

  it('reflects active=false as an unchecked checkbox', () => {
    renderPanel({
      skills: [{ name: 'manual-off', activation: 'manual', active: false }],
    })
    const cb = screen.getByTestId('skill-toggle-manual-off') as HTMLInputElement
    expect(cb.checked).toBe(false)
  })

  it('calls onActivate when the user toggles a manual skill on', () => {
    const onActivate = vi.fn()
    renderPanel({
      skills: [{ name: 'foo', activation: 'manual', active: false }],
      onActivate,
    })
    fireEvent.click(screen.getByTestId('skill-toggle-foo'))
    expect(onActivate).toHaveBeenCalledWith('foo')
  })

  it('calls onDeactivate when the user toggles a manual skill off', () => {
    const onDeactivate = vi.fn()
    renderPanel({
      skills: [{ name: 'foo', activation: 'manual', active: true }],
      onDeactivate,
    })
    fireEvent.click(screen.getByTestId('skill-toggle-foo'))
    expect(onDeactivate).toHaveBeenCalledWith('foo')
  })

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn()
    renderPanel({ skills: [], onClose })
    fireEvent.click(screen.getByTestId('skills-panel-close'))
    expect(onClose).toHaveBeenCalled()
  })

  it('treats unknown activation as auto (default behaviour)', () => {
    // Pre-#3209 servers don't send `activation` — those entries
    // should render as auto, not as manual toggles.
    renderPanel({
      skills: [{ name: 'legacy', active: true }],
    })
    expect(screen.queryByTestId('skill-toggle-legacy')).toBeNull()
    expect(screen.getByTestId('skill-item-legacy')).toBeInTheDocument()
  })
})

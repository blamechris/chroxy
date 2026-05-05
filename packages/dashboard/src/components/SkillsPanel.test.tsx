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
    canToggle: true,
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

  // #3246: subprocess providers (Codex, Gemini, Claude CLI) don't
  // honour mid-session toggles — the SkillsPanel must surface this
  // as a disabled checkbox + explanatory note rather than silently
  // letting the user click a non-functional control.
  describe('canToggle gate (#3246)', () => {
    it('disables manual-skill checkboxes when canToggle is false', () => {
      renderPanel({
        canToggle: false,
        skills: [{ name: 'manual-1', activation: 'manual', active: false }],
      })
      const cb = screen.getByTestId('skill-toggle-manual-1') as HTMLInputElement
      expect(cb.disabled).toBe(true)
    })

    it('shows the no-toggle note when canToggle is false and manual skills exist', () => {
      renderPanel({
        canToggle: false,
        skills: [{ name: 'manual-1', activation: 'manual', active: false }],
      })
      expect(screen.getByTestId('skills-panel-no-toggle-note')).toBeInTheDocument()
    })

    it('does not show the no-toggle note when there are no manual skills', () => {
      renderPanel({
        canToggle: false,
        skills: [{ name: 'auto-1', activation: 'auto', active: true }],
      })
      expect(screen.queryByTestId('skills-panel-no-toggle-note')).toBeNull()
    })

    it('does not show the no-toggle note when canToggle is true', () => {
      renderPanel({
        canToggle: true,
        skills: [{ name: 'manual-1', activation: 'manual', active: false }],
      })
      expect(screen.queryByTestId('skills-panel-no-toggle-note')).toBeNull()
    })

    it('defaults canToggle to false (read-only) when prop is omitted', () => {
      // Render without the prop — older callers / future providers
      // that haven't enumerated their capability shouldn't get a
      // functional toggle by default.
      const props: Partial<SkillsPanelProps> = {
        skills: [{ name: 'manual-1', activation: 'manual', active: false }],
      }
      delete (props as Record<string, unknown>).canToggle
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(<SkillsPanel {...(props as any)} onActivate={vi.fn()} onDeactivate={vi.fn()} onClose={NOOP} />)
      const cb = screen.getByTestId('skill-toggle-manual-1') as HTMLInputElement
      expect(cb.disabled).toBe(true)
    })
  })

  // #3205: skills metadata UI. Each skill row carries optional
  // `version`, `hashPrefix`, `firstSeen`, `lastVerified`, plus a
  // mismatch flag rendered when the skill name appears in
  // `mismatchedSkillNames`. All fields degrade gracefully on absence.
  describe('skills metadata (#3205)', () => {
    it('renders source, version, hash, and last-verified when present', () => {
      renderPanel({
        skills: [{
          name: 'auditable',
          activation: 'auto',
          active: true,
          source: 'global',
          version: '1.2.3',
          hashPrefix: 'abcdef01',
          // Use a stable timestamp far enough in the past to render
          // as a date (deterministic across CI timezones).
          lastVerified: '2025-01-15T12:00:00.000Z',
        }],
      })
      expect(screen.getByTestId('skill-meta-source-auditable')).toHaveTextContent(/source.*global/i)
      expect(screen.getByTestId('skill-meta-version-auditable')).toHaveTextContent(/version.*1\.2\.3/i)
      expect(screen.getByTestId('skill-meta-hash-auditable')).toHaveTextContent(/hash.*abcdef01/i)
      expect(screen.getByTestId('skill-meta-last-verified-auditable')).toBeInTheDocument()
    })

    it('omits metadata fields entirely when none are present (older server)', () => {
      renderPanel({
        skills: [{ name: 'minimal', activation: 'auto', active: true }],
      })
      expect(screen.queryByTestId('skill-meta-source-minimal')).toBeNull()
      expect(screen.queryByTestId('skill-meta-version-minimal')).toBeNull()
      expect(screen.queryByTestId('skill-meta-hash-minimal')).toBeNull()
      expect(screen.queryByTestId('skill-meta-last-verified-minimal')).toBeNull()
    })

    it('renders only the fields that have values (version present, hash absent)', () => {
      renderPanel({
        skills: [{ name: 'partial', activation: 'auto', active: true, version: '0.1.0' }],
      })
      expect(screen.getByTestId('skill-meta-version-partial')).toHaveTextContent(/0\.1\.0/)
      expect(screen.queryByTestId('skill-meta-hash-partial')).toBeNull()
    })

    it('renders mismatch flag when skill name is in mismatchedSkillNames', () => {
      renderPanel({
        skills: [{ name: 'changed', activation: 'auto', active: true }],
        mismatchedSkillNames: new Set(['changed']),
      })
      expect(screen.getByTestId('skill-mismatch-changed')).toBeInTheDocument()
    })

    it('does not render mismatch flag when skill is not in the mismatch set', () => {
      renderPanel({
        skills: [{ name: 'clean', activation: 'auto', active: true }],
        mismatchedSkillNames: new Set(['other-skill']),
      })
      expect(screen.queryByTestId('skill-mismatch-clean')).toBeNull()
    })

    it('does not render mismatch flag when mismatchedSkillNames is omitted', () => {
      renderPanel({
        skills: [{ name: 'noflag', activation: 'auto', active: true }],
      })
      expect(screen.queryByTestId('skill-mismatch-noflag')).toBeNull()
    })

    it('renders mismatch flag for manual skills too', () => {
      renderPanel({
        skills: [{ name: 'manual-changed', activation: 'manual', active: false }],
        mismatchedSkillNames: new Set(['manual-changed']),
      })
      expect(screen.getByTestId('skill-mismatch-manual-changed')).toBeInTheDocument()
    })

    // #3251 — clicking the mismatch flag must NOT toggle the checkbox.
    // Browser <label> association would tick the checkbox if the flag
    // sits inside the label; the operator hovers the warning to read
    // the tooltip and accidentally activates a skill they were about
    // to inspect more carefully. The flag is rendered as a sibling of
    // the <label> so it stays hoverable without firing the toggle.
    it('clicking the mismatch flag does not toggle the manual-skill checkbox (#3251)', () => {
      const onActivate = vi.fn()
      const onDeactivate = vi.fn()
      renderPanel({
        skills: [{ name: 'risky', activation: 'manual', active: false }],
        mismatchedSkillNames: new Set(['risky']),
        canToggle: true,
        onActivate,
        onDeactivate,
      })

      const flag = screen.getByTestId('skill-mismatch-risky')
      fireEvent.click(flag)

      expect(onActivate).not.toHaveBeenCalled()
      expect(onDeactivate).not.toHaveBeenCalled()
      expect((screen.getByTestId('skill-toggle-risky') as HTMLInputElement).checked).toBe(false)
    })

    it('handles malformed timestamps without crashing (returns raw string)', () => {
      // Defensive — if a future server emits a non-ISO timestamp,
      // the component must still render rather than throwing.
      renderPanel({
        skills: [{
          name: 'bad-time',
          activation: 'auto',
          active: true,
          lastVerified: 'not-a-real-timestamp',
        }],
      })
      expect(screen.getByTestId('skill-meta-last-verified-bad-time')).toBeInTheDocument()
    })
  })

  // #3270: 'Accept new content' affordance for mismatched skills. Pairs
  // with #3269's `skill_trust_accept` WS message — clicking the button
  // calls the onAcceptTrust prop (which the App wires to the store
  // action that sends the WS message). Server broadcasts back
  // `skill_trust_accepted`, which the message-handler uses to remove the
  // skill name from `mismatchedSkillNames`, clearing the badge.
  describe("'Accept new content' button (#3270)", () => {
    it('renders an Accept button next to the mismatch flag (auto skill)', () => {
      renderPanel({
        skills: [{ name: 'changed', activation: 'auto', active: true }],
        mismatchedSkillNames: new Set(['changed']),
        onAcceptTrust: vi.fn(),
      })
      expect(screen.getByTestId('skill-accept-trust-changed')).toBeInTheDocument()
    })

    it('renders an Accept button next to the mismatch flag (manual skill)', () => {
      renderPanel({
        skills: [{ name: 'manual-changed', activation: 'manual', active: false }],
        mismatchedSkillNames: new Set(['manual-changed']),
        onAcceptTrust: vi.fn(),
      })
      expect(screen.getByTestId('skill-accept-trust-manual-changed')).toBeInTheDocument()
    })

    it('calls onAcceptTrust(skillName) when clicked', () => {
      const onAcceptTrust = vi.fn()
      renderPanel({
        skills: [{ name: 'changed', activation: 'auto', active: true }],
        mismatchedSkillNames: new Set(['changed']),
        onAcceptTrust,
      })
      fireEvent.click(screen.getByTestId('skill-accept-trust-changed'))
      expect(onAcceptTrust).toHaveBeenCalledTimes(1)
      expect(onAcceptTrust).toHaveBeenCalledWith('changed')
    })

    it('does NOT render the Accept button when the skill is not in mismatchedSkillNames', () => {
      renderPanel({
        skills: [{ name: 'clean', activation: 'auto', active: true }],
        mismatchedSkillNames: new Set(['other-skill']),
        onAcceptTrust: vi.fn(),
      })
      expect(screen.queryByTestId('skill-accept-trust-clean')).toBeNull()
    })

    it('does NOT render the Accept button when onAcceptTrust prop is omitted (back-compat)', () => {
      renderPanel({
        skills: [{ name: 'changed', activation: 'auto', active: true }],
        mismatchedSkillNames: new Set(['changed']),
        // onAcceptTrust intentionally omitted
      })
      expect(screen.queryByTestId('skill-accept-trust-changed')).toBeNull()
      // Mismatch flag should still appear — just not the button.
      expect(screen.getByTestId('skill-mismatch-changed')).toBeInTheDocument()
    })

    it('clicking the Accept button does NOT toggle the checkbox (manual skill)', () => {
      // The button sits inside the same .skill-row flex container as the
      // <label>, but as a sibling to <label>, so clicking it must not
      // bubble into the label-association and flip the checkbox.
      const onActivate = vi.fn()
      const onDeactivate = vi.fn()
      const onAcceptTrust = vi.fn()
      renderPanel({
        skills: [{ name: 'risky', activation: 'manual', active: false }],
        mismatchedSkillNames: new Set(['risky']),
        onActivate,
        onDeactivate,
        onAcceptTrust,
      })

      fireEvent.click(screen.getByTestId('skill-accept-trust-risky'))

      expect(onAcceptTrust).toHaveBeenCalledWith('risky')
      // Toggle handlers MUST NOT fire from the Accept click.
      expect(onActivate).not.toHaveBeenCalled()
      expect(onDeactivate).not.toHaveBeenCalled()
      expect((screen.getByTestId('skill-toggle-risky') as HTMLInputElement).checked).toBe(false)
    })

    it('Accept button has an aria-label so screen readers announce it', () => {
      renderPanel({
        skills: [{ name: 'changed', activation: 'auto', active: true }],
        mismatchedSkillNames: new Set(['changed']),
        onAcceptTrust: vi.fn(),
      })
      const btn = screen.getByTestId('skill-accept-trust-changed')
      expect(btn).toHaveAttribute('aria-label')
      expect(btn.getAttribute('aria-label')).toMatch(/accept|trust/i)
    })
  })

  // #3298: "Pending review" section for community skills awaiting
  // first-activation trust grant. Rendered above Always-on / Manual,
  // gated on capabilities.skillTrustGrant === true.
  describe("'Pending review' section (#3298)", () => {
    it('renders the pending section when capability is true and entries exist', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        onGrantTrust: vi.fn(),
        capabilities: { skillTrustGrant: true },
      })
      expect(screen.getByTestId('skills-panel-pending-section')).toBeInTheDocument()
    })

    it('does not render the pending section when capability is false', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        onGrantTrust: vi.fn(),
        capabilities: { skillTrustGrant: false },
      })
      expect(screen.queryByTestId('skills-panel-pending-section')).toBeNull()
    })

    it('does not render the pending section when capabilities is omitted', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        onGrantTrust: vi.fn(),
        // capabilities intentionally omitted
      })
      expect(screen.queryByTestId('skills-panel-pending-section')).toBeNull()
    })

    it('does not render the pending section when pendingCommunitySkills is empty', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [],
        onGrantTrust: vi.fn(),
        capabilities: { skillTrustGrant: true },
      })
      expect(screen.queryByTestId('skills-panel-pending-section')).toBeNull()
    })

    it('does not render the pending section when onGrantTrust is omitted', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        // onGrantTrust intentionally omitted
        capabilities: { skillTrustGrant: true },
      })
      expect(screen.queryByTestId('skills-panel-pending-section')).toBeNull()
    })

    it('renders a Trust button per pending entry with correct testid', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [
          { name: 'skill-a', author: 'alice' },
          { name: 'skill-b', author: 'bob' },
        ],
        onGrantTrust: vi.fn(),
        capabilities: { skillTrustGrant: true },
      })
      expect(screen.getByTestId('skill-grant-trust-alice/skill-a')).toBeInTheDocument()
      expect(screen.getByTestId('skill-grant-trust-bob/skill-b')).toBeInTheDocument()
    })

    it('calls onGrantTrust(skillName, author) when Trust button is clicked', () => {
      const onGrantTrust = vi.fn()
      renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        onGrantTrust,
        capabilities: { skillTrustGrant: true },
      })
      fireEvent.click(screen.getByTestId('skill-grant-trust-alice/alice-skill'))
      expect(onGrantTrust).toHaveBeenCalledTimes(1)
      expect(onGrantTrust).toHaveBeenCalledWith('alice-skill', 'alice')
    })

    it('section disappears when pendingCommunitySkills becomes empty', () => {
      const { rerender } = renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        onGrantTrust: vi.fn(),
        capabilities: { skillTrustGrant: true },
      })
      expect(screen.getByTestId('skills-panel-pending-section')).toBeInTheDocument()

      rerender(
        <SkillsPanel
          skills={[]}
          pendingCommunitySkills={[]}
          onGrantTrust={vi.fn()}
          capabilities={{ skillTrustGrant: true }}
          onActivate={vi.fn()}
          onDeactivate={vi.fn()}
          onClose={NOOP}
        />,
      )
      expect(screen.queryByTestId('skills-panel-pending-section')).toBeNull()
    })

    it('Trust button has an aria-label for screen readers', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        onGrantTrust: vi.fn(),
        capabilities: { skillTrustGrant: true },
      })
      const btn = screen.getByTestId('skill-grant-trust-alice/alice-skill')
      expect(btn).toHaveAttribute('aria-label')
      expect(btn.getAttribute('aria-label')).toMatch(/trust|alice/i)
    })

    it('shows author in the skill row', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        onGrantTrust: vi.fn(),
        capabilities: { skillTrustGrant: true },
      })
      // The pending row shows "from: alice"
      expect(screen.getByText(/from: alice/i)).toBeInTheDocument()
    })

    it('renders empty state when no skills loaded AND no pending', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [],
        capabilities: { skillTrustGrant: true },
        onGrantTrust: vi.fn(),
      })
      expect(screen.getByTestId('skills-panel-empty')).toBeInTheDocument()
    })

    it('does NOT render empty state when there are pending entries (pending section is shown instead)', () => {
      renderPanel({
        skills: [],
        pendingCommunitySkills: [{ name: 'alice-skill', author: 'alice' }],
        onGrantTrust: vi.fn(),
        capabilities: { skillTrustGrant: true },
      })
      expect(screen.queryByTestId('skills-panel-empty')).toBeNull()
      expect(screen.getByTestId('skills-panel-pending-section')).toBeInTheDocument()
    })
  })
})

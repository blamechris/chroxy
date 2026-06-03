/**
 * ResumeUnknownChip tests — #4947
 *
 * Asserts the dedicated chip (not the generic red error bubble) renders for
 * `error{code: 'resume_unknown'}` (server PR #4944). The server emits this
 * code when claude CLI rejects a `--resume <id>` because the conversation id
 * is unknown locally (operator wiped ~/.claude/projects/ between chroxy boots,
 * restored a state file from a different machine, etc.). The CLI session
 * auto-falls-back to a fresh conversation — the chip surfaces that as a
 * calm, operator-friendly explanation instead of the loud red crash toast.
 *
 * Mirrors the StreamStallChip / AskUserQuestionStallChip patterns (#4476,
 * #4615): operator-friendly headline, raw server text preserved via the
 * title attribute for diagnostics, distinct testID so E2E and integration
 * tests can disambiguate this affordance from the other stall chips and
 * the generic error bubble.
 *
 * Adds: `attemptedResumeId` subtext for operator correlation against the
 * persisted session-state.json (`resumeConversationId` field). The
 * attempted id is the one the chroxy server passed to `claude --resume`,
 * which is exactly what's missing from `~/.claude/projects/` — surfacing
 * it lets the operator confirm WHICH conversation was lost rather than
 * having to grep server logs.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ResumeUnknownChip } from './ResumeUnknownChip'

afterEach(cleanup)

describe('ResumeUnknownChip (#4947)', () => {
  it('renders an operator-friendly headline explaining the auto-fallback', () => {
    render(
      <ResumeUnknownChip errorText="Previous Claude conversation could not be resumed (the id is unknown to the local claude CLI)." />,
    )
    const chip = screen.getByTestId('resume-unknown-chip')
    expect(chip).toBeInTheDocument()
    // Headline must explain the situation, not the jargon-y server text.
    // Match on the user-facing concept: the prior conversation is gone and
    // a fresh one is starting. Operator must understand they aren't losing
    // anything else (chroxy ring buffer transcript is preserved in the UI).
    expect(chip.textContent).toMatch(/previous conversation/i)
    expect(chip.textContent).toMatch(/starting fresh/i)
  })

  it('preserves the raw server error text via the title attribute', () => {
    // Operators investigating a recurring resume-failure pattern need the
    // underlying server message — the chip's prose is friendly, but the
    // diagnostic detail must remain accessible via tooltip without losing it.
    const raw =
      'Previous Claude conversation could not be resumed (the id is unknown to the local claude CLI — ' +
      'it may have been wiped from ~/.claude/projects/). Starting a fresh conversation; the model will ' +
      'not see the earlier transcript.'
    render(<ResumeUnknownChip errorText={raw} />)
    const chip = screen.getByTestId('resume-unknown-chip')
    expect(chip.getAttribute('title')).toBe(raw)
  })

  it('surfaces attemptedResumeId in a subtext slot when provided', () => {
    // Acceptance criterion: `attemptedResumeId` surfaced somewhere for
    // operator correlation against the persisted state file. We render it
    // as a small mono-spaced subtext under the headline so the operator
    // can copy/grep without leaving the chat.
    render(
      <ResumeUnknownChip
        errorText="x"
        attemptedResumeId="abc123-def456-7890"
      />,
    )
    const subtext = screen.getByTestId('resume-unknown-chip-id')
    expect(subtext).toBeInTheDocument()
    expect(subtext.textContent).toContain('abc123-def456-7890')
  })

  it('omits the attemptedResumeId subtext when the id is missing', () => {
    // Older servers (pre-#4944) and the rare edge where the resume-failure
    // path fires without an attempt tracked (defensive, shouldn't happen in
    // practice) must not render an empty "id:" slot. The headline alone is
    // still useful — the chip degrades cleanly to "no extra correlation hint".
    render(<ResumeUnknownChip errorText="x" />)
    expect(screen.queryByTestId('resume-unknown-chip-id')).toBeNull()
  })

  it('omits the attemptedResumeId subtext when the id is an empty string', () => {
    // Empty string is treated as missing — rendering "Attempted id:" with
    // no value would look broken.
    render(<ResumeUnknownChip errorText="x" attemptedResumeId="" />)
    expect(screen.queryByTestId('resume-unknown-chip-id')).toBeNull()
  })

  it('uses role="status" so assistive tech announces the fallback non-disruptively', () => {
    // Same accessibility rationale as StreamStallChip / AskUserQuestionStallChip:
    // this is recoverable (the server has already auto-fallen-back to a fresh
    // conversation, no operator action needed), so announce with `polite`
    // live-region semantics rather than the assertive `alert` role used for
    // destructive errors.
    render(<ResumeUnknownChip errorText="x" />)
    const chip = screen.getByTestId('resume-unknown-chip')
    expect(chip.getAttribute('role')).toBe('status')
  })

  it('does not collide with the StreamStallChip or AskUserQuestionStallChip testIDs', () => {
    // All three chips share the amber-warning palette; the testID
    // disambiguates so integration tests can target the correct affordance.
    render(<ResumeUnknownChip errorText="x" attemptedResumeId="x" />)
    expect(screen.queryByTestId('stream-stall-chip')).toBeNull()
    expect(screen.queryByTestId('ask-user-question-stall-chip')).toBeNull()
  })

  // #5006: terminal-escalation variant for `resume_unknown_exhausted`
  // (server PR #5004). When the post-fallback retry ALSO matches the
  // unknown-resume pattern, the server has stopped auto-respawning — the
  // user MUST start a fresh session manually. The chip switches to a
  // distinct headline that conveys "auto-recovery exhausted" so the
  // operator doesn't think this is the recoverable amber chip on its
  // second occurrence and wait for an auto-fallback that isn't coming.
  describe('variant="exhausted" (#5006 — terminal escalation)', () => {
    it('renders a distinct "auto-recovery exhausted" headline', () => {
      render(
        <ResumeUnknownChip
          variant="exhausted"
          errorText="Auto-recovery exhausted: …"
        />,
      )
      const chip = screen.getByTestId('resume-unknown-chip')
      expect(chip).toBeInTheDocument()
      // Headline must convey the terminal nature (the operator action
      // required is "start a fresh session manually" — distinct from the
      // recoverable variant's "starting fresh" auto-fallback phrasing).
      expect(chip.textContent).toMatch(/auto-recovery|exhausted/i)
      expect(chip.textContent).toMatch(/start a (new|fresh) session/i)
      // Must NOT match the recoverable variant's headline — different
      // affordance, different copy.
      expect(chip.textContent).not.toMatch(/starting fresh/i)
    })

    it('still surfaces attemptedResumeId subtext on the exhausted variant', () => {
      // Operator-correlation requirement is the SAME for both variants —
      // the failed conversation id helps identify the persisted state-file
      // entry that needs investigating.
      render(
        <ResumeUnknownChip
          variant="exhausted"
          errorText="x"
          attemptedResumeId="abc123-def456-7890"
        />,
      )
      const subtext = screen.getByTestId('resume-unknown-chip-id')
      expect(subtext.textContent).toContain('abc123-def456-7890')
    })

    it('uses role="alert" so assistive tech announces the terminal state with urgency', () => {
      // Unlike the recoverable variant (which uses role="status" + polite
      // live-region — chroxy has already recovered), the exhausted variant
      // is terminal and demands user action. role="alert" matches the
      // accessibility convention for an escalated, assertive announcement.
      render(<ResumeUnknownChip variant="exhausted" errorText="x" />)
      const chip = screen.getByTestId('resume-unknown-chip')
      expect(chip.getAttribute('role')).toBe('alert')
    })

    it('defaults to the recoverable variant when no variant prop is passed (back-compat)', () => {
      // Existing call sites pass no variant — they must continue to render
      // the recoverable copy unchanged (variant: 'recoverable' is implicit).
      render(<ResumeUnknownChip errorText="x" />)
      const chip = screen.getByTestId('resume-unknown-chip')
      expect(chip.textContent).toMatch(/starting fresh/i)
      expect(chip.getAttribute('role')).toBe('status')
    })
  })
})

/**
 * #8264 — an Approve-mode AskUserQuestion permission card reads as a question,
 * not as the tool input printed as JSON.
 *
 * The server builds the card's `description` from the tool input, so for
 * AskUserQuestion it is `{"questions":[{"question":"Which color do you prefer?",…`
 * cut at 200 characters. The #4685 consent gate stays; what changes is that the
 * card renders the question and its options as text.
 *
 * Runs against the REAL dashboard store (like PermissionPrompt.dismiss-record),
 * so the dropped-record path (expire -> Dismiss) is exercised end to end.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { ChatMessage } from '@chroxy/store-core'
import { PermissionPrompt } from './PermissionPrompt'
import { useConnectionStore } from '../store/connection'
import { createEmptyConnectionScope } from '../store/utils'

const NOW = 1_700_000_000_000

// What the server broadcasts: the description is the input as JSON cut at 200
// chars (mid-string); `input` is the whole, redacted, structured tool input.
const INPUT = {
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'A warm, bold color' },
        { label: 'Blue', description: 'A cool, calming color that goes on for a long while' },
      ],
    },
  ],
}
const RAW_DESCRIPTION = JSON.stringify(INPUT).slice(0, 200)

function renderCard(overrides: Partial<Parameters<typeof PermissionPrompt>[0]> = {}) {
  return render(
    <PermissionPrompt
      requestId="req-aq"
      tool="AskUserQuestion"
      description={RAW_DESCRIPTION}
      remainingMs={300_000}
      onRespond={() => {}}
      toolInput={INPUT}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  useConnectionStore.setState({
    ...createEmptyConnectionScope(),
    connectionPhase: 'connected',
    activeSessionId: 's1',
    sessions: [],
    sessionStates: {
      s1: {
        messages: [
          { id: 'm-aq', type: 'prompt', content: 'AskUserQuestion: ' + RAW_DESCRIPTION, tool: 'AskUserQuestion', requestId: 'req-aq', expiresAt: NOW - 1_000, timestamp: 0 } as ChatMessage,
        ],
      },
    } as unknown as ReturnType<typeof useConnectionStore.getState>['sessionStates'],
  })
})

afterEach(cleanup)

describe('AskUserQuestion permission card (#8264)', () => {
  it('says Claude wants to ask a question, with the question text and every option as text', () => {
    renderCard()
    const card = screen.getByTestId('permission-prompt')
    expect(within(card).getByTestId('perm-ask-headline')).toHaveTextContent('Claude wants to ask you a question')
    expect(within(card).getByText('Which color do you prefer?')).toBeInTheDocument()
    expect(within(card).getByText('Red')).toBeInTheDocument()
    expect(within(card).getByText('Blue')).toBeInTheDocument()
  })

  it('never shows the tool input as JSON or a mid-string cut of it', () => {
    renderCard()
    const text = screen.getByTestId('permission-prompt').textContent ?? ''
    expect(text.includes('{"questions"')).toBe(false)
    expect(text.includes('"question":')).toBe(false)
    // The old card ended in a truncated JSON fragment; the description prop must not be echoed at all.
    expect(text.includes(RAW_DESCRIPTION.slice(-30))).toBe(false)
  })

  it('does not list the synthetic Other free-text option the question card appends', () => {
    renderCard()
    expect(screen.queryByText('Other')).not.toBeInTheDocument()
    expect(screen.getByTestId('permission-prompt').textContent?.includes('__chroxy_other__')).toBe(false)
  })

  it('lists several questions in order and counts them in the headline', () => {
    renderCard({
      toolInput: {
        questions: [
          { question: 'First?', options: [{ label: 'a' }, { label: 'b' }] },
          { question: 'Second?', multiSelect: true, options: [{ label: 'c' }, { label: 'd' }] },
        ],
      },
    })
    expect(screen.getByTestId('perm-ask-headline')).toHaveTextContent('Claude wants to ask you 2 questions')
    expect(screen.getByTestId('perm-ask-question-0')).toHaveTextContent('First?')
    expect(screen.getByTestId('perm-ask-question-1')).toHaveTextContent('Second?')
  })

  it('falls back to the headline alone, still without JSON, when the input is unusable (server-truncated)', () => {
    renderCard({ toolInput: { _truncated: true, summary: '{"questions":[{"question":"Wh... [truncated]' } })
    const card = screen.getByTestId('permission-prompt')
    expect(within(card).getByTestId('perm-ask-headline')).toHaveTextContent('Claude wants to ask you a question')
    expect(within(card).queryByTestId('perm-ask-questions')).not.toBeInTheDocument()
    expect(card.textContent?.includes('{"questions"')).toBe(false)
    expect(card.textContent?.includes('[truncated]')).toBe(false)
  })

  it('still offers Allow and Deny (the #4685 consent gate is kept)', () => {
    renderCard()
    expect(screen.getByRole('button', { name: 'Allow AskUserQuestion' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny AskUserQuestion' })).toBeInTheDocument()
  })

  it('names the question, not JSON, in the record kept after the card expires and is dismissed', () => {
    renderCard({ remainingMs: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss expired permission' }))
    const record = screen.getByTestId('perm-dropped-record')
    expect(record).toHaveTextContent('Which color do you prefer?')
    expect(record.textContent?.includes('{"questions"')).toBe(false)
  })
})

describe('other tools are unchanged by the AskUserQuestion card (#8264)', () => {
  it('a Bash card still prints "Bash: <description>" and no question headline', () => {
    render(
      <PermissionPrompt
        requestId="req-bash"
        tool="Bash"
        description="npm test"
        remainingMs={300_000}
        onRespond={() => {}}
        toolInput={INPUT}
      />,
    )
    const card = screen.getByTestId('permission-prompt')
    expect(card.querySelector('.perm-desc')?.textContent).toBe('Bash: npm test')
    expect(within(card).queryByTestId('perm-ask-headline')).not.toBeInTheDocument()
  })
})

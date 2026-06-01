/**
 * QuestionPrompt tests (#1193)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { OTHER_OPTION_VALUE } from '@chroxy/store-core'
import { QuestionPrompt, MultiQuestionForm } from './QuestionPrompt'

afterEach(cleanup)

describe('QuestionPrompt', () => {
  const options = [
    { label: 'Option A', value: 'a' },
    { label: 'Option B', value: 'b' },
    { label: 'Option C', value: 'c' },
  ]

  it('renders question text', () => {
    render(
      <QuestionPrompt
        question="Which approach?"
        options={options}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('Which approach?')).toBeInTheDocument()
  })

  it('renders all option buttons', () => {
    render(
      <QuestionPrompt
        question="Pick one"
        options={options}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByText('Option B')).toBeInTheDocument()
    expect(screen.getByText('Option C')).toBeInTheDocument()
  })

  it('calls onSelect with value when option clicked', () => {
    const onSelect = vi.fn()
    render(
      <QuestionPrompt
        question="Pick one"
        options={options}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByText('Option B'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('shows answered state after selection', () => {
    render(
      <QuestionPrompt
        question="Pick one"
        options={options}
        answered="a"
        onSelect={vi.fn()}
      />
    )
    // Post-#4312: option list is collapsed by default; expand it to assert
    // that every option button still renders disabled.
    fireEvent.click(screen.getByTestId('question-answered-summary'))
    const optionButtons = screen
      .getAllByRole('button')
      .filter((btn) => btn.classList.contains('question-option'))
    expect(optionButtons).toHaveLength(3)
    optionButtons.forEach((btn) => expect(btn).toBeDisabled())
  })

  it('highlights the chosen option', () => {
    render(
      <QuestionPrompt
        question="Pick one"
        options={options}
        answered="b"
        onSelect={vi.fn()}
      />
    )
    // Expand the collapsed summary (#4312) to inspect the chosen-button styling.
    fireEvent.click(screen.getByTestId('question-answered-summary'))
    // "Option B" appears both inside the expanded summary's label span and on
    // the disabled option button — pick the button explicitly via class.
    const chosenButton = screen
      .getAllByText('Option B')
      .map((el) => el.closest('button'))
      .find((btn) => btn?.classList.contains('question-option'))
    expect(chosenButton).toHaveClass('chosen')
  })

  it('does not call onSelect when already answered', () => {
    const onSelect = vi.fn()
    render(
      <QuestionPrompt
        question="Pick one"
        options={options}
        answered="a"
        onSelect={onSelect}
      />
    )
    // Expand first (#4312) so the option button is reachable.
    fireEvent.click(screen.getByTestId('question-answered-summary'))
    // Click the disabled option button (filter to the .question-option
    // matching "Option B"; the summary's label span also contains "Option A"
    // but it's not the click target here).
    const optionB = screen
      .getAllByText('Option B')
      .map((el) => el.closest('button'))
      .find((btn) => btn?.classList.contains('question-option'))!
    fireEvent.click(optionB)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders without options with free-text input', () => {
    render(
      <QuestionPrompt
        question="What do you think?"
        options={[]}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('What do you think?')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(1) // Send button
    expect(screen.getByPlaceholderText('Type your response…')).toBeInTheDocument()
  })

  it('submits free-text response on Send click (#1245)', () => {
    const onSelect = vi.fn()
    render(
      <QuestionPrompt
        question="What is your name?"
        options={[]}
        onSelect={onSelect}
      />
    )
    fireEvent.change(screen.getByPlaceholderText('Type your response…'), { target: { value: 'Alice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSelect).toHaveBeenCalledWith('Alice')
  })

  it('submits free-text response on Enter key (#1245)', () => {
    const onSelect = vi.fn()
    render(
      <QuestionPrompt
        question="What is your name?"
        options={[]}
        onSelect={onSelect}
      />
    )
    const input = screen.getByPlaceholderText('Type your response…')
    fireEvent.change(input, { target: { value: 'Bob' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('Bob')
  })

  it('does not submit empty free-text response (#1245)', () => {
    const onSelect = vi.fn()
    render(
      <QuestionPrompt
        question="What is your name?"
        options={[]}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('hides free-text input when answered (#1245)', () => {
    render(
      <QuestionPrompt
        question="What is your name?"
        options={[]}
        answered="Alice"
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Type your response…')).not.toBeInTheDocument()
  })

  it('disables Send button when text is empty (#1336)', () => {
    render(
      <QuestionPrompt
        question="Your input?"
        options={[]}
        onSelect={vi.fn()}
      />
    )
    const sendBtn = screen.getByRole('button', { name: 'Send' })
    expect(sendBtn).toBeDisabled()
  })

  it('enables Send button when text is non-empty (#1336)', () => {
    render(
      <QuestionPrompt
        question="Your input?"
        options={[]}
        onSelect={vi.fn()}
      />
    )
    fireEvent.change(screen.getByPlaceholderText('Type your response…'), { target: { value: 'hello' } })
    const sendBtn = screen.getByRole('button', { name: 'Send' })
    expect(sendBtn).not.toBeDisabled()
  })

  describe('post-answer collapse (#4312)', () => {
    it('renders a collapsed ✓ <chosen-label> summary by default once answered', () => {
      render(
        <QuestionPrompt
          question="Pick one"
          options={options}
          answered="b"
          onSelect={vi.fn()}
        />
      )
      const summary = screen.getByTestId('question-answered-summary')
      expect(summary).toBeInTheDocument()
      // Marker + chosen label live inside the summary row.
      expect(summary.textContent).toContain('✓')
      expect(summary.textContent).toContain('Option B')
      // Collapsed: the disabled option list is NOT rendered yet (Option A / C
      // would only appear once the user clicks the summary to expand).
      expect(screen.queryByText('Option A')).not.toBeInTheDocument()
      expect(screen.queryByText('Option C')).not.toBeInTheDocument()
      // Summary advertises its collapsed state to assistive tech.
      expect(summary).toHaveAttribute('aria-expanded', 'false')
    })

    it('clicking the chevron expands back to the full disabled-button list', () => {
      render(
        <QuestionPrompt
          question="Pick one"
          options={options}
          answered="b"
          onSelect={vi.fn()}
        />
      )
      // Click the collapsed summary to expand.
      fireEvent.click(screen.getByTestId('question-answered-summary'))
      // Every option renders, all disabled, with the chosen one marked.
      const optionButtons = screen
        .getAllByRole('button')
        .filter((btn) => btn.classList.contains('question-option'))
      expect(optionButtons).toHaveLength(3)
      const labels = optionButtons.map((b) => b.textContent)
      expect(labels).toEqual(['Option A', 'Option B', 'Option C'])
      optionButtons.forEach((btn) => expect(btn).toBeDisabled())
      const chosenButton = optionButtons.find((btn) => btn.textContent === 'Option B')
      expect(chosenButton).toHaveClass('chosen')
      // Summary now reports expanded; clicking again collapses.
      const summary = screen.getByTestId('question-answered-summary')
      expect(summary).toHaveAttribute('aria-expanded', 'true')
    })
  })

  describe('Other / free-text escape hatch (#3746)', () => {
    const withOther = [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
      { label: 'Other', value: OTHER_OPTION_VALUE },
    ]

    it('clicking Other swaps option buttons for a free-text input', () => {
      const onSelect = vi.fn()
      render(
        <QuestionPrompt
          question="Pick one"
          options={withOther}
          onSelect={onSelect}
        />
      )
      fireEvent.click(screen.getByText('Other'))
      expect(onSelect).not.toHaveBeenCalled()
      expect(screen.queryByText('Option A')).not.toBeInTheDocument()
      expect(screen.queryByText('Option B')).not.toBeInTheDocument()
      expect(screen.getByPlaceholderText('Type your response…')).toBeInTheDocument()
    })

    it('submits the typed answer when Send is clicked from Other mode', () => {
      const onSelect = vi.fn()
      render(
        <QuestionPrompt
          question="Pick one"
          options={withOther}
          onSelect={onSelect}
        />
      )
      fireEvent.click(screen.getByText('Other'))
      fireEvent.change(screen.getByPlaceholderText('Type your response…'), { target: { value: 'custom answer' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      expect(onSelect).toHaveBeenCalledWith('custom answer')
    })

    it('Cancel returns to the option buttons without submitting', () => {
      const onSelect = vi.fn()
      render(
        <QuestionPrompt
          question="Pick one"
          options={withOther}
          onSelect={onSelect}
        />
      )
      fireEvent.click(screen.getByText('Other'))
      fireEvent.change(screen.getByPlaceholderText('Type your response…'), { target: { value: 'aborted' } })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onSelect).not.toHaveBeenCalled()
      expect(screen.getByText('Option A')).toBeInTheDocument()
    })

    it('clicking a regular option after Other was never opened still submits that option', () => {
      const onSelect = vi.fn()
      render(
        <QuestionPrompt
          question="Pick one"
          options={withOther}
          onSelect={onSelect}
        />
      )
      fireEvent.click(screen.getByText('Option A'))
      expect(onSelect).toHaveBeenCalledWith('a')
    })

    it('shows the typed answer when answered does not match any option', () => {
      render(
        <QuestionPrompt
          question="Pick one"
          options={withOther}
          answered="my custom answer"
          onSelect={vi.fn()}
        />
      )
      expect(screen.getByText('my custom answer')).toBeInTheDocument()
    })
  })

  // #4666: multi-question AskUserQuestion tool_uses are denied at the
  // permission-hook (#4648 / v0.9.24) because the keystroke driver can't
  // reliably answer combined forms, and the broadcast layer emits the
  // tool_use independently of the deny decision. The dashboard must render
  // a non-interactive notice instead of the MultiQuestionForm so the user
  // can't submit answers that misroute through `_pendingUserAnswer` to the
  // wrong question slot (the long-term refactor lives on #4668).
  describe('multi-question deferred notice (#4666)', () => {
    const q1 = {
      question: 'Which release strategy?',
      options: [{ label: 'Patch', value: 'Patch' }, { label: 'Minor', value: 'Minor' }],
    }
    const q2 = {
      question: 'Which targets?',
      multiSelect: true,
      options: [
        { label: 'App', value: 'App' },
        { label: 'Docs', value: 'Docs' },
        { label: 'Tests', value: 'Tests' },
      ],
    }
    const q3 = {
      question: 'Confirm?',
      options: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }],
    }
    const multiQuestions = [q1, q2, q3]

    it('renders the deferred notice instead of the multi-question form when questions.length > 1', () => {
      const onSelect = vi.fn()
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={onSelect}
        />
      )
      expect(screen.getByTestId('multi-question-deferred-notice')).toBeInTheDocument()
      // The interactive multi-question form is NOT rendered — no Submit,
      // no per-question radios/checkboxes, no per-question rows.
      expect(screen.queryByTestId('question-prompt-multi')).not.toBeInTheDocument()
      expect(screen.queryByTestId('question-multi-submit')).not.toBeInTheDocument()
      expect(screen.queryByTestId('question-multi-row-0')).not.toBeInTheDocument()
      // No input elements (radios/checkboxes) rendered for any question.
      expect(screen.queryAllByRole('radio')).toHaveLength(0)
      expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    })

    it('the deferred notice is non-interactive (no buttons, never invokes onSelect)', () => {
      const onSelect = vi.fn()
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={onSelect}
        />
      )
      // No buttons rendered at all in the deferred-notice variant.
      expect(screen.queryAllByRole('button')).toHaveLength(0)
      // Clicking the notice itself does nothing.
      fireEvent.click(screen.getByTestId('multi-question-deferred-notice'))
      expect(onSelect).not.toHaveBeenCalled()
    })

    it('mentions the question count in the notice copy so the user knows what was suppressed', () => {
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={vi.fn()}
        />
      )
      const notice = screen.getByTestId('multi-question-deferred-notice')
      // 3 questions in `multiQuestions`.
      expect(notice.textContent).toContain('3')
    })

    it('falls back to single-question UI when questions has length 1', () => {
      // N=1 payload — single-question UI must render the interactive
      // button list as before, NOT the deferred notice.
      render(
        <QuestionPrompt
          question="Just one?"
          options={[{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }]}
          questions={[{ question: 'Just one?', options: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }] }]}
          onSelect={vi.fn()}
        />
      )
      expect(screen.getByTestId('question-prompt')).toBeInTheDocument()
      expect(screen.queryByTestId('multi-question-deferred-notice')).not.toBeInTheDocument()
      // Interactive option buttons remain present.
      expect(screen.getByText('Yes')).toBeInTheDocument()
      expect(screen.getByText('No')).toBeInTheDocument()
    })

    it('falls back to single-question UI when questions is an empty array', () => {
      // questions.length === 0 — the multi-question branch should not
      // fire. Single-question UI renders normally.
      render(
        <QuestionPrompt
          question="Pick one"
          options={[{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]}
          questions={[]}
          onSelect={vi.fn()}
        />
      )
      expect(screen.getByTestId('question-prompt')).toBeInTheDocument()
      expect(screen.queryByTestId('multi-question-deferred-notice')).not.toBeInTheDocument()
      expect(screen.getByText('A')).toBeInTheDocument()
    })

    it('falls back to single-question UI when questions is undefined', () => {
      // No questions prop at all — the legacy single-question path is
      // the regression-guard happy path for the v0.9.4 majority case.
      render(
        <QuestionPrompt
          question="Pick one"
          options={[{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]}
          onSelect={vi.fn()}
        />
      )
      expect(screen.getByTestId('question-prompt')).toBeInTheDocument()
      expect(screen.queryByTestId('multi-question-deferred-notice')).not.toBeInTheDocument()
    })

    it('falls back to single-question UI when answered is already set (multi-question post-answer summary path)', () => {
      // Once an answer is recorded, render the single-question collapse
      // UI — even for a multi-question payload. The deferred notice is
      // strictly the pre-answer state.
      render(
        <QuestionPrompt
          question="Q1?"
          options={[{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]}
          questions={[
            { question: 'Q1?', options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }] },
            { question: 'Q2?', options: [{ label: 'x', value: 'x' }] },
          ]}
          answered="Q1?: a | Q2?: x"
          onSelect={vi.fn()}
        />
      )
      expect(screen.queryByTestId('multi-question-deferred-notice')).not.toBeInTheDocument()
      // Single-q UI renders the answered summary (free-text variant).
      expect(screen.getByTestId('question-answered-summary')).toBeInTheDocument()
    })
  })

  // #4666: MultiQuestionForm stays exported but unused by QuestionPrompt.
  // When the #4668 long-term refactor lands (Map-keyed _pendingUserAnswer),
  // native multi-question support can be re-enabled by flipping the gate
  // in QuestionPrompt back to rendering this component. Keep a smoke test
  // so the dormant component doesn't bit-rot in the meantime.
  describe('MultiQuestionForm (#4604 Chunk B, dormant per #4666)', () => {
    const q1 = {
      question: 'Which release strategy?',
      options: [{ label: 'Patch', value: 'Patch' }, { label: 'Minor', value: 'Minor' }],
    }
    const q2 = {
      question: 'Confirm?',
      options: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }],
    }

    it('renders the interactive form when invoked directly', () => {
      const onSelect = vi.fn()
      render(<MultiQuestionForm questions={[q1, q2]} onSelect={onSelect} />)
      expect(screen.getByTestId('question-prompt-multi')).toBeInTheDocument()
      expect(screen.getByTestId('question-multi-submit')).toBeInTheDocument()
    })

    it('Submit fires onSelect with the answersMap', () => {
      const onSelect = vi.fn()
      render(<MultiQuestionForm questions={[q1, q2]} onSelect={onSelect} />)
      fireEvent.click(screen.getByTestId('question-multi-option-0-Minor').querySelector('input')!)
      fireEvent.click(screen.getByTestId('question-multi-option-1-Yes').querySelector('input')!)
      fireEvent.click(screen.getByTestId('question-multi-submit'))
      expect(onSelect).toHaveBeenCalledTimes(1)
      const arg = onSelect.mock.calls[0]?.[0] as Record<string, string> | undefined
      expect(arg!['Which release strategy?']).toBe('Minor')
      expect(arg!['Confirm?']).toBe('Yes')
    })
  })
})

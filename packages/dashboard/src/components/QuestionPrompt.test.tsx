/**
 * QuestionPrompt tests (#1193)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { OTHER_OPTION_VALUE } from '@chroxy/store-core'
import { QuestionPrompt } from './QuestionPrompt'

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

  // #4604 Chunk B — multi-question form UI. Renders one selection control
  // per question (radio for single-select, checkboxes for multi-select)
  // with a single Submit button that fires onSelect(answersMap).
  describe('multi-question form (#4604 Chunk B)', () => {
    // Using `as const` so the tuple types index without
    // noUncheckedIndexedAccess complaints. Each question is consumed as
    // a top-level fixture below.
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

    it('renders every question with its label', () => {
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={vi.fn()}
        />
      )
      expect(screen.getByTestId('question-prompt-multi')).toBeInTheDocument()
      expect(screen.getByText('Which release strategy?')).toBeInTheDocument()
      expect(screen.getByText('Which targets?')).toBeInTheDocument()
      expect(screen.getByText('Confirm?')).toBeInTheDocument()
    })

    it('single-select questions render as radio buttons', () => {
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={vi.fn()}
        />
      )
      // Q1 single-select renders radios; the two option inputs belong to
      // the same radio group so only one is selectable at a time.
      const patch = screen.getByTestId('question-multi-option-0-Patch').querySelector('input')!
      const minor = screen.getByTestId('question-multi-option-0-Minor').querySelector('input')!
      expect(patch.getAttribute('type')).toBe('radio')
      expect(minor.getAttribute('type')).toBe('radio')
      expect(patch.getAttribute('name')).toBe(minor.getAttribute('name'))
    })

    it('multi-select questions render as checkboxes', () => {
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={vi.fn()}
        />
      )
      const app = screen.getByTestId('question-multi-option-1-App').querySelector('input')!
      const docs = screen.getByTestId('question-multi-option-1-Docs').querySelector('input')!
      expect(app.getAttribute('type')).toBe('checkbox')
      expect(docs.getAttribute('type')).toBe('checkbox')
    })

    it('Submit is disabled until every single-select question has a choice', () => {
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={vi.fn()}
        />
      )
      const submit = screen.getByTestId('question-multi-submit') as HTMLButtonElement
      expect(submit).toBeDisabled()

      // Answer Q1 only — still disabled, Q3 unanswered.
      fireEvent.click(screen.getByTestId('question-multi-option-0-Patch').querySelector('input')!)
      expect(submit).toBeDisabled()

      // Answer Q3 (Q2 is multi-select, allowed empty) — enables Submit.
      fireEvent.click(screen.getByTestId('question-multi-option-2-Yes').querySelector('input')!)
      expect(submit).not.toBeDisabled()
    })

    it('multi-select toggles let the user pick multiple options', () => {
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={vi.fn()}
        />
      )
      const app = screen.getByTestId('question-multi-option-1-App').querySelector<HTMLInputElement>('input')!
      const docs = screen.getByTestId('question-multi-option-1-Docs').querySelector<HTMLInputElement>('input')!
      fireEvent.click(app)
      fireEvent.click(docs)
      expect(app.checked).toBe(true)
      expect(docs.checked).toBe(true)
      // Toggling off works too.
      fireEvent.click(app)
      expect(app.checked).toBe(false)
      expect(docs.checked).toBe(true)
    })

    it('Submit fires onSelect with the full answersMap, multi-select JSON-encoded', () => {
      const onSelect = vi.fn()
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={onSelect}
        />
      )
      fireEvent.click(screen.getByTestId('question-multi-option-0-Minor').querySelector('input')!)
      fireEvent.click(screen.getByTestId('question-multi-option-1-App').querySelector('input')!)
      fireEvent.click(screen.getByTestId('question-multi-option-1-Tests').querySelector('input')!)
      fireEvent.click(screen.getByTestId('question-multi-option-2-No').querySelector('input')!)
      fireEvent.click(screen.getByTestId('question-multi-submit'))

      expect(onSelect).toHaveBeenCalledTimes(1)
      const arg = onSelect.mock.calls[0]?.[0] as Record<string, string> | undefined
      expect(arg).toBeDefined()
      expect(typeof arg).toBe('object')
      expect(arg!['Which release strategy?']).toBe('Minor')
      // Multi-select wire shape: JSON-stringified array (Record<string,string>
      // wire constraint — server's respondToQuestion JSON.parse splits it back).
      expect(arg!['Which targets?']).toBe(JSON.stringify(['App', 'Tests']))
      expect(arg!['Confirm?']).toBe('No')
    })

    it('Submit guards against double-fire (only first click registers)', () => {
      const onSelect = vi.fn()
      render(
        <QuestionPrompt
          question={q1.question}
          options={q1.options}
          questions={multiQuestions}
          onSelect={onSelect}
        />
      )
      fireEvent.click(screen.getByTestId('question-multi-option-0-Patch').querySelector('input')!)
      fireEvent.click(screen.getByTestId('question-multi-option-2-Yes').querySelector('input')!)
      const submit = screen.getByTestId('question-multi-submit')
      fireEvent.click(submit)
      fireEvent.click(submit)
      fireEvent.click(submit)
      expect(onSelect).toHaveBeenCalledTimes(1)
    })

    it('falls back to single-question UI when questions has length <= 1', () => {
      // N=1 multi-question payload — should render the legacy
      // single-question UI (button list), not the multi-question form.
      render(
        <QuestionPrompt
          question="Just one?"
          options={[{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }]}
          questions={[{ question: 'Just one?', options: [{ label: 'Yes', value: 'Yes' }, { label: 'No', value: 'No' }] }]}
          onSelect={vi.fn()}
        />
      )
      // Legacy single-q UI uses `question-prompt`, not `question-prompt-multi`.
      expect(screen.getByTestId('question-prompt')).toBeInTheDocument()
      expect(screen.queryByTestId('question-prompt-multi')).not.toBeInTheDocument()
    })

    it('falls back to single-question UI when answered is already set (multi-question post-answer summary path)', () => {
      // The post-answer collapse/summary path is single-question UI only;
      // once the user has submitted a multi-question form, render the
      // legacy collapse UI with the answer summary string. Multi-question
      // mode is only entered when answered is null/undefined.
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
      expect(screen.queryByTestId('question-prompt-multi')).not.toBeInTheDocument()
      // Single-q UI renders the answered summary
      expect(screen.getByTestId('question-answered-summary')).toBeInTheDocument()
    })
  })
})

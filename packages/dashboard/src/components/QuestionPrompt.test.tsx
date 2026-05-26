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
})

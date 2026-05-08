/**
 * EvaluatorPrompts component tests (#3188).
 *
 * Covers the rewrite-explanation banner (collapsed/expanded) and the
 * inline clarify prompt (iteration counter, submit handler, Enter-to-send).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { EvaluatorRewriteBanner, EvaluatorClarifyPrompt } from './EvaluatorPrompts'
import type { EvaluatorRewriteMeta } from '../store/types'

afterEach(cleanup)

describe('EvaluatorRewriteBanner (#3188)', () => {
  const meta: EvaluatorRewriteMeta = {
    kind: 'rewrite',
    evaluatorIterationId: 'iter-1',
    originalDraft: 'fix it',
    rewritten: 'Please fix the failing test in foo.js',
    reasoning: 'Original was too vague.',
  }

  it('renders the collapsed summary by default', () => {
    render(<EvaluatorRewriteBanner meta={meta} />)
    expect(screen.getByText(/Your message was rewritten to be clearer/)).toBeInTheDocument()
    // Details panel hidden by default.
    expect(screen.queryByTestId('evaluator-rewrite-details')).toBeNull()
  })

  it('toggles details on click and shows original + rewritten + reasoning', () => {
    render(<EvaluatorRewriteBanner meta={meta} />)
    const toggle = screen.getByRole('button', { name: /Your message was rewritten/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const details = screen.getByTestId('evaluator-rewrite-details')
    expect(details).toBeInTheDocument()
    expect(details).toHaveTextContent('fix it')
    expect(details).toHaveTextContent('Please fix the failing test in foo.js')
    expect(details).toHaveTextContent('Original was too vague.')
  })

  it('omits the reasoning section when reasoning is empty', () => {
    render(
      <EvaluatorRewriteBanner
        meta={{ ...meta, reasoning: '' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /rewritten/ }))
    const details = screen.getByTestId('evaluator-rewrite-details')
    expect(details).not.toHaveTextContent('Why')
  })
})

describe('EvaluatorClarifyPrompt (#3188)', () => {
  it('renders the iteration counter as N/3', () => {
    render(
      <EvaluatorClarifyPrompt
        evaluatorIteration={2}
        originalDraft="fix"
        clarification="Which file?"
        reasoning="vague"
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByTestId('evaluator-clarify-iteration')).toHaveTextContent('Iteration 2/3')
  })

  it('renders 1/3 on the first clarify round', () => {
    render(
      <EvaluatorClarifyPrompt
        evaluatorIteration={1}
        originalDraft="fix"
        clarification="What?"
        reasoning=""
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByTestId('evaluator-clarify-iteration')).toHaveTextContent('Iteration 1/3')
  })

  it('renders 3/3 at the cap', () => {
    render(
      <EvaluatorClarifyPrompt
        evaluatorIteration={3}
        originalDraft="x"
        clarification="y"
        reasoning="z"
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByTestId('evaluator-clarify-iteration')).toHaveTextContent('Iteration 3/3')
  })

  it('renders the original draft, question, and reasoning sections', () => {
    render(
      <EvaluatorClarifyPrompt
        evaluatorIteration={1}
        originalDraft="my vague draft"
        clarification="which file should I look at?"
        reasoning="no file specified"
        onSubmit={vi.fn()}
      />,
    )
    expect(screen.getByText('my vague draft')).toBeInTheDocument()
    expect(screen.getByText('which file should I look at?')).toBeInTheDocument()
    expect(screen.getByText('no file specified')).toBeInTheDocument()
  })

  it('Send button is disabled until the textarea has non-whitespace content', () => {
    render(
      <EvaluatorClarifyPrompt
        evaluatorIteration={1}
        originalDraft="x"
        clarification="y"
        reasoning="z"
        onSubmit={vi.fn()}
      />,
    )
    const send = screen.getByTestId('evaluator-clarify-send') as HTMLButtonElement
    expect(send.disabled).toBe(true)

    const input = screen.getByTestId('evaluator-clarify-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '   ' } })
    expect(send.disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'src/foo.js' } })
    expect(send.disabled).toBe(false)
  })

  it('submitting fires onSubmit with the trimmed answer', () => {
    const onSubmit = vi.fn()
    render(
      <EvaluatorClarifyPrompt
        evaluatorIteration={1}
        originalDraft="x"
        clarification="y"
        reasoning="z"
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByTestId('evaluator-clarify-input')
    fireEvent.change(input, { target: { value: '   src/foo.js   ' } })
    fireEvent.click(screen.getByTestId('evaluator-clarify-send'))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('src/foo.js')
  })

  it('Enter submits, Shift+Enter inserts a newline', () => {
    const onSubmit = vi.fn()
    render(
      <EvaluatorClarifyPrompt
        evaluatorIteration={1}
        originalDraft="x"
        clarification="y"
        reasoning="z"
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByTestId('evaluator-clarify-input')
    fireEvent.change(input, { target: { value: 'foo' } })

    // Shift+Enter: not submitted.
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    // Enter alone: submitted.
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    expect(onSubmit).toHaveBeenCalledWith('foo')
  })

  it('guards against double-submit (submittedRef)', () => {
    const onSubmit = vi.fn()
    render(
      <EvaluatorClarifyPrompt
        evaluatorIteration={1}
        originalDraft="x"
        clarification="y"
        reasoning="z"
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByTestId('evaluator-clarify-input')
    fireEvent.change(input, { target: { value: 'foo' } })
    const send = screen.getByTestId('evaluator-clarify-send')
    fireEvent.click(send)
    fireEvent.click(send)
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})

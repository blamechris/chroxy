/**
 * QuestionPrompt tests (#1193)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
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
    expect(screen.getByText('Option A')).toBeInTheDocument()
    // All buttons should be disabled when answered
    const buttons = screen.getAllByRole('button')
    buttons.forEach(btn => expect(btn).toBeDisabled())
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
    expect(screen.getByText('Option B').closest('button')).toHaveClass('chosen')
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
    fireEvent.click(screen.getByText('Option B'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('renders without options as plain text', () => {
    render(
      <QuestionPrompt
        question="What do you think?"
        options={[]}
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByText('What do you think?')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

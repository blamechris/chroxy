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
})

/**
 * WorkingIndicator tests (#5953, epic #5951).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { WorkingIndicator, DEFAULT_WORKING_LABEL } from './WorkingIndicator'

afterEach(cleanup)

describe('WorkingIndicator', () => {
  it('shows the generic default label when none is supplied', () => {
    render(<WorkingIndicator />)
    expect(screen.getByTestId('working-label')).toHaveTextContent(DEFAULT_WORKING_LABEL)
  })

  it('falls back to the default for an empty label', () => {
    render(<WorkingIndicator label="" />)
    expect(screen.getByTestId('working-label')).toHaveTextContent(DEFAULT_WORKING_LABEL)
  })

  it('surfaces a provided activity label (e.g. the in-flight tool)', () => {
    render(<WorkingIndicator label="Running Bash…" />)
    expect(screen.getByTestId('working-label')).toHaveTextContent('Running Bash…')
  })

  it('keeps the animated dots (thinking-dots) for existing callers/tests', () => {
    render(<WorkingIndicator label="Running Read…" />)
    expect(screen.getByTestId('working-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('thinking-dots')).toBeInTheDocument()
  })
})

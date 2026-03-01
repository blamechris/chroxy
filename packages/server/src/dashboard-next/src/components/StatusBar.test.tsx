import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatusBar } from './StatusBar'

afterEach(cleanup)

describe('StatusBar', () => {
  it('shows $0.0000 when cost is zero', () => {
    render(<StatusBar cost={0} />)
    expect(screen.getByText('$0.0000')).toBeInTheDocument()
  })

  it('hides cost when cost is undefined', () => {
    render(<StatusBar />)
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it('shows cost when cost > 0', () => {
    render(<StatusBar cost={0.1234} />)
    expect(screen.getByText('$0.1234')).toBeInTheDocument()
  })
})

/**
 * MRU integration test — verifies that executing a command reorders palette
 * items on next open (#1418).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CommandPalette, type Command } from './CommandPalette'
import { useMruStore } from '../store/mru'

beforeEach(() => {
  // Reset MRU state between tests
  useMruStore.setState({ mruList: [] })
  localStorage.clear()
})

afterEach(cleanup)

function makeCommands(): Command[] {
  return [
    { id: 'cmd-a', name: 'Alpha', category: 'General', action: vi.fn() },
    { id: 'cmd-b', name: 'Beta', category: 'General', action: vi.fn() },
    { id: 'cmd-c', name: 'Charlie', category: 'General', action: vi.fn() },
  ]
}

describe('CommandPalette MRU ordering (#1418)', () => {
  it('displays commands in original order when no MRU data', () => {
    const commands = makeCommands()
    render(<CommandPalette commands={commands} isOpen={true} onClose={vi.fn()} />)
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('Alpha')
    expect(options[1]).toHaveTextContent('Beta')
    expect(options[2]).toHaveTextContent('Charlie')
  })

  it('MRU-recorded commands appear first when mruList is provided', () => {
    const commands = makeCommands()
    // Simulate MRU: Charlie was used most recently, then Beta
    const mruList = ['cmd-c', 'cmd-b']
    render(
      <CommandPalette commands={commands} isOpen={true} onClose={vi.fn()} mruList={mruList} />,
    )
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('Charlie')
    expect(options[1]).toHaveTextContent('Beta')
    expect(options[2]).toHaveTextContent('Alpha')
  })

  it('executing a command and reopening shows updated MRU order', () => {
    const commands = makeCommands()
    const onClose = vi.fn()

    // Record 'cmd-c' as recently used
    useMruStore.getState().recordCommand('cmd-c')

    // Render with current MRU
    const { rerender } = render(
      <CommandPalette
        commands={commands}
        isOpen={true}
        onClose={onClose}
        mruList={[...useMruStore.getState().mruList]}
      />,
    )
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveTextContent('Charlie')

    // Close palette
    rerender(
      <CommandPalette
        commands={commands}
        isOpen={false}
        onClose={onClose}
        mruList={[...useMruStore.getState().mruList]}
      />,
    )

    // Record 'cmd-a' as most recent
    useMruStore.getState().recordCommand('cmd-a')

    // Reopen with updated MRU
    rerender(
      <CommandPalette
        commands={commands}
        isOpen={true}
        onClose={onClose}
        mruList={[...useMruStore.getState().mruList]}
      />,
    )
    const reorderedOptions = screen.getAllByRole('option')
    expect(reorderedOptions[0]).toHaveTextContent('Alpha')
    expect(reorderedOptions[1]).toHaveTextContent('Charlie')
    expect(reorderedOptions[2]).toHaveTextContent('Beta')
  })

  it('MRU persists to localStorage', () => {
    useMruStore.getState().recordCommand('cmd-b')
    useMruStore.getState().recordCommand('cmd-a')

    const stored = JSON.parse(localStorage.getItem('chroxy-mru-commands') || '[]')
    expect(stored[0]).toBe('cmd-a')
    expect(stored[1]).toBe('cmd-b')
  })
})

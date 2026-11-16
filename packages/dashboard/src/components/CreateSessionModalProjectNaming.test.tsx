/**
 * A daemon that advertises `projectSessionNames` names an unnamed session after its project
 * ("chroxy 7"), so the modal must not prefill or require a name and must send none when the
 * field is blank. A daemon that does not advertise it keeps today's behaviour exactly:
 * a prefilled name, required.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

const caps: { value: Record<string, boolean> } = { value: {} }

vi.mock('../hooks/usePathAutocomplete', () => ({
  usePathAutocomplete: () => ({ suggestions: [] }),
}))

vi.mock('../store/connection', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      defaultProvider: 'claude-sdk',
      availableProviders: [{ name: 'claude-sdk' }],
      requestDirectoryListing: () => {},
      setDirectoryListingCallback: () => {},
      defaultCwd: null,
      serverCapabilities: caps.value,
    }),
}))

import { CreateSessionModal } from './CreateSessionModal'

afterEach(cleanup)
beforeEach(() => { caps.value = {} })

const baseProps = () => ({
  open: true,
  onClose: vi.fn(),
  onCreate: vi.fn(),
  initialCwd: '/Users/me/projects',
  knownCwds: [] as string[],
  existingNames: [] as string[],
})
const nameInput = () => screen.getByLabelText('Session name') as HTMLInputElement
const clickCreate = () => fireEvent.click(screen.getByRole('button', { name: /^create/i }))

describe('CreateSessionModal with a daemon that names sessions after the project', () => {
  beforeEach(() => { caps.value = { projectSessionNames: true } })

  it('does not prefill a name and says what a blank field means', () => {
    render(<CreateSessionModal {...baseProps()} />)
    expect(nameInput().value).toBe('')
    expect(nameInput().placeholder).toMatch(/leave blank.*after the project.*chroxy 7/i)
  })

  it('does not require a name and sends none when the field is blank', () => {
    const props = baseProps()
    render(<CreateSessionModal {...props} />)
    clickCreate()
    expect(screen.queryByText('Session name is required')).toBeNull()
    expect(props.onCreate).toHaveBeenCalledTimes(1)
    expect(props.onCreate.mock.calls[0]![0].name).toBeUndefined()
  })

  it('sends a typed name trimmed', () => {
    const props = baseProps()
    render(<CreateSessionModal {...props} />)
    fireEvent.change(nameInput(), { target: { value: '  My notes ' } })
    clickCreate()
    expect(props.onCreate.mock.calls[0]![0].name).toBe('My notes')
  })
})

describe('CreateSessionModal with a daemon that does not advertise project naming', () => {
  it('prefills a name from the folder, as before', () => {
    render(<CreateSessionModal {...baseProps()} />)
    expect(nameInput().value).toBe('projects')
    expect(nameInput().placeholder).toBe('Session name')
  })

  it('still requires a name', () => {
    const props = baseProps()
    render(<CreateSessionModal {...props} />)
    fireEvent.change(nameInput(), { target: { value: '' } })
    clickCreate()
    expect(screen.getByText('Session name is required')).toBeTruthy()
    expect(props.onCreate).not.toHaveBeenCalled()
  })

  it('an explicit false is the same as absent', () => {
    caps.value = { projectSessionNames: false }
    render(<CreateSessionModal {...baseProps()} />)
    expect(nameInput().value).toBe('projects')
  })
})

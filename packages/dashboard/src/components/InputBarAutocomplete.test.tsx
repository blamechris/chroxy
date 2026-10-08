/**
 * InputBar autocomplete regressions (#8432, #8433).
 *
 * The real InputBar is driven by an App-like parent: per-session drafts, and an
 * `onValueChange` whose identity changes when the active session changes (App's
 * `handleDraftChange` closes over `activeSessionId`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useCallback, useRef, useState } from 'react'
import { InputBar } from './InputBar'

afterEach(cleanup)

const COMMANDS = [
  { name: 'commit', description: 'Create a git commit', source: 'project' as const },
  { name: 'review-pr', description: 'Review a pull request', source: 'project' as const },
]
const FILES = [
  { path: 'README.md', type: 'file' as const, size: 256 },
  { path: 'package.json', type: 'file' as const, size: 128 },
  { path: 'src/index.ts', type: 'file' as const, size: 1024 },
]

function AppLikeParent({ initial, onSend = vi.fn() }: { initial: Record<string, string>; onSend?: (t: string) => void }) {
  const [activeSessionId, setActiveSessionId] = useState('A')
  const draftsRef = useRef<Map<string, string>>(new Map(Object.entries(initial)))
  const [, bump] = useState(0)
  // Same shape as App.handleDraftChange: new identity per active session.
  const handleDraftChange = useCallback((text: string) => {
    draftsRef.current.set(activeSessionId, text)
    bump(n => n + 1)
  }, [activeSessionId])
  return (
    <div>
      <button data-testid="switch-A" onClick={() => setActiveSessionId('A')} />
      <button data-testid="switch-B" onClick={() => setActiveSessionId('B')} />
      <pre data-testid="draft-A">{draftsRef.current.get('A') ?? ''}</pre>
      <pre data-testid="draft-B">{draftsRef.current.get('B') ?? ''}</pre>
      <InputBar
        onSend={onSend}
        onInterrupt={vi.fn()}
        sendOnEnter
        slashCommands={COMMANDS}
        filePickerFiles={FILES}
        controlledValue={draftsRef.current.get(activeSessionId) ?? ''}
        onValueChange={handleDraftChange}
      />
    </div>
  )
}

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement
const draft = (id: 'A' | 'B') => screen.getByTestId(`draft-${id}`).textContent

// Type `text` with the caret at `caret` (fireEvent.change would park it at the end).
function typeWithCaret(text: string, caret: number) {
  const ta = box()
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  set.call(ta, text)
  ta.setSelectionRange(caret, caret)
  fireEvent.input(ta)
}

describe('slash pick after a session switch (#8432)', () => {
  it('click writes the picked command to the ACTIVE session draft', () => {
    render(<AppLikeParent initial={{}} />)
    fireEvent.click(screen.getByTestId('switch-B'))
    typeWithCaret('/', 1)
    fireEvent.click(screen.getByText('/commit'))
    expect(draft('B')).toBe('/commit ')
    expect(draft('A')).toBe('')
    // away and back: the draft stayed where it was written
    fireEvent.click(screen.getByTestId('switch-A'))
    expect(box().value).toBe('')
    fireEvent.click(screen.getByTestId('switch-B'))
    expect(box().value).toBe('/commit ')
  })

  it('Enter and Tab write to the active session draft too', () => {
    render(<AppLikeParent initial={{}} />)
    fireEvent.click(screen.getByTestId('switch-B'))
    typeWithCaret('/', 1)
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(draft('B')).toBe('/commit ')
    expect(draft('A')).toBe('')
  })

  it('send clears the ACTIVE session draft (equal drafts keep `value` unchanged)', () => {
    const onSend = vi.fn()
    render(<AppLikeParent initial={{ A: 'hi', B: 'hi' }} onSend={onSend} />)
    fireEvent.click(screen.getByTestId('switch-B'))
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hi')
    expect(draft('B')).toBe('')
    expect(draft('A')).toBe('hi')
  })
})

describe('@ file picker follows the caret (#8433)', () => {
  const options = () => screen.queryAllByRole('option').map(o => o.textContent ?? '')

  it('mid-draft @ filters on the text up to the caret only', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('see @RE and more', 7)
    expect(options().length).toBe(1)
    expect(options()[0]!.startsWith('README.md')).toBe(true)
  })

  it('Enter completes mid-draft, replacing only the token and parking the caret after the path', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('see @RE and more', 7)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('see README.md and more')
    expect(draft('A')).toBe('see README.md and more')
    expect(box().selectionStart).toBe('see README.md'.length)
    expect(box().selectionEnd).toBe('see README.md'.length)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('caret inside a token: filters up to the caret and replaces the whole word', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('see @REAXX and more', 7)
    expect(options().length).toBe(1)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('see README.md and more')
    expect(box().selectionStart).toBe('see README.md'.length)
  })

  it('at the end of the text it still works and the caret ends after the added space', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('see @pack', 9)
    expect(options().length).toBe(1)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('see package.json ')
    expect(box().selectionStart).toBe('see package.json '.length)
  })

  it('with several @s, the one at the caret wins (earlier and later)', () => {
    render(<AppLikeParent initial={{}} />)
    const text = 'open @pack and @RE now'
    // caret right after "@pack" (first token)
    typeWithCaret(text, 10)
    expect(options().length).toBe(1)
    expect(options()[0]!.startsWith('package.json')).toBe(true)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('open package.json and @RE now')
    expect(box().selectionStart).toBe('open package.json'.length)
    cleanup()

    render(<AppLikeParent initial={{}} />)
    // caret right after "@RE" (second token)
    typeWithCaret(text, 18)
    expect(options().length).toBe(1)
    expect(options()[0]!.startsWith('README.md')).toBe(true)
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('open @pack and README.md now')
    expect(box().selectionStart).toBe('open @pack and README.md'.length)
  })

  it('closes when the caret moves out of the token without an edit', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('@RE and more', 3)
    expect(screen.getByRole('listbox')).toBeTruthy()
    box().setSelectionRange(8, 8)
    fireEvent.select(box())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('closes when the caret is typed past whitespace out of the token', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('@RE', 3)
    expect(screen.getByRole('listbox')).toBeTruthy()
    typeWithCaret('@RE ', 4)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

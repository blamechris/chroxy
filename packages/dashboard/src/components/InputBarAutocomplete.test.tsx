/**
 * InputBar autocomplete regressions (#8432, #8433, #8831, #8832).
 *
 * The real InputBar is driven by an App-like parent: per-session drafts, and an
 * `onValueChange` whose identity changes when the active session changes (App's
 * `handleDraftChange` closes over `activeSessionId`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react'
import { useCallback, useRef, useState, type ComponentProps } from 'react'
import { InputBar } from './InputBar'
import type { EvaluatorResultPayload } from '../store/types'

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

type InputBarProps = ComponentProps<typeof InputBar>

function AppLikeParent({ initial, onSend = vi.fn(), onSlashTrigger, onFileTrigger, onFileAttach, onEvaluate, userMessageHistory }: {
  initial: Record<string, string>
  onSend?: (t: string) => void
} & Pick<InputBarProps, 'onSlashTrigger' | 'onFileTrigger' | 'onFileAttach' | 'onEvaluate' | 'userMessageHistory'>) {
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
      {/* The parent writing the active draft itself, as App does for a CI
          prefill, a queued-message reopen or a removed paste marker. */}
      <button data-testid="empty-active-draft" onClick={() => {
        draftsRef.current.set(activeSessionId, '')
        bump(n => n + 1)
      }} />
      <pre data-testid="draft-A">{draftsRef.current.get('A') ?? ''}</pre>
      <pre data-testid="draft-B">{draftsRef.current.get('B') ?? ''}</pre>
      <InputBar
        onSend={onSend}
        onInterrupt={vi.fn()}
        sendOnEnter
        slashCommands={COMMANDS}
        onSlashTrigger={onSlashTrigger}
        filePickerFiles={FILES}
        onFileTrigger={onFileTrigger}
        onFileAttach={onFileAttach}
        onEvaluate={onEvaluate}
        userMessageHistory={userMessageHistory}
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
    expect(screen.queryByTestId('file-picker')).toBeNull()
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

  it('an @ that does not start a token never opens the picker (me@x, a@RE)', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('me@x', 4)
    expect(screen.queryByTestId('file-picker')).toBeNull()
    typeWithCaret('mail a@RE', 9)
    expect(screen.queryByTestId('file-picker')).toBeNull()
    // the same text after whitespace does open it
    typeWithCaret('mail a @RE', 10)
    expect(screen.getByTestId('file-picker')).toBeTruthy()
  })

  it('closes when the caret moves out of the token without an edit', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('@RE and more', 3)
    expect(screen.getByTestId('file-picker')).toBeTruthy()
    box().setSelectionRange(8, 8)
    fireEvent.select(box())
    expect(screen.queryByTestId('file-picker')).toBeNull()
  })

  it('closes when the caret is typed past whitespace out of the token', () => {
    render(<AppLikeParent initial={{}} />)
    typeWithCaret('@RE', 3)
    expect(screen.getByTestId('file-picker')).toBeTruthy()
    typeWithCaret('@RE ', 4)
    expect(screen.queryByTestId('file-picker')).toBeNull()
  })
})

describe('a value replaced from outside the composer resets its picker and history state (#8831)', () => {
  const slashRows = () =>
    within(screen.getByTestId('slash-picker')).getAllByRole('option').map(o => o.getAttribute('aria-selected'))
  const fileRows = () =>
    within(screen.getByTestId('file-picker')).getAllByRole('option').map(o => o.getAttribute('aria-selected'))

  it('a switch to an empty draft: / refetches the commands and highlights row 1', () => {
    const onSlashTrigger = vi.fn()
    render(<AppLikeParent initial={{}} onSlashTrigger={onSlashTrigger} />)
    typeWithCaret('/', 1)
    expect(onSlashTrigger).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(slashRows()).toEqual(['false', 'true'])

    fireEvent.click(screen.getByTestId('switch-B'))
    expect(box().value).toBe('')
    expect(screen.queryByTestId('slash-picker')).toBeNull()

    typeWithCaret('/', 1)
    expect(onSlashTrigger).toHaveBeenCalledTimes(2)
    expect(slashRows()).toEqual(['true', 'false'])
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(draft('B')).toBe('/commit ')
  })

  it('a switch to an empty draft closes the @ picker; @ refetches the files and highlights row 1', () => {
    const onFileTrigger = vi.fn()
    render(<AppLikeParent initial={{}} onFileTrigger={onFileTrigger} />)
    typeWithCaret('@', 1)
    expect(onFileTrigger).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(fileRows()).toEqual(['false', 'true', 'false'])

    fireEvent.click(screen.getByTestId('switch-B'))
    expect(box().value).toBe('')
    expect(screen.queryByTestId('file-picker')).toBeNull()

    typeWithCaret('@', 1)
    expect(onFileTrigger).toHaveBeenCalledTimes(2)
    expect(fileRows()).toEqual(['true', 'false', 'false'])
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(draft('B')).toBe('README.md ')
  })

  it('Enter on the switched-to empty draft attaches no file from the previous picker', () => {
    const onFileAttach = vi.fn()
    render(<AppLikeParent initial={{}} onFileAttach={onFileAttach} />)
    typeWithCaret('@', 1)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })

    fireEvent.click(screen.getByTestId('switch-B'))
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onFileAttach).not.toHaveBeenCalled()
    expect(draft('B')).toBe('')
  })

  it('a switch leaves history cycling, so Down does not write the stashed draft into the other session', () => {
    // One history array across the switch, so the userMessageHistory identity
    // reset never fires and only the value-change reset is under test.
    const history = ['older', 'newest']
    render(<AppLikeParent initial={{ A: 'mine' }} userMessageHistory={history} />)
    box().setSelectionRange(4, 4)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('newest')

    fireEvent.click(screen.getByTestId('switch-B'))
    expect(box().value).toBe('')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(box().value).toBe('')
    expect(draft('B')).toBe('')
  })

  it('a switch ends history cycling, so Up starts again from the newest entry', () => {
    const history = ['older', 'newest']
    render(<AppLikeParent initial={{ A: 'mine' }} userMessageHistory={history} />)
    box().setSelectionRange(4, 4)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('newest')

    fireEvent.click(screen.getByTestId('switch-B'))
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('newest')
  })

  it('a switch drops the evaluator panel, whose result belongs to the other draft', async () => {
    const onEvaluate = vi.fn().mockResolvedValue({ verdict: 'forward', reasoning: 'Looks good' })
    render(<AppLikeParent initial={{ A: 'draft text' }} onEvaluate={onEvaluate} />)
    fireEvent.click(screen.getByTestId('evaluate-button'))
    await waitFor(() => {
      expect(screen.getByTestId('evaluator-panel')).toHaveAttribute('data-verdict', 'forward')
    })

    fireEvent.click(screen.getByTestId('switch-B'))
    expect(screen.queryByTestId('evaluator-panel')).toBeNull()
  })

  it('the parent emptying the draft without a switch resets the palette the same way', () => {
    const onSlashTrigger = vi.fn()
    render(<AppLikeParent initial={{}} onSlashTrigger={onSlashTrigger} />)
    typeWithCaret('/', 1)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })

    fireEvent.click(screen.getByTestId('empty-active-draft'))
    expect(box().value).toBe('')

    typeWithCaret('/', 1)
    expect(onSlashTrigger).toHaveBeenCalledTimes(2)
    expect(slashRows()).toEqual(['true', 'false'])
  })

  it('an outside value equal to an earlier own write still counts as outside', async () => {
    const onEvaluate = vi.fn().mockResolvedValue({ verdict: 'forward', reasoning: 'Looks good' })
    render(<AppLikeParent initial={{ B: 'other' }} onEvaluate={onEvaluate} />)
    typeWithCaret('mine', 4)
    fireEvent.click(screen.getByTestId('switch-B'))
    fireEvent.click(screen.getByTestId('evaluate-button'))
    await waitFor(() => {
      expect(screen.getByTestId('evaluator-panel')).toHaveAttribute('data-verdict', 'forward')
    })

    // Back to A: 'mine' is the composer's last own write, but this time the
    // parent wrote it, so B's evaluation must not stay up over it.
    fireEvent.click(screen.getByTestId('switch-A'))
    expect(box().value).toBe('mine')
    expect(screen.queryByTestId('evaluator-panel')).toBeNull()
  })

  it('the composer\'s own writes keep the state: typing keeps the highlight', () => {
    const onSlashTrigger = vi.fn()
    render(<AppLikeParent initial={{}} onSlashTrigger={onSlashTrigger} />)
    typeWithCaret('/', 1)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    // "i" matches both commands, so both rows stay listed.
    typeWithCaret('/i', 2)
    expect(slashRows()).toEqual(['false', 'true'])
    expect(onSlashTrigger).toHaveBeenCalledTimes(1)
  })

  it('the composer\'s own writes keep the state: a history recall walks deeper', () => {
    render(<AppLikeParent initial={{}} userMessageHistory={['older', 'newest']} />)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('newest')
    box().setSelectionRange(0, 0)
    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().value).toBe('older')
    box().setSelectionRange(5, 5)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(box().value).toBe('newest')
  })
})

// #8832 — an evaluation still pending when the parent replaces the draft
// resolves afterwards, over the other session's draft. Its result must be
// dropped, or its Apply rewrite would replace that draft.
describe('a late evaluator result after the draft is replaced from outside (#8832)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>(res => { resolve = res })
    return { promise, resolve }
  }
  const REWRITE: EvaluatorResultPayload = { verdict: 'rewrite', rewritten: 'A draft, rewritten', reasoning: 'Clearer' }

  it('a switch while pending: the result is dropped and B\'s draft is untouched', async () => {
    const call = deferred<EvaluatorResultPayload>()
    render(<AppLikeParent initial={{ A: 'A draft', B: 'B draft' }} onEvaluate={() => call.promise} />)
    fireEvent.click(screen.getByTestId('evaluate-button'))
    expect(screen.getByTestId('evaluator-panel')).toHaveAttribute('aria-busy', 'true')

    fireEvent.click(screen.getByTestId('switch-B'))
    expect(box().value).toBe('B draft')

    await act(async () => { call.resolve(REWRITE) })
    expect(screen.queryByTestId('evaluator-panel')).toBeNull()
    expect(screen.queryByTestId('evaluator-apply')).toBeNull()
    expect(draft('B')).toBe('B draft')
  })

  it('the parent emptying the draft while pending: the result is dropped', async () => {
    const call = deferred<EvaluatorResultPayload>()
    render(<AppLikeParent initial={{ A: 'A draft' }} onEvaluate={() => call.promise} />)
    fireEvent.click(screen.getByTestId('evaluate-button'))
    fireEvent.click(screen.getByTestId('empty-active-draft'))
    expect(box().value).toBe('')

    await act(async () => { call.resolve(REWRITE) })
    expect(screen.queryByTestId('evaluator-panel')).toBeNull()
  })
})

/** #8268 — what the stale-bundle auto-reload treats as work a reload would destroy. */
import { describe, it, expect, afterEach } from 'vitest'
import { composerHasUnsavedWork, hasUnsavedWork, registerUnsavedWorkProbe } from './unsaved-work'

const empty = { drafts: [] as string[], pastedBlocks: [] as unknown[][], fileAttachments: [] as unknown[], imageAttachments: [] as unknown[] }

describe('composerHasUnsavedWork — one test per way to lose composer state', () => {
  it('is false for an empty composer', () => {
    expect(composerHasUnsavedWork(empty)).toBe(false)
  })

  it('a draft held only in a session that is not the visible tab counts', () => {
    expect(composerHasUnsavedWork({ ...empty, drafts: ['', 'half a thought for another session'] })).toBe(true)
  })

  it('whitespace-only drafts do not count', () => {
    expect(composerHasUnsavedWork({ ...empty, drafts: ['', '  \n '] })).toBe(false)
  })

  it('a pasted-text chip counts (the large paste is not in the textarea any more)', () => {
    expect(composerHasUnsavedWork({ ...empty, pastedBlocks: [[], [{ id: 1, content: 'big paste' }]] })).toBe(true)
  })

  it('a session whose pasted-block list is empty does not count', () => {
    expect(composerHasUnsavedWork({ ...empty, pastedBlocks: [[], []] })).toBe(false)
  })

  it('a staged file attachment counts', () => {
    expect(composerHasUnsavedWork({ ...empty, fileAttachments: [{ path: 'a.ts' }] })).toBe(true)
  })

  it('a staged image attachment counts', () => {
    expect(composerHasUnsavedWork({ ...empty, imageAttachments: [{ name: 'a.png' }] })).toBe(true)
  })

  it('works on the live iterators App passes (Map#values), not only arrays', () => {
    const drafts = new Map([['s1', ''], ['s2', 'unsent']])
    expect(composerHasUnsavedWork({ ...empty, drafts: drafts.values() })).toBe(true)
  })
})

describe('hasUnsavedWork — the DOM scan', () => {
  afterEach(() => { document.body.innerHTML = '' })
  const body = (html: string) => { document.body.innerHTML = html }

  it('is false on a clean page', () => {
    body('<textarea></textarea><input type="text" value="">')
    expect(hasUnsavedWork()).toBe(false)
  })

  it('a non-empty textarea counts', () => {
    body('<textarea>draft</textarea>')
    expect(hasUnsavedWork()).toBe(true)
  })

  for (const type of ['text', 'search', 'url', 'email', 'password']) {
    it(`a filled <input type="${type}"> in a form counts`, () => {
      body(`<form><input type="${type}" value="half-filled"></form>`)
      expect(hasUnsavedWork()).toBe(true)
    })
  }

  it('an <input> with no type attribute is a text input and counts', () => {
    body('<form><input value="half-filled"></form>')
    expect(hasUnsavedWork()).toBe(true)
  })

  it('a whitespace-only text input does not count', () => {
    body('<input type="text" value="   ">')
    expect(hasUnsavedWork()).toBe(false)
  })

  it('checkboxes, radios, hidden and range inputs hold no typed text and do not count', () => {
    body('<input type="checkbox" value="on" checked><input type="radio" value="a" checked><input type="hidden" value="csrf"><input type="range" value="3">')
    expect(hasUnsavedWork()).toBe(false)
  })

  it('a read-only input or textarea does not count', () => {
    body('<input type="text" value="shown" readonly><textarea readonly>shown</textarea>')
    expect(hasUnsavedWork()).toBe(false)
  })

  it('a registered probe counts, and unregistering removes it', () => {
    const off = registerUnsavedWorkProbe(() => true)
    expect(hasUnsavedWork()).toBe(true)
    off()
    expect(hasUnsavedWork()).toBe(false)
  })
})

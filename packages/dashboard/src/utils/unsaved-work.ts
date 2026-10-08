/**
 * Is there anything on this page a reload would destroy? (#8268)
 *
 * The stale-bundle check reloads the page on its own only when the answer is no.
 * Composer drafts are held in React refs and are not persisted anywhere, so a reload
 * mid-sentence would lose them; so would staged attachments.
 *
 * Two sources, both fail-safe (an unknown answer is "yes"):
 *  - probes the app registers for state the DOM does not show (attachments, pasted
 *    blocks, drafts of sessions that are not the visible tab);
 *  - any non-empty `<textarea>` or text-like `<input>` on the page, which covers the
 *    composer and every form (add-server, preset editors, settings) without each of
 *    them having to register. Checkboxes, radios, hidden and read-only fields do not
 *    count.
 *
 * A field that holds only an EPHEMERAL QUERY (a list filter, a search box) opts out with
 * `data-unsaved-ignore`: losing its text to a reload costs one keystroke-burst, and
 * counting it would quietly turn the auto-reload into the persistent banner whenever
 * someone left a filter filled in (#8385). Never put it on a field whose text the user
 * would be annoyed to retype from scratch (a form, a rename, a message).
 */
const probes = new Set<() => boolean>()

/** Register a probe that returns true while the app holds unsaved work. Returns an unregister function. */
export function registerUnsavedWorkProbe(probe: () => boolean): () => void {
  probes.add(probe)
  return () => { probes.delete(probe) }
}

/**
 * The composer's unsaved state, as plain data: the per-session drafts (a draft for a
 * session that is not the visible tab exists ONLY here), the per-session pasted-text
 * chips (a large paste leaves the textarea), and the staged file and image
 * attachments (chips too). None of it is persisted, and none of it is in a
 * `<textarea>` the DOM scan could see, so each clause is a separate way to lose work.
 */
export interface ComposerState {
  drafts: Iterable<string>
  pastedBlocks: Iterable<{ length: number }>
  fileAttachments: { length: number }
  imageAttachments: { length: number }
}

export function composerHasUnsavedWork(c: ComposerState): boolean {
  for (const draft of c.drafts) if (draft.trim() !== '') return true
  for (const blocks of c.pastedBlocks) if (blocks.length > 0) return true
  return c.fileAttachments.length > 0 || c.imageAttachments.length > 0
}

// Text-like <input> types. A checkbox, radio, range, file, button, hidden or color
// input holds no typed text, so it is not work a reload would destroy.
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'password', 'tel', 'number'])

function elementHoldsTypedText(el: Element): boolean {
  if (el.hasAttribute('data-unsaved-ignore')) return false
  if (el instanceof HTMLTextAreaElement) {
    return !el.readOnly && el.value.trim() !== ''
  }
  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    return TEXT_INPUT_TYPES.has(type) && !el.readOnly && el.value.trim() !== ''
  }
  return false
}

export function hasUnsavedWork(): boolean {
  for (const probe of probes) {
    try {
      if (probe()) return true
    } catch {
      return true
    }
  }
  if (typeof document === 'undefined') return false
  try {
    for (const el of Array.from(document.querySelectorAll('textarea, input'))) {
      if (elementHoldsTypedText(el)) return true
    }
  } catch {
    return true
  }
  return false
}

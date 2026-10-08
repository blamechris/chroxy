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
 *  - any non-empty `<textarea>` on the page, which covers the composer and every
 *    settings editor without each of them having to register.
 */
const probes = new Set<() => boolean>()

/** Register a probe that returns true while the app holds unsaved work. Returns an unregister function. */
export function registerUnsavedWorkProbe(probe: () => boolean): () => void {
  probes.add(probe)
  return () => { probes.delete(probe) }
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
    for (const el of Array.from(document.querySelectorAll('textarea'))) {
      if (el.value.trim() !== '') return true
    }
  } catch {
    return true
  }
  return false
}

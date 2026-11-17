/**
 * The provider a new session on the connected server actually uses (#8277).
 * The saved default is origin-global, so it can name a provider this server
 * does not offer: then the first offered provider wins. While the roster is
 * still empty (not yet received) the saved value is kept.
 */
export function resolveEffectiveProvider(
  saved: string,
  available: ReadonlyArray<{ name: string }>,
): string {
  if (available.length > 0 && !available.some(p => p.name === saved)) {
    return available[0]!.name
  }
  return saved
}

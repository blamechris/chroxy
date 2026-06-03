/**
 * Generic id-keyed reordering helpers.
 *
 * Used by the left-sidebar session list (#4832) and the top SessionBar
 * tab strip (#4831). Both need to:
 *
 *   - Move an item from one position to another (drag-and-drop, keyboard
 *     reorder shortcuts).
 *   - Reconcile a persisted order array against a current live array of
 *     items: keep the persisted order for items that still exist, drop
 *     ids that are gone, and append new ids that haven't been ordered
 *     yet.
 *
 * Keeping both helpers in one place avoids the two issues drifting on
 * subtly different rules (which we hit on #4419/#4420 with the
 * pending-shell cap helpers).
 */

/**
 * Move the item at `fromIndex` so it lands at `toIndex` in a fresh array.
 *
 * Out-of-range indices are clamped to the array's valid range. Returns the
 * original array (no copy) when the move is a no-op (same index or
 * single-element array). Callers can treat the return as immutable.
 */
export function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (items.length <= 1) return items as T[]
  const clampedFrom = Math.max(0, Math.min(fromIndex, items.length - 1))
  const clampedTo = Math.max(0, Math.min(toIndex, items.length - 1))
  if (clampedFrom === clampedTo) return items as T[]
  const next = items.slice()
  const [moved] = next.splice(clampedFrom, 1)
  next.splice(clampedTo, 0, moved as T)
  return next
}

/**
 * Reorder a list of items keyed by id, following a saved order.
 *
 * - `getId` extracts the stable id from an item.
 * - `order` is the persisted ordering (e.g. from localStorage). Ids in
 *   `order` that are missing from `items` are silently dropped.
 * - Items present in `items` but NOT in `order` are appended at the end,
 *   preserving their relative order from the input array. New sessions
 *   land at the bottom of the list — they don't shuffle existing entries.
 *
 * This is the function the sidebar memo runs every render, so it
 * intentionally returns a fresh array only when reordering actually
 * happens; if the live order already matches `order` (plus any tail
 * additions), the result is still a fresh array but the contents are
 * stable for downstream memoization.
 */
export function applyOrderById<T>(
  items: readonly T[],
  order: readonly string[],
  getId: (item: T) => string,
): T[] {
  if (items.length === 0) return []
  if (order.length === 0) return items.slice()

  const byId = new Map<string, T>()
  for (const item of items) byId.set(getId(item), item)

  const seen = new Set<string>()
  const ordered: T[] = []
  for (const id of order) {
    const found = byId.get(id)
    if (found && !seen.has(id)) {
      ordered.push(found)
      seen.add(id)
    }
  }
  // Tail-append unseen items in their original order.
  for (const item of items) {
    const id = getId(item)
    if (!seen.has(id)) {
      ordered.push(item)
      seen.add(id)
    }
  }
  return ordered
}

/**
 * Convert a reordered item list back into the id array we persist. Pure
 * convenience: keeps callers from inlining `.map(getId)` everywhere.
 */
export function orderToIds<T>(items: readonly T[], getId: (item: T) => string): string[] {
  return items.map(getId)
}

import { useLayoutEffect, useState, type RefObject } from 'react'

/** The tree's floor when the stylesheet is not available (jsdom without the CSS). */
const FALLBACK_TREE_FLOOR = 96

/**
 * #8888 — decide whether the sidebar's project tree should FLOW with the scroll
 * column instead of scrolling inside it.
 *
 * `.sidebar-tree` is boxed by default (`flex: 1`, a 96px floor, its own
 * scroller), so on a tall window it fills the space above the Archived section
 * and panel slot. When the column cannot hold every section with the tree at
 * that floor, the column scrolls and a boxed tree would be a small scroller
 * nested inside it. In that case the tree takes its content height (the
 * `sidebar-tree--flow` modifier) and the column is the only scroller.
 *
 * The test is `need = column.scrollHeight - tree.offsetHeight + floor` against
 * `column.clientHeight`: the height the column needs with the tree at its
 * floor. It is the same number in both modes (when the column overflows every
 * other section sits at its minimum either way; when it fits, it is at most
 * `clientHeight`), so the answer does not depend on the current mode and
 * cannot flip-flop.
 *
 * Every direct child of the column is observed, so an Archived expand/collapse,
 * a panel-slot resize or a list change re-evaluates; a MutationObserver
 * re-observes when sections mount or unmount. Without ResizeObserver (jsdom)
 * the evaluation runs once on mount.
 */
export function useSidebarTreeFlow(
  scrollRef: RefObject<HTMLElement | null>,
  treeRef: RefObject<HTMLElement | null>,
  // The column only mounts while the sidebar is open; re-run when that changes.
  mounted = true,
): boolean {
  const [flow, setFlow] = useState(false)

  useLayoutEffect(() => {
    const column = scrollRef.current
    const tree = treeRef.current
    if (!column || !tree) return

    const evaluate = () => {
      const parsed = Number.parseFloat(getComputedStyle(tree).minHeight)
      const floor = Number.isFinite(parsed) ? parsed : FALLBACK_TREE_FLOOR
      const need = column.scrollHeight - tree.offsetHeight + floor
      // +1 absorbs sub-pixel rounding in scrollHeight / offsetHeight.
      // A column with no height is not laid out (hidden / jsdom): stay boxed.
      setFlow(column.clientHeight > 0 && need > column.clientHeight + 1)
    }
    evaluate()
    if (typeof ResizeObserver === 'undefined') return

    const ro = new ResizeObserver(evaluate)
    const observe = () => {
      ro.disconnect()
      ro.observe(column)
      for (const child of Array.from(column.children)) ro.observe(child)
    }
    observe()
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(observe)
    mo?.observe(column, { childList: true })
    return () => {
      ro.disconnect()
      mo?.disconnect()
    }
  }, [scrollRef, treeRef, mounted])

  return flow
}

/**
 * Dev-only render counter (#5516, epic #5514).
 *
 * A process-global tally of how many times a labelled component instance has
 * rendered. Used by the memoization tests (and ad-hoc dev debugging) to PROVE
 * that non-tail chat bubbles do not re-render — and re-parse markdown — on a
 * streaming delta flush.
 *
 * Deliberately tiny and dependency-free: a single `Map<label, count>`. It is
 * NEVER consulted on the production hot path — only the tests and an opt-in
 * dev log read it. Components call {@link bumpRenderCount} from their render
 * body (cheap Map write); the buffers/percentiles live in `latency-stats`.
 *
 * The counter is keyed by an arbitrary string label. Callers that want a
 * per-instance tally pass a stable id (e.g. `MessageBubble:${message.id}`);
 * callers that want an aggregate pass a constant (e.g. `MessageBubble`).
 */

const _counts = new Map<string, number>()

/** Increment (and return) the render tally for `label`. */
export function bumpRenderCount(label: string): number {
  const next = (_counts.get(label) ?? 0) + 1
  _counts.set(label, next)
  return next
}

/** Current render tally for `label` (0 if never rendered). */
export function getRenderCount(label: string): number {
  return _counts.get(label) ?? 0
}

/** Reset one label's tally, or all of them when `label` is omitted. */
export function resetRenderCounts(label?: string): void {
  if (label === undefined) _counts.clear()
  else _counts.delete(label)
}

/** Snapshot of every tracked label → count. Test/debug only. */
export function renderCountSnapshot(): Record<string, number> {
  return Object.fromEntries(_counts)
}

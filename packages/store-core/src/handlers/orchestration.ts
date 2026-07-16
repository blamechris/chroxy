/**
 * Shared, pure client-side reducers for the orchestration / delegation harness
 * ("committee" — epic #6691, delivery step S-1).
 *
 * Runs are host-level objects delivered as a survey snapshot
 * (orchestration_runs_snapshot / orchestration_run_snapshot) plus a seq'd push
 * delta (orchestration_run_delta). These functions own the merge logic — the
 * runs-list upsert and the strict seq-gap delta application — so that when the
 * dashboard wires them (S-3, #6702) and later the mobile app (post-v1) the two
 * clients share ONE tested implementation instead of drifting. Nothing calls
 * these yet; they are tested groundwork the client handlers will call.
 *
 * The delta contract: a client that holds a run's detail applies a delta iff
 * `delta.seq === held.seq + 1`. A gap ⇒ `resync: true`, and the caller
 * re-requests the run snapshot (deltas for an unheld run, or a stale/duplicate
 * seq, are ignored). This mirrors the repo-events snapshot+delta contract.
 */

import type {
  RunSummary,
  RunDetail,
  RunNode,
  RunGate,
  RunTimelineEntry,
  ServerOrchestrationRunDelta,
} from '@chroxy/protocol'

// Server sends the last 500 timeline entries in a snapshot; keep the same bound
// as deltas append so a long run's client-held timeline stays bounded.
export const RUN_TIMELINE_MAX = 500

/** A run detail plus the wire seq high-water mark it was last consistent at. */
export interface HeldRunDetail {
  detail: RunDetail
  seq: number
}

/** Insert-or-replace a run summary in the runs list, keyed by runId. New runs
 *  go to the front (most-recent-first, matching how the list is rendered). */
export function upsertRunSummary(
  list: readonly RunSummary[],
  summary: RunSummary,
): RunSummary[] {
  const i = list.findIndex((r) => r.runId === summary.runId)
  if (i === -1) return [summary, ...list]
  const next = list.slice()
  next[i] = summary
  return next
}

function upsertById<T>(arr: readonly T[], item: T, key: (x: T) => string): T[] {
  const id = key(item)
  const i = arr.findIndex((x) => key(x) === id)
  if (i === -1) return [...arr, item]
  const next = arr.slice()
  next[i] = item
  return next
}

function appendTimeline(
  timeline: readonly RunTimelineEntry[],
  entry: RunTimelineEntry,
): RunTimelineEntry[] {
  const next = [...timeline, entry]
  return next.length > RUN_TIMELINE_MAX ? next.slice(next.length - RUN_TIMELINE_MAX) : next
}

/**
 * Apply a run delta to the held detail under the strict seq contract.
 * - not holding this run (or a different run): ignore (`resync: false`).
 * - stale/duplicate seq (`delta.seq <= held.seq`): ignore.
 * - gap (`delta.seq > held.seq + 1`): `resync: true`, held unchanged — caller
 *   re-requests the snapshot.
 * - in-order (`delta.seq === held.seq + 1`): apply the run/node/gate/timeline
 *   upserts and advance the seq.
 */
export function applyRunDelta(
  held: HeldRunDetail | null,
  delta: ServerOrchestrationRunDelta,
): { held: HeldRunDetail | null; resync: boolean } {
  if (!held || held.detail.runId !== delta.runId) return { held, resync: false }
  if (delta.seq <= held.seq) return { held, resync: false }
  if (delta.seq !== held.seq + 1) return { held, resync: true }

  let detail: RunDetail = held.detail
  // delta.run carries only RunSummary-level keys, so spreading it updates the
  // header (status/usage/budget/nodeCounts/pendingUserGates/...) and leaves the
  // detail-only keys (nodes/gates/timeline/epicPrompt/...) intact.
  if (delta.run) detail = { ...detail, ...delta.run }
  if (delta.node) {
    detail = { ...detail, nodes: upsertById<RunNode>(detail.nodes, delta.node, (n) => n.nodeId) }
  }
  if (delta.gate) {
    detail = { ...detail, gates: upsertById<RunGate>(detail.gates, delta.gate, (g) => g.gateId) }
  }
  if (delta.timeline) {
    detail = { ...detail, timeline: appendTimeline(detail.timeline, delta.timeline) }
  }
  return { held: { detail, seq: delta.seq }, resync: false }
}

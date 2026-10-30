/**
 * Pure helpers for the read-only, paged history views (#8860, generalised for
 * the session archive). A failed restore's panel and an archived session's
 * panel are the same thing keyed by a different id, so the three rules below
 * live HERE, once, and both store maps (`failedRestoreHistories`,
 * `archivedSessionHistories`) go through them:
 *
 *   - beginHistoryRequest  — one page in flight per id; the offset comes from
 *                            `entries.length`, never from the caller.
 *   - applyHistoryReply    — a reply lands only on a view that is OPEN and
 *                            WAITING and only if it echoes the offset asked for.
 *   - settleHistoryViewsOnDrop — a page in flight on a dead socket becomes an
 *                            error beside the entries already fetched.
 *
 * They take and return plain maps (no store access), so each is trivially
 * testable and neither caller can drift from the other.
 */
import type { HistoryPageView } from './types';

/** Entries asked for per page. The server clamps to 1..100. */
export const HISTORY_PAGE_SIZE = 50;

export type HistoryViewMap = Record<string, HistoryPageView>;

/** The fields of a history reply this module reads (every reply shape has them). */
export interface HistoryReplyFields {
  ok?: boolean;
  offset?: number;
  total?: number;
  entries?: unknown;
  refused?: boolean;
  code?: string;
  message?: string;
}

/**
 * Open (or extend) the view for `id`. Returns the next map and the offset to
 * put on the wire, or `null` when a page is already in flight for this id (a
 * second request would make the offset a reply is matched against ambiguous).
 * `more` asks for the page after what is shown; otherwise it starts over from
 * the oldest entry.
 */
export function beginHistoryRequest(
  views: HistoryViewMap,
  id: string,
  more: boolean,
): { views: HistoryViewMap; offset: number } | null {
  const current = views[id];
  if (current?.loading) return null;
  const offset = more && current ? current.entries.length : 0;
  return {
    offset,
    views: {
      ...views,
      [id]: {
        entries: offset === 0 ? [] : current!.entries,
        total: offset === 0 ? null : current!.total,
        loading: true,
        pendingOffset: offset,
      },
    },
  };
}

/**
 * Apply a reply for `id`. Returns the next map, or `null` when the reply must
 * be DROPPED: no id, no such view, a view that is not waiting (closed
 * meanwhile, or an unsolicited frame), or an `ok` page whose echoed offset is
 * not the one asked for. A dropped reply never resurrects or corrupts a panel.
 */
export function applyHistoryReply(
  views: HistoryViewMap,
  id: unknown,
  reply: HistoryReplyFields,
): HistoryViewMap | null {
  if (typeof id !== 'string' || id === '') return null;
  const view = views[id];
  if (!view || !view.loading || view.pendingOffset === null) return null;
  if (reply.ok === true) {
    // The offset is optional on the wire; when present it must match.
    if (typeof reply.offset === 'number' && reply.offset !== view.pendingOffset) return null;
    const page = Array.isArray(reply.entries) ? (reply.entries as HistoryPageView['entries']) : [];
    const base = view.pendingOffset === 0 ? [] : view.entries;
    const entries = [...base, ...page];
    const total = typeof reply.total === 'number' ? reply.total : entries.length;
    return {
      ...views,
      // A zero-length page with a total still ahead would make "Load more"
      // re-request the same offset forever; treat it as the end.
      [id]: {
        entries,
        total: page.length === 0 ? Math.min(total, entries.length) : total,
        loading: false,
        pendingOffset: null,
      },
    };
  }
  return {
    ...views,
    [id]: {
      ...view,
      loading: false,
      pendingOffset: null,
      error: { code: reply.code, message: reply.message, refused: reply.refused === true },
    },
  };
}

/**
 * Settle every page in flight when the socket drops: it can never be answered
 * on the dead one. Not emptied wholesale — the entries already fetched are data
 * the next reconnect to the SAME daemon can still show — so only the pending
 * flag becomes an error the panel renders beside them. Returns `null` when
 * nothing was pending, so an idle drop writes nothing.
 */
export function settleHistoryViewsOnDrop(views: HistoryViewMap): HistoryViewMap | null {
  let next: HistoryViewMap | null = null;
  for (const [id, view] of Object.entries(views)) {
    if (!view.loading) continue;
    next ??= { ...views };
    next[id] = {
      ...view,
      loading: false,
      pendingOffset: null,
      error: { code: 'CONNECTION_LOST', message: 'Connection lost while loading — try again.' },
    };
  }
  return next;
}

/** Keep only the views whose id is in `liveIds`. Same reference when nothing is dropped. */
export function pruneHistoryViews(views: HistoryViewMap, liveIds: ReadonlySet<string>): HistoryViewMap {
  const kept = Object.entries(views).filter(([id]) => liveIds.has(id));
  return kept.length === Object.keys(views).length ? views : Object.fromEntries(kept);
}

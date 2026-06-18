/**
 * usePermissionAnnouncer (#5750, item 2) — mobile assertive announcement when a
 * NEW permission prompt appears, so a VoiceOver/TalkBack user is told
 * immediately. The prompt auto-DENIES on timeout, so silence is a footgun: the
 * user could lose an action they'd have allowed without ever knowing it was
 * asked.
 *
 * Companion to the dashboard's #5733 `alertdialog` / assertive `aria-live`
 * treatment. Mobile has no DOM live region, so this pushes through
 * `AccessibilityInfo.announceForAccessibility` — the same one-shot primitive
 * already used by `useConnectionAnnouncer`, `CheckInChip`, and
 * `ThinkingIndicator`.
 *
 * Semantics (mirroring `useConnectionAnnouncer`):
 *   - Watches the active session's messages for the first LIVE permission
 *     prompt — `type:'prompt'` with a `requestId` + a future `expiresAt` and no
 *     `answered` decision. (The requestId+expiresAt pair excludes
 *     AskUserQuestion prompts, which are also `type:'prompt'`.)
 *   - Announces once per prompt, keyed on `requestId`.
 *   - Seeds the last-announced ref SYNCHRONOUSLY with whatever is already
 *     pending, so arriving at a session that ALREADY shows a prompt stays
 *     silent — only genuinely newly-arriving prompts are announced.
 *   - Clears the ref when no prompt is live, so the next arrival announces.
 *
 * Session-aware (#5760 review): ChatView is NOT remounted on a tab-switch — it
 * just re-renders with the new session's `messages` — so a single persistent
 * ref would carry across sessions and falsely announce the destination
 * session's ALREADY-pending prompt. We therefore re-seed whenever `sessionKey`
 * changes: the seed runs again for the new session, suppressing its existing
 * prompt and announcing only what arrives after the switch settles.
 */
import { useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { ChatMessage } from '@chroxy/store-core';
// #5759 — the live-permission-prompt predicate is shared with the dashboard via
// store-core so the two clients can't drift on what counts as "pending".
import { livePermissionPrompts } from '@chroxy/store-core';
import { getPermissionSummary } from '../components/PermissionDetail';

export function usePermissionAnnouncer(messages: ChatMessage[], sessionKey: string | null): void {
  // requestIds we've already announced. A Set (not a single id) because more
  // than one permission can be live at once (parallel SDK tool calls) — keying
  // on the *first* live prompt would never announce a second concurrent one
  // while the first stayed live. Pruned each run to only still-live ids, which
  // bounds it and (harmlessly, since requestIds are unique) allows re-use.
  const announcedRef = useRef<Set<string>>(new Set());
  // The session the set is seeded for. A change means we navigated sessions and
  // must re-seed against the destination's existing prompts (ChatView doesn't
  // remount on switch, so the set would otherwise leak across sessions and
  // either re-announce or wrongly suppress).
  const seededSessionRef = useRef<string | null | undefined>(undefined);
  if (seededSessionRef.current !== sessionKey) {
    seededSessionRef.current = sessionKey;
    // Seed: treat the destination session's already-pending prompts as
    // already-announced so arriving stays silent — only later arrivals speak.
    announcedRef.current = new Set(
      livePermissionPrompts(messages, Date.now()).map((m) => m.requestId as string),
    );
  }

  useEffect(() => {
    const now = Date.now();
    const live = livePermissionPrompts(messages, now);
    const liveIds = new Set(live.map((m) => m.requestId as string));
    // Prune resolved/expired ids so the set stays bounded to what's live.
    for (const id of announcedRef.current) {
      if (!liveIds.has(id)) announcedRef.current.delete(id);
    }
    // Announce the first not-yet-announced live prompt. Sequential arrivals
    // (the common case — each tool call appends its own prompt message) each
    // get their own effect run, so each announces once.
    const fresh = live.find((m) => !announcedRef.current.has(m.requestId as string));
    if (!fresh) return;
    announcedRef.current.add(fresh.requestId as string);
    const summary = getPermissionSummary(fresh.tool, fresh.toolInput);
    AccessibilityInfo.announceForAccessibility?.(`Permission requested: ${summary}`);
  }, [messages, sessionKey]);
}

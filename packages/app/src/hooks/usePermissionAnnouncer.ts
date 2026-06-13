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
import { getPermissionSummary } from '../components/PermissionDetail';

/** The first live, unanswered permission prompt in `messages`, or null. */
export function firstLivePermissionPrompt(messages: ChatMessage[], now: number): ChatMessage | null {
  for (const m of messages) {
    if (m.type === 'prompt' && !!m.requestId && !!m.expiresAt && m.expiresAt > now && !m.answered) {
      return m;
    }
  }
  return null;
}

export function usePermissionAnnouncer(messages: ChatMessage[], sessionKey: string | null): void {
  // requestId of the prompt we last announced. `undefined` = not yet seeded;
  // `null` = nothing pending. Seeded so a prompt already present (at mount, or
  // in the session we just switched to) isn't announced — only new arrivals.
  const lastAnnouncedRef = useRef<string | null | undefined>(undefined);
  // The session the ref is seeded for. A change means we navigated sessions and
  // must re-seed against the destination's existing prompt (ChatView doesn't
  // remount on switch, so the ref would otherwise leak across sessions).
  const seededSessionRef = useRef<string | null | undefined>(undefined);
  if (seededSessionRef.current !== sessionKey) {
    seededSessionRef.current = sessionKey;
    lastAnnouncedRef.current = firstLivePermissionPrompt(messages, Date.now())?.requestId ?? null;
  }

  useEffect(() => {
    const live = firstLivePermissionPrompt(messages, Date.now());
    const id = live?.requestId ?? null;
    if (id == null) {
      // Nothing live → reset so a future prompt (new requestId) announces.
      lastAnnouncedRef.current = null;
      return;
    }
    if (id === lastAnnouncedRef.current) return;
    lastAnnouncedRef.current = id;
    const summary = getPermissionSummary(live!.tool, live!.toolInput);
    AccessibilityInfo.announceForAccessibility?.(`Permission requested: ${summary}`);
  }, [messages, sessionKey]);
}

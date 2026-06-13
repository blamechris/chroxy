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
 *   - Seeds the last-announced ref SYNCHRONOUSLY at first render with whatever
 *     is already pending, so arriving at a session that ALREADY shows a prompt
 *     stays silent — only genuinely newly-arriving prompts are announced.
 *   - Clears the ref when no prompt is live, so the next arrival announces.
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

export function usePermissionAnnouncer(messages: ChatMessage[]): void {
  // requestId of the prompt we last announced. `undefined` = not yet seeded;
  // `null` = nothing pending. Seeded once on the first render so a prompt that
  // is already present at mount isn't announced — only new arrivals are.
  const lastAnnouncedRef = useRef<string | null | undefined>(undefined);
  if (lastAnnouncedRef.current === undefined) {
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
  }, [messages]);
}

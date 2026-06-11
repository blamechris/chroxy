/**
 * useConnectionAnnouncer (#5581) — mobile port of the dashboard's debounced
 * ConnectionAnnouncer (`packages/dashboard/src/components/ConnectionAnnouncer.tsx`).
 *
 * Background — a VoiceOver/TalkBack user on the phone gets no audible signal
 * when the connection drops or recovers. The dashboard solved this with a
 * single hidden `aria-live` region that announces only the SETTLED connection
 * phase after a debounce window, so reconnect storms (the phase flips
 * `connecting → reconnecting → connected → reconnecting…` many times per
 * second) coalesce into one polite announcement of the resting state rather
 * than spamming the screen reader.
 *
 * Mobile has no DOM live region, so this hook subscribes to
 * `connectionPhase` from the connection-lifecycle store and pushes the
 * settled phase through `AccessibilityInfo.announceForAccessibility` — the
 * same one-shot announcement primitive already used by ThinkingIndicator and
 * CheckInChip.
 *
 * Debounce semantics mirror the dashboard:
 *   - A phase change schedules a `debounceMs` timer (default 1500ms).
 *   - A subsequent change within the window cancels the prior timer, so only
 *     the LAST (settled) phase fires.
 *   - When the timer fires it re-checks the current phase against the last
 *     announced value, so a flap that returns to the previously-announced
 *     state says nothing.
 *
 * Difference from the dashboard — initial mount:
 *   The dashboard mounts in `connecting` and intentionally schedules a timer
 *   for that initial phase. Mobile mounts in `disconnected` on a cold open
 *   (before the user has ever connected), and announcing "Disconnected" out
 *   of the gate would be a confusing blast with no preceding "connected" to
 *   close the loop. So we seed the last-announced ref with the phase observed
 *   at mount and skip scheduling a timer for it — only genuine *transitions*
 *   away from the mount phase are announced.
 */
import { useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { ConnectionPhase } from '../store/types';
import { useConnectionLifecycleStore } from '../store/connection-lifecycle';

/** Production debounce window — long enough to absorb reconnect-storm churn. */
export const CONNECTION_ANNOUNCE_DEBOUNCE_MS = 1500;

/**
 * Settled-phase → spoken label. Mirrors the dashboard's `SETTLED_LABELS`
 * mapping, adapted to the mobile phase union.
 */
const SETTLED_LABELS: Record<ConnectionPhase, string> = {
  connected: 'Connected to Chroxy server',
  connecting: 'Connecting to Chroxy server',
  reconnecting: 'Reconnecting to Chroxy server',
  server_restarting: 'Chroxy server restarting',
  disconnected: 'Disconnected from Chroxy server',
};

export function settledLabelFor(phase: ConnectionPhase): string {
  return SETTLED_LABELS[phase] ?? `Connection status: ${phase}`;
}

export interface UseConnectionAnnouncerOptions {
  /**
   * Debounce window in ms. Phase changes within this window are coalesced —
   * only the final phase is announced. Exposed for tests to set very short
   * windows; the production default is `CONNECTION_ANNOUNCE_DEBOUNCE_MS`.
   */
  debounceMs?: number;
}

/**
 * Subscribe to the connection phase and announce settled transitions to
 * assistive tech. Mount once at the app level (see `App.tsx`). Renders
 * nothing — it is a pure side-effect hook.
 */
export function useConnectionAnnouncer({
  debounceMs = CONNECTION_ANNOUNCE_DEBOUNCE_MS,
}: UseConnectionAnnouncerOptions = {}): void {
  const phase = useConnectionLifecycleStore((s) => s.connectionPhase);

  // Last phase we actually announced. Seeded lazily with the mount phase (see
  // the mount-guard effect below) so the first paint does not announce — a
  // cold open in `disconnected` must stay silent until a real connect/drop.
  const lastAnnouncedRef = useRef<ConnectionPhase | null>(null);
  // Pending debounce timer; successive phase changes cancel the prior one.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed the last-announced ref with the phase present at mount, BEFORE the
  // debounce effect runs, so the initial phase is treated as already-spoken
  // and never scheduled. Empty dep array → runs once on mount.
  useEffect(() => {
    if (lastAnnouncedRef.current === null) {
      lastAnnouncedRef.current = phase;
    }
    // Intentionally mount-only — we want the phase captured at first render,
    // not on every phase change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Clear any pending timer — only the LAST change in a churn window fires.
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // No-op change (re-render with same phase, or the seeded mount phase) →
    // nothing to announce.
    if (phase === lastAnnouncedRef.current) return;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Re-check: the phase may have flapped back to the last-announced value
      // by the time the timer fires, in which case there's nothing to say.
      if (phase === lastAnnouncedRef.current) return;
      lastAnnouncedRef.current = phase;
      AccessibilityInfo.announceForAccessibility?.(settledLabelFor(phase));
    }, debounceMs);

    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [phase, debounceMs]);
}

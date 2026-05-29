/**
 * ActivityIndicator — "Working… last activity Ns ago" UI (#3758).
 *
 * Renders only while the active session is busy. Shows the elapsed time
 * since the last activity-bearing server event (stream_start, stream_delta,
 * stream_end, tool_start, tool_result, message, result, user_question,
 * permission_request — see ACTIVITY_EVENT_TYPES in @chroxy/store-core).
 *
 * Mobile companion to packages/dashboard/src/components/ActivityIndicator.tsx
 * — same selector + tick-once-per-second pattern, React Native styling.
 *
 * #4321 / #4308 — also names the most-recent in-flight tool when one is
 * running ("Running Bash · 12s"), derived from the active session's
 * messages[]. Mirrors the dashboard's derive-from-messages approach —
 * no protocol change, no state-shape work, no parallel-tool tracking;
 * the most-recent unresolved tool_use is the one named. Falls back to
 * the original "Working… last activity" label when every tool has
 * resolved or no tool is in flight.
 *
 * Color escalation:
 *   0-30s         green   (active)
 *   30-60s        yellow  (quiet)
 *   60s-threshold orange  (slow)
 *   approaching   red     (last 60s before timeout)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { formatToolName } from '@chroxy/store-core';
import { useConnectionStore } from '../store/connection';
import { useConnectionLifecycleStore } from '../store/connection-lifecycle';
import { COLORS } from '../constants/colors';

/** Fallback default matching the server's BaseSession.DEFAULT_RESULT_TIMEOUT_MS (#3754 / #3884) */
const FALLBACK_TIMEOUT_MS = 30 * 60 * 1000;

function formatElapsed(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS === 0 ? `${m}m ago` : `${m}m ${remS}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

// #4321 / #4308 — duration without the "ago" suffix, used for the
// "Running X · 12s" label (the named tool is current, not past, so
// "ago" is wrong). Mirrors the dashboard helper.
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function statusColor(elapsedMs: number, timeoutMs: number): string {
  if (elapsedMs >= timeoutMs - 60_000) return COLORS.accentRed500;
  if (elapsedMs >= 60_000) return COLORS.accentOrange500;
  if (elapsedMs >= 30_000) return COLORS.accentYellow500;
  return COLORS.accentGreen;
}

export function ActivityIndicator() {
  const isIdle = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessionStates[id]?.isIdle ?? true : true;
  });
  const lastActivityAt = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessionStates[id]?.lastClientActivityAt ?? null : null;
  });
  // #4321 / #4308 — subscribe to the active session's messages so the
  // indicator can name the in-flight tool. The store mutates `messages`
  // immutably, so this only re-renders when the array reference changes.
  const messages = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessionStates[id]?.messages ?? null : null;
  });
  // #4422 — subscribe to pendingBackgroundShells so the idle-state surface
  // can name the most-recently-started backgrounded shell. Mirrors the
  // dashboard's #4419 surface but adapted to React Native. The store
  // immutably swaps this array on `background_work_changed`, so this only
  // re-renders when the slot actually mutates.
  const pendingBackgroundShells = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return id ? s.sessionStates[id]?.pendingBackgroundShells ?? null : null;
  });
  const referenceTimeoutMs = useConnectionLifecycleStore(
    (s) => s.serverResultTimeoutMs ?? FALLBACK_TIMEOUT_MS,
  );

  // #4321 / #4308 — walk back through messages to find the most-recent
  // tool_use that has no result attached. `toolResult === undefined`
  // plus a check on `toolResultImages` mirrors the same "no result yet"
  // predicate the ToolBubble header pulse uses (#4308). Returns null
  // when every tool call has resolved — the indicator falls back to
  // the original "Working… last activity" label.
  const inFlight = useMemo<{ tool: string; startedAt: number; serverName?: string } | null>(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.type !== 'tool_use') continue;
      const hasResult =
        m.toolResult !== undefined || (m.toolResultImages?.length ?? 0) > 0;
      if (!hasResult) {
        return { tool: m.tool ?? 'tool', startedAt: m.timestamp, serverName: m.serverName };
      }
    }
    return null;
  }, [messages]);

  // #4422 — most-recently-started pending background shell, projected so the
  // idle-state surface can name it. Mirrors the dashboard's #4419 approach:
  // when the turn ends but a shell is still parked in the background, the
  // chip says "Waiting on background work · <command>" instead of vanishing.
  // We fall back to the shellId when the command string is empty so the chip
  // always has something concrete to show.
  const pendingShell = useMemo<{ command: string; shellId: string } | null>(() => {
    if (!pendingBackgroundShells || pendingBackgroundShells.length === 0) return null;
    const latest = pendingBackgroundShells.reduce((acc, s) =>
      s.startedAt > acc.startedAt ? s : acc,
    );
    return { command: latest.command, shellId: latest.shellId };
  }, [pendingBackgroundShells]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isIdle) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isIdle]);

  if (isIdle) {
    // #4422 — when the turn ends but the agent backgrounded a Bash shell, the
    // session is still effectively waiting on work. Surface that as a chip so
    // the user can tell "idle and done" from "idle but parked on a long-
    // running shell". Single-shell case: project the most-recently-started
    // shell's command (falling back to its shellId when the command is
    // empty). Multi-shell expand UI is deferred per #4418's body — for now
    // the full command list rides on the chip's accessibilityLabel so screen-
    // reader users still hear every entry. Pending shells are SECONDARY:
    // during an active turn the live tool label wins (the busy branch below
    // handles that).
    if (pendingShell) {
      const detail = pendingShell.command.length > 0 ? pendingShell.command : pendingShell.shellId;
      const fullList = (pendingBackgroundShells ?? [])
        .map((s) => (s.command.length > 0 ? s.command : s.shellId))
        .join(', ');
      return (
        <View style={styles.container}>
          <View style={[styles.dot, { backgroundColor: COLORS.accentGreen }]} />
          <Text
            style={[styles.label, { color: COLORS.accentGreen }]}
            accessibilityRole="text"
            accessibilityLabel={`Waiting on background work: ${fullList}`}
            testID="activity-indicator-label"
            numberOfLines={1}
          >
            Waiting on background work · {detail}
          </Text>
        </View>
      );
    }
    return null;
  }

  if (lastActivityAt == null) {
    return (
      <View style={styles.container}>
        <View style={[styles.dot, { backgroundColor: COLORS.accentGreen }]} />
        <Text style={[styles.label, { color: COLORS.accentGreen }]}>Working…</Text>
      </View>
    );
  }

  const elapsed = Math.max(0, now - lastActivityAt);
  const remaining = referenceTimeoutMs - elapsed;
  const approaching = remaining > 0 && remaining <= 60_000;
  const color = statusColor(elapsed, referenceTimeoutMs);

  // #4321 / #4308 — name the in-flight tool when one is running. Falls
  // back to the original "Working… last activity" label when no tool is
  // in flight (e.g. waiting on assistant text between tool calls).
  const label = inFlight
    ? `Running ${formatToolName(inFlight.tool, inFlight.serverName)} · ${formatDuration(now - inFlight.startedAt)}`
    : `Working… last activity ${formatElapsed(elapsed)}`;

  return (
    <View style={styles.container}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text
        style={[styles.label, { color }]}
        accessibilityRole="text"
        testID="activity-indicator-label"
      >
        {label}
      </Text>
      {approaching && (
        <Text style={[styles.warning, { color }]}>
          · approaching timeout ({Math.ceil(remaining / 1000)}s left)
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  warning: {
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4,
  },
});


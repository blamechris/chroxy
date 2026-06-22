/**
 * MissionControlScreen (#5968 PR1) — the mobile, READ-ONLY mission-control view.
 *
 * Parity port of the dashboard `CrossSessionMissionControl` (#6183): it reuses
 * store-core's `selectCrossSessionActivity` (#6182) so the mobile aggregate can
 * never drift from the dashboard / tray badge. Sessions are grouped by
 * repo+worktree (cwd); the overall set and each group carry
 * running/blocked/failed/idle SESSION counts. Each session renders as a row with
 * a derived-status badge.
 *
 * Scope (PR1): read-only only — NO drill-down/expansion, NO cancel/jump, NO
 * external-sessions section. The live data feeder (dispatching
 * `activity_snapshot` / `activity_delta` into `state.activity`) is PR2; until it
 * lands the view shows the empty state for a fresh store.
 *
 * Testability: the screen is a thin store-reader that delegates rendering to the
 * exported pure {@link MissionControlBody}. The render test drives the Body
 * directly with seeded fixtures (no store / navigation context needed).
 */
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import type {
  CrossSessionMeta,
  CrossSessionRollup,
  SessionDerivedStatus,
} from '@chroxy/store-core';
import { selectCrossSessionActivity } from '@chroxy/store-core';
import { useConnectionStore } from '../store/connection';
import { COLORS } from '../constants/colors';

// The store-core cross-session reducer state. Imported inline to avoid colliding
// with the app's own `ActivityState` enum (store/session-activity.ts), which is
// re-exported through store/types.ts under the same name.
type CrossSessionState = import('@chroxy/store-core').ActivityState;

const STATUS_LABEL: Record<SessionDerivedStatus, string> = {
  running: 'Running',
  blocked: 'Blocked',
  failed: 'Failed',
  idle: 'Idle',
};

const STATUS_COLOR: Record<SessionDerivedStatus, string> = {
  running: COLORS.accentGreen,
  blocked: COLORS.accentOrange,
  failed: COLORS.accentRed,
  idle: COLORS.textSecondary,
};

/** running/blocked/failed chips for a rollup (idle implied; omitted to cut noise). */
function RollupChips({
  rollup,
  testIdPrefix,
}: {
  rollup: CrossSessionRollup;
  testIdPrefix: string;
}): React.ReactElement {
  return (
    <View style={styles.rollupRow} testID={testIdPrefix}>
      <Text style={[styles.chip, { color: STATUS_COLOR.running }]} testID={`${testIdPrefix}-running`}>
        {rollup.running} running
      </Text>
      <Text style={[styles.chip, { color: STATUS_COLOR.blocked }]} testID={`${testIdPrefix}-blocked`}>
        {rollup.blocked} blocked
      </Text>
      <Text style={[styles.chip, { color: STATUS_COLOR.failed }]} testID={`${testIdPrefix}-failed`}>
        {rollup.failed} failed
      </Text>
    </View>
  );
}

export interface MissionControlBodyProps {
  /** Whole-store activity reducer state (one tree per session). */
  activity: CrossSessionState;
  /** The authoritative session list (drives membership + grouping). */
  sessions: readonly CrossSessionMeta[];
}

/**
 * Pure, prop-driven render of the cross-session aggregate. Exported so the
 * render test can seed fixtures directly without a store or navigator.
 */
export function MissionControlBody({ activity, sessions }: MissionControlBodyProps): React.ReactElement {
  const cross = selectCrossSessionActivity(activity, sessions);

  if (cross.groups.length === 0) {
    return (
      <View style={styles.container} testID="mission-control">
        <View style={styles.emptyWrap} testID="mission-control-empty">
          <Text style={styles.emptyText}>No active sessions</Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} testID="mission-control">
      <View style={styles.header}>
        <Text style={styles.headerLabel}>All sessions</Text>
        <RollupChips rollup={cross.total} testIdPrefix="mission-control-total" />
      </View>

      {cross.groups.map((group) => (
        <View key={group.key} style={styles.group} testID={`mc-group-${groupTestId(group.key)}`}>
          <View style={styles.groupHead}>
            <Text style={styles.groupLabel} testID="mission-control-group-label">
              {group.label}
            </Text>
            {group.worktree && (
              <Text style={styles.worktreeBadge} testID="mission-control-group-worktree">
                worktree
              </Text>
            )}
          </View>
          <RollupChips rollup={group.rollup} testIdPrefix="mission-control-group-rollup" />

          <View style={styles.sessionList}>
            {group.sessions.map((s) => (
              <View key={s.sessionId} style={styles.sessionRow} testID={`mc-session-${s.sessionId}`}>
                <Text style={styles.sessionName} numberOfLines={1}>
                  {s.name}
                </Text>
                <Text
                  style={[styles.statusBadge, { color: STATUS_COLOR[s.status] }]}
                  testID={`mission-control-session-status-${s.sessionId}`}
                  accessibilityRole="text"
                  accessibilityLabel={`Status: ${STATUS_LABEL[s.status]}`}
                >
                  {STATUS_LABEL[s.status]}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

/** Maps a SessionInfo (store shape) to the selector's minimal CrossSessionMeta. */
function toMeta(s: { sessionId: string; cwd?: string | null; name?: string; worktree?: boolean }): CrossSessionMeta {
  return { sessionId: s.sessionId, cwd: s.cwd, name: s.name, worktree: s.worktree };
}

/**
 * Stable testID fragment for a group (#6245 review): the selector keys groups by
 * raw cwd, which is '' for the Ungrouped bucket and can carry path separators /
 * colons (Windows paths) — both make E2E selectors brittle. Map empty → 'ungrouped'
 * and collapse any non-alphanumeric run to a single '-'.
 */
function groupTestId(key: string): string {
  return key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ungrouped';
}

/** The navigable screen: reads the store, delegates to the pure Body. */
export function MissionControlScreen(): React.ReactElement {
  const activity = useConnectionStore((s) => s.activity);
  const sessions = useConnectionStore((s) => s.sessions);
  const metas = React.useMemo(() => sessions.map(toMeta), [sessions]);
  return <MissionControlBody activity={activity} sessions={metas} />;
}

export default MissionControlScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  content: {
    padding: 12,
  },
  emptyWrap: {
    flex: 1,
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {
    color: COLORS.textSecondary,
    fontSize: 15,
  },
  header: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
    marginBottom: 8,
  },
  headerLabel: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  rollupRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  chip: {
    fontSize: 13,
    fontWeight: '600',
    marginRight: 12,
    marginBottom: 2,
  },
  group: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderPrimary,
    padding: 12,
    marginBottom: 12,
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  groupLabel: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
  worktreeBadge: {
    marginLeft: 8,
    color: COLORS.accentPurple,
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sessionList: {
    marginTop: 8,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderPrimary,
  },
  sessionName: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: 14,
    marginRight: 12,
  },
  statusBadge: {
    fontSize: 13,
    fontWeight: '600',
  },
});

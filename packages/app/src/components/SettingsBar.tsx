import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, Animated, AccessibilityInfo, Alert, Modal, Pressable, ScrollView, Switch, TextInput, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { resolveContextWindow, contextOccupancyTokens, contextFillPercent } from '@chroxy/store-core';
import type { CumulativeUsage, PendingPermissionConfirm, SessionIntervention } from '@chroxy/store-core';
import { formatCostBadge } from '@chroxy/store-core';
import type { ModelInfo, ContextOccupancy, AgentInfo, ConnectedClient, CustomAgent, SessionContext, McpServer, PermissionMode } from '../store/connection';
import { Icon } from './Icon';
import { COLORS } from '../constants/colors';

// Connection quality → color mapping (consistent 13% opacity backgrounds)
const QUALITY_COLORS = {
  good: { bg: COLORS.accentGreenLight, fg: COLORS.accentGreen },
  fair: { bg: COLORS.accentOrangeSubtle, fg: COLORS.accentOrange },
  poor: { bg: COLORS.accentRedSubtle, fg: COLORS.accentRed },
} as const;

// #4876 — shared `hitSlop` for the tappable header badges so each Pressable
// hits Apple HIG's 44pt minimum touch target even though the
// visible badge is kept visually compact (paddingVertical: 2,
// paddingHorizontal: 6, fontSize: 10 or 11). Numbers chosen so the
// effective touch area is ≥ 44 × 44pt for even the smallest plausible
// content (a single-glyph badge), while still leaving small horizontal
// gaps between adjacent badges so each one's hitbox doesn't fully overlap
// its neighbour.
//
// Effective hitbox = visible bounds + hitSlop. Worst-case intrinsic vertical
// extent is fontSize (10pt) + 2pt + 2pt padding = ~14pt, plus 14 + 14 slop
// = 42pt — bumped to 16 to clear 44pt cleanly. Worst-case horizontal is a
// single glyph ~6pt + 6pt + 6pt padding = ~18pt, plus 14 + 14 slop = 46pt.
export const HEADER_BADGE_HIT_SLOP = {
  top: 16,
  bottom: 16,
  left: 14,
  right: 14,
} as const;

// #6822 — the MCP OAuth "Authorize" + "Submit" buttons use a compact look; this
// hitSlop (paired with minHeight: 44 on the button styles) brings the effective
// touch target above Apple HIG's 44 × 44pt on both axes even for the narrowest
// plausible label.
export const MCP_AUTH_HIT_SLOP = {
  top: 12,
  bottom: 12,
  left: 12,
  right: 12,
} as const;

// -- Props --

export interface SettingsBarProps {
  expanded: boolean;
  onToggle: () => void;
  activeModel: string | null;
  defaultModelId?: string | null;
  availableModels: ModelInfo[];
  permissionMode: string | null;
  // #4213: typed PermissionMode from store-core — the optional `description`
  // field drives the hint text rendered under the chip row so the mobile UI
  // shares one source of truth with the server (matches the dashboard
  // #4019 plumbing).
  availablePermissionModes: PermissionMode[];
  lastResultCost: number | null;
  lastResultDuration: number | null;
  sessionCost?: number | null;
  // #4074: per-session running totals. When `costUsd > 0` the summary
  // row renders a tappable cost badge that opens a Modal with the full
  // token breakdown.
  cumulativeUsage?: CumulativeUsage | null;
  costBudget?: number | null;
  // #6769: occupancy snapshot — the meter's only input. Null = no occupancy
  // signal (claude-cli / claude-tui / codex / gemini — plus any byok-loop
  // subclass, e.g. ollama, whose endpoint reports no usage) -> no meter,
  // the honest dash state. Never fed from the billing usage aggregate.
  contextOccupancy: ContextOccupancy | null;
  sessionCwd: string | null;
  serverMode: 'cli' | null;
  isIdle: boolean;
  activeAgents: AgentInfo[];
  // #4764: chroxy-side intervention ring for the active session. When
  // non-empty the session-header renders a counter badge; tapping opens
  // a sheet listing the recent interventions newest-first (mirrors the
  // dashboard's FooterBar from #4758).
  interventions?: SessionIntervention[];
  connectedClients: ConnectedClient[];
  customAgents: CustomAgent[];
  mcpServers: McpServer[];
  onInvokeAgent?: (agentName: string) => void;
  // #6824 — toggle an MCP server on/off for the active session. Only invoked
  // for servers that report `canToggle` (the BYOK lane). Absent → the MCP list
  // stays read-only (matches sdk/cli/tui providers).
  onToggleMcpServer?: (server: string, enabled: boolean) => void;
  // #6822 — submit a pasted OAuth authorization code for a remote MCP server that
  // reported `oauth-required`. Absent → the paste-code affordance stays hidden.
  onSubmitMcpAuthCode?: (server: string, code: string) => void;
  setModel: (model: string) => void;
  setPermissionMode: (mode: string) => void;
  pendingPermissionConfirm?: PendingPermissionConfirm | null;
  onConfirmPermissionMode?: (mode: string) => void;
  onCancelPermissionConfirm?: () => void;
  conversationId?: string | null;
  sessionContext?: SessionContext | null;
  latencyMs?: number | null;
  connectionQuality?: 'good' | 'fair' | 'poor' | null;
  // #5518: which transport is active — 'lan' (direct ws://) or 'tunnel'
  // (wss:// via Cloudflare). Surfaced next to the latency badge so the user
  // can see when the faster local path is in use.
  activePath?: 'lan' | 'tunnel' | null;
  // #5424: active session's provider name (e.g. 'claude-sdk', 'ollama').
  // Drives context-window resolution — the 200k default only applies to
  // claude-backed providers; for providers that legitimately report no
  // window (ollama) the usage meter renders the raw token count without
  // a percentage/progress bar instead of a misleading "% of 200k".
  provider?: string | null;
  // #5731 — provider capability gating (mirrors the dashboard's dropdownFlags).
  // Default to `true` (the value is undefined for older callers / before the
  // provider list lands) so behaviour is unchanged unless the active provider
  // explicitly reports the capability as false. When `modelSwitchSupported` is
  // false (e.g. claude-tui — model fixed at boot), the model row renders a
  // read-only badge instead of an interactive picker that can't actually
  // switch; when `permissionModeSwitchSupported` is false the permission-mode
  // chips are hidden entirely.
  modelSwitchSupported?: boolean;
  permissionModeSwitchSupported?: boolean;
}

// -- Helpers --

/**
 * #4764 — humanise an intervention's discriminator into a one-line
 * operator-facing description. Mirrors the dashboard's `describeIntervention`
 * helper (FooterBar.tsx) so both surfaces narrate the same intervention with
 * the same copy. Exported for unit-testing.
 */
export function describeIntervention(iv: SessionIntervention): string {
  switch (iv.kind) {
    case 'multi_question':
      return `Multi-question form intercepted (${iv.count} questions) — asked agent to ask one at a time`;
    default: {
      // Exhaustive fallback for future discriminator additions. Renders the
      // raw kind so a forgotten case still gives the operator SOMETHING to
      // grep on rather than an empty row.
      const _exhaustive: never = iv.kind;
      return `chroxy intervention: ${String(_exhaustive)}`;
    }
  }
}

/**
 * #4764 — format a wall-clock timestamp as a short relative string ("3s ago",
 * "2m ago", "1h ago"). Falls back to ISO date string for entries older than
 * 24 hours. Mirrors the dashboard's `formatRelativeTimestamp` helper for
 * intervention rows.
 */
export function formatInterventionTimestamp(ts: number, now: number = Date.now()): string {
  const elapsedMs = now - ts;
  if (elapsedMs < 0) return 'just now';
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

export function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs.toString().padStart(2, '0')}s`;
}

function PulsingDot({ reduceMotion }: { reduceMotion: boolean }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, opacity]);

  return <Animated.View style={[styles.agentDot, { opacity }]} />;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

// -- Component --

export function SettingsBar({
  expanded,
  onToggle,
  activeModel,
  defaultModelId,
  availableModels,
  permissionMode,
  availablePermissionModes,
  lastResultCost,
  lastResultDuration,
  sessionCost,
  cumulativeUsage,
  costBudget,
  contextOccupancy,
  sessionCwd,
  serverMode,
  isIdle,
  activeAgents,
  interventions,
  connectedClients,
  customAgents,
  mcpServers,
  onInvokeAgent,
  onToggleMcpServer,
  onSubmitMcpAuthCode,
  setModel,
  setPermissionMode,
  pendingPermissionConfirm,
  onConfirmPermissionMode,
  onCancelPermissionConfirm,
  conversationId,
  sessionContext,
  latencyMs,
  connectionQuality,
  activePath,
  provider,
  modelSwitchSupported = true,
  permissionModeSwitchSupported = true,
}: SettingsBarProps) {
  // Elapsed time ticker — only runs when expanded with active agents
  const [now, setNow] = useState(Date.now());
  const showAgentTimers = expanded && activeAgents.length > 0;
  useEffect(() => {
    if (!showAgentTimers) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [showAgentTimers]);

  // Reduce-motion preference for pulsing dots
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  // #4074: tap-to-expand sheet for the cumulative-cost breakdown.
  // Distinct from the SettingsBar's expand/collapse — this is a Modal
  // dedicated to the cost details, mirroring the dashboard's hover
  // popover.
  const [costBreakdownOpen, setCostBreakdownOpen] = useState(false);
  // #4764: tap-to-expand sheet for the chroxy-intervention ring. Distinct
  // from the SettingsBar's expand/collapse — this is a Modal dedicated to
  // the recent-interventions list, mirroring the dashboard's
  // InterventionsPanel from #4758.
  const [interventionsOpen, setInterventionsOpen] = useState(false);
  const interventionCount = interventions?.length ?? 0;
  // Close a stale sheet if the underlying ring drops back to empty (e.g.
  // session switch / state restore). Same pattern as the cost breakdown
  // sheet above so the modal can't strand itself on top of a now-hidden
  // badge.
  useEffect(() => {
    if (interventionCount === 0 && interventionsOpen) setInterventionsOpen(false);
  }, [interventionCount, interventionsOpen]);
  const hasCumulativeCost =
    !!cumulativeUsage && Number.isFinite(cumulativeUsage.costUsd) && cumulativeUsage.costUsd > 0;
  // Close a stale sheet if the cost predicate flips back to false (e.g.
  // the session resets or a state restore drops the cumulative block).
  // Without this guard the badge disappears but the modal stays open on
  // top, anchored to data that no longer applies (#4121 review).
  //
  // Known limitation: switching between two sessions that both have
  // cumulativeUsage > 0 keeps the sheet open and re-anchors it to the
  // NEW session's data without an explicit user open. The Sheet is
  // dismissible (Close button + backdrop tap) so the impact is minor;
  // a cleaner fix would pass `activeSessionId` through SettingsBar and
  // useEffect on the id to auto-close on switch — tracked as a follow-up.
  useEffect(() => {
    if (!hasCumulativeCost && costBreakdownOpen) setCostBreakdownOpen(false);
  }, [hasCumulativeCost, costBreakdownOpen]);

  // Show confirmation dialog when server challenges auto permission mode
  useEffect(() => {
    if (!pendingPermissionConfirm) return;
    const { mode, warning } = pendingPermissionConfirm;
    Alert.alert(
      'Enable Auto Mode?',
      warning,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => onCancelPermissionConfirm?.() },
        { text: 'Enable', style: 'destructive', onPress: () => onConfirmPermissionMode?.(mode) },
      ],
      { cancelable: true, onDismiss: () => onCancelPermissionConfirm?.() },
    );
  }, [pendingPermissionConfirm, onConfirmPermissionMode, onCancelPermissionConfirm]);

  // Truncate working directory path for collapsed view
  let truncatedCwd: string | null = null;
  if (sessionCwd) {
    // Replace common home-directory prefixes with "~" for macOS, Linux, and Windows
    const homeShortened = sessionCwd.replace(
      /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/,
      '~'
    );
    truncatedCwd = homeShortened.length > 30 ? homeShortened.slice(-30) : homeShortened;
  }

  // Build collapsed summary: "main · 3 dirty · chroxy · Opus · $0.02"
  const summaryParts: string[] = [];

  if (sessionContext?.gitBranch) {
    summaryParts.push(sessionContext.gitBranch);
    if (sessionContext.gitDirty > 0) {
      summaryParts.push(`${sessionContext.gitDirty} dirty`);
    }
    if (sessionContext.projectName) {
      summaryParts.push(sessionContext.projectName);
    }
  } else if (truncatedCwd) {
    summaryParts.push(truncatedCwd);
  }
  if (serverMode && !sessionContext) {
    summaryParts.push(serverMode);
  }

  if (activeModel) {
    const modelInfo = availableModels.find((m) => m.id === activeModel || m.fullId === activeModel);
    summaryParts.push(modelInfo?.label || activeModel);
  }
  if (permissionMode) {
    const permInfo = availablePermissionModes.find((m) => m.id === permissionMode);
    summaryParts.push(permInfo?.label || permissionMode);
  }
  // #4074: when cumulativeUsage carries a non-zero cost, the dedicated
  // badge below the summary takes over. Otherwise fall back to the
  // pre-existing sessionCost / lastResultCost summary text so older
  // sessions and subscription-billed sessions (which never populate
  // cumulativeUsage.costUsd) keep their current display.
  if (!hasCumulativeCost) {
    if (sessionCost != null) {
      summaryParts.push(`$${sessionCost.toFixed(2)}`);
    } else if (lastResultCost != null) {
      summaryParts.push(`$${lastResultCost.toFixed(2)}`);
    }
  }
  if (contextOccupancy) {
    // #6769: the meter reads the provider's occupancy SNAPSHOT — never the
    // billing usage aggregate (summed across agent-loop rounds; over-reads
    // fill ≈N× on an N-round turn). No snapshot → no summary entry at all
    // (the honest dash state for claude-cli / claude-tui / codex / gemini
    // and any byok-loop subclass whose endpoint reports no usage).
    const total = contextOccupancyTokens(contextOccupancy) ?? 0;
    if (total > 0) {
      const mInfo = availableModels.find((m) => m.id === activeModel || m.fullId === activeModel);
      const cw = contextOccupancy.maxTokens ?? resolveContextWindow(mInfo, provider);
      // Percent metered against the snapshot's real autoCompactThreshold
      // when present, else the documented reserve below the window. #5424:
      // when the window is genuinely unknown, show the raw token count
      // instead of a fabricated "% of 200k".
      const pct = contextFillPercent(contextOccupancy, cw);
      summaryParts.push(
        pct != null
          ? `${Math.min(Math.round(pct), 100)}%`
          : formatTokenCount(total),
      );
    }
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={onToggle} style={styles.summaryRow} activeOpacity={0.7}>
        <View
          style={[styles.statusDot, { backgroundColor: isIdle ? COLORS.accentGreen : COLORS.accentOrange }]}
          accessibilityLabel={isIdle ? 'Agent idle' : 'Agent busy'}
          accessibilityRole="image"
        />
        {activeAgents.length > 0 && (
          <View
            style={styles.agentBadge}
            accessibilityLabel={`${activeAgents.length} background agent${activeAgents.length !== 1 ? 's' : ''} running`}
            accessibilityRole="text"
          >
            <Text style={styles.agentBadgeText}>
              {activeAgents.length} agent{activeAgents.length !== 1 ? 's' : ''}
            </Text>
          </View>
        )}
        {/* #4764: chroxy-side intervention counter. Renders only when at
            least one intervention has fired for the active session. Tap
            opens a sheet listing the recent interventions newest-first.
            Mirrors the dashboard's FooterBar counter chip from #4758. */}
        {interventionCount > 0 && (
          <Pressable
            onPress={() => setInterventionsOpen(true)}
            style={({ pressed }) => [styles.interventionBadge, pressed && styles.interventionBadgePressed]}
            // #4876 — widen the effective touch target to ≥ 44pt without
            // resizing the visible badge.
            hitSlop={HEADER_BADGE_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`${interventionCount} chroxy ${interventionCount === 1 ? 'intervention' : 'interventions'}. Tap for details.`}
            testID="session-interventions-badge"
          >
            <Text style={styles.interventionBadgeText}>
              {interventionCount} {interventionCount === 1 ? 'intervention' : 'interventions'}
            </Text>
          </Pressable>
        )}
        {connectionQuality && (() => {
          const qc = QUALITY_COLORS[connectionQuality];
          const pathLabel = activePath === 'lan' ? 'LAN' : activePath === 'tunnel' ? 'Tunnel' : null;
          return (
            <View
              testID="connection-quality-badge"
              style={[styles.qualityBadge, { backgroundColor: qc.bg }]}
              accessibilityLabel={
                `Connection quality: ${connectionQuality}` +
                (latencyMs != null ? `, ${latencyMs}ms latency` : '') +
                (pathLabel ? `, ${pathLabel === 'LAN' ? 'direct LAN' : 'tunnel'} path` : '')
              }
              accessibilityRole="text"
            >
              <View style={[styles.qualityDot, { backgroundColor: qc.fg }]} />
              <Text style={[styles.qualityText, { color: qc.fg }]}>
                {latencyMs != null ? `${latencyMs}ms` : connectionQuality}
              </Text>
              {pathLabel && (
                <Text testID="connection-path-label" style={[styles.qualityPath, { color: qc.fg }]}>
                  {pathLabel}
                </Text>
              )}
            </View>
          );
        })()}
        {connectedClients.length > 1 && (
          <View
            style={styles.deviceBadge}
            accessibilityLabel={`${connectedClients.length} devices connected`}
            accessibilityRole="text"
          >
            <Text style={styles.deviceBadgeText}>
              {connectedClients.length} devices
            </Text>
          </View>
        )}
        <Text style={styles.summaryText} numberOfLines={1}>
          {summaryParts.join(' \u00B7 ') || 'Settings'}
        </Text>
        {hasCumulativeCost && cumulativeUsage && (
          // #4074: tappable cost badge in the session header. The badge
          // intercepts the press inside its own bounds \u2014 the outer
          // TouchableOpacity (which toggles the SettingsBar expansion)
          // only fires when the user taps OUTSIDE this Pressable.
          <Pressable
            onPress={() => setCostBreakdownOpen(true)}
            style={({ pressed }) => [styles.costBadge, pressed && styles.costBadgePressed]}
            // #4876 — widen the effective touch target to ≥ 44pt without
            // resizing the visible badge.
            hitSlop={HEADER_BADGE_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={`Session cost ${formatCostBadge(cumulativeUsage.costUsd)}. Tap for breakdown.`}
            testID="session-cost-badge"
          >
            <Text style={styles.costBadgeText}>{formatCostBadge(cumulativeUsage.costUsd)}</Text>
          </Pressable>
        )}
        {expanded ? <Icon name="chevronDown" size={12} color={COLORS.textMuted} /> : <Icon name="chevronRight" size={12} color={COLORS.textMuted} />}
      </TouchableOpacity>
      {expanded && (
        <View style={styles.expandedContent}>
          {sessionContext?.gitBranch && (
            <View style={styles.contextRow}>
              <Text style={styles.contextText}>
                {sessionContext.gitBranch}
                {sessionContext.gitDirty > 0 ? ` \u00B7 ${sessionContext.gitDirty} uncommitted` : ''}
                {sessionContext.gitAhead > 0 ? ` \u00B7 ${sessionContext.gitAhead} ahead` : ''}
                {sessionContext.projectName ? ` \u00B7 ${sessionContext.projectName}` : ''}
              </Text>
            </View>
          )}
          {/* #5731: gate the interactive model picker on the provider's
              modelSwitch capability. A provider that can't switch mid-session
              (claude-tui) gets a non-interactive badge of its fixed model
              instead of chips that silently do nothing on tap. Mirrors the
              dashboard's `showModelPicker` / `readOnlyModel` split. */}
          {availableModels.length > 0 && modelSwitchSupported && (
                <View style={styles.chipRow}>
                  {availableModels.map((m) => {
                    const isActive = activeModel === m.id || activeModel === m.fullId
                      || (!activeModel && defaultModelId === m.id);
                    return (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.chip, isActive && styles.chipActive]}
                        onPress={() => setModel(m.id)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                          {m.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
              {!modelSwitchSupported && (() => {
                // Fall back to defaultModelId when there's no explicit override,
                // mirroring the interactive chip's `!activeModel && defaultModelId`
                // active-match so a non-switching provider still shows its model.
                const fixedId = activeModel || defaultModelId;
                if (!fixedId) return null;
                const fixed = availableModels.find((m) => m.id === fixedId || m.fullId === fixedId);
                return (
                  <View style={styles.chipRow}>
                    <View style={[styles.chip, styles.chipReadOnly]} accessibilityRole="text">
                      <Text style={styles.chipReadOnlyText}>{fixed?.label || fixedId} · fixed</Text>
                    </View>
                  </View>
                );
              })()}
              {/* #5731: hide the permission-mode chips when the provider can't
                  switch permission modes (mirrors the dashboard's
                  `showPermissionMode`). */}
              {availablePermissionModes.length > 0 && permissionModeSwitchSupported && (
                <View style={styles.chipRow}>
                  {availablePermissionModes.map((m) => {
                    const isActive = permissionMode === m.id;
                    return (
                      <TouchableOpacity
                        key={m.id}
                        style={[styles.chip, isActive && styles.chipActive]}
                        onPress={() => setPermissionMode(m.id)}
                        activeOpacity={0.7}
                      >
                        <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                          {m.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
              {/* #4213: surface the selected permission mode's description
                  from the server's PERMISSION_MODES table. Falls back to the
                  pre-#4213 hardcoded copy when the server didn't send a
                  description (older server) so mobile users still get the
                  trade-off explanation. Mirrors CreateSessionModal's #4019
                  hint pattern. */}
              {permissionMode && availablePermissionModes.length > 0 && permissionModeSwitchSupported && (() => {
                const selected = availablePermissionModes.find((m) => m.id === permissionMode);
                let hint = selected?.description;
                if (!hint) {
                  if (permissionMode === 'auto') {
                    hint = 'Equivalent to `claude --dangerously-skip-permissions`. Every tool call auto-approves with no prompt.';
                  } else if (permissionMode === 'acceptEdits') {
                    hint = 'Read/Write/Edit/Grep/Glob/NotebookEdit auto-approve. Bash, MCP, and other tools still gate on approval.';
                  } else if (permissionMode === 'plan') {
                    hint = 'Claude is asked to plan before acting; each tool call still gates on your approval.';
                  } else if (permissionMode === 'approve') {
                    hint = 'Default. Each tool call gates on your approval in the dashboard or mobile app.';
                  }
                }
                // #4251: parity with dashboard CreateSessionModal.tsx #4019
                // catch-all. When a future provider adds a permission mode the
                // mobile build doesn't recognise AND the server didn't send a
                // description, surface the same explanatory copy the dashboard
                // shows instead of hiding the hint entirely.
                if (!hint) {
                  hint = 'Uses whatever the server’s --default-permission-mode was set to (usually Approve).';
                }
                return (
                  <Text
                    style={styles.permissionModeHint}
                    testID="permission-mode-hint"
                    accessibilityLabel={`Permission mode: ${hint}`}
                  >
                    {hint}
                  </Text>
                );
              })()}
              {(lastResultCost != null || sessionCost != null || contextOccupancy) && (
                <View style={styles.contextRow}>
                  {sessionCost != null ? (
                    <Text style={styles.contextText}>
                      Session: ${sessionCost.toFixed(4)}
                      {costBudget != null ? ` / $${costBudget.toFixed(2)}` : ''}
                      {lastResultDuration != null ? ` \u00B7 ${(lastResultDuration / 1000).toFixed(1)}s` : ''}
                    </Text>
                  ) : lastResultCost != null ? (
                    <Text style={styles.contextText}>
                      ${lastResultCost.toFixed(4)}
                      {lastResultDuration != null ? ` \u00B7 ${(lastResultDuration / 1000).toFixed(1)}s` : ''}
                    </Text>
                  ) : null}
                  {contextOccupancy && (() => {
                    // #6769: occupancy SNAPSHOT only — never the billing
                    // usage aggregate (summed across agent-loop rounds, so
                    // it over-reads window fill ≈N× on an N-round turn).
                    const total = contextOccupancyTokens(contextOccupancy) ?? 0;
                    if (total === 0) return null;
                    const modelInfo = availableModels.find((m) => m.id === activeModel || m.fullId === activeModel);
                    const contextWindow =
                      contextOccupancy.maxTokens ?? resolveContextWindow(modelInfo, provider);
                    // Percent metered against the snapshot's real
                    // autoCompactThreshold when present (desktop /context
                    // parity), else the documented reserve below the window.
                    const pct = contextFillPercent(contextOccupancy, contextWindow);
                    if (contextWindow == null || pct == null) {
                      // #5424: window genuinely unknown (e.g. ollama reports
                      // none — the real limit is the local model file's
                      // num_ctx). Show the raw token count, no percentage or
                      // progress bar, instead of metering against a
                      // fabricated 200k.
                      return (
                        <Text style={styles.contextText} testID="context-usage-unknown-window">
                          {formatTokenCount(total)}
                        </Text>
                      );
                    }
                    const barColor = pct >= 80 ? COLORS.accentRed : pct >= 50 ? COLORS.accentOrange : COLORS.accentGreen;
                    return (
                      <>
                        <Text style={styles.contextText}>
                          {formatTokenCount(total)} ({Math.min(Math.round(pct), 100)}%)
                        </Text>
                        <View style={styles.contextBarContainer}>
                          <View style={[styles.contextBarFill, { width: `${Math.min(100, pct)}%` as `${number}%`, backgroundColor: barColor }]} />
                        </View>
                      </>
                    );
                  })()}
                </View>
              )}
              {costBudget != null && sessionCost != null && (
                <View style={styles.budgetBarContainer}>
                  <View style={[styles.budgetBarFill, {
                    width: `${Math.min(100, (sessionCost / costBudget) * 100)}%` as `${number}%`,
                    backgroundColor: sessionCost / costBudget >= 1.0 ? COLORS.accentRed : sessionCost / costBudget >= 0.8 ? COLORS.accentOrange : COLORS.accentGreen,
                  }]} />
                </View>
              )}
          {conversationId && (
            <TouchableOpacity
              style={styles.conversationIdRow}
              onPress={async () => {
                try {
                  await Clipboard.setStringAsync(conversationId);
                  Alert.alert(
                    'Copied',
                    `Resume this conversation from your terminal:\n\nclaude --resume ${conversationId}`,
                  );
                } catch {
                  Alert.alert('Error', 'Failed to copy conversation ID.');
                }
              }}
              accessibilityRole="button"
              accessibilityLabel="Copy conversation ID"
              testID="conversation-id-row"
            >
              <Text style={styles.conversationIdLabel}>Conversation ID</Text>
              <Text style={styles.conversationIdValue} numberOfLines={1}>
                {conversationId.slice(0, 8)}...
              </Text>
            </TouchableOpacity>
          )}
          {activeAgents.length > 0 && (
            <View style={styles.agentSection}>
              <Text style={styles.agentSectionTitle}>
                Running Agents ({activeAgents.length})
              </Text>
              {activeAgents.map((agent) => (
                <View key={agent.toolUseId} style={styles.agentEntry}>
                  <PulsingDot reduceMotion={reduceMotion} />
                  <Text style={styles.agentDescription} numberOfLines={2}>
                    {agent.description}
                  </Text>
                  <Text style={styles.agentElapsed}>
                    {formatElapsed(agent.startedAt, now)}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {connectedClients.length > 1 && (
            <View style={styles.agentSection}>
              <Text style={styles.deviceSectionTitle}>
                Connected Devices ({connectedClients.length})
              </Text>
              {connectedClients.map((client) => (
                <View key={client.clientId} style={styles.agentEntry}>
                  <View style={[styles.statusDot, { backgroundColor: COLORS.accentBlue }]} />
                  <Text style={styles.agentDescription} numberOfLines={1}>
                    {client.deviceName || client.deviceType}{client.isSelf ? ' (this device)' : ''}
                  </Text>
                  <Text style={styles.agentElapsed}>
                    {client.platform}
                  </Text>
                </View>
              ))}
            </View>
          )}
          {mcpServers.length > 0 && (
            <View style={styles.agentSection}>
              <Text style={styles.deviceSectionTitle}>
                MCP Servers ({mcpServers.length})
              </Text>
              {mcpServers.map((server) => (
                <McpServerRow
                  key={server.name}
                  server={server}
                  onToggleMcpServer={onToggleMcpServer}
                  onSubmitMcpAuthCode={onSubmitMcpAuthCode}
                />
              ))}
            </View>
          )}
          {customAgents.length > 0 && (
            <View style={styles.agentSection}>
              <Text style={styles.customAgentSectionTitle}>
                Custom Agents ({customAgents.length})
              </Text>
              {customAgents.map((agent) => (
                <TouchableOpacity
                  key={agent.name}
                  style={styles.customAgentEntry}
                  onPress={() => onInvokeAgent?.(agent.name)}
                  accessibilityRole="button"
                  accessibilityLabel={`Invoke agent ${agent.name}`}
                >
                  <View style={[styles.statusDot, { backgroundColor: COLORS.accentGreen }]} />
                  <View style={styles.customAgentInfo}>
                    <Text style={styles.customAgentName}>{agent.name}</Text>
                    {agent.description ? (
                      <Text style={styles.customAgentDesc} numberOfLines={1}>{agent.description}</Text>
                    ) : null}
                  </View>
                  {agent.source === 'project' && (
                    <Text style={styles.customAgentBadge}>project</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      )}
      {/* #4074: cumulative-cost breakdown sheet. Visible only when a tap
          on the cost badge has set costBreakdownOpen. Mirrors the
          dashboard's hover popover (same six fields, same ordering). */}
      {cumulativeUsage && (
        <Modal
          visible={costBreakdownOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setCostBreakdownOpen(false)}
        >
          <Pressable
            style={styles.costSheetBackdrop}
            onPress={() => setCostBreakdownOpen(false)}
            accessibilityLabel="Dismiss cost breakdown"
            accessibilityRole="button"
          >
            <Pressable
              style={styles.costSheetCard}
              // Eat the tap so it doesn't close the modal via the
              // backdrop. RN Pressable doesn't propagate to ancestor
              // Pressables when handled inside.
              onPress={() => {}}
              testID="session-cost-breakdown-sheet"
            >
              <Text style={styles.costSheetTitle}>Session cost</Text>
              <View style={styles.costSheetRow}>
                <Text style={styles.costSheetLabel}>Total cost</Text>
                <Text style={styles.costSheetValue}>${cumulativeUsage.costUsd.toFixed(4)}</Text>
              </View>
              <View style={styles.costSheetRow}>
                <Text style={styles.costSheetLabel}>Turns billed</Text>
                <Text style={styles.costSheetValue}>{cumulativeUsage.turnsBilled.toLocaleString()}</Text>
              </View>
              <View style={styles.costSheetDivider} />
              <View style={styles.costSheetRow}>
                <Text style={styles.costSheetLabel}>Input tokens</Text>
                <Text style={styles.costSheetValue}>{cumulativeUsage.inputTokens.toLocaleString()}</Text>
              </View>
              <View style={styles.costSheetRow}>
                <Text style={styles.costSheetLabel}>Output tokens</Text>
                <Text style={styles.costSheetValue}>{cumulativeUsage.outputTokens.toLocaleString()}</Text>
              </View>
              <View style={styles.costSheetRow}>
                <Text style={styles.costSheetLabel}>Cache read</Text>
                <Text style={styles.costSheetValue}>{cumulativeUsage.cacheReadTokens.toLocaleString()}</Text>
              </View>
              <View style={styles.costSheetRow}>
                <Text style={styles.costSheetLabel}>Cache write</Text>
                <Text style={styles.costSheetValue}>{cumulativeUsage.cacheCreationTokens.toLocaleString()}</Text>
              </View>
              <TouchableOpacity
                style={styles.costSheetDismiss}
                onPress={() => setCostBreakdownOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close cost breakdown"
              >
                <Text style={styles.costSheetDismissText}>Close</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}
      {/* #4764: interventions sheet — modal listing recent interventions
          newest-first. Visible only when a tap on the intervention badge
          has set interventionsOpen. Mirrors the dashboard's
          InterventionsPanel from #4758 (same six fields, same ordering). */}
      {interventionCount > 0 && (
        <Modal
          visible={interventionsOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setInterventionsOpen(false)}
        >
          <Pressable
            style={styles.costSheetBackdrop}
            onPress={() => setInterventionsOpen(false)}
            accessibilityLabel="Dismiss interventions panel"
            accessibilityRole="button"
          >
            <Pressable
              style={styles.costSheetCard}
              onPress={() => {}}
              testID="session-interventions-sheet"
            >
              <Text style={styles.costSheetTitle}>Recent chroxy interventions</Text>
              {/* #4862 (Copilot review): the interventions ring is capped at 50
                  entries (MAX_SESSION_INTERVENTIONS in store-core). Without a
                  scroll container, on smaller devices a full ring would push
                  the Close button off-screen and strand the modal. Constrain
                  the list area and let it scroll; the title + Close button
                  stay pinned outside the scroll region. */}
              <ScrollView
                style={styles.interventionList}
                contentContainerStyle={styles.interventionListContent}
                showsVerticalScrollIndicator
                testID="session-interventions-scroll"
              >
                {[...(interventions ?? [])].reverse().map((iv) => (
                  <View
                    key={iv.toolUseId}
                    style={styles.interventionRow}
                    testID={`session-intervention-${iv.toolUseId}`}
                  >
                    <Text style={styles.interventionReason}>{describeIntervention(iv)}</Text>
                    <Text style={styles.interventionMeta}>{formatInterventionTimestamp(iv.timestamp)}</Text>
                  </View>
                ))}
              </ScrollView>
              <TouchableOpacity
                style={styles.costSheetDismiss}
                onPress={() => setInterventionsOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close interventions panel"
              >
                <Text style={styles.costSheetDismissText}>Close</Text>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

/**
 * One row in the SettingsBar "MCP Servers" list. Extracted so an oauth-required
 * server (#6822) can hold its own paste-code input state. Renders:
 *   - the status dot + name (always);
 *   - a Switch when the server reports `canToggle` (BYOK lane) and a toggle
 *     handler is wired (#6824), else read-only status text;
 *   - an "Authorize" button (opens the browser authorization URL on the user's
 *     device) + a paste-code input (the universal fallback) when the server
 *     reports `status: 'oauth-required'` and a submit handler is wired (#6822).
 */
function McpServerRow({
  server,
  onToggleMcpServer,
  onSubmitMcpAuthCode,
}: {
  server: McpServer;
  onToggleMcpServer?: (server: string, enabled: boolean) => void;
  onSubmitMcpAuthCode?: (server: string, code: string) => void;
}) {
  const [code, setCode] = useState('');
  // #6824: a server is "on" unless parked. Prefer the explicit `enabled` flag
  // (BYOK emits it); fall back to status so a pre-#6824 payload still reads.
  const enabled = typeof server.enabled === 'boolean' ? server.enabled : server.status !== 'disabled';
  const canToggle = !!server.canToggle && !!onToggleMcpServer;
  const needsAuth = server.status === 'oauth-required';

  return (
    <View style={styles.mcpServerRow}>
      <View style={styles.agentEntry}>
        <View style={[styles.statusDot, { backgroundColor: server.status === 'connected' ? COLORS.accentGreen : COLORS.textMuted }]} />
        <Text style={styles.agentDescription} numberOfLines={1}>
          {server.name}
        </Text>
        {canToggle ? (
          <Switch
            testID={`mcp-server-toggle-${server.name}`}
            value={enabled}
            onValueChange={(next) => onToggleMcpServer?.(server.name, next)}
            accessibilityLabel={`${enabled ? 'Disable' : 'Enable'} MCP server ${server.name}`}
          />
        ) : (
          <Text style={styles.agentElapsed}>
            {server.status}
          </Text>
        )}
      </View>
      {needsAuth && !!onSubmitMcpAuthCode && (
        <View style={styles.mcpAuthContainer} testID={`mcp-server-auth-${server.name}`}>
          {!!server.authUrl && (
            <TouchableOpacity
              style={styles.mcpAuthorizeButton}
              testID={`mcp-server-authorize-${server.name}`}
              hitSlop={MCP_AUTH_HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel={`Authorize MCP server ${server.name}`}
              onPress={() => { if (server.authUrl) Linking.openURL(server.authUrl).catch(() => {}); }}
            >
              <Text style={styles.mcpAuthorizeButtonText}>Authorize in browser</Text>
            </TouchableOpacity>
          )}
          <View style={styles.mcpAuthPasteRow}>
            <TextInput
              style={styles.mcpAuthInput}
              testID={`mcp-server-auth-input-${server.name}`}
              placeholder="Paste code"
              placeholderTextColor={COLORS.textMuted}
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={`Authorization code for MCP server ${server.name}`}
            />
            <TouchableOpacity
              style={[styles.mcpAuthSubmit, !code.trim() && styles.mcpAuthSubmitDisabled]}
              testID={`mcp-server-auth-submit-${server.name}`}
              hitSlop={MCP_AUTH_HIT_SLOP}
              disabled={!code.trim()}
              accessibilityRole="button"
              accessibilityLabel={`Submit authorization code for MCP server ${server.name}`}
              onPress={() => {
                const trimmed = code.trim();
                if (!trimmed) return;
                onSubmitMcpAuthCode?.(server.name, trimmed);
                setCode('');
              }}
            >
              <Text style={styles.mcpAuthSubmitText}>Submit</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

// -- Styles --

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.backgroundSecondary,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    minHeight: 44,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 8,
  },
  summaryText: {
    flex: 1,
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  chevron: {
    color: COLORS.textDim,
    fontSize: 10,
    marginLeft: 8,
  },
  expandedContent: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 8,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: COLORS.backgroundCard,
    borderWidth: 1,
    borderColor: COLORS.borderTransparent,
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: COLORS.accentBlueSubtle,
    borderColor: COLORS.accentBlueBorderStrong,
  },
  chipText: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: '500',
  },
  chipTextActive: {
    color: COLORS.accentBlue,
  },
  // #5731: non-interactive model badge for providers that can't switch models.
  chipReadOnly: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: COLORS.backgroundCard,
    borderWidth: 1,
    borderColor: COLORS.borderTransparent,
    opacity: 0.7,
  },
  chipReadOnlyText: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: '500',
  },
  contextRow: {
    flexDirection: 'row',
    gap: 12,
  },
  contextText: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // #4213: small muted hint rendered under the permission-mode chip row.
  // Uses the same sizing as contextText but without the monospace font so
  // the prose description reads as descriptive copy rather than data.
  permissionModeHint: {
    color: COLORS.textMuted,
    fontSize: 10,
    lineHeight: 14,
    marginTop: -2,
  },
  qualityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 8,
    gap: 3,
  },
  qualityDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  qualityText: {
    fontSize: 9,
    fontWeight: '600',
  },
  qualityPath: {
    fontSize: 8,
    fontWeight: '700',
    opacity: 0.85,
    marginLeft: 1,
  },
  budgetBarContainer: {
    height: 3,
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 1.5,
    overflow: 'hidden' as const,
  },
  budgetBarFill: {
    height: 3,
    borderRadius: 1.5,
  },
  contextBarContainer: {
    height: 4,
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 2,
    overflow: 'hidden' as const,
    marginTop: 4,
  },
  contextBarFill: {
    height: 4,
    borderRadius: 2,
  },
  deviceBadge: {
    backgroundColor: COLORS.accentBlueSubtle,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 8,
  },
  deviceBadgeText: {
    color: COLORS.accentBlue,
    fontSize: 10,
    fontWeight: '600',
  },
  deviceSectionTitle: {
    color: COLORS.accentBlue,
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  agentBadge: {
    backgroundColor: COLORS.accentPurpleSubtle,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 8,
  },
  agentBadgeText: {
    color: COLORS.accentPurple,
    fontSize: 10,
    fontWeight: '600',
  },
  // #4764 — chroxy-intervention header badge. Uses the orange palette to
  // signal "something the platform intervened on" without veering into
  // alert-red (the operator may want to acknowledge it, but the deny is
  // working-as-intended). Tappable target sized comfortably for thumb taps.
  interventionBadge: {
    backgroundColor: COLORS.accentOrangeSubtle,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 8,
  },
  interventionBadgePressed: {
    opacity: 0.7,
  },
  interventionBadgeText: {
    color: COLORS.accentOrange,
    fontSize: 10,
    fontWeight: '600',
  },
  interventionRow: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  interventionReason: {
    color: COLORS.textPrimary,
    fontSize: 13,
    marginBottom: 2,
  },
  interventionMeta: {
    color: COLORS.textMuted,
    fontSize: 11,
  },
  // #4862 (Copilot review) — scroll container for the recent-interventions
  // list. maxHeight keeps the modal card bounded on small devices so the
  // Close button outside the ScrollView is always reachable, even at the
  // ring's 50-entry cap. marginVertical separates the list from the title
  // and the Close button.
  interventionList: {
    maxHeight: 280,
    marginVertical: 8,
  },
  interventionListContent: {
    paddingBottom: 4,
  },
  agentSection: {
    gap: 4,
  },
  agentSectionTitle: {
    color: COLORS.accentPurple,
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  agentEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  // #6822 — oauth-required MCP server: the row stacks the status line above the
  // authorize + paste-code affordance.
  mcpServerRow: {
    flexDirection: 'column',
    gap: 6,
  },
  mcpAuthContainer: {
    flexDirection: 'column',
    gap: 6,
    paddingLeft: 12,
  },
  mcpAuthorizeButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.accentBlue,
  },
  mcpAuthorizeButtonText: {
    color: COLORS.accentBlue,
    fontSize: 11,
    fontWeight: '600',
  },
  mcpAuthPasteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  mcpAuthInput: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
    color: COLORS.textPrimary,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  mcpAuthSubmit: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.accentBlue,
  },
  mcpAuthSubmitDisabled: {
    opacity: 0.5,
  },
  mcpAuthSubmitText: {
    color: COLORS.accentBlue,
    fontSize: 11,
    fontWeight: '600',
  },
  agentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentPurple,
  },
  agentDescription: {
    flex: 1,
    color: COLORS.textMuted,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  agentElapsed: {
    color: COLORS.textDim,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginLeft: 8,
  },
  customAgentSectionTitle: {
    color: COLORS.accentGreen,
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  customAgentEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    minHeight: 44,
  },
  customAgentInfo: {
    flex: 1,
  },
  customAgentName: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '600',
  },
  customAgentDesc: {
    color: COLORS.textDim,
    fontSize: 10,
    marginTop: 1,
  },
  customAgentBadge: {
    color: COLORS.textDim,
    fontSize: 9,
    backgroundColor: COLORS.backgroundCard,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: 'hidden',
  },
  // #4893 — bump minHeight from 32 → 44 so the copy-to-clipboard row clears
  // the Apple HIG / CLAUDE.md 44pt minimum tappable target. Sibling fix to
  // #4892 (which used hitSlop for the compact header badges); here the row
  // already has horizontal whitespace in the expanded panel, so growing the
  // visible row by 12pt is preferable to a hitSlop hack.
  conversationIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    minHeight: 44,
  },
  conversationIdLabel: {
    color: COLORS.textMuted,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  conversationIdValue: {
    color: COLORS.accentBlue,
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginLeft: 8,
  },
  // #4074: header cost badge — small, tappable, muted background so it
  // doesn't compete with the model/permission chips. Uses tabular-nums
  // via a monospaced font on iOS for stable layout as the cost grows.
  costBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: COLORS.backgroundTertiary,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
    marginLeft: 6,
  },
  costBadgePressed: {
    opacity: 0.7,
  },
  costBadgeText: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // #4074: breakdown sheet — modal backdrop + card. Renders the same
  // six rows the dashboard hover popover does (#4073).
  costSheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  costSheetCard: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
    padding: 20,
    width: '100%',
    maxWidth: 360,
  },
  costSheetTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  costSheetRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  costSheetLabel: {
    color: COLORS.textMuted,
    fontSize: 14,
  },
  costSheetValue: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontVariant: ['tabular-nums'],
  },
  costSheetDivider: {
    height: 1,
    backgroundColor: COLORS.borderPrimary,
    marginVertical: 8,
  },
  costSheetDismiss: {
    marginTop: 16,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: COLORS.backgroundTertiary,
  },
  costSheetDismissText: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
});

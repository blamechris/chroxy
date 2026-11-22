/**
 * FolderTrustBanner (mobile) — per-folder trust for project settings.
 *
 * A session folder can carry settings that make the agent run commands (MCP
 * servers, hooks, a status line, plugins, agents, skills, commands). They are not
 * loaded until the owner trusts the folder. This is the per-session surface for
 * that decision, driven by the daemon's `folder_trust_state`:
 *
 *   - `untrusted` -> a strip with Review, which opens a dialog that lists what
 *     would run and offers "Trust this folder".
 *   - `trusted`   -> a strip with "Stop trusting".
 *   - no state yet, or a provider that does not run claude -> nothing.
 *
 * The dialog renders from a SNAPSHOT taken when Review was pressed, and Trust
 * sends THAT snapshot's digest: what the owner approves is what they read, whatever
 * newer state has arrived since. If a newer frame changes the digest the dialog says
 * so, offers Reload and disables Trust. With no summary and digest (a session-bound
 * client) or an incomplete scan, the dialog is read-only.
 *
 * The component only displays and forwards the two actions; the daemon decides
 * (primary token on an unbound connection) and says so in `error`. Mirrors
 * `packages/dashboard/src/components/FolderTrustBanner.tsx`; the shared text and
 * rules live in `@chroxy/store-core`.
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  canTrustFolderSnapshot,
  folderTrustAppliesFromText,
  folderTrustCountsText,
  folderTrustHasFileCounts,
  folderTrustMcpCommandLine,
  type FolderTrustEntry,
} from '@chroxy/store-core';
import { COLORS } from '../constants/colors';

export interface FolderTrustBannerProps {
  entry: FolderTrustEntry | null | undefined;
  /** A trust change for this session is in flight. */
  pending?: boolean;
  /** Why the last trust change failed, or null. */
  error?: string | null;
  /** Called with the digest of the SNAPSHOT the owner reviewed, never the latest one. */
  onTrust: (digest: string) => void;
  onUntrust: () => void;
}

const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

function SummaryList({ entry }: { entry: FolderTrustEntry }) {
  const summary = entry.summary;
  if (!summary) return null;
  const { mcpServers, hooks, statusLine, enabledPlugins, counts, files, warnings } = summary;
  return (
    <View testID="folder-trust-summary">
      {!summary.hasCommandBearingFiles && (
        <Text style={styles.body} testID="folder-trust-no-commands">
          No commands found; trusting loads this folder's CLAUDE.md, rules and other project settings.
        </Text>
      )}
      {mcpServers.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.heading}>MCP servers</Text>
          {mcpServers.map((s, i) => (
            <Text key={`${s.file}:${s.name}:${i}`} style={styles.body} testID="folder-trust-mcp-server">
              <Text style={styles.strong}>{s.name}</Text>
              {' '}
              <Text style={styles.code}>{folderTrustMcpCommandLine(s)}</Text>
              {s.envKeys && s.envKeys.length > 0 ? ` (sets environment: ${s.envKeys.join(', ')})` : ''}
            </Text>
          ))}
        </View>
      )}
      {hooks.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.heading}>Hooks</Text>
          {hooks.map((h, i) => (
            <Text key={`${h.file}:${h.event}:${i}`} style={styles.body} testID="folder-trust-hook">
              <Text style={styles.strong}>{h.event}</Text>
              {' '}
              <Text style={styles.code}>{h.commands.join('  ')}</Text>
            </Text>
          ))}
        </View>
      )}
      {statusLine.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.heading}>Status line</Text>
          {statusLine.map((s, i) => (
            <Text key={i} style={[styles.body, styles.code]} testID="folder-trust-status-line">{s.command}</Text>
          ))}
        </View>
      )}
      {enabledPlugins.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.heading}>Plugins</Text>
          {enabledPlugins.map((p, i) => (
            <Text key={i} style={styles.body} testID="folder-trust-plugin">{p.plugin}</Text>
          ))}
        </View>
      )}
      {folderTrustHasFileCounts(counts) && (
        <View style={styles.section}>
          <Text style={styles.heading}>Files</Text>
          <Text style={styles.body} testID="folder-trust-counts">{folderTrustCountsText(counts)}</Text>
        </View>
      )}
      {files.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.heading}>Settings files</Text>
          {files.map((f) => (
            <Text key={f.path} style={[styles.body, styles.code]} testID="folder-trust-file">
              {f.path}
              {f.linkTarget ? ` -> ${f.linkTarget}` : ''}
            </Text>
          ))}
        </View>
      )}
      {warnings.length > 0 && (
        <View style={styles.section} testID="folder-trust-warnings">
          <Text style={styles.heading}>Notes</Text>
          {warnings.map((w, i) => (
            <Text key={i} style={styles.body}>{w}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

export function FolderTrustBanner({ entry, pending = false, error = null, onTrust, onUntrust }: FolderTrustBannerProps) {
  const insets = useSafeAreaInsets();
  // What the owner is looking at: the state when Review was pressed. The dialog renders
  // from it, and Trust sends ITS digest, whatever newer state has arrived since.
  const [snapshot, setSnapshot] = useState<FolderTrustEntry | null>(null);
  const status = entry?.status;
  const applies = entry ? folderTrustAppliesFromText(entry.appliesFrom) : null;

  // Approving moves the state to trusted: the dialog has done its job.
  useEffect(() => {
    if (status !== 'untrusted') setSnapshot(null);
  }, [status]);

  if (!entry || entry.appliesFrom === 'n/a') return null;

  if (status === 'trusted') {
    return (
      <View style={[styles.strip, styles.stripTrusted]} accessibilityRole="summary" testID="folder-trust-trusted">
        <View style={styles.stripRow}>
          <Text style={styles.stripText}>Project settings for this folder are trusted.</Text>
          <TouchableOpacity
            style={[styles.stripButton, pending && styles.buttonDisabled]}
            onPress={onUntrust}
            disabled={pending}
            accessibilityRole="button"
            accessibilityLabel="Stop trusting this folder's project settings"
            accessibilityState={{ disabled: pending }}
            testID="folder-trust-untrust"
          >
            <Text style={styles.stripButtonText}>Stop trusting</Text>
          </TouchableOpacity>
        </View>
        {applies && <Text style={styles.note} testID="folder-trust-applies">{applies}</Text>}
        {error && <Text style={styles.error} accessibilityRole="alert" testID="folder-trust-error">{error}</Text>}
      </View>
    );
  }

  if (status !== 'untrusted') return null;

  // The owner approves what they reviewed: needs the summary and its digest, and a
  // folder that could be reviewed completely.
  const shown = snapshot ?? entry;
  const canTrust = canTrustFolderSnapshot(shown);
  const changed = snapshot !== null && entry.digest !== snapshot.digest;
  const shownApplies = folderTrustAppliesFromText(shown.appliesFrom);

  return (
    <>
      <View style={[styles.strip, styles.stripUntrusted]} accessibilityRole="summary" testID="folder-trust-banner">
        <View style={styles.stripRow}>
          <Text style={styles.stripText}>This folder's project settings are not loaded.</Text>
          <TouchableOpacity
            style={styles.stripButton}
            onPress={() => setSnapshot(entry)}
            accessibilityRole="button"
            accessibilityLabel="Review this folder's project settings"
            testID="folder-trust-review"
          >
            <Text style={styles.stripButtonText}>Review</Text>
          </TouchableOpacity>
        </View>
        {entry.launchedWithProject === true && (
          <Text style={styles.note} testID="folder-trust-still-loaded">
            Project settings stay loaded in this running session until it restarts.
          </Text>
        )}
      </View>
      <Modal
        visible={snapshot !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSnapshot(null)}
      >
        <View
          style={[
            styles.backdrop,
            { paddingTop: 16 + insets.top, paddingBottom: 16 + insets.bottom, paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right },
          ]}
        >
          <View style={styles.dialog} testID="folder-trust-dialog">
            <Text style={styles.title} accessibilityRole="header">Trust this folder's project settings?</Text>
            {changed && (
              <View style={styles.changed} accessibilityRole="alert" testID="folder-trust-changed">
                <Text style={styles.body}>This folder changed since you opened it. Review again.</Text>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => setSnapshot(entry)}
                  accessibilityRole="button"
                  accessibilityLabel="Reload the folder's project settings"
                  testID="folder-trust-reload"
                >
                  <Text style={styles.secondaryButtonText}>Reload</Text>
                </TouchableOpacity>
              </View>
            )}
            {/* The summary can be long (absolute paths, many servers and hooks). It scrolls
                on its own so the warning, the error and the buttons below stay on screen. */}
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} testID="folder-trust-summary-scroll">
              <SummaryList entry={shown} />
            </ScrollView>
            <View style={styles.footer}>
              {canTrust && !changed && (
                <Text style={styles.warning} testID="folder-trust-warning">
                  Trusting this folder lets these settings run, along with the code they point to.
                </Text>
              )}
              {!canTrust && (
                <Text style={styles.body} testID="folder-trust-readonly">
                  This folder's settings cannot be trusted from here.
                </Text>
              )}
              {shownApplies && <Text style={styles.note} testID="folder-trust-applies">{shownApplies}</Text>}
              {error && <Text style={styles.error} accessibilityRole="alert" testID="folder-trust-error">{error}</Text>}
              <View style={styles.buttons}>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => setSnapshot(null)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  testID="folder-trust-cancel"
                >
                  <Text style={styles.secondaryButtonText}>Cancel</Text>
                </TouchableOpacity>
                {canTrust && (
                  <TouchableOpacity
                    style={[styles.primaryButton, (pending || changed) && styles.buttonDisabled]}
                    onPress={() => onTrust(shown.digest as string)}
                    disabled={pending || changed}
                    accessibilityRole="button"
                    accessibilityLabel="Trust this folder"
                    accessibilityState={{ disabled: pending || changed }}
                    testID="folder-trust-confirm"
                  >
                    <Text style={styles.primaryButtonText}>Trust this folder</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  strip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
  stripUntrusted: {
    backgroundColor: COLORS.accentOrangeSubtle,
    borderBottomColor: COLORS.accentOrangeBorder,
  },
  stripTrusted: {
    backgroundColor: COLORS.accentGreenLight,
    borderBottomColor: COLORS.accentGreenBorder,
  },
  stripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  stripText: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: 13,
  },
  stripButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stripButtonText: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  note: {
    color: COLORS.textMuted,
    fontSize: 12,
    paddingBottom: 4,
  },
  error: {
    color: COLORS.textError,
    fontSize: 13,
    paddingVertical: 4,
  },
  backdrop: {
    flex: 1,
    // The app's base background at 80% alpha: dims the screen behind the dialog.
    backgroundColor: `${COLORS.backgroundPrimary}cc`,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialog: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 12,
    width: '100%',
    maxWidth: 600,
    maxHeight: '100%',
    borderWidth: 1,
    borderColor: COLORS.backgroundCard,
    overflow: 'hidden',
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.backgroundCard,
  },
  changed: {
    padding: 12,
    gap: 8,
    backgroundColor: COLORS.accentOrangeSubtle,
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    padding: 12,
  },
  section: {
    marginTop: 8,
  },
  heading: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  body: {
    color: COLORS.textSecondary,
    fontSize: 13,
    marginBottom: 4,
  },
  strong: {
    color: COLORS.textPrimary,
    fontWeight: '600',
  },
  code: {
    fontFamily: MONO,
    fontSize: 12,
    color: COLORS.textCodeBlock,
  },
  footer: {
    padding: 12,
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: COLORS.backgroundCard,
  },
  warning: {
    color: COLORS.accentOrange,
    fontSize: 13,
    fontWeight: '600',
  },
  buttons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    paddingTop: 4,
  },
  primaryButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: COLORS.accentBlue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: COLORS.textPrimary,
    fontSize: 14,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});

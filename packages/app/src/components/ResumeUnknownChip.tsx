/**
 * ResumeUnknownChip — #4971 (mobile-app companion to dashboard #4947).
 *
 * Replaces the generic red error bubble when the server emits
 * `error{code: 'resume_unknown'}` (server PR #4944). The server fires this
 * code when claude CLI rejects a `--resume <id>` because the conversation
 * id is unknown locally (operator wiped `~/.claude/projects/` between
 * chroxy boots, restored a state file from a different machine, etc.).
 *
 * The CliSession has already auto-fallen-back to a fresh conversation by
 * the time this chip surfaces — the model loses the prior transcript but
 * the chroxy ring buffer transcript is preserved in the UI. So we render a
 * calm operator-friendly explanation rather than the loud red crash toast,
 * matching the spirit of the mobile StreamStallChip (#4476): "recoverable,
 * here's what happened, here's what to expect next".
 *
 * `attemptedResumeId` (when provided) renders as small mono-spaced subtext
 * for operator correlation against the persisted state file
 * (`resumeConversationId` in ~/.chroxy/session-state.json) — answers "which
 * conversation did we lose?" without forcing the operator to grep logs.
 * Defensive empty/whitespace guard mirrors the dashboard component so a
 * stale or trimmed empty value can't produce a broken-looking "Attempted
 * id: " slot.
 *
 * Uses `accentYellow500` from constants/colors to match StreamStallChip
 * (and the other amber-recoverable surfaces) so the user learns one
 * affordance — the chip visual language is shared.
 */
import { Platform, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../constants/colors';

export interface ResumeUnknownChipProps {
  /**
   * Raw error text from the server (e.g. "Previous Claude conversation
   * could not be resumed (the id is unknown to the local claude CLI — ...)").
   * Preserved verbatim in `accessibilityHint` for assistive-tech triage.
   */
  errorText: string;
  /**
   * The conversation id chroxy passed to `claude --resume <id>` before
   * the CLI rejected it. Surfaced as mono-spaced subtext when present;
   * empty / whitespace / undefined hides the subtext slot entirely
   * (matches the dashboard chip's defensive guard).
   */
  attemptedResumeId?: string;
}

export function ResumeUnknownChip({ errorText, attemptedResumeId }: ResumeUnknownChipProps) {
  // Empty-string defense — same rationale as the dashboard chip and the
  // SessionNotFoundChip: a stale or trimmed empty value should not produce
  // a broken-looking "Attempted id: " slot with no value.
  const hasId = typeof attemptedResumeId === 'string' && attemptedResumeId.trim().length > 0;

  return (
    <View
      testID="resume-unknown-chip"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel="Previous conversation could not be resumed — starting fresh"
      accessibilityHint={errorText}
      style={styles.container}
    >
      <View style={styles.dot} />
      <Text style={styles.label}>
        Previous conversation could not be resumed — starting fresh
      </Text>
      {hasId && (
        // #4971 review: drop `accessibilityElementsHidden` /
        // `importantForAccessibility="no"` so the attempted id is
        // naturally announced by screen readers (mirrors the dashboard
        // chip, which renders the id as visible text the AT tree picks
        // up via the standard sibling traversal). The container's
        // `accessibilityLabel` stays minimal and `accessibilityHint`
        // continues to carry the raw error verbatim for triage.
        <Text
          testID="resume-unknown-chip-id"
          style={styles.idSubtext}
          selectable
        >
          Attempted id: {attemptedResumeId}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginVertical: 4,
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.accentYellow500,
    backgroundColor: 'rgba(217, 165, 12, 0.12)',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accentYellow500,
  },
  label: {
    fontSize: 13,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  idSubtext: {
    width: '100%',
    marginTop: 4,
    fontSize: 12,
    // #4971 review: iOS doesn't ship a font literally named "monospace" —
    // RN falls back to a system font that varies by iOS version. Use the
    // same Menlo/monospace pair as ToolBubble / DiffViewer /
    // MarkdownRenderer so the attempted id renders in a consistent
    // monospace face across platforms.
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: COLORS.textSecondary,
    opacity: 0.85,
  },
});

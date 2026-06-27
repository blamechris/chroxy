/**
 * ResumeUnknownChip — #4971 / #5006 (mobile-app companion to dashboard
 * #4947 / #5006).
 *
 * Replaces the generic red error bubble when the server emits one of the
 * two resume-failure codes from CliSession's `_handleChildClose` path:
 *
 *   - `error{code: 'resume_unknown'}` (server PR #4944) — RECOVERABLE.
 *     CliSession has already auto-fallen-back to a fresh conversation by
 *     the time the chip surfaces. The model loses the prior transcript
 *     but the chroxy ring buffer transcript is preserved in the UI. We
 *     render a calm operator-friendly explanation rather than the loud
 *     red crash toast.
 *
 *   - `error{code: 'resume_unknown_exhausted'}` (server PR #5004) —
 *     TERMINAL. The post-fallback retry ALSO matched the unknown-resume
 *     pattern; the server has stopped auto-respawning and the user must
 *     start a fresh session manually. The chip switches headline /
 *     accessibilityLabel copy so AT users get the "auto-recovery
 *     exhausted, action needed" signal — `accessibilityRole="alert"` is
 *     already used on the recoverable variant (mobile RN convention is
 *     louder by default than the dashboard's status/alert split), so the
 *     variant difference rides on the label + visible text.
 *
 * `attemptedResumeId` (when provided) renders as small mono-spaced subtext
 * for operator correlation against the persisted state file
 * (`resumeConversationId` in ~/.chroxy/session-state.json) — answers "which
 * conversation did we lose?" without forcing the operator to grep logs.
 * Surfaces on both variants because the correlation use case is identical.
 * Defensive empty/whitespace guard mirrors the dashboard component so a
 * stale or trimmed empty value can't produce a broken-looking "Attempted
 * id: " slot.
 *
 * Uses `accentYellow500` from constants/colors to match StreamStallChip
 * (and the other amber-recoverable surfaces) so the user learns one
 * affordance — the chip visual language is shared.
 */
import { Platform, StyleSheet, Text, View } from 'react-native';
import { getErrorPresentation } from '@chroxy/store-core';
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
  /**
   * #5006 — variant switch matched against the server error code:
   *   - `'recoverable'` (default) — `code: 'resume_unknown'`; chip renders
   *     the "starting fresh" headline.
   *   - `'exhausted'` — `code: 'resume_unknown_exhausted'`; chip renders
   *     the "auto-recovery exhausted" headline + "start a new session
   *     manually" call-to-action.
   * Optional + defaulted so existing call sites that pre-date #5006
   * continue to render the recoverable copy unchanged.
   */
  variant?: 'recoverable' | 'exhausted';
}

export function ResumeUnknownChip({
  errorText,
  attemptedResumeId,
  variant = 'recoverable',
}: ResumeUnknownChipProps) {
  // Empty-string defense — same rationale as the dashboard chip and the
  // SessionNotFoundChip: a stale or trimmed empty value should not produce
  // a broken-looking "Attempted id: " slot with no value.
  const hasId = typeof attemptedResumeId === 'string' && attemptedResumeId.trim().length > 0;

  // #5006 / #6392: the variant maps to a resume error code; the shared
  // error-presentation registry (store-core) supplies the headline so the copy
  // is single-sourced cross-surface. accessibilityRole stays `'alert'` for both
  // variants — the mobile RN convention is the assertive role on recoverable
  // amber chips too (parity with StreamStallChip); the label carries the urgency.
  const { headline } = getErrorPresentation(
    variant === 'exhausted' ? 'resume_unknown_exhausted' : 'resume_unknown',
  );

  return (
    <View
      testID="resume-unknown-chip"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={headline}
      accessibilityHint={errorText}
      style={styles.container}
    >
      <View style={styles.dot} />
      <Text style={styles.label}>{headline}</Text>
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

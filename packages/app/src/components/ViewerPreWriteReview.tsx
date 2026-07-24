/**
 * ViewerPreWriteReview (#6544, IDE P3.3 feature A — mobile) — the RN mirror of
 * the dashboard's viewer review. When a Write/Edit permission is pending for the
 * file open in the FileEditor, surface the #6556 per-hunk pre-write review right
 * inside the editor and route Approve/Deny through the SAME `editedInput` seam
 * (`get_permission_input` -> `sendPermissionResponse(requestId, decision,
 * editedInput)`) — the exact wire path #6543/#6556 established. No new protocol:
 * the narrowed content rides the existing per-hunk `editedInput` the server
 * whitelists (#6552).
 *
 * Delta over #6556: LOCATION. #6556 renders the review inside the chat
 * permission bubble (MessageBubble); this correlates the pending write to the
 * file open in the FileEditor and renders it there, so the operator reviews (and
 * narrows) the edit in the file's own context. Both surfaces read the same store
 * state and drive the same response — the chat bubble keeps working independently.
 *
 * The correlation helpers (`pathMatchesViewer` / `findPendingWriteForFile`) are
 * shared with the dashboard via `@chroxy/store-core` (#6859 — hoisted out of two
 * byte-identical copies to prevent cross-client drift). Gated on `features.ide`;
 * hides when no live reviewable write targets the open file, or once the
 * request is resolved (locally via `markPromptAnswered`, or by another
 * client's `permission_resolved` — both set the message's `answered`, which
 * `isLivePermissionPrompt` excludes).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { findPendingWriteForFile } from '@chroxy/store-core';
import type { ChatMessage } from '@chroxy/store-core';
import { useConnectionStore } from '../store/connection';
import { PreWriteDiffReview, isReviewableTool } from './PreWriteDiffReview';
import { COLORS } from '../constants/colors';

// Stable empty array so the messages selector never returns a fresh reference.
const EMPTY_MESSAGES: ChatMessage[] = [];

export interface ViewerPreWriteReviewProps {
  /** The path currently open in the FileEditor (absolute, or workspace-relative). */
  filePath: string | null;
}

export function ViewerPreWriteReview({ filePath }: ViewerPreWriteReviewProps) {
  const ideEnabled = useConnectionStore((s) => Boolean(s.serverCapabilities?.ide));
  const messages = useConnectionStore((s) => {
    const id = s.activeSessionId;
    return (id ? s.sessionStates[id]?.messages : undefined) ?? EMPTY_MESSAGES;
  });

  // The live reviewable write (if any) targeting the open file. The store's
  // permission_resolved / permission_expired handlers mutate the message (which
  // re-runs this memo); the authoritative countdown lives on the chat bubble.
  const pending = useMemo(
    () => (ideEnabled ? findPendingWriteForFile(messages, filePath, Date.now(), isReviewableTool) : null),
    [ideEnabled, messages, filePath],
  );
  const requestId = pending?.requestId ?? null;
  const tool = pending?.tool ?? null;

  const pulledInput = useConnectionStore((s) => (requestId ? s.permissionInputs?.[requestId] : undefined));
  const requestPermissionInput = useConnectionStore((s) => s.requestPermissionInput);
  const sendPermissionResponse = useConnectionStore((s) => s.sendPermissionResponse);

  const [editedInput, setEditedInput] = useState<Record<string, string> | null>(null);
  // Double-submit guard: flips synchronously on the first press, before the
  // store's answered state catches up a render later.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset per-request UI state when the target request changes.
  useEffect(() => {
    setEditedInput(null);
    submittingRef.current = false;
    setSubmitting(false);
  }, [requestId]);

  // Pull the full redacted tool input once for a live write (the broadcast input
  // is truncated — #6543/#6550). The diff renders once it lands; until then the
  // plain Approve/Deny still work.
  useEffect(() => {
    if (ideEnabled && requestId && pulledInput === undefined) {
      requestPermissionInput(requestId);
    }
  }, [ideEnabled, requestId, pulledInput, requestPermissionInput]);

  if (!ideEnabled || !pending || !requestId) return null;

  // Narrow the discriminated `permission_input` union: only found:true carries
  // `input` (found:false is a security message with no tool input).
  const proposedInput = pulledInput?.found ? pulledInput.input : null;
  const hasDiff = proposedInput !== null;

  const respond = (decision: 'allow' | 'deny') => {
    if (!requestId || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    // #6543: carry the per-hunk narrowing on an approve only (never on a deny).
    // sendPermissionResponse itself records the canonical decision TOKEN on the
    // prompt (markPromptAnsweredByRequestId — 'allow' | 'deny'). Do NOT re-mark
    // here with a display label: a viewer DENY that stored 'Denied' would clobber
    // the 'deny' token, and PermissionDetail (`isDenied = answer === 'deny'`) would
    // then render a green "Allowed" pill for a denied write (#6222/#6223 — answer
    // is the decision token, not a label).
    const sent = sendPermissionResponse(requestId, decision, decision === 'deny' ? null : editedInput);
    if (sent !== 'sent') {
      // #6308: the socket can flip OPEN→CLOSING before this synchronous send, so
      // sendPermissionResponse returns false without marking the token — leave the
      // review actionable instead of wedging with submitting=true.
      submittingRef.current = false;
      setSubmitting(false);
    }
    // On 'sent': the message's `answered` token flips → the pending memo recomputes
    // to null → this component unmounts. Keep submitting=true in the interim so a
    // rapid second press can't double-fire.
  };

  return (
    <View style={styles.container} testID="viewer-prewrite-review">
      <Text style={styles.title} testID="viewer-prewrite-title">
        <Text style={styles.tool}>{tool}</Text> proposed for this file — review before approving.
      </Text>

      {hasDiff ? (
        <PreWriteDiffReview
          tool={tool as string}
          input={proposedInput as Record<string, unknown>}
          onEditedInputChange={setEditedInput}
        />
      ) : (
        <Text style={styles.loading} testID="viewer-prewrite-loading">
          {pulledInput?.found === false
            ? 'Proposed change unavailable — approve to write it as-is.'
            : 'Loading proposed change…'}
        </Text>
      )}

      <View style={styles.buttons}>
        <TouchableOpacity
          style={[styles.btn, styles.approve, submitting && styles.btnDisabled]}
          testID="viewer-prewrite-approve"
          disabled={submitting}
          onPress={() => respond('allow')}
          accessibilityRole="button"
          accessibilityLabel={`Approve ${tool} to this file`}
        >
          <Text style={styles.btnText}>Approve</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.deny, submitting && styles.btnDisabled]}
          testID="viewer-prewrite-deny"
          disabled={submitting}
          onPress={() => respond('deny')}
          accessibilityRole="button"
          accessibilityLabel={`Deny ${tool} to this file`}
        >
          <Text style={styles.btnText}>Deny</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 12,
    marginTop: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.accentOrange,
    borderRadius: 8,
    backgroundColor: COLORS.backgroundSecondary,
  },
  title: {
    fontSize: 13,
    color: COLORS.textSecondary,
    marginBottom: 4,
  },
  tool: {
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  loading: {
    fontSize: 12,
    color: COLORS.textSecondary,
    paddingVertical: 6,
  },
  buttons: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  btn: {
    flex: 1,
    minHeight: 44,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approve: {
    backgroundColor: COLORS.accentGreen,
  },
  deny: {
    backgroundColor: COLORS.accentRed,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
});

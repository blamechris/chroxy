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
 * The correlation helpers mirror the dashboard's (`pathMatchesViewer` /
 * `findPendingWriteForFile`). Gated on `features.ide`; hides when no live
 * reviewable write targets the open file, or once the request is resolved
 * (locally via `markPromptAnswered`, or by another client's `permission_resolved`
 * — both set the message's `answered`, which `isLivePermissionPrompt` excludes).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { isLivePermissionPrompt } from '@chroxy/store-core';
import type { ChatMessage } from '@chroxy/store-core';
import { useConnectionStore } from '../store/connection';
import { PreWriteDiffReview, isReviewableTool } from './PreWriteDiffReview';
import { COLORS } from '../constants/colors';

// Stable empty array so the messages selector never returns a fresh reference.
const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Tolerant path match between a permission's `file_path` and the file open in
 * the viewer. Claude passes an ABSOLUTE `file_path` for Write/Edit; the viewer
 * path may be absolute or workspace-relative — match exactly or by tail. Both
 * nulls => no match. Mirrors the dashboard helper of the same name.
 */
export function pathMatchesViewer(filePath: string | null | undefined, viewed: string | null): boolean {
  if (!filePath || !viewed) return false;
  const a = filePath.replace(/\\/g, '/');
  const b = viewed.replace(/\\/g, '/');
  if (a === b) return true;
  const tail = (p: string) => p.replace(/^\.?\//, '');
  return a.endsWith('/' + tail(b)) || b.endsWith('/' + tail(a));
}

/**
 * The first live, reviewable (Write/Edit) permission whose target `file_path`
 * matches the file open in the viewer — or null. Pure so it's unit-testable
 * without the store. Mirrors the dashboard helper of the same name.
 */
export function findPendingWriteForFile(
  messages: ChatMessage[],
  viewed: string | null,
  now: number,
): ChatMessage | null {
  if (!viewed) return null;
  for (const m of messages) {
    if (!isLivePermissionPrompt(m, now)) continue;
    if (!m.tool || !isReviewableTool(m.tool)) continue;
    const fp = m.toolInput && typeof m.toolInput.file_path === 'string' ? (m.toolInput.file_path as string) : null;
    if (pathMatchesViewer(fp, viewed)) return m;
  }
  return null;
}

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
    () => (ideEnabled ? findPendingWriteForFile(messages, filePath, Date.now()) : null),
    [ideEnabled, messages, filePath],
  );
  const requestId = pending?.requestId ?? null;
  const tool = pending?.tool ?? null;
  const messageId = pending?.id ?? null;

  const pulledInput = useConnectionStore((s) => (requestId ? s.permissionInputs?.[requestId] : undefined));
  const requestPermissionInput = useConnectionStore((s) => s.requestPermissionInput);
  const sendPermissionResponse = useConnectionStore((s) => s.sendPermissionResponse);
  const markPromptAnswered = useConnectionStore((s) => s.markPromptAnswered);

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
    const sent = sendPermissionResponse(requestId, decision, decision === 'deny' ? null : editedInput);
    if (sent === 'sent' && messageId) {
      markPromptAnswered(messageId, decision === 'deny' ? 'Denied' : 'Approved');
    } else {
      // Not sent (e.g. disconnected) — leave the review actionable.
      submittingRef.current = false;
      setSubmitting(false);
    }
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
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Modal,
  ScrollView,
  Platform,
} from 'react-native';
import {
  composeCommentReviewPrompt,
  composeReviewRequestPrompt,
  deriveLineNumber,
  type DiffLineComment,
} from '@chroxy/store-core';
import { useConnectionStore } from '../store/connection';
import type { DiffResult, DiffFile, DiffHunk, DiffHunkLine } from '../store/connection';
import { COLORS } from '../constants/colors';
import { ICON_DIFF } from '../constants/icons';
import { Icon } from './Icon';

/** Stable, position-derived key for one diff line (used as the comment id). */
function lineKey(filePath: string, hunkIndex: number, lineIndex: number): string {
  return `${filePath}#${hunkIndex}#${lineIndex}`;
}

/** Everything the composer needs to build a DiffLineComment on save. */
type LineCommentTarget = {
  key: string;
  filePath: string;
  lineNumber: number | null;
  lineType: DiffHunkLine['type'];
  lineContent: string;
};

/**
 * #6800: inline-comment wiring threaded down to the diff lines. Absent for the
 * read-only / PreWriteDiffReview renders, which stay unchanged.
 */
type CommentApi = {
  comments: DiffLineComment[];
  editingKey: string | null;
  draft: string;
  onOpen: (target: LineCommentTarget) => void;
  onDraftChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onRemove: (key: string) => void;
};

/** Status badge color mapping */
function statusColor(status: DiffFile['status']): string {
  switch (status) {
    case 'added': return COLORS.accentGreen;
    case 'deleted': return COLORS.accentRed;
    case 'renamed': return COLORS.accentBlue;
    case 'untracked': return COLORS.accentBlue;
    default: return COLORS.accentOrange;
  }
}

/** Status label */
function statusLabel(status: DiffFile['status']): string {
  switch (status) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'untracked': return 'U';
    default: return 'M';
  }
}

/**
 * Render a single diff hunk. #6542: opt-in per-hunk accept/reject — when
 * `selectable`, the header becomes a ≥44pt touch-target row with a checkbox
 * glyph. Read-only viewers omit it, so the existing render is unchanged. The
 * props are a discriminated union so `selectable` ALWAYS carries `selected` +
 * `onToggle` — no dead checkbox (a control with a checkbox role but no handler).
 * The selection STATE + applyHunks wiring live in the consuming surface (#6543/#6544).
 *
 * #6800: when `commentApi` + `filePath` are supplied, each line becomes a
 * touch-target that opens an inline comment editor. Read-only consumers pass
 * neither, so the existing render is unchanged.
 */
export type DiffHunkViewProps = { hunk: DiffHunk; filePath?: string; hunkIndex?: number; commentApi?: CommentApi } & (
  | { selectable?: false; selected?: never; onToggle?: never }
  | { selectable: true; selected: boolean; onToggle: () => void }
);

export function DiffHunkView({
  hunk,
  filePath,
  hunkIndex = 0,
  commentApi,
  selectable = false,
  selected = false,
  onToggle,
}: DiffHunkViewProps) {
  const commentsOn = !!commentApi && filePath != null;
  return (
    <View style={[styles.hunk, selectable && !selected ? styles.hunkRejected : null]}>
      {selectable ? (
        <TouchableOpacity
          style={styles.hunkToggleRow}
          onPress={onToggle}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selected }}
          accessibilityLabel={selected ? 'Reject this hunk' : 'Accept this hunk'}
          testID="hunk-toggle"
        >
          <Text style={styles.hunkToggleBox}>{selected ? '☑' : '☐'}</Text>
          <Text style={styles.hunkHeader} selectable>{hunk.header}</Text>
        </TouchableOpacity>
      ) : (
        <Text style={styles.hunkHeader} selectable>{hunk.header}</Text>
      )}
      {hunk.lines.map((line, i) => {
        const lineStyle =
          line.type === 'addition' ? styles.lineAdded :
          line.type === 'deletion' ? styles.lineRemoved :
          styles.lineContext;
        const prefix =
          line.type === 'addition' ? '+' :
          line.type === 'deletion' ? '-' :
          ' ';

        if (!commentsOn) {
          return (
            <Text key={i} style={lineStyle} selectable>
              <Text style={styles.linePrefix}>{prefix}</Text>
              {line.content}
            </Text>
          );
        }

        const api = commentApi!;
        const key = lineKey(filePath!, hunkIndex, i);
        const existing = api.comments.find((c) => c.id === key);
        const isEditing = api.editingKey === key;
        return (
          <View key={i}>
            <TouchableOpacity
              onPress={() =>
                api.onOpen({
                  key,
                  filePath: filePath!,
                  lineNumber: deriveLineNumber(hunk, i),
                  lineType: line.type,
                  lineContent: line.content,
                })
              }
              accessibilityRole="button"
              accessibilityLabel={existing ? 'Edit comment on this line' : 'Comment on this line'}
              testID={`diff-line-${i}`}
            >
              <Text style={[lineStyle, existing ? styles.lineHasComment : null]}>
                <Text style={styles.linePrefix}>{prefix}</Text>
                {line.content}
              </Text>
            </TouchableOpacity>

            {existing && !isEditing && (
              <TouchableOpacity
                style={styles.commentNote}
                onPress={() =>
                  api.onOpen({
                    key,
                    filePath: filePath!,
                    lineNumber: deriveLineNumber(hunk, i),
                    lineType: line.type,
                    lineContent: line.content,
                  })
                }
                testID={`diff-comment-note-${i}`}
              >
                <Text style={styles.commentNoteText}>{existing.comment}</Text>
                <TouchableOpacity
                  onPress={() => api.onRemove(key)}
                  accessibilityRole="button"
                  accessibilityLabel="Remove comment"
                  testID={`diff-comment-remove-${i}`}
                >
                  <Text style={styles.commentRemove}>Remove</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            )}

            {isEditing && (
              <View style={styles.commentEditor} testID={`diff-comment-editor-${i}`}>
                <TextInput
                  style={styles.commentInput}
                  value={api.draft}
                  onChangeText={api.onDraftChange}
                  placeholder="Leave a comment for Claude…"
                  placeholderTextColor={COLORS.textMuted}
                  multiline
                  autoFocus
                  testID="diff-comment-input"
                />
                <View style={styles.commentEditorActions}>
                  <TouchableOpacity
                    style={[styles.commentSave, api.draft.trim().length === 0 ? styles.commentSaveDisabled : null]}
                    onPress={api.onSave}
                    disabled={api.draft.trim().length === 0}
                    testID="diff-comment-save"
                  >
                    <Text style={styles.commentSaveText}>Add comment</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.commentCancel} onPress={api.onCancel} testID="diff-comment-cancel">
                    <Text style={styles.commentCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** File diff detail view */
function FileDiffView({
  file,
  onBack,
  commentApi,
}: {
  file: DiffFile;
  onBack: () => void;
  commentApi?: CommentApi;
}) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={onBack}>
          <Text style={styles.backButtonText}>{'< Back'}</Text>
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <Text style={styles.fileName} numberOfLines={1}>{file.path}</Text>
          <Text style={styles.fileStat}>
            <Text style={styles.additionsStat}>+{file.additions}</Text>
            {'  '}
            <Text style={styles.deletionsStat}>-{file.deletions}</Text>
          </Text>
        </View>
      </View>
      <ScrollView style={styles.diffScroll} contentContainerStyle={styles.diffScrollContent}>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View>
            {file.hunks.map((hunk, i) => (
              <DiffHunkView key={i} hunk={hunk} filePath={file.path} hunkIndex={i} commentApi={commentApi} />
            ))}
            {file.hunks.length === 0 && (
              <Text style={styles.emptyText}>No diff content</Text>
            )}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

/** Main DiffViewer modal component */
export function DiffViewer({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<DiffFile | null>(null);

  // #6800: pending inline comments + the open editor.
  const [comments, setComments] = useState<DiffLineComment[]>([]);
  const [editing, setEditing] = useState<LineCommentTarget | null>(null);
  const [draft, setDraft] = useState('');

  const setDiffCallback = useConnectionStore((s) => s.setDiffCallback);
  const requestDiff = useConnectionStore((s) => s.requestDiff);
  const sendInput = useConnectionStore((s) => s.sendInput);

  const requestIdRef = useRef(0);
  const activeRequestRef = useRef(0);

  useEffect(() => {
    if (!visible) return;

    setFiles([]);
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    setComments([]);
    setEditing(null);
    setDraft('');

    const handleResult = (result: DiffResult) => {
      if (activeRequestRef.current !== requestIdRef.current) return;
      activeRequestRef.current = -1;
      setLoading(false);
      if (result.error) {
        setError(result.error);
        setFiles([]);
        return;
      }
      setFiles(result.files);
      setError(null);
    };

    setDiffCallback(handleResult);

    const id = ++requestIdRef.current;
    activeRequestRef.current = id;
    requestDiff();

    const timer = setTimeout(() => {
      if (activeRequestRef.current === id) {
        activeRequestRef.current = -1;
        setLoading(false);
        setError('Request timed out');
      }
    }, 10000);

    return () => {
      clearTimeout(timer);
      setDiffCallback(null);
    };
  }, [visible, setDiffCallback, requestDiff]);

  const handleClose = useCallback(() => {
    setSelectedFile(null);
    onClose();
  }, [onClose]);

  const handleBack = useCallback(() => {
    setSelectedFile(null);
  }, []);

  const handleOpenComment = useCallback((target: LineCommentTarget) => {
    setEditing(target);
    setComments((prev) => {
      const existing = prev.find((c) => c.id === target.key);
      setDraft(existing?.comment ?? '');
      return prev;
    });
  }, []);

  const handleSaveComment = useCallback(() => {
    if (!editing) return;
    const text = draft.trim();
    if (!text) return;
    setComments((prev) => {
      const next: DiffLineComment = {
        id: editing.key,
        filePath: editing.filePath,
        lineNumber: editing.lineNumber,
        lineType: editing.lineType,
        lineContent: editing.lineContent,
        comment: text,
      };
      const idx = prev.findIndex((c) => c.id === editing.key);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = next;
        return copy;
      }
      return [...prev, next];
    });
    setEditing(null);
    setDraft('');
  }, [editing, draft]);

  const handleCancelComment = useCallback(() => {
    setEditing(null);
    setDraft('');
  }, []);

  const handleRemoveComment = useCallback((key: string) => {
    setComments((prev) => prev.filter((c) => c.id !== key));
    setEditing((cur) => (cur?.key === key ? null : cur));
  }, []);

  const handleSubmitComments = useCallback(() => {
    if (comments.length === 0) return;
    const prompt = composeCommentReviewPrompt(comments);
    if (!prompt) return;
    const result = sendInput(prompt);
    if (result) {
      setComments([]);
      setEditing(null);
      setDraft('');
      handleClose();
    }
  }, [comments, sendInput, handleClose]);

  const handleReview = useCallback(() => {
    const prompt = composeReviewRequestPrompt(files.map((f) => ({ path: f.path })));
    const result = sendInput(prompt);
    if (result) handleClose();
  }, [files, sendInput, handleClose]);

  const commentApi: CommentApi = {
    comments,
    editingKey: editing?.key ?? null,
    draft,
    onOpen: handleOpenComment,
    onDraftChange: setDraft,
    onSave: handleSaveComment,
    onCancel: handleCancelComment,
    onRemove: handleRemoveComment,
  };

  if (!visible) return null;

  const showActionBar = !loading && !error && files.length > 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.modalContainer}>
        {/* Header */}
        <View style={styles.modalHeader}>
          <TouchableOpacity style={styles.closeButton} onPress={handleClose} accessibilityRole="button" accessibilityLabel="Close changes viewer">
            <Icon name="close" size={18} color={COLORS.textPrimary} />
          </TouchableOpacity>
          <View style={styles.modalHeaderInfo}>
            <Text style={styles.modalTitle}>
              {ICON_DIFF} Changes
            </Text>
            {!loading && !error && files.length > 0 && (
              <Text style={styles.modalSubtitle}>
                {files.length} file{files.length !== 1 ? 's' : ''} changed
              </Text>
            )}
          </View>
        </View>

        {/* Content */}
        {selectedFile ? (
          <FileDiffView file={selectedFile} onBack={handleBack} commentApi={commentApi} />
        ) : (
          <View style={styles.container}>
            {loading && (
              <View style={styles.centerContent}>
                <ActivityIndicator size="small" color={COLORS.accentBlue} />
              </View>
            )}
            {!loading && error && (
              <View style={styles.centerContent}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
            {!loading && !error && files.length === 0 && (
              <View style={styles.centerContent}>
                <Text style={styles.emptyText}>No uncommitted changes</Text>
              </View>
            )}
            {!loading && !error && files.length > 0 && (
              <FlatList
                data={files}
                keyExtractor={(item) => item.path}
                renderItem={({ item }) => {
                  const fileComments = comments.filter((c) => c.filePath === item.path).length;
                  return (
                    <TouchableOpacity
                      style={styles.fileEntry}
                      onPress={() => setSelectedFile(item)}
                      testID={`diff-file-${item.path}`}
                    >
                      <View style={[styles.statusBadge, { backgroundColor: statusColor(item.status) + '33' }]}>
                        <Text style={[styles.statusText, { color: statusColor(item.status) }]}>
                          {statusLabel(item.status)}
                        </Text>
                      </View>
                      <Text style={styles.fileEntryName} numberOfLines={1}>{item.path}</Text>
                      {fileComments > 0 && (
                        <View style={styles.fileCommentBadge}>
                          <Text style={styles.fileCommentBadgeText}>{fileComments}</Text>
                        </View>
                      )}
                      <Text style={styles.fileEntryStat}>
                        <Text style={styles.additionsStat}>+{item.additions}</Text>
                        {'  '}
                        <Text style={styles.deletionsStat}>-{item.deletions}</Text>
                      </Text>
                    </TouchableOpacity>
                  );
                }}
              />
            )}
          </View>
        )}

        {/* #6800: review action bar — submit queued comments / one-click review. */}
        {showActionBar && (
          <View style={styles.actionBar} testID="diff-action-bar">
            {comments.length > 0 && (
              <TouchableOpacity
                style={styles.submitButton}
                onPress={handleSubmitComments}
                accessibilityRole="button"
                accessibilityLabel={`Submit ${comments.length} comment${comments.length !== 1 ? 's' : ''} to Claude`}
                testID="diff-submit-comments"
              >
                <Text style={styles.submitButtonText}>
                  Submit {comments.length} comment{comments.length !== 1 ? 's' : ''}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.reviewButton}
              onPress={handleReview}
              accessibilityRole="button"
              accessibilityLabel="Ask Claude to review these changes"
              testID="diff-review-code"
            >
              <Text style={styles.reviewButtonText}>Review code</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
    backgroundColor: COLORS.backgroundSecondary,
  },
  closeButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeText: {
    color: COLORS.accentBlue,
    fontSize: 18,
  },
  modalHeaderInfo: {
    flex: 1,
    marginLeft: 8,
  },
  modalTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  modalSubtitle: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  headerInfo: {
    flex: 1,
    marginLeft: 8,
  },
  backButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingRight: 8,
  },
  backButtonText: {
    color: COLORS.accentBlue,
    fontSize: 15,
    fontWeight: '600',
  },
  fileName: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fileStat: {
    fontSize: 12,
    marginTop: 2,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
  },
  errorText: {
    color: COLORS.textError,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  emptyText: {
    color: COLORS.textDisabled,
    fontSize: 14,
    textAlign: 'center',
  },
  fileEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
  },
  statusBadge: {
    width: 24,
    height: 24,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fileEntryName: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  fileEntryStat: {
    marginLeft: 8,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  // #6800: a per-file badge showing how many pending comments it carries.
  fileCommentBadge: {
    marginLeft: 8,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: COLORS.accentBlue,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fileCommentBadgeText: {
    color: COLORS.textPrimary,
    fontSize: 11,
    fontWeight: '700',
  },
  additionsStat: {
    color: COLORS.accentGreen,
  },
  deletionsStat: {
    color: COLORS.accentRed,
  },
  diffScroll: {
    flex: 1,
  },
  diffScrollContent: {
    padding: 12,
  },
  hunk: {
    marginBottom: 16,
  },
  // #6542: a rejected (unchecked) hunk dims so the accepted set reads at a glance.
  // 0.55 to match the dashboard's .diff-hunk-rejected (cross-platform parity).
  hunkRejected: {
    opacity: 0.55,
  },
  // #6542: per-hunk accept/reject toggle row — ≥44pt touch target (mobile min).
  hunkToggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: 8,
    marginBottom: 2,
  },
  hunkToggleBox: {
    color: COLORS.accentBlue,
    fontSize: 18,
    paddingHorizontal: 4,
  },
  hunkHeader: {
    color: COLORS.accentBlue,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    paddingVertical: 4,
    paddingHorizontal: 4,
    backgroundColor: COLORS.accentBlueSubtle,
    borderRadius: 2,
    marginBottom: 2,
  },
  lineContext: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
    paddingHorizontal: 4,
  },
  lineAdded: {
    color: COLORS.accentGreen,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
    paddingHorizontal: 4,
    backgroundColor: COLORS.diffAddBackground,
  },
  lineRemoved: {
    color: COLORS.accentRed,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
    paddingHorizontal: 4,
    backgroundColor: COLORS.diffRemoveBackground,
  },
  linePrefix: {
    fontWeight: '700',
  },
  // #6800: a commented line gets a left accent so it reads at a glance.
  lineHasComment: {
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accentBlue,
  },
  commentNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginLeft: 4,
    backgroundColor: COLORS.accentBlueLight,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accentBlue,
  },
  commentNoteText: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: 13,
  },
  commentRemove: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  commentEditor: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    marginLeft: 4,
    backgroundColor: COLORS.backgroundTertiary,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.accentBlue,
  },
  commentInput: {
    minHeight: 44,
    color: COLORS.textPrimary,
    fontSize: 13,
    backgroundColor: COLORS.backgroundInput,
    borderWidth: 1,
    borderColor: COLORS.borderSecondary,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    textAlignVertical: 'top',
  },
  commentEditorActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  commentSave: {
    minHeight: 36,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 4,
    backgroundColor: COLORS.accentBlue,
  },
  commentSaveDisabled: {
    opacity: 0.5,
  },
  commentSaveText: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  commentCancel: {
    minHeight: 36,
    paddingHorizontal: 12,
    justifyContent: 'center',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  commentCancelText: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  // #6800: bottom action bar with review triggers.
  actionBar: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderPrimary,
    backgroundColor: COLORS.backgroundSecondary,
  },
  submitButton: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
    backgroundColor: COLORS.accentBlue,
  },
  submitButtonText: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  reviewButton: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: COLORS.borderSecondary,
    backgroundColor: COLORS.backgroundTertiary,
  },
  reviewButtonText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
});

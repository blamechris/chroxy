import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  TextInput,
  StyleSheet,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useConnectionStore } from '../store/connection';
import type {
  GitFileStatus,
  GitStatusResult,
  GitBranchesResult,
  GitStageResult,
  GitCommitResult,
} from '../store/types';
import { COLORS } from '../constants/colors';
import { Icon } from './Icon';

interface GitViewProps {
  visible: boolean;
  onClose: () => void;
}

type TabId = 'changes' | 'branches';

const STATUS_COLORS: Record<string, string> = {
  modified: COLORS.accentOrange,
  added: COLORS.accentGreen,
  deleted: COLORS.accentRed,
  renamed: COLORS.accentBlue,
  copied: COLORS.accentBlue,
  unknown: COLORS.textDim,
};

const STATUS_LABELS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  unknown: '?',
};

function FileStatusItem({
  file,
  isStaged,
  selected,
  onToggle,
}: {
  file: GitFileStatus;
  isStaged: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const statusColor = STATUS_COLORS[file.status] || COLORS.textDim;
  const statusLabel = STATUS_LABELS[file.status] || '?';
  const fileName = file.path.split('/').pop() || file.path;
  const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';

  return (
    <TouchableOpacity
      style={styles.fileItem}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`${isStaged ? 'Staged' : 'Unstaged'} ${file.status} file ${file.path}`}
    >
      <View style={[styles.statusBadge, { backgroundColor: statusColor + '22' }]}>
        <Text style={[styles.statusBadgeText, { color: statusColor }]}>{statusLabel}</Text>
      </View>
      <View style={styles.fileNameContainer}>
        {dirPath ? <Text style={styles.fileDirPath}>{dirPath}</Text> : null}
        <Text style={styles.fileName}>{fileName}</Text>
      </View>
      <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
        {selected && <Icon name="check" size={12} color={COLORS.textPrimary} />}
      </View>
    </TouchableOpacity>
  );
}

function UntrackedItem({ path, selected, onToggle }: { path: string; selected: boolean; onToggle: () => void }) {
  const fileName = path.split('/').pop() || path;
  const dirPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';

  return (
    <TouchableOpacity
      style={styles.fileItem}
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`Untracked file ${path}`}
    >
      <View style={[styles.statusBadge, { backgroundColor: COLORS.accentGreen + '22' }]}>
        <Text style={[styles.statusBadgeText, { color: COLORS.accentGreen }]}>?</Text>
      </View>
      <View style={styles.fileNameContainer}>
        {dirPath ? <Text style={styles.fileDirPath}>{dirPath}</Text> : null}
        <Text style={styles.fileName}>{fileName}</Text>
      </View>
      <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
        {selected && <Icon name="check" size={12} color={COLORS.textPrimary} />}
      </View>
    </TouchableOpacity>
  );
}

export function GitView({ visible, onClose }: GitViewProps) {
  const [activeTab, setActiveTab] = useState<TabId>('changes');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [staged, setStaged] = useState<GitFileStatus[]>([]);
  const [unstaged, setUnstaged] = useState<GitFileStatus[]>([]);
  const [untracked, setUntracked] = useState<string[]>([]);
  const [branches, setBranches] = useState<{ name: string; isCurrent: boolean; isRemote: boolean }[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

  const setGitStatusCallback = useConnectionStore((s) => s.setGitStatusCallback);
  const setGitBranchesCallback = useConnectionStore((s) => s.setGitBranchesCallback);
  const setGitStageCallback = useConnectionStore((s) => s.setGitStageCallback);
  const setGitCommitCallback = useConnectionStore((s) => s.setGitCommitCallback);
  const requestGitStatus = useConnectionStore((s) => s.requestGitStatus);
  const requestGitBranches = useConnectionStore((s) => s.requestGitBranches);
  const requestGitStage = useConnectionStore((s) => s.requestGitStage);
  const requestGitUnstage = useConnectionStore((s) => s.requestGitUnstage);
  const requestGitCommit = useConnectionStore((s) => s.requestGitCommit);

  const stageCallbackRef = useRef<((result: GitStageResult) => void) | null>(null);
  const commitCallbackRef = useRef<((result: GitCommitResult) => void) | null>(null);

  // Fetch data when modal opens
  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError(null);

    const statusCb = (result: GitStatusResult) => {
      setLoading(false);
      if (result.error) {
        setError(result.error);
      } else {
        setBranch(result.branch);
        setStaged(result.staged);
        setUnstaged(result.unstaged);
        setUntracked(result.untracked);
      }
    };

    setGitStatusCallback(statusCb);
    requestGitStatus();

    const branchesCb = (result: GitBranchesResult) => {
      if (!result.error) {
        setBranches(result.branches);
      }
    };

    setGitBranchesCallback(branchesCb);
    requestGitBranches();

    return () => {
      setGitStatusCallback(null);
      setGitBranchesCallback(null);
    };
  }, [visible, setGitStatusCallback, setGitBranchesCallback, requestGitStatus, requestGitBranches]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (stageCallbackRef.current) setGitStageCallback(null);
      if (commitCallbackRef.current) setGitCommitCallback(null);
    };
  }, [setGitStageCallback, setGitCommitCallback]);

  const toggleSelection = useCallback((path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleStageSelected = useCallback(() => {
    // Only stage unstaged + untracked files (not already-staged ones)
    const unstagedPaths = new Set(unstaged.map((f) => f.path));
    const untrackedSet = new Set(untracked);
    const paths = Array.from(selectedPaths).filter(
      (p) => unstagedPaths.has(p) || untrackedSet.has(p),
    );
    if (paths.length === 0) return;

    const cb = (result: GitStageResult) => {
      setGitStageCallback(null);
      stageCallbackRef.current = null;
      if (result.error) {
        Alert.alert('Stage Failed', result.error);
      } else {
        setSelectedPaths(new Set());
        // Re-fetch status
        setGitStatusCallback((r: GitStatusResult) => {
          if (!r.error) {
            setBranch(r.branch);
            setStaged(r.staged);
            setUnstaged(r.unstaged);
            setUntracked(r.untracked);
          }
          setGitStatusCallback(null);
        });
        requestGitStatus();
      }
    };

    stageCallbackRef.current = cb;
    setGitStageCallback(cb);
    requestGitStage(paths);
  }, [selectedPaths, unstaged, untracked, setGitStageCallback, requestGitStage, setGitStatusCallback, requestGitStatus]);

  const handleUnstageSelected = useCallback(() => {
    // Only unstage staged files (not unstaged/untracked ones)
    const stagedPaths = new Set(staged.map((f) => f.path));
    const paths = Array.from(selectedPaths).filter((p) => stagedPaths.has(p));
    if (paths.length === 0) return;

    const cb = (result: GitStageResult) => {
      setGitStageCallback(null);
      stageCallbackRef.current = null;
      if (result.error) {
        Alert.alert('Unstage Failed', result.error);
      } else {
        setSelectedPaths(new Set());
        setGitStatusCallback((r: GitStatusResult) => {
          if (!r.error) {
            setBranch(r.branch);
            setStaged(r.staged);
            setUnstaged(r.unstaged);
            setUntracked(r.untracked);
          }
          setGitStatusCallback(null);
        });
        requestGitStatus();
      }
    };

    stageCallbackRef.current = cb;
    setGitStageCallback(cb);
    requestGitUnstage(paths);
  }, [selectedPaths, staged, setGitStageCallback, requestGitUnstage, setGitStatusCallback, requestGitStatus]);

  const handleCommit = useCallback(() => {
    const msg = commitMessage.trim();
    if (!msg) return;

    Alert.alert('Commit Changes', `Commit ${staged.length} staged file(s)?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Commit',
        onPress: () => {
          setCommitting(true);
          const cb = (result: GitCommitResult) => {
            setCommitting(false);
            setGitCommitCallback(null);
            commitCallbackRef.current = null;
            if (result.error) {
              Alert.alert('Commit Failed', result.error);
            } else {
              setCommitMessage('');
              Alert.alert('Committed', `${result.hash?.slice(0, 7)} — ${result.message}`);
              // Re-fetch status
              setGitStatusCallback((r: GitStatusResult) => {
                if (!r.error) {
                  setBranch(r.branch);
                  setStaged(r.staged);
                  setUnstaged(r.unstaged);
                  setUntracked(r.untracked);
                }
                setGitStatusCallback(null);
              });
              requestGitStatus();
            }
          };
          commitCallbackRef.current = cb;
          setGitCommitCallback(cb);
          requestGitCommit(msg);
        },
      },
    ]);
  }, [commitMessage, staged.length, setGitCommitCallback, requestGitCommit, setGitStatusCallback, requestGitStatus]);

  const hasChanges = staged.length > 0 || unstaged.length > 0 || untracked.length > 0;
  const hasUnstagedSelected = Array.from(selectedPaths).some(
    (p) => unstaged.some((f) => f.path === p) || untracked.includes(p),
  );
  const hasStagedSelected = Array.from(selectedPaths).some(
    (p) => staged.some((f) => f.path === p),
  );

  const renderChangesTab = () => (
    <View style={styles.tabContent}>
      {/* Staged section */}
      {staged.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Staged ({staged.length})</Text>
          {staged.map((file) => (
            <FileStatusItem
              key={`staged-${file.path}`}
              file={file}
              isStaged={true}
              selected={selectedPaths.has(file.path)}
              onToggle={() => toggleSelection(file.path)}
            />
          ))}
        </View>
      )}

      {/* Unstaged section */}
      {unstaged.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Changes ({unstaged.length})</Text>
          {unstaged.map((file) => (
            <FileStatusItem
              key={`unstaged-${file.path}`}
              file={file}
              isStaged={false}
              selected={selectedPaths.has(file.path)}
              onToggle={() => toggleSelection(file.path)}
            />
          ))}
        </View>
      )}

      {/* Untracked section */}
      {untracked.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Untracked ({untracked.length})</Text>
          {untracked.map((path) => (
            <UntrackedItem
              key={`untracked-${path}`}
              path={path}
              selected={selectedPaths.has(path)}
              onToggle={() => toggleSelection(path)}
            />
          ))}
        </View>
      )}

      {!hasChanges && !loading && !error && (
        <View style={styles.emptyState}>
          <Icon name="check" size={32} color={COLORS.accentGreen} />
          <Text style={styles.emptyText}>Working tree clean</Text>
        </View>
      )}

      {/* Action bar */}
      {selectedPaths.size > 0 && (
        <View style={styles.actionBar}>
          {hasUnstagedSelected && (
            <TouchableOpacity style={styles.actionButton} onPress={handleStageSelected} accessibilityRole="button" accessibilityLabel="Stage selected files">
              <Icon name="plus" size={14} color={COLORS.accentGreen} />
              <Text style={styles.actionButtonText}>Stage</Text>
            </TouchableOpacity>
          )}
          {hasStagedSelected && (
            <TouchableOpacity style={styles.actionButton} onPress={handleUnstageSelected} accessibilityRole="button" accessibilityLabel="Unstage selected files">
              <Icon name="minus" size={14} color={COLORS.accentOrange} />
              <Text style={[styles.actionButtonText, { color: COLORS.accentOrange }]}>Unstage</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Commit form */}
      {staged.length > 0 && (
        <View style={styles.commitArea}>
          <TextInput
            style={styles.commitInput}
            placeholder="Commit message..."
            placeholderTextColor={COLORS.textDim}
            value={commitMessage}
            onChangeText={setCommitMessage}
            multiline
            maxLength={500}
            editable={!committing}
          />
          <TouchableOpacity
            style={[styles.commitButton, (!commitMessage.trim() || committing) && styles.commitButtonDisabled]}
            onPress={handleCommit}
            disabled={!commitMessage.trim() || committing}
            accessibilityRole="button"
            accessibilityLabel="Commit staged changes"
          >
            {committing ? (
              <ActivityIndicator size="small" color={COLORS.textPrimary} />
            ) : (
              <Text style={styles.commitButtonText}>Commit</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  const renderBranchesTab = () => {
    const local = branches.filter((b) => !b.isRemote);
    const remote = branches.filter((b) => b.isRemote);

    return (
      <View style={styles.tabContent}>
        {local.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Local ({local.length})</Text>
            {local.map((b) => (
              <View key={b.name} style={styles.branchItem}>
                {b.isCurrent && <Icon name="check" size={14} color={COLORS.accentGreen} />}
                <Text style={[styles.branchName, b.isCurrent && styles.branchNameCurrent]}>
                  {b.name}
                </Text>
              </View>
            ))}
          </View>
        )}
        {remote.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Remote ({remote.length})</Text>
            {remote.map((b) => (
              <View key={b.name} style={styles.branchItem}>
                <Text style={styles.branchNameRemote}>{b.name}</Text>
              </View>
            ))}
          </View>
        )}
        {branches.length === 0 && !loading && (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No branches found</Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Text style={styles.title}>Git</Text>
              {branch && (
                <View style={styles.branchBadge}>
                  <Icon name="gitBranch" size={12} color={COLORS.accentBlue} />
                  <Text style={styles.branchBadgeText}>{branch}</Text>
                </View>
              )}
            </View>
            <TouchableOpacity style={styles.closeButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close git view">
              <Icon name="close" size={20} color={COLORS.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Tabs */}
          <View style={styles.tabs}>
            <TouchableOpacity
              style={[styles.tab, activeTab === 'changes' && styles.tabActive]}
              onPress={() => setActiveTab('changes')}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === 'changes' }}
            >
              <Text style={[styles.tabText, activeTab === 'changes' && styles.tabTextActive]}>Changes</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, activeTab === 'branches' && styles.tabActive]}
              onPress={() => setActiveTab('branches')}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === 'branches' }}
            >
              <Text style={[styles.tabText, activeTab === 'branches' && styles.tabTextActive]}>Branches</Text>
            </TouchableOpacity>
          </View>

          {/* Content */}
          {loading && (
            <View style={styles.loadingState}>
              <ActivityIndicator size="large" color={COLORS.accentBlue} />
            </View>
          )}

          {error && (
            <View style={styles.errorState}>
              <Icon name="warning" size={24} color={COLORS.accentRed} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {!loading && !error && (
            <FlatList
              data={[null]}
              renderItem={() => activeTab === 'changes' ? renderChangesTab() : renderBranchesTab()}
              keyExtractor={() => activeTab}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.scrollContent}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: COLORS.backgroundPrimary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '85%',
    minHeight: '50%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  branchBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: COLORS.accentBlueLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  branchBadgeText: {
    fontSize: 13,
    color: COLORS.accentBlue,
    fontWeight: '500',
  },
  closeButton: {
    padding: 4,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabActive: {
    borderBottomWidth: 2,
    borderBottomColor: COLORS.accentBlue,
  },
  tabText: {
    fontSize: 14,
    color: COLORS.textMuted,
    fontWeight: '500',
  },
  tabTextActive: {
    color: COLORS.accentBlue,
  },
  scrollContent: {
    paddingBottom: 32,
  },
  tabContent: {
    padding: 16,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 6,
    minHeight: 44,
  },
  statusBadge: {
    width: 24,
    height: 24,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  fileNameContainer: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  fileDirPath: {
    fontSize: 13,
    color: COLORS.textDim,
  },
  fileName: {
    fontSize: 13,
    color: COLORS.textPrimary,
    fontWeight: '500',
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: COLORS.borderPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  checkboxSelected: {
    backgroundColor: COLORS.accentBlue,
    borderColor: COLORS.accentBlue,
  },
  actionBar: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderPrimary,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.accentGreenBorder,
    minHeight: 44,
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: COLORS.accentGreen,
  },
  commitArea: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderPrimary,
    paddingTop: 12,
    gap: 8,
  },
  commitInput: {
    backgroundColor: COLORS.backgroundCard,
    color: COLORS.textPrimary,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 60,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  commitButton: {
    backgroundColor: COLORS.accentGreen,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  commitButtonDisabled: {
    opacity: 0.5,
  },
  commitButtonText: {
    color: COLORS.textPrimary,
    fontWeight: '600',
    fontSize: 15,
  },
  branchItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 8,
    minHeight: 44,
  },
  branchName: {
    fontSize: 14,
    color: COLORS.textPrimary,
  },
  branchNameCurrent: {
    fontWeight: '600',
    color: COLORS.accentGreen,
  },
  branchNameRemote: {
    fontSize: 14,
    color: COLORS.textDim,
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
  },
  errorState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  errorText: {
    color: COLORS.accentRed,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
  emptyText: {
    color: COLORS.textSecondary,
    fontSize: 15,
    fontWeight: '500',
  },
});

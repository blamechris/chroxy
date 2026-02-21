import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  Modal,
  ScrollView,
  Platform,
} from 'react-native';
import { useConnectionStore, DiffResult, DiffFile, DiffHunk } from '../store/connection';
import { COLORS } from '../constants/colors';
import { ICON_CLOSE, ICON_DIFF } from '../constants/icons';

/** Status badge color mapping */
function statusColor(status: DiffFile['status']): string {
  switch (status) {
    case 'added': return COLORS.accentGreen;
    case 'deleted': return COLORS.accentRed;
    case 'renamed': return COLORS.accentBlue;
    default: return COLORS.accentOrange;
  }
}

/** Status label */
function statusLabel(status: DiffFile['status']): string {
  switch (status) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    default: return 'M';
  }
}

/** Render a single diff hunk */
function DiffHunkView({ hunk }: { hunk: DiffHunk }) {
  return (
    <View style={styles.hunk}>
      <Text style={styles.hunkHeader} selectable>{hunk.header}</Text>
      {hunk.lines.map((line, i) => {
        const lineStyle =
          line.type === 'addition' ? styles.lineAdded :
          line.type === 'deletion' ? styles.lineRemoved :
          styles.lineContext;
        const prefix =
          line.type === 'addition' ? '+' :
          line.type === 'deletion' ? '-' :
          ' ';
        return (
          <Text key={i} style={lineStyle} selectable>
            <Text style={styles.linePrefix}>{prefix}</Text>
            {line.content}
          </Text>
        );
      })}
    </View>
  );
}

/** File diff detail view */
function FileDiffView({
  file,
  onBack,
}: {
  file: DiffFile;
  onBack: () => void;
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
              <DiffHunkView key={i} hunk={hunk} />
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

  const setDiffCallback = useConnectionStore((s) => s.setDiffCallback);
  const requestDiff = useConnectionStore((s) => s.requestDiff);

  const requestIdRef = useRef(0);
  const activeRequestRef = useRef(0);

  useEffect(() => {
    if (!visible) return;

    setFiles([]);
    setLoading(true);
    setError(null);
    setSelectedFile(null);

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

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.modalContainer}>
        {/* Header */}
        <View style={styles.modalHeader}>
          <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
            <Text style={styles.closeText}>{ICON_CLOSE}</Text>
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
          <FileDiffView file={selectedFile} onBack={handleBack} />
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
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.fileEntry}
                    onPress={() => setSelectedFile(item)}
                  >
                    <View style={[styles.statusBadge, { backgroundColor: statusColor(item.status) + '33' }]}>
                      <Text style={[styles.statusText, { color: statusColor(item.status) }]}>
                        {statusLabel(item.status)}
                      </Text>
                    </View>
                    <Text style={styles.fileEntryName} numberOfLines={1}>{item.path}</Text>
                    <Text style={styles.fileEntryStat}>
                      <Text style={styles.additionsStat}>+{item.additions}</Text>
                      {'  '}
                      <Text style={styles.deletionsStat}>-{item.deletions}</Text>
                    </Text>
                  </TouchableOpacity>
                )}
              />
            )}
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
    backgroundColor: '#1a2e1a',
  },
  lineRemoved: {
    color: COLORS.accentRed,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 18,
    paddingHorizontal: 4,
    backgroundColor: '#2e1a1a',
  },
  linePrefix: {
    fontWeight: '700',
  },
});

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnectionStore, FileListing, FileContent } from '../store/connection';
import { COLORS } from '../constants/colors';
import { Icon } from './Icon';
import { tokenize, SYNTAX_COLORS } from '../utils/syntax';
import type { Token } from '../utils/syntax';

/** Format bytes into human-readable size */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render syntax-highlighted code as Text elements */
const SyntaxHighlightedCode = React.memo(({ content, language }: { content: string; language: string | null }) => {
  const lang = language || '';
  const tokens = useMemo(() => tokenize(content, lang), [content, lang]);

  return (
    <Text style={styles.codeText} selectable>
      {tokens.map((token, i) => (
        <Text key={i} style={{ color: SYNTAX_COLORS[token.type] }}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
});
SyntaxHighlightedCode.displayName = 'SyntaxHighlightedCode';

/** Modal for viewing file content with syntax highlighting */
function FileViewerModal({
  visible,
  filePath,
  onClose,
}: {
  visible: boolean;
  filePath: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [content, setContent] = useState<string | null>(null);
  const [language, setLanguage] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setFileContentCallback = useConnectionStore((s) => s.setFileContentCallback);
  const requestFileContent = useConnectionStore((s) => s.requestFileContent);

  const requestIdRef = useRef(0);
  const activeRequestRef = useRef(0);

  useEffect(() => {
    if (!visible || !filePath) return;

    setContent(null);
    setLanguage(null);
    setFileSize(null);
    setTruncated(false);
    setLoading(true);
    setError(null);

    const handleContent = (fc: FileContent) => {
      if (activeRequestRef.current !== requestIdRef.current) return;
      activeRequestRef.current = -1;
      setLoading(false);
      if (fc.error) {
        setError(fc.error);
        if (fc.size != null) setFileSize(fc.size);
        return;
      }
      setContent(fc.content);
      setLanguage(fc.language);
      setFileSize(fc.size);
      setTruncated(fc.truncated);
      setError(null);
    };

    setFileContentCallback(handleContent);

    const id = ++requestIdRef.current;
    activeRequestRef.current = id;
    requestFileContent(filePath);

    const timer = setTimeout(() => {
      if (activeRequestRef.current === id) {
        activeRequestRef.current = -1;
        setLoading(false);
        setError('Request timed out');
      }
    }, 8000);

    return () => {
      clearTimeout(timer);
      setFileContentCallback(null);
    };
  }, [visible, filePath, setFileContentCallback, requestFileContent]);

  if (!visible) return null;

  const fileName = filePath ? filePath.split('/').pop() || filePath : '';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.viewerContainer}>
        <View style={[styles.viewerHeader, { paddingTop: insets.top + 12 }]}>
          <TouchableOpacity style={styles.viewerCloseButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close file viewer">
            <Icon name="close" size={18} color={COLORS.textPrimary} />
          </TouchableOpacity>
          <View style={styles.viewerHeaderInfo}>
            <Text style={styles.viewerFileName} numberOfLines={1}>{fileName}</Text>
            {fileSize != null && (
              <Text style={styles.viewerFileSize}>{formatSize(fileSize)}</Text>
            )}
          </View>
        </View>

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
        {!loading && !error && content != null && (
          <ScrollView
            style={styles.viewerScroll}
            contentContainerStyle={styles.viewerScrollContent}
            horizontal={false}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <SyntaxHighlightedCode content={content} language={language} />
            </ScrollView>
            {truncated && (
              <Text style={styles.truncatedText}>File truncated at 100KB</Text>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

export function FileBrowser() {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; isDirectory: boolean; size: number | null }[]>([]);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // File viewer state
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [viewerVisible, setViewerVisible] = useState(false);

  const setFileBrowserCallback = useConnectionStore((s) => s.setFileBrowserCallback);
  const requestFileListing = useConnectionStore((s) => s.requestFileListing);
  const sessionCwd = useConnectionStore((s) => s.sessionCwd);

  const requestIdRef = useRef(0);
  const activeRequestRef = useRef(0);

  // Register callback on mount
  useEffect(() => {
    const handleListing = (listing: FileListing) => {
      if (activeRequestRef.current !== requestIdRef.current) return;
      activeRequestRef.current = -1;
      setLoading(false);
      if (listing.error) {
        setError(listing.error);
        setEntries([]);
        if (listing.path) setResolvedPath(listing.path);
        setParentPath(null);
        return;
      }
      setResolvedPath(listing.path);
      setParentPath(listing.parentPath);
      setEntries(listing.entries);
      setError(null);
    };

    setFileBrowserCallback(handleListing);
    return () => {
      setFileBrowserCallback(null);
    };
  }, [setFileBrowserCallback]);

  // Request listing whenever currentPath changes
  useEffect(() => {
    const id = ++requestIdRef.current;
    activeRequestRef.current = id;
    setLoading(true);
    setError(null);
    requestFileListing(currentPath || undefined);

    const timer = setTimeout(() => {
      if (activeRequestRef.current === id) {
        activeRequestRef.current = -1;
        setLoading(false);
        setError('Request timed out');
        setEntries([]);
        setParentPath(null);
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [currentPath, requestFileListing]);

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  const navigateUp = useCallback(() => {
    if (parentPath) {
      setCurrentPath(parentPath);
    }
  }, [parentPath]);

  const openFile = useCallback((path: string) => {
    setViewerPath(path);
    setViewerVisible(true);
  }, []);

  const closeViewer = useCallback(() => {
    setViewerVisible(false);
    setViewerPath(null);
  }, []);

  // Display path relative to CWD
  const displayPath = resolvedPath || currentPath || sessionCwd || '';
  const cwdPrefix = sessionCwd || '';
  let relativePath = displayPath;
  if (cwdPrefix && displayPath.startsWith(cwdPrefix)) {
    relativePath = displayPath.slice(cwdPrefix.length);
    if (relativePath.startsWith('/')) relativePath = relativePath.slice(1);
    if (!relativePath) relativePath = '.';
  }

  return (
    <View style={styles.container}>
      {/* Header with back button and relative path */}
      <View style={styles.header}>
        <TouchableOpacity
          style={[styles.backButton, !parentPath && styles.backButtonDisabled]}
          onPress={navigateUp}
          disabled={!parentPath}
        >
          <Text style={[styles.backButtonText, !parentPath && styles.backButtonTextDisabled]}>
            {'< Back'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.pathText} numberOfLines={1}>{relativePath}</Text>
      </View>

      {/* Content area */}
      <View style={styles.content}>
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
        {!loading && !error && entries.length === 0 && (
          <View style={styles.centerContent}>
            <Text style={styles.emptyText}>Empty directory</Text>
          </View>
        )}
        {!loading && !error && entries.length > 0 && (
          <FlatList
            data={entries}
            keyExtractor={(item) => item.name}
            renderItem={({ item }) => {
              const fullPath = resolvedPath ? `${resolvedPath}/${item.name}` : item.name;
              return (
                <TouchableOpacity
                  style={styles.entry}
                  onPress={() => item.isDirectory ? navigateTo(fullPath) : openFile(fullPath)}
                >
                  {item.isDirectory ? <Icon name="folderOpen" size={16} color={COLORS.textMuted} /> : <Icon name="document" size={16} color={COLORS.textMuted} />}
                  <Text style={styles.entryName} numberOfLines={1}>{item.name}</Text>
                  {item.isDirectory ? (
                    <Text style={styles.entryChevron}>{'>'}</Text>
                  ) : (
                    item.size != null && (
                      <Text style={styles.entrySize}>{formatSize(item.size)}</Text>
                    )
                  )}
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>

      <FileViewerModal
        visible={viewerVisible}
        filePath={viewerPath}
        onClose={closeViewer}
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
  backButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingRight: 8,
  },
  backButtonDisabled: {
    opacity: 0.3,
  },
  backButtonText: {
    color: COLORS.accentBlue,
    fontSize: 15,
    fontWeight: '600',
  },
  backButtonTextDisabled: {
    color: COLORS.textDisabled,
  },
  pathText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 13,
    textAlign: 'right',
  },
  content: {
    flex: 1,
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
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderPrimary,
  },
  entryIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  entryName: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: 15,
  },
  entryChevron: {
    color: COLORS.textDisabled,
    fontSize: 16,
    marginLeft: 8,
  },
  entrySize: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginLeft: 8,
  },
  // File viewer modal styles
  viewerContainer: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
    backgroundColor: COLORS.backgroundSecondary,
  },
  viewerCloseButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerCloseText: {
    color: COLORS.accentBlue,
    fontSize: 18,
  },
  viewerHeaderInfo: {
    flex: 1,
    marginLeft: 8,
  },
  viewerFileName: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  viewerFileSize: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  viewerScroll: {
    flex: 1,
  },
  viewerScrollContent: {
    padding: 12,
  },
  codeText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 18,
    color: COLORS.syntaxPlain,
  },
  truncatedText: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 12,
    paddingBottom: 20,
  },
});

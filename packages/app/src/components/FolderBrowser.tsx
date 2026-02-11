import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useConnectionStore, DirectoryListing } from '../store/connection';
import { COLORS } from '../constants/colors';

interface FolderBrowserProps {
  visible: boolean;
  initialPath?: string;
  onSelectPath: (path: string) => void;
  onClose: () => void;
}

export function FolderBrowser({ visible, initialPath, onSelectPath, onClose }: FolderBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || '~');
  const [entries, setEntries] = useState<{ name: string; isDirectory: boolean }[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [resolvedPath, setResolvedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setDirectoryListingCallback = useConnectionStore((s) => s.setDirectoryListingCallback);
  const requestDirectoryListing = useConnectionStore((s) => s.requestDirectoryListing);

  // Monotonic request counter to discard stale responses
  const requestIdRef = useRef(0);
  const activeRequestRef = useRef(0);

  // Reset state when becoming visible
  useEffect(() => {
    if (visible) {
      const path = initialPath || '~';
      setCurrentPath(path);
      setEntries([]);
      setParentPath(null);
      setResolvedPath(null);
      setLoading(true);
      setError(null);
    }
  }, [visible, initialPath]);

  // Register callback on mount, clear on unmount
  useEffect(() => {
    if (!visible) return;

    const handleListing = (listing: DirectoryListing) => {
      // Ignore stale responses: only accept if no newer request has been issued
      if (activeRequestRef.current !== requestIdRef.current) return;
      activeRequestRef.current = -1; // consumed
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

    setDirectoryListingCallback(handleListing);
    return () => {
      setDirectoryListingCallback(null);
    };
  }, [visible, setDirectoryListingCallback]);

  // Request listing whenever currentPath changes
  useEffect(() => {
    if (!visible) return;
    const id = ++requestIdRef.current;
    activeRequestRef.current = id;
    setLoading(true);
    setError(null);
    requestDirectoryListing(currentPath);
  }, [visible, currentPath, requestDirectoryListing]);

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  const navigateUp = useCallback(() => {
    if (parentPath) {
      setCurrentPath(parentPath);
    }
  }, [parentPath]);

  const handleSelect = useCallback(() => {
    onSelectPath(resolvedPath || currentPath);
  }, [resolvedPath, currentPath, onSelectPath]);

  // Truncate display path for the header
  const displayPath = resolvedPath || currentPath;
  const truncatedPath = displayPath.length > 30
    ? '...' + displayPath.slice(-27)
    : displayPath;

  if (!visible) return null;

  return (
    <View style={styles.container}>
      {/* Header with back button and current path */}
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
        <Text style={styles.pathText} numberOfLines={1}>{truncatedPath}</Text>
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
            <Text style={styles.emptyText}>No subdirectories</Text>
          </View>
        )}
        {!loading && !error && entries.length > 0 && (
          <FlatList
            data={entries}
            keyExtractor={(item) => item.name}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.entry}
                onPress={() => navigateTo(resolvedPath ? `${resolvedPath}/${item.name}` : `${currentPath}/${item.name}`)}
              >
                <Text style={styles.entryIcon}>{'📁'}</Text>
                <Text style={styles.entryName} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.entryChevron}>{'>'}</Text>
              </TouchableOpacity>
            )}
          />
        )}
      </View>

      {/* Footer with Cancel and Select buttons */}
      <View style={styles.footer}>
        <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.selectButton, loading && styles.selectButtonDisabled]}
          onPress={handleSelect}
          disabled={loading}
        >
          <Text style={styles.selectButtonText}>Select This</Text>
        </TouchableOpacity>
      </View>
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
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderPrimary,
    marginBottom: 8,
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
    minHeight: 200,
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
    paddingHorizontal: 8,
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
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderPrimary,
    marginTop: 8,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: COLORS.backgroundCard,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  cancelButtonText: {
    color: COLORS.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
  selectButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: COLORS.accentBlue,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  selectButtonDisabled: {
    opacity: 0.5,
  },
  selectButtonText: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
});

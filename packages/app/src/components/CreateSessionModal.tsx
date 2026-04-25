import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Switch,
  Modal,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useConnectionStore } from '../store/connection';
import { FolderBrowser } from './FolderBrowser';
import { COLORS } from '../constants/colors';
import { getProviderLabel } from '../constants/providers';

const PROVIDERS_TIMEOUT_MS = 5000;

interface CreateSessionModalProps {
  visible: boolean;
  onClose: () => void;
}

// '' means "use server default provider"; always shown as the first chip.
const DEFAULT_PROVIDER_CHIP = { id: '', label: 'Default' };

export function CreateSessionModal({ visible, onClose }: CreateSessionModalProps) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [provider, setProvider] = useState('');
  const createSession = useConnectionStore((s) => s.createSession);
  const sessions = useConnectionStore((s) => s.sessions);
  const availableProviders = useConnectionStore((s) => s.availableProviders);
  const fetchProviders = useConnectionStore((s) => s.fetchProviders);
  const [showBrowser, setShowBrowser] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersTimedOut, setProvidersTimedOut] = useState(false);
  const providersTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startProvidersTimeout = () => {
    if (providersTimeoutRef.current) {
      clearTimeout(providersTimeoutRef.current);
    }
    setProvidersLoading(true);
    setProvidersTimedOut(false);
    providersTimeoutRef.current = setTimeout(() => {
      setProvidersLoading(false);
      setProvidersTimedOut(true);
    }, PROVIDERS_TIMEOUT_MS);
  };

  const handleRetryProviders = () => {
    fetchProviders();
    startProvidersTimeout();
  };

  // Reset state when modal opens and refresh provider list from server.
  useEffect(() => {
    if (visible) {
      setShowBrowser(false);
      setWorktree(false);
      setProvider('');
      fetchProviders();
      startProvidersTimeout();
    } else {
      // Clean up timeout when modal closes
      if (providersTimeoutRef.current) {
        clearTimeout(providersTimeoutRef.current);
        providersTimeoutRef.current = null;
      }
      setProvidersLoading(false);
      setProvidersTimedOut(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, fetchProviders]);

  // Cancel timeout once providers have loaded; also clears timed-out state if
  // providers arrive late (after the timeout already fired).
  useEffect(() => {
    if (availableProviders.length > 0) {
      if (providersTimeoutRef.current) {
        clearTimeout(providersTimeoutRef.current);
        providersTimeoutRef.current = null;
      }
      setProvidersLoading(false);
      setProvidersTimedOut(false);
    }
  }, [availableProviders.length]);

  const providerChips = [
    DEFAULT_PROVIDER_CHIP,
    ...availableProviders.map((p) => ({
      id: p.name,
      label: getProviderLabel(p.name),
    })),
  ];

  const handleCreate = () => {
    const sessionName = name.trim() || `Session ${sessions.length + 1}`;
    const sessionCwd = cwd.trim() || undefined;
    createSession(sessionName, sessionCwd, worktree || undefined, provider || undefined);
    setName('');
    setCwd('');
    setWorktree(false);
    setProvider('');
    onClose();
  };

  const handleCancel = () => {
    setName('');
    setCwd('');
    setWorktree(false);
    setProvider('');
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleCancel}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {showBrowser ? (
          <View style={styles.modal}>
            <Text style={styles.title}>Select Directory</Text>
            <FolderBrowser
              visible={showBrowser}
              initialPath={cwd || '~'}
              onSelectPath={(path) => {
                setCwd(path);
                setShowBrowser(false);
              }}
              onClose={() => setShowBrowser(false)}
            />
          </View>
        ) : (
        <ScrollView contentContainerStyle={styles.scrollContent} bounces={false}>
          <View style={styles.modal}>
            <Text style={styles.title}>New Session</Text>

            <Text style={styles.label}>Session Name</Text>
            <TextInput
              style={styles.input}
              placeholder={`Session ${sessions.length + 1}`}
              placeholderTextColor="#555"
              value={name}
              onChangeText={setName}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />

            <Text style={styles.label}>Working Directory</Text>
            <View style={styles.cwdRow}>
              <TextInput
                style={[styles.input, styles.cwdInput]}
                placeholder="Server default"
                placeholderTextColor="#555"
                value={cwd}
                onChangeText={setCwd}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity style={styles.browseButton} onPress={() => setShowBrowser(true)}>
                <Text style={styles.browseButtonText}>Browse</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.hint}>Leave empty to use the server's default directory</Text>

            <View style={styles.toggleRow}>
              <View style={styles.toggleLabel}>
                <Text style={styles.label}>Isolate filesystem (git worktree)</Text>
                <Text style={styles.toggleHint}>
                  {worktree
                    ? 'CWD must point to an existing git repository'
                    : 'Runs in a separate worktree — requires a git repo CWD'}
                </Text>
              </View>
              <Switch
                value={worktree}
                onValueChange={setWorktree}
                disabled={!cwd.trim()}
                trackColor={{ false: COLORS.borderPrimary, true: COLORS.accentBlue }}
                thumbColor={COLORS.textPrimary}
                accessibilityLabel="Isolate filesystem in a git worktree"
                accessibilityHint="When enabled, the session runs in an isolated git worktree"
              />
            </View>

            <Text style={styles.label}>Provider</Text>
            <View style={styles.providerRow}>
              {providerChips.map((p) => (
                <TouchableOpacity
                  key={p.id || '__default__'}
                  style={[styles.providerChip, provider === p.id && styles.providerChipActive]}
                  onPress={() => setProvider(p.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Provider: ${p.label}`}
                  accessibilityState={{ selected: provider === p.id }}
                >
                  <Text style={[styles.providerChipText, provider === p.id && styles.providerChipTextActive]}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
              {availableProviders.length === 0 && providersLoading && (
                <Text style={styles.providerHint}>Loading providers…</Text>
              )}
              {availableProviders.length === 0 && providersTimedOut && (
                <View style={styles.providersEmptyRow}>
                  <Text style={styles.providerHint}>No additional providers available</Text>
                  <TouchableOpacity
                    onPress={handleRetryProviders}
                    accessibilityLabel="Retry loading providers"
                    accessibilityRole="button"
                  >
                    <Text style={styles.retryText}>Retry</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>

            <View style={styles.buttons}>
              <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.createButton} onPress={handleCreate}>
                <Text style={styles.createButtonText}>Create</Text>
              </TouchableOpacity>
            </View>

          </View>
        </ScrollView>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modal: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  label: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  input: {
    backgroundColor: COLORS.backgroundInput,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: COLORS.textPrimary,
    fontSize: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  cwdRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
  },
  cwdInput: {
    flex: 1,
  },
  browseButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: COLORS.backgroundCard,
    borderWidth: 1,
    borderColor: COLORS.borderSecondary,
    minHeight: 44,
    justifyContent: 'center',
  },
  browseButtonText: {
    color: COLORS.accentBlue,
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    color: COLORS.textDisabled,
    fontSize: 12,
    marginTop: -8,
    marginBottom: 16,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 12,
  },
  toggleLabel: {
    flex: 1,
  },
  toggleHint: {
    color: COLORS.textDisabled,
    fontSize: 11,
    marginTop: 2,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: COLORS.backgroundCard,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: COLORS.textMuted,
    fontSize: 15,
    fontWeight: '600',
  },
  providerRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  providerChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: COLORS.backgroundInput,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  providerChipActive: {
    backgroundColor: COLORS.accentBlue,
    borderColor: COLORS.accentBlue,
  },
  providerChipText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  providerChipTextActive: {
    color: COLORS.textPrimary,
  },
  providerHint: {
    color: COLORS.textDisabled,
    fontSize: 12,
    paddingVertical: 8,
  },
  providersEmptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  retryText: {
    color: COLORS.accentBlue,
    fontSize: 12,
    fontWeight: '600',
    paddingVertical: 8,
  },
  createButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: COLORS.accentBlue,
    alignItems: 'center',
  },
  createButtonText: {
    color: COLORS.textPrimary,
    fontSize: 15,
    fontWeight: '600',
  },
});

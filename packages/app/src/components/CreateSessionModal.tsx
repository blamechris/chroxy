import React, { useState, useEffect, useRef, useCallback } from 'react';
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
import { buildProviderLimitationNote } from '@chroxy/store-core';
import {
  DEFAULT_PROVIDER,
  CODEX_PROVIDER,
  CODEX_DEFAULT_SANDBOX,
  CODEX_SANDBOX_MODE_META,
  type CodexSandboxMode,
} from '@chroxy/protocol';

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
  // #6689 — per-session Codex sandbox mode; defaults to workspace-write and is
  // only surfaced/forwarded for the codex provider.
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxMode>(CODEX_DEFAULT_SANDBOX);
  const createSession = useConnectionStore((s) => s.createSession);
  const sessions = useConnectionStore((s) => s.sessions);
  const availableProviders = useConnectionStore((s) => s.availableProviders);
  const fetchProviders = useConnectionStore((s) => s.fetchProviders);
  const [showBrowser, setShowBrowser] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersTimedOut, setProvidersTimedOut] = useState(false);
  const providersTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startProvidersTimeout = useCallback(() => {
    if (providersTimeoutRef.current) {
      clearTimeout(providersTimeoutRef.current);
    }
    setProvidersLoading(true);
    setProvidersTimedOut(false);
    providersTimeoutRef.current = setTimeout(() => {
      setProvidersLoading(false);
      setProvidersTimedOut(true);
    }, PROVIDERS_TIMEOUT_MS);
  }, []);

  const handleRetryProviders = useCallback(() => {
    fetchProviders();
    startProvidersTimeout();
  }, [fetchProviders, startProvidersTimeout]);

  // Reset state when modal opens and refresh provider list from server.
  // Cancel timeout and clear loading state when modal closes or on unmount.
  useEffect(() => {
    if (visible) {
      setShowBrowser(false);
      setWorktree(false);
      setProvider('');
      setCodexSandbox(CODEX_DEFAULT_SANDBOX);
      fetchProviders();
      startProvidersTimeout();
    } else {
      if (providersTimeoutRef.current) {
        clearTimeout(providersTimeoutRef.current);
        providersTimeoutRef.current = null;
      }
      setProvidersLoading(false);
      setProvidersTimedOut(false);
    }
    return () => {
      // Unmount cleanup — prevent setState on unmounted component
      if (providersTimeoutRef.current) {
        clearTimeout(providersTimeoutRef.current);
        providersTimeoutRef.current = null;
      }
    };
  }, [visible, fetchProviders, startProvidersTimeout]);

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

  // #6689 — reset the codex sandbox to the default on every provider change so
  // a stale (e.g. danger-full-access) selection can't survive a provider
  // round-trip and silently apply to a fresh codex session.
  useEffect(() => {
    setCodexSandbox(CODEX_DEFAULT_SANDBOX);
  }, [provider]);

  const providerChips = [
    { ...DEFAULT_PROVIDER_CHIP, ready: true, detail: '' },
    ...availableProviders.map((p) => ({
      id: p.name,
      label: getProviderLabel(p.name),
      // #3404 audit F5: ready=false providers stay visible but get disabled
      // styling. Default to true so older servers without an `auth` field
      // continue to work as before.
      ready: p.auth?.ready !== false,
      // #3404 audit F6: surface the server's billing-identity detail so
      // mobile users see what wallet the chip will charge.
      detail: p.auth?.detail ?? '',
    })),
  ];

  const selectedProviderDetail = providerChips.find((p) => p.id === provider)?.detail ?? '';

  // #6312 / #6352 — mobile parity with the dashboard's session-creation limitation
  // note. When the selected provider reports a capability as `false` (notably the
  // default claude-tui: no plan mode / streaming / model switch), surface a concise
  // non-blocking note rather than leaving the user to infer the gap from an absent
  // control. The empty `provider` chip means "server default", so resolve it to
  // DEFAULT_PROVIDER for the capability lookup.
  const selectedProviderCaps = availableProviders.find(
    (p) => p.name === (provider || DEFAULT_PROVIDER),
  )?.capabilities;
  const providerLimitationNote = buildProviderLimitationNote(selectedProviderCaps);

  const handleCreate = () => {
    const sessionName = name.trim() || `Session ${sessions.length + 1}`;
    const sessionCwd = cwd.trim() || undefined;
    createSession({
      name: sessionName,
      cwd: sessionCwd,
      worktree: worktree || undefined,
      provider: provider || undefined,
      // #6689 — only forward the sandbox mode for codex; other providers ignore it.
      codexSandbox: provider === CODEX_PROVIDER ? codexSandbox : undefined,
    });
    setName('');
    setCwd('');
    setWorktree(false);
    setProvider('');
    setCodexSandbox(CODEX_DEFAULT_SANDBOX);
    onClose();
  };

  const handleCancel = () => {
    setName('');
    setCwd('');
    setWorktree(false);
    setProvider('');
    setCodexSandbox(CODEX_DEFAULT_SANDBOX);
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
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          bounces={false}
          keyboardShouldPersistTaps="handled"
        >
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
                  style={[
                    styles.providerChip,
                    provider === p.id && styles.providerChipActive,
                    !p.ready && styles.providerChipDisabled,
                  ]}
                  onPress={() => p.ready && setProvider(p.id)}
                  disabled={!p.ready}
                  accessibilityRole="button"
                  accessibilityLabel={`Provider: ${p.label}${p.ready ? '' : ' (credentials missing)'}`}
                  accessibilityState={{ selected: provider === p.id, disabled: !p.ready }}
                >
                  <Text style={[
                    styles.providerChipText,
                    provider === p.id && styles.providerChipTextActive,
                    !p.ready && styles.providerChipTextDisabled,
                  ]}>
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
            {/* #3404 audit F6: billing-identity detail under the chip row so
                mobile users see what wallet they're picking. */}
            {selectedProviderDetail ? (
              <Text
                style={styles.providerBillingHint}
                accessibilityLabel={`Billing: ${selectedProviderDetail}`}
              >
                {selectedProviderDetail}
              </Text>
            ) : null}

            {/* #6312 / #6352 — non-blocking capability-limitation note for a
                reduced-capability provider (notably claude-tui). Additive copy
                explaining the absent affordances; behaviour is unchanged. */}
            {providerLimitationNote ? (
              <Text style={styles.providerLimitationNote} testID="provider-limitation-note">
                {providerLimitationNote}
              </Text>
            ) : null}

            {/* #6689 — Codex-only sandbox selector. Codex applies the sandbox at
                thread start, so this is a create-time choice. Hidden for every
                non-codex provider (they ignore the field). Options + labels are
                single-sourced from CODEX_SANDBOX_MODE_META. */}
            {provider === CODEX_PROVIDER ? (
              <View testID="codex-sandbox-field">
                <Text style={styles.label}>Codex sandbox</Text>
                <View style={styles.providerRow}>
                  {CODEX_SANDBOX_MODE_META.map((m) => (
                    <TouchableOpacity
                      key={m.id}
                      testID={`codex-sandbox-chip-${m.id}`}
                      style={[
                        styles.providerChip,
                        codexSandbox === m.id && styles.providerChipActive,
                      ]}
                      onPress={() => setCodexSandbox(m.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Codex sandbox: ${m.label}`}
                      accessibilityState={{ selected: codexSandbox === m.id }}
                    >
                      <Text style={[
                        styles.providerChipText,
                        codexSandbox === m.id && styles.providerChipTextActive,
                      ]}>
                        {m.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.toggleHint} testID="codex-sandbox-hint">
                  {CODEX_SANDBOX_MODE_META.find((m) => m.id === codexSandbox)?.description
                    ?? 'Controls how much of the filesystem the Codex sandbox may write.'}
                </Text>
              </View>
            ) : null}

            <View style={styles.buttons}>
              <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.createButton}
                onPress={handleCreate}
                accessibilityRole="button"
                accessibilityLabel="Create session"
              >
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
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    // Centering lives here (not on the overlay) so when the keyboard pops up
    // and content overflows, the ScrollView can actually scroll instead of
    // letting the centered modal clip off the top of the screen on Android.
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
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
  providerChipDisabled: {
    // #3676: Opacity is the disabled signal. RN's `borderStyle: 'dashed'`
    // silently falls back to solid on Android whenever borderRadius != 0
    // (chip uses borderRadius: 10), so we don't bother with it — opacity is
    // the cross-platform indicator and the accessibility label already says
    // "(credentials missing)" for screen readers.
    opacity: 0.5,
  },
  providerChipTextDisabled: {
    color: COLORS.textDisabled,
  },
  providerHint: {
    color: COLORS.textDisabled,
    fontSize: 12,
    paddingVertical: 8,
  },
  providerBillingHint: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: -8,
    marginBottom: 16,
    fontStyle: 'italic',
  },
  // #6312 / #6352 — capability-limitation note; subtle, sits under the provider row.
  providerLimitationNote: {
    color: COLORS.textMuted,
    fontSize: 12,
    marginTop: -8,
    marginBottom: 16,
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

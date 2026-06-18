import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Switch,
  TouchableOpacity,
  TextInput,
  Alert,
  Modal,
  Pressable,
  Platform,
  AccessibilityInfo,
} from 'react-native';
import { COLORS } from '../../constants/colors';
import { buildQuietHoursTimezoneList } from '@chroxy/store-core';
import { styles } from './styles';
import {
  NOTIFICATION_CATEGORY_LABELS,
  NOTIFICATION_CATEGORY_ORDER,
  isValidHHMM,
} from './constants';

/**
 * #4544: mobile quiet-hours editor.
 *
 * Mirrors the dashboard `QuietHoursEditor` shape: enable toggle, HH:MM
 * inputs for start/end, timezone picker (modal), and a per-category bypass
 * list. Owns draft state so partial edits don't round-trip every keystroke;
 * `Save` commits the window in one WS message. Bypass toggles patch
 * immediately because they're booleans without an intermediate form
 * stage.
 */
export function QuietHoursEditor(props: {
  window: { start: string; end: string; timezone: string } | null;
  categories: Record<string, boolean>;
  bypassCategories: string[];
  onWindowChange: (w: { start: string; end: string; timezone: string } | null) => void;
  onBypassChange: (categories: string[]) => void;
}) {
  const { window: win, categories, bypassCategories, onWindowChange, onBypassChange } = props;
  // Resolve the device's IANA timezone once. `Intl.DateTimeFormat` is
  // available in modern Hermes / JSC — the try/catch covers an extremely
  // old runtime gracefully.
  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
  }, []);
  const tzOptions = useMemo(() => buildQuietHoursTimezoneList(browserTz), [browserTz]);

  const [enabled, setEnabled] = useState<boolean>(win != null);
  const [start, setStart] = useState<string>(win?.start ?? '22:00');
  const [end, setEnd] = useState<string>(win?.end ?? '07:00');
  const [timezone, setTimezone] = useState<string>(win?.timezone ?? browserTz);
  const [showTzPicker, setShowTzPicker] = useState(false);

  // #4570: track "user has typed but not saved" so an incoming snapshot
  // broadcast doesn't clobber the in-flight draft. Cleared on save / disable
  // / explicit accept. Read via ref inside the snapshot effect so the
  // dependency array stays minimal (adding `dirty` would re-run the effect
  // when dirty changes and re-apply the snapshot we just skipped).
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(dirty);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  // #4570: parked snapshot when a broadcast arrives mid-edit. `undefined`
  // means no pending conflict; `null` means "remote disabled"; an object
  // means "remote changed window".
  const [pendingSnapshot, setPendingSnapshot] = useState<
    | { start: string; end: string; timezone: string }
    | null
    | undefined
  >(undefined);

  // #4595: VoiceOver fallback for the conflict banner on iOS.
  // #4594 (the original a11y wiring) set `accessibilityLiveRegion="polite"`
  // on the banner View, which is what Android TalkBack uses to auto-announce
  // a region as it mounts. The prop is Android-only — iOS VoiceOver does
  // NOT auto-announce live regions; it only speaks when focus moves to the
  // View. A user editing the field via VoiceOver would never hear about the
  // divergent snapshot. AccessibilityInfo.announceForAccessibility is the
  // iOS equivalent of the live-region announce. We gate on Platform.OS so
  // Android (which already gets the announcement via the live-region prop)
  // doesn't double-speak the same line. The effect fires on every mount of
  // a new pending conflict (`pendingSnapshot !== undefined` transition);
  // resolving the conflict (banner unmounts) does not re-announce.
  useEffect(() => {
    if (pendingSnapshot !== undefined && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(
        'Another client updated quiet hours. Keep your edits, or discard and load the latest values.',
      );
    }
  }, [pendingSnapshot]);

  // Re-sync draft when the snapshot changes (remote save, broadcast).
  //
  // #4570: skip the apply when the editor is dirty AND the incoming
  // snapshot diverges from the local draft. Park the snapshot so the user
  // can resolve it via the conflict banner instead of losing their typing.
  useEffect(() => {
    const isDirty = dirtyRef.current;
    const matchesDraft = win
      ? (win.start === start && win.end === end && win.timezone === timezone && enabled)
      : !enabled;
    if (isDirty && !matchesDraft) {
      setPendingSnapshot(win);
      return;
    }
    setEnabled(win != null);
    if (win) {
      setStart(win.start);
      setEnd(win.end);
      setTimezone(win.timezone);
    }
    setPendingSnapshot(undefined);
    setDirty(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win]);

  const handleToggleEnable = useCallback((next: boolean) => {
    setEnabled(next);
    setDirty(false);
    setPendingSnapshot(undefined);
    if (!next) {
      onWindowChange(null);
    } else if (win == null) {
      onWindowChange({ start, end, timezone });
    }
  }, [win, start, end, timezone, onWindowChange]);

  const handleSaveWindow = useCallback(() => {
    if (!isValidHHMM(start) || !isValidHHMM(end)) {
      Alert.alert('Invalid time', 'Use HH:MM (24-hour). Example: 22:00');
      return;
    }
    setDirty(false);
    setPendingSnapshot(undefined);
    onWindowChange({ start, end, timezone });
  }, [start, end, timezone, onWindowChange]);

  // #4570: keep the local draft, dismiss the parked snapshot.
  const handleAcceptDraft = useCallback(() => {
    setPendingSnapshot(undefined);
  }, []);

  // #4570: take the remote snapshot, overwrite the draft, clear dirty.
  const handleDiscardDraft = useCallback(() => {
    const snap = pendingSnapshot;
    if (snap === undefined) return;
    setEnabled(snap != null);
    if (snap) {
      setStart(snap.start);
      setEnd(snap.end);
      setTimezone(snap.timezone);
    }
    setDirty(false);
    setPendingSnapshot(undefined);
  }, [pendingSnapshot]);

  // #4570: dirty-tracking wrappers around field setters so every edit path
  // flips the flag — used by the TextInputs and the timezone picker.
  const setStartDirty = useCallback((next: string) => { setStart(next); setDirty(true); }, []);
  const setEndDirty = useCallback((next: string) => { setEnd(next); setDirty(true); }, []);
  const setTimezoneDirty = useCallback((next: string) => { setTimezone(next); setDirty(true); }, []);

  const handleToggleBypass = useCallback((cat: string, next: boolean) => {
    const set = new Set(bypassCategories);
    if (next) set.add(cat); else set.delete(cat);
    onBypassChange([...set]);
  }, [bypassCategories, onBypassChange]);

  const bypassCandidates = useMemo(() => {
    const known = NOTIFICATION_CATEGORY_ORDER.filter((k) => k in categories || bypassCategories.includes(k));
    const extras = bypassCategories.filter((k) => !NOTIFICATION_CATEGORY_ORDER.includes(k) && !(k in categories));
    return [...known, ...extras];
  }, [categories, bypassCategories]);

  // Save button visibility: surface whenever the draft diverges from the
  // last known snapshot (existing behaviour) OR whenever dirty is set.
  const saveVisible = enabled && (dirty || start !== (win?.start ?? '') || end !== (win?.end ?? '') || timezone !== (win?.timezone ?? ''));

  return (
    <View testID="quiet-hours-editor">
      <View style={styles.row}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.rowLabel}>Enable quiet hours</Text>
          <Text style={[styles.rowHint, { marginTop: 2 }]}>
            Mute pushes during a fixed window. Operator-blocking categories
            still fire by default — uncheck them below to silence too.
          </Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={handleToggleEnable}
          trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
          testID="quiet-hours-enabled-toggle"
        />
      </View>
      {enabled && (
        <>
          {pendingSnapshot !== undefined && (
            <>
              <View style={styles.separator} />
              {/* #4581: accessibilityLiveRegion="polite" lets TalkBack /
                  VoiceOver announce the divergence the moment the banner
                  mounts — a screen-reader user editing the field would
                  otherwise miss the conflict entirely. Matches the
                  dashboard's role="alert" semantic without using `assertive`,
                  which would interrupt mid-typing speech. The two action
                  TouchableOpacity children get accessibilityRole="button"
                  + accessibilityLabel below for the same reason. */}
              <View
                style={styles.row}
                testID="quiet-hours-conflict-banner"
                accessibilityLiveRegion="polite"
                accessible={true}
              >
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={styles.rowLabel}>Another client updated quiet hours</Text>
                  <Text style={[styles.rowHint, { marginTop: 2 }]}>
                    Keep your unsaved edits, or discard them and load the
                    latest values?
                  </Text>
                </View>
              </View>
              <View style={styles.separator} />
              <TouchableOpacity
                style={styles.row}
                onPress={handleAcceptDraft}
                testID="quiet-hours-conflict-accept"
                accessibilityRole="button"
                accessibilityLabel="Keep my edits"
              >
                <Text style={styles.actionText}>Keep my edits</Text>
              </TouchableOpacity>
              <View style={styles.separator} />
              <TouchableOpacity
                style={styles.row}
                onPress={handleDiscardDraft}
                testID="quiet-hours-conflict-discard"
                accessibilityRole="button"
                accessibilityLabel="Discard and load latest"
              >
                <Text style={styles.actionText}>Discard and load latest</Text>
              </TouchableOpacity>
            </>
          )}
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>From</Text>
            <TextInput
              value={start}
              onChangeText={setStartDirty}
              placeholder="22:00"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.timeInput}
              testID="quiet-hours-start-input"
            />
          </View>
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>To</Text>
            <TextInput
              value={end}
              onChangeText={setEndDirty}
              placeholder="07:00"
              placeholderTextColor={COLORS.textMuted}
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.timeInput}
              testID="quiet-hours-end-input"
            />
          </View>
          <View style={styles.separator} />
          <TouchableOpacity
            style={styles.row}
            onPress={() => setShowTzPicker(true)}
            testID="quiet-hours-timezone-picker"
          >
            <Text style={styles.rowLabel}>Timezone</Text>
            <Text style={styles.rowValue}>{timezone}</Text>
          </TouchableOpacity>
          {saveVisible && (
            <>
              <View style={styles.separator} />
              <TouchableOpacity
                style={styles.row}
                onPress={handleSaveWindow}
                testID="quiet-hours-save-button"
              >
                <Text style={styles.actionText}>Save Quiet Hours</Text>
              </TouchableOpacity>
            </>
          )}
          <View style={styles.separator} />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Bypass during quiet hours</Text>
          </View>
          {bypassCandidates.map((cat, idx) => {
            const meta = NOTIFICATION_CATEGORY_LABELS[cat];
            const label = meta?.label ?? cat;
            const checked = bypassCategories.includes(cat);
            return (
              <React.Fragment key={cat}>
                {idx === 0 ? null : <View style={styles.separator} />}
                <View style={styles.row}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.rowLabel}>{label}</Text>
                  </View>
                  <Switch
                    value={checked}
                    onValueChange={(value) => handleToggleBypass(cat, value)}
                    trackColor={{ false: COLORS.backgroundCard, true: COLORS.accentBlue }}
                    testID={`quiet-hours-bypass-toggle-${cat}`}
                  />
                </View>
              </React.Fragment>
            );
          })}
        </>
      )}
      <Modal
        visible={showTzPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowTzPicker(false)}
      >
        <Pressable style={styles.sheetOverlay} onPress={() => setShowTzPicker(false)}>
          <Pressable
            style={[styles.sheetContent, { paddingBottom: 16 }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.sheetTitle}>Timezone</Text>
            <ScrollView style={styles.sheetList} bounces={false}>
              {tzOptions.map((tz) => (
                <TouchableOpacity
                  key={tz}
                  style={[styles.sheetOption, tz === timezone && styles.sheetOptionActive]}
                  onPress={() => { setTimezoneDirty(tz); setShowTzPicker(false); }}
                >
                  <Text style={[styles.sheetOptionText, tz === timezone && styles.sheetOptionTextActive]}>
                    {tz === browserTz ? `${tz} (this device)` : tz}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity
              style={[styles.sheetOption, styles.sheetCancel]}
              onPress={() => setShowTzPicker(false)}
            >
              <Text style={[styles.sheetOptionText, styles.sheetCancelText]}>Cancel</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

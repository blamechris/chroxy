import { StyleSheet } from 'react-native';
import { COLORS } from '../../constants/colors';

/**
 * Shared StyleSheet for SettingsScreen and its extracted section components
 * (NotificationPrefsSection, VoiceInputSection, SecuritySection,
 * QuietHoursEditor, KnownDevicesList). Lifted out of SettingsScreen.tsx so the
 * sections can be split into their own files without duplicating row / sheet /
 * device styling.
 */
export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  sectionHeader: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 6,
    marginHorizontal: 16,
  },
  section: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 10,
    marginHorizontal: 16,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    minHeight: 44,
  },
  // #4543: subordinate per-device row sits flush under the parent category
  // row with a slight indent so the visual hierarchy makes it clear that
  // "Mute on this device" is layered on top of the global toggle, not a
  // peer of it.
  deviceOverrideRow: {
    paddingLeft: 32,
    paddingTop: 4,
    paddingBottom: 8,
    minHeight: 36,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.backgroundCard,
    marginLeft: 16,
  },
  rowLabel: {
    color: COLORS.textPrimary,
    fontSize: 15,
  },
  rowValue: {
    color: COLORS.textMuted,
    fontSize: 15,
  },
  rowValueSmall: {
    fontSize: 13,
    maxWidth: 200,
  },
  // #4544: HH:MM picker field — small fixed width so the keyboard slots
  // straight into the row layout without pushing the label.
  timeInput: {
    color: COLORS.textPrimary,
    fontSize: 15,
    minWidth: 64,
    paddingVertical: 6,
    paddingHorizontal: 8,
    textAlign: 'right',
  },
  rowHint: {
    color: COLORS.textMuted,
    fontSize: 13,
    flex: 1,
  },
  destructiveText: {
    color: COLORS.accentRed,
    fontSize: 15,
  },
  // #4559: inline banner shown above the NOTIFICATION CATEGORIES section
  // when a notification-prefs Switch tap fires while the WS is closed.
  // Matches the section header indent (marginHorizontal: 16) so the
  // banner aligns with the section it describes; tinted with the
  // destructive red used by Clear actions so the failure tone reads
  // immediately.
  wsClosedBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: COLORS.backgroundCard,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accentRed,
  },
  wsClosedBannerText: {
    color: COLORS.accentRed,
    fontSize: 13,
  },
  actionText: {
    color: COLORS.accentBlue,
    fontSize: 15,
  },
  // #4564: known-devices list styles. The label group flexes so a long
  // truncated token still leaves the Clear button room; the self-tag
  // borrows the accent blue used elsewhere for "this device" markers
  // (LAN scan, etc.) so cross-screen styling stays consistent.
  deviceLabelGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    marginRight: 12,
  },
  deviceLabelText: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontFamily: 'Courier',
    flexShrink: 1,
  },
  deviceSelfTag: {
    color: COLORS.accentBlue,
    fontSize: 12,
  },
  // #4587: subdued meta text for the platform + last-seen badges. Borrows
  // the same `textMuted` accent already used for hints and section
  // headers so the badges read as secondary content next to the token.
  deviceMetaText: {
    color: COLORS.textMuted,
    fontSize: 12,
  },
  deviceClearButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: COLORS.backgroundCard,
  },
  deviceClearText: {
    color: COLORS.accentRed,
    fontSize: 13,
    fontWeight: '600',
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  updateBadge: {
    backgroundColor: COLORS.accentOrangeSubtle,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  updateBadgeText: {
    color: COLORS.accentOrange,
    fontSize: 11,
    fontWeight: '600',
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheetContent: {
    backgroundColor: COLORS.backgroundSecondary,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
    maxHeight: '60%',
  },
  sheetTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: 12,
  },
  sheetList: {
    flexShrink: 1,
  },
  sheetOption: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    minHeight: 48,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sheetOptionActive: {
    backgroundColor: COLORS.accentBlueLight,
  },
  sheetOptionText: {
    color: COLORS.textPrimary,
    fontSize: 16,
  },
  sheetOptionTextActive: {
    color: COLORS.accentBlue,
    fontWeight: '600',
  },
  sheetOptionTag: {
    color: COLORS.textMuted,
    fontSize: 13,
  },
  sheetCancel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderPrimary,
    marginTop: 4,
    justifyContent: 'center',
  },
  sheetCancelText: {
    color: COLORS.accentRed,
    textAlign: 'center',
  },
  rulesContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  ruleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  ruleChipAllow: {
    backgroundColor: COLORS.accentGreenLight,
    borderColor: COLORS.accentGreenBorder,
  },
  ruleChipDeny: {
    backgroundColor: COLORS.accentRedSubtle,
    borderColor: COLORS.accentRedBorder,
  },
  ruleChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  ruleChipTextAllow: {
    color: COLORS.accentGreen,
  },
  ruleChipTextDeny: {
    color: COLORS.accentRed,
  },
  ruleChipRemove: {
    fontSize: 15,
    fontWeight: '600',
    marginLeft: 2,
  },
});

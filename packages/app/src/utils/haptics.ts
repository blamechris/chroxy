import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

function isNative(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

/** Light tap — send message, switch tab, pull-to-refresh */
export function hapticLight(): void {
  if (isNative()) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** Medium tap — approve permission, disconnect, interrupt, long-press */
export function hapticMedium(): void {
  if (isNative()) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Success — connection established */
export function hapticSuccess(): void {
  if (isNative()) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Warning — deny permission, destructive actions */
export function hapticWarning(): void {
  if (isNative()) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}

import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

function isNative(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

/** Light tap — send message, switch tab, pull-to-refresh */
export function hapticLight(): void {
  if (isNative()) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** Medium tap — approve permission, disconnect, interrupt, long-press */
export function hapticMedium(): void {
  if (isNative()) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
}

/** Success — connection established, response complete */
export function hapticSuccess(): void {
  if (isNative()) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

/** Warning — deny permission, destructive actions */
export function hapticWarning(): void {
  if (isNative()) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
}

/**
 * Bridge to the native iOS Live Activity module.
 *
 * These are stubs that return null/void until the native Swift module
 * is implemented in #2171. The manager handles null activity IDs gracefully.
 */
import { Platform } from 'react-native';
import type {
  LiveActivityAttributes,
  LiveActivityContentState,
} from './types';

/** Whether the current device supports Live Activities (iOS 16.1+). */
export function isLiveActivitySupported(): boolean {
  return Platform.OS === 'ios' && parseInt(Platform.Version as string, 10) >= 16;
}

/**
 * Request a new Live Activity. Returns the activity ID, or null if
 * the native module is not yet implemented or the request fails.
 */
export async function startLiveActivity(
  _attributes: LiveActivityAttributes,
  _initialState: LiveActivityContentState,
): Promise<string | null> {
  // Stub — native implementation in #2171
  return null;
}

/**
 * Update the content state of a running Live Activity.
 */
export async function updateLiveActivity(
  _activityId: string,
  _state: LiveActivityContentState,
): Promise<void> {
  // Stub — native implementation in #2171
}

/**
 * End a running Live Activity.
 */
export async function endLiveActivity(
  _activityId: string,
): Promise<void> {
  // Stub — native implementation in #2171
}

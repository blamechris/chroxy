/**
 * Bridge to the native iOS Live Activity module via expo-live-activity.
 *
 * Maps Chroxy's LiveActivityContentState to the expo-live-activity
 * package format (title/subtitle/progressBar) and delegates to the
 * native module.
 */
import { Platform } from 'react-native';
import type {
  LiveActivityAttributes,
  LiveActivityContentState,
} from './types';

// Lazy-import the native module to avoid crashes on unsupported platforms.
// expo-live-activity throws at import time if ActivityKit is unavailable.
let _nativeModule: typeof import('expo-live-activity') | null = null;

function getNativeModule() {
  if (_nativeModule !== null) return _nativeModule;
  if (!isLiveActivitySupported()) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _nativeModule = require('expo-live-activity');
    return _nativeModule;
  } catch {
    return null;
  }
}

/** Whether the current device supports Live Activities (iOS 16.1+). */
export function isLiveActivitySupported(): boolean {
  return Platform.OS === 'ios' && parseInt(Platform.Version as string, 10) >= 16;
}

/** Map state enum to human-readable subtitle text. */
function stateToSubtitle(
  state: LiveActivityContentState['state'],
  detail?: string,
): string {
  if (detail) return detail;

  switch (state) {
    case 'thinking':
      return 'Thinking...';
    case 'active':
      return 'Running';
    case 'waiting':
      return 'Waiting for input';
    case 'error':
      return 'Error';
    case 'ended':
      return 'Session ended';
    default:
      return 'Running';
  }
}

/** Chroxy Live Activity widget config — dark theme matching the app. */
const WIDGET_CONFIG = {
  backgroundColor: '#0f0f1a',
  titleColor: '#ffffff',
  subtitleColor: '#a0a0b0',
  deepLinkUrl: 'chroxy://',
} as const;

/**
 * Request a new Live Activity. Returns the activity ID, or null if
 * the native module is unavailable or the request fails.
 */
export async function startLiveActivity(
  _attributes: LiveActivityAttributes,
  initialState: LiveActivityContentState,
): Promise<string | null> {
  const mod = getNativeModule();
  if (!mod) return null;

  try {
    const id = mod.startActivity(
      {
        title: 'Chroxy',
        subtitle: stateToSubtitle(initialState.state, initialState.detail),
      },
      WIDGET_CONFIG,
    );
    return id ?? null;
  } catch {
    return null;
  }
}

/**
 * Update the content state of a running Live Activity.
 */
export async function updateLiveActivity(
  activityId: string,
  state: LiveActivityContentState,
): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;

  try {
    mod.updateActivity(activityId, {
      title: 'Chroxy',
      subtitle: stateToSubtitle(state.state, state.detail),
    });
  } catch {
    // Swallow — activity may have been dismissed by the user
  }
}

/**
 * End a running Live Activity.
 */
export async function endLiveActivity(
  activityId: string,
): Promise<void> {
  const mod = getNativeModule();
  if (!mod) return;

  try {
    mod.stopActivity(activityId, {
      title: 'Chroxy',
      subtitle: 'Session ended',
    });
  } catch {
    // Swallow — activity may have already ended
  }
}

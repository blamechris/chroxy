/**
 * Types for iOS Live Activity integration.
 *
 * LiveActivityState maps to the Dynamic Island / Lock Screen UI states.
 * ActivityState (from session-activity.ts) is the app-internal state that
 * gets mapped to LiveActivityState before sending to the native bridge.
 */

/** State shown in the Live Activity UI on the Lock Screen / Dynamic Island. */
export type LiveActivityState = 'active' | 'thinking' | 'waiting' | 'error' | 'ended';

/** Attributes set once when the Live Activity is started (immutable). */
export interface LiveActivityAttributes {
  sessionName: string;
  /** #6792 — the originating chroxy session id, threaded into the widget's
   *  deep-link URL so tapping the Live Activity routes back to this session
   *  instead of the app's default screen. Optional: absent when the Live
   *  Activity starts before a session is active yet. */
  sessionId?: string;
}

/** Content state that can be updated while the Live Activity is running. */
export interface LiveActivityContentState {
  state: LiveActivityState;
  elapsedSeconds: number;
  detail?: string;
}

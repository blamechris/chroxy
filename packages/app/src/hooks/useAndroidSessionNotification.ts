import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useConnectionStore } from '../store/connection';
import { updateSessionNotification, dismissSessionNotification, startElapsedTimer, stopElapsedTimer } from '../android-session-notification';
import { getActivityLabel } from '../components/BackgroundSessionProgress';

/**
 * Subscribes to the active session's activity state and updates the
 * Android persistent notification accordingly. No-op on iOS.
 * Only shows notification when the app is in the background.
 */
export function useAndroidSessionNotification(): void {
  const prevStateRef = useRef<string>('idle');

  useEffect(() => {
    const unsubscribe = useConnectionStore.subscribe((state) => {
      const activeId = state.activeSessionId;
      const activity = activeId ? state.sessionStates[activeId]?.activityState : undefined;
      const activityState = activity?.state ?? 'idle';

      // Skip if state hasn't actually changed
      if (activityState === prevStateRef.current) return;
      prevStateRef.current = activityState;

      if (activityState === 'idle') {
        stopElapsedTimer();
        void dismissSessionNotification();
        return;
      }

      // Don't show notification when the app is in the foreground —
      // the user can already see the session activity in the UI
      if (AppState.currentState === 'active') return;

      const label = getActivityLabel(activityState, activity?.detail) ?? 'Session active';
      const elapsed = activity ? Math.floor((Date.now() - activity.startedAt) / 1000) : 0;
      void updateSessionNotification(activityState, label, elapsed);

      // Start periodic elapsed-time updates so the notification stays fresh
      if (activity) {
        startElapsedTimer(label, activity.startedAt);
      }
    });

    // When app goes to background while session is active, start notification
    const appStateSub = AppState.addEventListener('change', (nextState) => {
      const { activeSessionId, sessionStates } = useConnectionStore.getState();
      const activity = activeSessionId ? sessionStates[activeSessionId]?.activityState : undefined;
      const activityState = activity?.state ?? 'idle';

      if (nextState === 'active') {
        // App came to foreground — dismiss notification
        stopElapsedTimer();
        void dismissSessionNotification();
      } else if (nextState === 'background' && activityState !== 'idle') {
        // App went to background while session is active — show notification
        const label = getActivityLabel(activityState, activity?.detail) ?? 'Session active';
        const elapsed = activity ? Math.floor((Date.now() - activity.startedAt) / 1000) : 0;
        void updateSessionNotification(activityState, label, elapsed);
        if (activity) {
          startElapsedTimer(label, activity.startedAt);
        }
      }
    });

    return () => {
      unsubscribe();
      appStateSub.remove();
      stopElapsedTimer();
      void dismissSessionNotification();
    };
  }, []);
}

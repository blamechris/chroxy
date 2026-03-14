import { useEffect, useRef } from 'react';
import { useConnectionStore } from '../store/connection';
import { updateSessionNotification, dismissSessionNotification } from '../android-session-notification';
import { getActivityLabel } from '../components/BackgroundSessionProgress';

/**
 * Subscribes to the active session's activity state and updates the
 * Android persistent notification accordingly. No-op on iOS.
 */
export function useAndroidSessionNotification(): void {
  const prevStateRef = useRef<string>('idle');

  useEffect(() => {
    const unsubscribe = useConnectionStore.subscribe((state) => {
      const activeId = state.activeSessionId;
      const activity = activeId ? state.sessionStates[activeId]?.activityState : undefined;
      const activityState = activity?.state ?? 'idle';

      // Skip if state hasn't changed
      if (activityState === prevStateRef.current && activityState === 'idle') return;
      prevStateRef.current = activityState;

      if (activityState === 'idle') {
        void dismissSessionNotification();
        return;
      }

      const label = getActivityLabel(activityState, activity?.detail) ?? 'Session active';
      const elapsed = activity ? Math.floor((Date.now() - activity.startedAt) / 1000) : 0;
      void updateSessionNotification(activityState, label, elapsed);
    });

    return () => {
      unsubscribe();
      void dismissSessionNotification();
    };
  }, []);
}

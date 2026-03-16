/**
 * React hook that connects the LiveActivityManager to the Zustand store.
 *
 * Subscribes to session activity state changes and maps them to
 * Live Activity updates. Starts on connection, stops on disconnect.
 */
import { useEffect, useRef, useMemo } from 'react';
import { useConnectionStore } from '../store/connection';
import { useConnectionLifecycleStore } from '../store/connection-lifecycle';
import { LiveActivityManager, mapActivityState } from './live-activity-manager';

interface LiveActivityHookResult {
  isActive: boolean;
  isSupported: boolean;
}

/**
 * Manages the iOS Live Activity for the active session.
 * No-op on Android and iOS < 16.1.
 */
export function useLiveActivity(): LiveActivityHookResult {
  const manager = useMemo(() => new LiveActivityManager(), []);
  const prevStateRef = useRef<string>('idle');
  const isActiveRef = useRef(false);

  useEffect(() => {
    if (!manager.isSupported) return;

    const unsubscribe = useConnectionStore.subscribe((state) => {
      const activeId = state.activeSessionId;
      const phase = useConnectionLifecycleStore.getState().connectionPhase;

      // Stop on disconnect
      if (phase === 'disconnected' && isActiveRef.current) {
        isActiveRef.current = false;
        prevStateRef.current = 'idle';
        void manager.stop();
        return;
      }

      // Only manage when connected
      if (phase !== 'connected') return;

      const activity = activeId ? state.sessionStates[activeId]?.activityState : undefined;
      const activityState = activity?.state ?? 'idle';

      // Start Live Activity on first connected state if not yet active
      if (!isActiveRef.current) {
        isActiveRef.current = true;
        const session = activeId ? state.sessions.find((s) => s.sessionId === activeId) : undefined;
        const sessionName = session?.name ?? 'Session';
        void manager.start(sessionName).then(() => {
          // Send initial state update after start
          const liveState = mapActivityState(activityState);
          void manager.update(liveState, activity?.detail);
        });
        prevStateRef.current = activityState;
        return;
      }

      // Skip if state hasn't changed
      if (activityState === prevStateRef.current) return;
      prevStateRef.current = activityState;

      const liveState = mapActivityState(activityState);
      void manager.update(liveState, activity?.detail);
    });

    return () => {
      unsubscribe();
      void manager.stop();
      isActiveRef.current = false;
    };
  }, [manager]);

  return {
    isActive: isActiveRef.current,
    isSupported: manager.isSupported,
  };
}

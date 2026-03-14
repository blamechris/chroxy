/**
 * LiveActivityManager — manages the iOS Live Activity lifecycle.
 *
 * Handles starting, updating, and stopping the Live Activity,
 * tracks elapsed time, and no-ops gracefully on unsupported platforms
 * or when the native bridge returns null activity IDs (stubs).
 */
import type { LiveActivityState } from './types';
import {
  isLiveActivitySupported,
  startLiveActivity,
  updateLiveActivity,
  endLiveActivity,
} from './live-activity-bridge';
import type { ActivityState } from '../store/session-activity';

const THROTTLE_MS = 1000;

/** Maps app-internal ActivityState to Live Activity UI state. */
export function mapActivityState(state: ActivityState): LiveActivityState {
  switch (state) {
    case 'thinking':
      return 'thinking';
    case 'busy':
      return 'active';
    case 'waiting':
      return 'waiting';
    case 'error':
      return 'error';
    case 'idle':
    default:
      return 'active';
  }
}

export class LiveActivityManager {
  private _activityId: string | null = null;
  private _startedAt: number | null = null;
  private _lastUpdateTime = 0;
  private _supported: boolean;

  constructor() {
    this._supported = isLiveActivitySupported();
  }

  /** Whether the current device supports Live Activities. */
  get isSupported(): boolean {
    return this._supported;
  }

  /** Whether a Live Activity is currently active. */
  get isActive(): boolean {
    return this._activityId !== null;
  }

  /** The current activity ID, or null if none is active. */
  get activityId(): string | null {
    return this._activityId;
  }

  /** Elapsed seconds since the Live Activity was started. */
  get elapsedSeconds(): number {
    if (this._startedAt === null) return 0;
    return Math.floor((Date.now() - this._startedAt) / 1000);
  }

  /**
   * Start a new Live Activity for the given session.
   * No-ops if unsupported or if one is already active.
   */
  async start(sessionName: string): Promise<void> {
    if (!this._supported) return;
    if (this._activityId !== null) return;

    this._startedAt = Date.now();

    const id = await startLiveActivity(
      { sessionName },
      { state: 'active', elapsedSeconds: 0 },
    );

    if (id === null) {
      // Bridge stub or native failure — degrade gracefully
      return;
    }

    this._activityId = id;
  }

  /**
   * Update the Live Activity with a new state and optional detail.
   * Throttled to at most one update per THROTTLE_MS.
   */
  async update(state: LiveActivityState, detail?: string): Promise<void> {
    if (!this._supported) return;
    if (this._activityId === null) return;

    const now = Date.now();
    if (now - this._lastUpdateTime < THROTTLE_MS) return;
    this._lastUpdateTime = now;

    await updateLiveActivity(this._activityId, {
      state,
      elapsedSeconds: this.elapsedSeconds,
      detail,
    });
  }

  /**
   * Stop the current Live Activity.
   * No-ops if none is active.
   */
  async stop(): Promise<void> {
    if (!this._supported) return;

    const id = this._activityId;
    if (id === null) return;

    this._activityId = null;
    this._startedAt = null;
    this._lastUpdateTime = 0;

    await endLiveActivity(id);
  }

  /** Reset internal state (for testing). */
  _reset(): void {
    this._activityId = null;
    this._startedAt = null;
    this._lastUpdateTime = 0;
  }
}

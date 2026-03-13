import { deriveActivityState, type SessionActivity, type ActivityState } from '../store/session-activity';

describe('deriveActivityState', () => {
  it('returns idle for default session state', () => {
    const activity = deriveActivityState({
      isIdle: true,
      streamingMessageId: null,
      isPlanPending: false,
    });
    expect(activity.state).toBe('idle');
  });

  it('returns thinking when streaming is active', () => {
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: 'msg-123',
      isPlanPending: false,
    });
    expect(activity.state).toBe('thinking');
  });

  it('returns waiting when plan is pending', () => {
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: null,
      isPlanPending: true,
    });
    expect(activity.state).toBe('waiting');
  });

  it('returns busy when not idle and not streaming', () => {
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: null,
      isPlanPending: false,
    });
    expect(activity.state).toBe('busy');
  });

  it('returns waiting when permission is pending', () => {
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: null,
      isPlanPending: false,
      pendingPermission: true,
    });
    expect(activity.state).toBe('waiting');
  });

  it('includes startedAt timestamp', () => {
    const mockNow = 1700000000000;
    jest.spyOn(Date, 'now').mockReturnValue(mockNow);
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: 'msg-1',
      isPlanPending: false,
    });
    expect(activity.startedAt).toBe(mockNow);
    jest.restoreAllMocks();
  });

  it('preserves startedAt from previous activity when state unchanged', () => {
    const previous: SessionActivity = {
      state: 'thinking',
      startedAt: 1000,
    };
    const activity = deriveActivityState({
      isIdle: false,
      streamingMessageId: 'msg-1',
      isPlanPending: false,
    }, previous);
    expect(activity.startedAt).toBe(1000);
  });

  it('resets startedAt when state changes', () => {
    const mockNow = 1700000000000;
    jest.spyOn(Date, 'now').mockReturnValue(mockNow);
    const previous: SessionActivity = {
      state: 'thinking',
      startedAt: 1000,
    };
    const activity = deriveActivityState({
      isIdle: true,
      streamingMessageId: null,
      isPlanPending: false,
    }, previous);
    expect(activity.state).toBe('idle');
    expect(activity.startedAt).toBe(mockNow);
    jest.restoreAllMocks();
  });

  it('exports ActivityState type with all expected values', () => {
    const states: ActivityState[] = ['idle', 'thinking', 'busy', 'waiting', 'error'];
    expect(states).toHaveLength(5);
  });
});

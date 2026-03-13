export type ActivityState = 'idle' | 'thinking' | 'busy' | 'waiting' | 'error';

export interface SessionActivity {
  state: ActivityState;
  detail?: string;
  startedAt: number;
}

interface DeriveInput {
  isIdle: boolean;
  streamingMessageId: string | null;
  isPlanPending: boolean;
  pendingPermission?: boolean;
  hasError?: boolean;
}

export function deriveActivityState(
  input: DeriveInput,
  previous?: SessionActivity,
): SessionActivity {
  let state: ActivityState = 'idle';

  if (input.hasError) {
    state = 'error';
  } else if (input.pendingPermission || input.isPlanPending) {
    state = 'waiting';
  } else if (input.streamingMessageId) {
    state = 'thinking';
  } else if (!input.isIdle) {
    state = 'busy';
  }

  const startedAt = previous && previous.state === state
    ? previous.startedAt
    : Date.now();

  return { state, startedAt };
}

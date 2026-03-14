export type LiveActivityState = 'thinking' | 'writing' | 'waiting' | 'idle' | 'error'

export interface LiveActivityAttributes {
  sessionName: string
}

export interface LiveActivityContentState {
  state: LiveActivityState
  detail?: string
  elapsedSeconds: number
  sessionCount: number
}

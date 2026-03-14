import { Platform } from 'react-native'
import type { LiveActivityAttributes, LiveActivityContentState } from './types'

const MIN_IOS_VERSION = 16.2

function isLiveActivitySupported(): boolean {
  if (Platform.OS !== 'ios') return false
  const version = parseFloat(Platform.Version as string)
  return version >= MIN_IOS_VERSION
}

// Stub implementations — will be replaced with actual native bridge in #2171
export async function startLiveActivity(
  _attributes: LiveActivityAttributes,
  _state: LiveActivityContentState
): Promise<string | null> {
  if (!isLiveActivitySupported()) return null
  // TODO: Call native module when widget extension is ready (#2171)
  return null
}

export async function updateLiveActivity(
  _activityId: string,
  _state: LiveActivityContentState
): Promise<void> {
  if (!isLiveActivitySupported()) return
  // TODO: Call native module when widget extension is ready (#2171)
}

export async function endLiveActivity(_activityId: string): Promise<void> {
  if (!isLiveActivitySupported()) return
  // TODO: Call native module when widget extension is ready (#2171)
}

export { isLiveActivitySupported }

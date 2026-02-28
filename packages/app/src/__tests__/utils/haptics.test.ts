/**
 * Tests for haptics utility (#1032).
 */
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { hapticLight, hapticMedium, hapticSuccess, hapticWarning } from '../../utils/haptics';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: {
    Light: 'LIGHT',
    Medium: 'MEDIUM',
    Heavy: 'HEAVY',
  },
  NotificationFeedbackType: {
    Success: 'SUCCESS',
    Warning: 'WARNING',
    Error: 'ERROR',
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  // Default to iOS (has haptics)
  (Platform as any).OS = 'ios';
});

describe('haptics utility', () => {
  it('hapticLight triggers light impact feedback', () => {
    hapticLight();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it('hapticMedium triggers medium impact feedback', () => {
    hapticMedium();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it('hapticSuccess triggers success notification feedback', () => {
    hapticSuccess();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  });

  it('hapticWarning triggers warning notification feedback', () => {
    hapticWarning();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);
  });

  it('no-ops gracefully on web platform', () => {
    (Platform as any).OS = 'web';
    hapticLight();
    hapticMedium();
    hapticSuccess();
    hapticWarning();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });
});

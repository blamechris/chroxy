/**
 * Tests for isVisibleAppState (#3672).
 *
 * iOS `inactive` is a transient state (app switcher, control-center pulldown,
 * biometric prompt, incoming call, post-unlock window) where the user is still
 * on the device — treating it as not-visible flips the server to
 * visible=false and arms a phantom completion-push notification. The heuristic
 * therefore folds `inactive` into the visible bucket on iOS only. Android
 * never emits `inactive`, but we still gate it by Platform.OS so the contract
 * is explicit.
 */
import { Platform } from 'react-native';
import { isVisibleAppState } from '../../store/message-handler';

describe('isVisibleAppState', () => {
  const originalOS = Platform.OS;

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  });

  describe('on iOS', () => {
    beforeEach(() => {
      Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    });

    it('treats active as visible', () => {
      expect(isVisibleAppState('active')).toBe(true);
    });

    it('treats inactive as visible (the #3672 fix)', () => {
      expect(isVisibleAppState('inactive')).toBe(true);
    });

    it('treats background as not-visible', () => {
      expect(isVisibleAppState('background')).toBe(false);
    });

    it('treats unknown as not-visible', () => {
      expect(isVisibleAppState('unknown')).toBe(false);
    });

    it('treats extension as not-visible', () => {
      expect(isVisibleAppState('extension')).toBe(false);
    });
  });

  describe('on Android', () => {
    beforeEach(() => {
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    });

    it('treats active as visible', () => {
      expect(isVisibleAppState('active')).toBe(true);
    });

    it('treats inactive as not-visible (Android never emits this; defensive)', () => {
      expect(isVisibleAppState('inactive')).toBe(false);
    });

    it('treats background as not-visible', () => {
      expect(isVisibleAppState('background')).toBe(false);
    });
  });
});

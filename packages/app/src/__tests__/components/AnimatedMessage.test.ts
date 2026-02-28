import { getAnimationConfig, shouldAnimate } from '../../components/AnimatedMessage';

describe('AnimatedMessage', () => {
  describe('getAnimationConfig', () => {
    it('returns slide-right config for user_input messages', () => {
      const config = getAnimationConfig('user_input');
      expect(config.translateX).toBe(30);
      expect(config.duration).toBeLessThanOrEqual(300);
    });

    it('returns slide-left config for response messages', () => {
      const config = getAnimationConfig('response');
      expect(config.translateX).toBe(-30);
      expect(config.duration).toBeLessThanOrEqual(300);
    });

    it('returns fade-only config for system messages', () => {
      const config = getAnimationConfig('system');
      expect(config.translateX).toBe(0);
      expect(config.duration).toBeLessThanOrEqual(200);
    });

    it('returns fade-only config for error messages', () => {
      const config = getAnimationConfig('error');
      expect(config.translateX).toBe(0);
    });

    it('returns slide-up config for prompt messages', () => {
      const config = getAnimationConfig('prompt');
      expect(config.translateY).toBeGreaterThan(0);
    });
  });

  describe('shouldAnimate', () => {
    it('returns true for messages newer than the threshold', () => {
      const now = Date.now();
      expect(shouldAnimate(now - 100, now - 500)).toBe(true);
    });

    it('returns false for messages older than the threshold', () => {
      const now = Date.now();
      expect(shouldAnimate(now - 10000, now - 500)).toBe(false);
    });

    it('returns false when reduce motion is enabled', () => {
      expect(shouldAnimate(Date.now(), Date.now() - 500, true)).toBe(false);
    });
  });
});

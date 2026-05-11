/**
 * Unit tests for ActivityIndicator's statusColor() threshold escalation (#3772).
 *
 * The function is the visible signal that telegraphs how close a session is
 * to timing out. Thresholds must match the dashboard's CSS-driven escalation
 * (packages/dashboard/src/theme/components.css:6028-6031). A token swap or an
 * off-by-one on the boundary would silently mis-color the indicator.
 */
import { statusColor } from '../ActivityIndicator';
import { COLORS } from '../../constants/colors';

describe('ActivityIndicator statusColor()', () => {
  // Production default is 20 min; tests use it unless asserting the
  // dynamic-timeout branch.
  const TIMEOUT_20MIN = 20 * 60_000;

  describe('green band (< 30 s elapsed)', () => {
    it('returns green at 0 ms', () => {
      expect(statusColor(0, TIMEOUT_20MIN)).toBe(COLORS.accentGreen);
    });

    it('returns green just below the yellow boundary', () => {
      expect(statusColor(29_999, TIMEOUT_20MIN)).toBe(COLORS.accentGreen);
    });
  });

  describe('yellow band (30 s ≤ elapsed < 60 s)', () => {
    it('flips to yellow exactly at 30 000 ms', () => {
      expect(statusColor(30_000, TIMEOUT_20MIN)).toBe(COLORS.accentYellow500);
    });

    it('stays yellow just below the orange boundary', () => {
      expect(statusColor(59_999, TIMEOUT_20MIN)).toBe(COLORS.accentYellow500);
    });
  });

  describe('orange band (60 s ≤ elapsed < timeout - 60 s)', () => {
    it('flips to orange exactly at 60 000 ms', () => {
      expect(statusColor(60_000, TIMEOUT_20MIN)).toBe(COLORS.accentOrange500);
    });

    it('stays orange just below the red boundary', () => {
      // timeout - 60 001 ms = 1 139 999 ms = 18 min 59.999 s
      expect(statusColor(TIMEOUT_20MIN - 60_001, TIMEOUT_20MIN)).toBe(COLORS.accentOrange500);
    });
  });

  describe('red band (last 60 s before timeout)', () => {
    it('flips to red exactly at timeout - 60 000 ms', () => {
      expect(statusColor(TIMEOUT_20MIN - 60_000, TIMEOUT_20MIN)).toBe(COLORS.accentRed500);
    });

    it('stays red at the timeout itself', () => {
      expect(statusColor(TIMEOUT_20MIN, TIMEOUT_20MIN)).toBe(COLORS.accentRed500);
    });

    it('stays red past the timeout (slow rerender after fire)', () => {
      expect(statusColor(TIMEOUT_20MIN + 5_000, TIMEOUT_20MIN)).toBe(COLORS.accentRed500);
    });
  });

  describe('red threshold respects the dynamic timeout argument', () => {
    // Guard against regression where the red boundary becomes a hardcoded
    // value instead of `timeoutMs - 60_000`. A 2-min timeout means red
    // should kick in at 60 s — earlier than the 20-min default's 19 min.
    const TIMEOUT_2MIN = 2 * 60_000;

    it('uses the configured timeout for the red boundary, not a hardcoded constant', () => {
      // At 60 s elapsed with a 2-min timeout, red SHOULD already be active
      // (60 s == timeoutMs - 60 s). With a hardcoded 19-min threshold, this
      // would still be orange.
      expect(statusColor(60_000, TIMEOUT_2MIN)).toBe(COLORS.accentRed500);
    });

    it('handles an unusually short 90 s configured timeout', () => {
      const TIMEOUT_90S = 90_000;
      // At 30 s, the green→yellow boundary still fires (band is fixed),
      // but the red boundary collapses inward: timeoutMs - 60_000 = 30 000.
      // So 30 s is simultaneously the yellow boundary AND the red boundary.
      // The red check runs FIRST, so red wins (#3757 guarded the
      // configured-timeout-respecting behaviour).
      expect(statusColor(30_000, TIMEOUT_90S)).toBe(COLORS.accentRed500);
    });
  });
});

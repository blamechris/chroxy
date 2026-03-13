import { getActivityLabel, getActivityColor } from '../../components/BackgroundSessionProgress';
import { COLORS } from '../../constants/colors';

describe('BackgroundSessionProgress helpers', () => {
  describe('getActivityLabel', () => {
    it('returns "Thinking..." for thinking state', () => {
      expect(getActivityLabel('thinking')).toBe('Thinking...');
    });

    it('returns "Working..." for busy state', () => {
      expect(getActivityLabel('busy')).toBe('Working...');
    });

    it('returns "Waiting for approval" for waiting state', () => {
      expect(getActivityLabel('waiting')).toBe('Waiting for approval');
    });

    it('returns "Error" for error state', () => {
      expect(getActivityLabel('error')).toBe('Error');
    });

    it('returns null for idle state', () => {
      expect(getActivityLabel('idle')).toBeNull();
    });

    it('includes detail for busy state with tool info', () => {
      expect(getActivityLabel('busy', 'Writing src/index.ts')).toBe('Writing src/index.ts');
    });

    it('includes detail for waiting state', () => {
      expect(getActivityLabel('waiting', 'Edit permission')).toBe('Waiting: Edit permission');
    });
  });

  describe('getActivityColor', () => {
    it('returns accentBlue for thinking', () => {
      expect(getActivityColor('thinking')).toBe(COLORS.accentBlue);
    });

    it('returns accentOrange for busy', () => {
      expect(getActivityColor('busy')).toBe(COLORS.accentOrange);
    });

    it('returns accentOrange for waiting', () => {
      expect(getActivityColor('waiting')).toBe(COLORS.accentOrange);
    });

    it('returns accentRed for error', () => {
      expect(getActivityColor('error')).toBe(COLORS.accentRed);
    });

    it('returns textMuted for idle', () => {
      expect(getActivityColor('idle')).toBe(COLORS.textMuted);
    });
  });
});

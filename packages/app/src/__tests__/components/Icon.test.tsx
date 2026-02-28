import React from 'react';
import { iconMap, getIconName, IconName } from '../../components/Icon';

describe('Icon', () => {
  describe('iconMap', () => {
    it('maps all standard icon keys to Ionicons names', () => {
      const requiredKeys: IconName[] = [
        'camera', 'search', 'settings', 'mic', 'close',
        'check', 'plus', 'folder', 'document', 'cloud',
        'chevronDown', 'chevronRight', 'arrowUp', 'arrowDown',
        'terminal', 'chatbubble', 'stop', 'paperclip',
      ];
      for (const key of requiredKeys) {
        expect(iconMap[key]).toBeDefined();
        expect(typeof iconMap[key]).toBe('string');
      }
    });

    it('does not contain empty strings', () => {
      for (const [key, value] of Object.entries(iconMap)) {
        expect(value).not.toBe('');
      }
    });
  });

  describe('getIconName', () => {
    it('returns the mapped icon name for known keys', () => {
      expect(getIconName('search')).toBe(iconMap.search);
    });

    it('returns undefined for unknown keys', () => {
      expect(getIconName('nonexistent' as never)).toBeUndefined();
    });
  });
});

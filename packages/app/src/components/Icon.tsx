import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';

/**
 * Icon name mapping — maps semantic keys to Ionicons glyph names.
 * This serves as the single source of truth for all icons in the app.
 */
export const iconMap = {
  // Navigation & Actions
  camera: 'camera-outline',
  search: 'search-outline',
  settings: 'settings-outline',
  close: 'close',
  check: 'checkmark',
  plus: 'add',
  send: 'send',
  stop: 'stop-circle-outline',
  mic: 'mic-outline',
  paperclip: 'attach-outline',
  download: 'download-outline',
  export: 'share-outline',
  edit: 'create-outline',

  // Content & Files
  folder: 'folder-outline',
  folderOpen: 'folder-open-outline',
  document: 'document-text-outline',
  diff: 'git-compare-outline',
  cloud: 'cloud-outline',
  clock: 'time-outline',

  // Communication
  chatbubble: 'chatbubble-outline',
  terminal: 'terminal-outline',
  satellite: 'radio-outline',
  link: 'link-outline',

  // Directional
  chevronDown: 'chevron-down',
  chevronLeft: 'chevron-back',
  chevronRight: 'chevron-forward',
  chevronUp: 'chevron-up',
  arrowUp: 'arrow-up',
  arrowDown: 'arrow-down',
  triangleDown: 'caret-down',
  triangleRight: 'caret-forward',

  // Status
  checkCircle: 'checkmark-circle',
  closeCircle: 'close-circle',
  alertCircle: 'alert-circle-outline',
  warning: 'warning-outline',
  bullet: 'ellipse',
  square: 'square',

  // Visibility
  eye: 'eye-outline',
  eyeOff: 'eye-off-outline',

  // Misc
  minus: 'remove',
  gitBranch: 'git-branch-outline',
  returnKey: 'return-down-back',
  checkboxChecked: 'checkbox',
  checkboxUnchecked: 'square-outline',
} as const satisfies Record<string, string>;

/** Semantic icon name — use this to type-check icon references */
export type IconName = keyof typeof iconMap;

/** Look up an Ionicons glyph name by semantic key */
export function getIconName(key: IconName): string {
  return iconMap[key];
}

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
}

/** Render a vector icon by semantic name */
export function Icon({ name, size = 20, color = COLORS.textMuted }: IconProps) {
  const glyphName = iconMap[name];
  if (!glyphName) return null;
  return <Ionicons name={glyphName as keyof typeof Ionicons.glyphMap} size={size} color={color} />;
}

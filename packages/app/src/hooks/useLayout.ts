import { useWindowDimensions } from 'react-native';

/** Breakpoint thresholds (in dp) */
const TABLET_MIN_WIDTH = 768;
const WIDE_MIN_WIDTH = 1024;

export interface LayoutInfo {
  /** Current window width */
  width: number;
  /** Current window height */
  height: number;
  /** True when width >= 768dp (iPad, landscape phones with large screens) */
  isTablet: boolean;
  /** True when width >= 1024dp (large tablets in landscape, desktop) */
  isWide: boolean;
  /** True when width > height */
  isLandscape: boolean;
  /** True when side-by-side layout should be used (tablet + landscape) */
  isSplitView: boolean;
}

/**
 * Reactive layout hook that recalculates on orientation and window changes.
 * Use `isSplitView` to enable side-by-side chat + terminal layouts.
 */
export function useLayout(): LayoutInfo {
  const { width, height } = useWindowDimensions();
  const isTablet = width >= TABLET_MIN_WIDTH;
  const isWide = width >= WIDE_MIN_WIDTH;
  const isLandscape = width > height;
  const isSplitView = isTablet && isLandscape;

  return { width, height, isTablet, isWide, isLandscape, isSplitView };
}

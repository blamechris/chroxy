import { useWindowDimensions } from 'react-native';

const SPLIT_VIEW_MIN_WIDTH = 768;

interface LayoutInfo {
  isSplitView: boolean;
  windowWidth: number;
  windowHeight: number;
}

export function useLayout(): LayoutInfo {
  const { width, height } = useWindowDimensions();
  return {
    isSplitView: width >= SPLIT_VIEW_MIN_WIDTH,
    windowWidth: width,
    windowHeight: height,
  };
}

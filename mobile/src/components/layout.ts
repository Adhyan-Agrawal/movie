import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const BROWSE_MAX_WIDTH = 1180;
export const BROWSE_GAP = 12;

export function browseLayout(windowWidth: number, fontScale = 1, sideInsets = 0) {
  const width = Math.min(BROWSE_MAX_WIDTH, Math.max(240, windowWidth - sideInsets));
  const gutter = width >= 700 ? 32 : 20;
  const available = width - gutter * 2;
  const minPoster = fontScale > 1.3 ? 140 : 96;
  const columns = Math.max(2, Math.min(width >= 1000 ? 6 : width >= 700 ? 4 : 3, Math.floor((available + BROWSE_GAP) / (minPoster + BROWSE_GAP))));
  return {
    width,
    gutter,
    columns,
    cardWidth: Math.floor((available - BROWSE_GAP * (columns - 1)) / columns),
    shelfWidth: width >= 700 ? 172 : Math.round(available * 0.42),
    landscapeWidth: Math.min(360, Math.round(available * (width >= 700 ? 0.43 : 0.82))),
    wide: width >= 700,
    largeText: fontScale > 1.3,
  };
}

export function useBrowseLayout() {
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return browseLayout(width, fontScale, insets.left + insets.right);
}

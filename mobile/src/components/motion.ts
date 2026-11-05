import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';

/** Motion stays off until the preference is known, and while the app is hidden. */
export function useMotionEnabled() {
  const [reduced, setReduced] = useState(true);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    let alive = true;
    let changed = false;
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      changed = true;
      if (alive) setReduced(value);
    });
    const state = AppState.addEventListener('change', (value) => {
      if (alive) setForeground(value === 'active');
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive && !changed) setReduced(value);
    }).catch(() => {});
    return () => { alive = false; motion.remove(); state.remove(); };
  }, []);
  return !reduced && foreground;
}

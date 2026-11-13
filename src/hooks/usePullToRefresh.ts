import { useEffect, useRef, useState, type RefObject } from 'react';

const START_THRESHOLD = 12;
const TRIGGER_DISTANCE = 72;
const MAX_DISTANCE = 110;

/**
 * Pull-down gesture that refreshes the photo timeline instead of letting the
 * browser reload the whole PWA. Works anywhere over the gallery, not only at
 * the very top of the page, and ignores horizontal swipes.
 */
export function usePullToRefresh(
  target: RefObject<HTMLElement | null>,
  onRefresh: () => void,
  enabled: boolean,
): { distance: number; pulled: boolean } {
  const [distance, setDistance] = useState(0);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const pullingRef = useRef(false);
  const distanceRef = useRef(0);
  // Held in a ref so a re-render mid-gesture cannot detach the listeners.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const element = target.current;
    if (!element || !enabled) return;

    const reset = (): void => {
      startRef.current = null;
      pullingRef.current = false;
      distanceRef.current = 0;
      setDistance(0);
    };

    const onStart = (event: TouchEvent): void => {
      if (event.touches.length !== 1) {
        reset();
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      startRef.current = { x: touch.clientX, y: touch.clientY };
      pullingRef.current = false;
    };

    const onMove = (event: TouchEvent): void => {
      const start = startRef.current;
      const touch = event.touches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      // Stop the browser's own pull-to-refresh / overscroll from committing
      // before our gesture has decided what to do. Only relevant at the top,
      // where native refresh can fire.
      if (dy > 0 && window.scrollY <= 8) {
        event.preventDefault();
      }

      if (!pullingRef.current) {
        if (Math.abs(dy) < START_THRESHOLD) return;
        // A horizontal gesture belongs to the lightbox/carousel, not to us.
        if (Math.abs(dx) > Math.abs(dy) * 1.2) {
          startRef.current = null;
          return;
        }
        if (dy <= 0) {
          startRef.current = null;
          return;
        }
        pullingRef.current = true;
      }

      event.preventDefault();
      const next = Math.min(MAX_DISTANCE, Math.max(0, dy * 0.55));
      distanceRef.current = next;
      setDistance(next);
    };

    const onEnd = (): void => {
      const shouldRefresh = distanceRef.current >= TRIGGER_DISTANCE;
      reset();
      if (shouldRefresh) onRefreshRef.current();
    };

    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: false });
    element.addEventListener('touchend', onEnd, { passive: true });
    element.addEventListener('touchcancel', reset, { passive: true });

    return () => {
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
      element.removeEventListener('touchcancel', reset);
    };
  }, [enabled, target]);

  return { distance, pulled: distance >= TRIGGER_DISTANCE };
}

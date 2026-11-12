import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Reports whether an element is within (or near) the viewport.
 * Used to release decrypted preview object URLs once a tile scrolls away while
 * keeping a generous preload margin so scrolling stays smooth.
 */
export function useNearViewport<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setNear(entry.isIntersecting);
      },
      { rootMargin: '1000px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, near];
}

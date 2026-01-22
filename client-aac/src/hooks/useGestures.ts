import { useEffect } from "react";

interface GestureHandlers {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  onCornerTap?: () => void;
}

export function useGestures(handlers: GestureHandlers) {
  useEffect(() => {
    let startX = 0;
    let startY = 0;
    let startTime = 0;

    const handleTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const endTime = Date.now();
      
      const diffX = endX - startX;
      const diffY = endY - startY;
      const diffTime = endTime - startTime;
      
      // Only process quick gestures (under 300ms)
      if (diffTime > 300) return;
      
      const minDistance = 50;
      const absX = Math.abs(diffX);
      const absY = Math.abs(diffY);
      
      // Check for corner taps (bottom-right corner)
      if (
        absX < 30 && 
        absY < 30 && 
        endX > window.innerWidth - 100 && 
        endY > window.innerHeight - 100
      ) {
        handlers.onCornerTap?.();
        return;
      }
      
      // Swipe gestures
      if (absX > absY && absX > minDistance) {
        if (diffX > 0 && startX < 50) {
          // Swipe right from left edge
          handlers.onSwipeRight?.();
        } else if (diffX < 0) {
          // Swipe left
          handlers.onSwipeLeft?.();
        }
      } else if (absY > absX && absY > minDistance) {
        if (diffY > 0) {
          // Swipe down
          handlers.onSwipeDown?.();
        } else {
          // Swipe up
          handlers.onSwipeUp?.();
        }
      }
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handlers]);
}

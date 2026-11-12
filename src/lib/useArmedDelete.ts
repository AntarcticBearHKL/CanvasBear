import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Two-click delete confirmation that is safe against fast clicks.
 *
 * React state alone is not enough here: two clicks can land in the same render
 * closure, so the second click would only arm the button again. The ref is the
 * source of truth for the click handler; state only drives the visual state.
 */
export function useArmedDelete(resetMs = 3000) {
  const [armed, setArmed] = useState<string | null>(null);
  const armedRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clear = useCallback(() => {
    armedRef.current = null;
    setArmed(null);
    clearTimer();
  }, [clearTimer]);

  const arm = useCallback((key: string) => {
    armedRef.current = key;
    setArmed(key);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      armedRef.current = null;
      setArmed(null);
      timerRef.current = null;
    }, resetMs);
  }, [clearTimer, resetMs]);

  const requestDelete = useCallback((key: string, onDelete: () => void) => {
    if (armedRef.current !== key) {
      arm(key);
      return false;
    }
    clear();
    onDelete();
    return true;
  }, [arm, clear]);

  useEffect(() => clearTimer, [clearTimer]);

  return { armed, requestDelete, clear };
}

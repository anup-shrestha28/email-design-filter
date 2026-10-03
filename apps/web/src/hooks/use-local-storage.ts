"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * Per-viewer convenience state (pane widths, collapsed groups). Renders the fallback on the
 * server and during hydration, then applies the stored value; always survives blocked storage.
 */
export function useLocalStorage<T>(key: string, fallback: T, validate: (v: unknown) => v is T) {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return;
      const parsed: unknown = JSON.parse(raw);
      if (validate(parsed)) setValue(parsed);
    } catch {
      // storage unavailable: keep the fallback
    }
    // validate is expected to be a stable module-level function
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // storage unavailable (private mode): keep in memory only
      }
    },
    [key],
  );
  return [value, set] as const;
}

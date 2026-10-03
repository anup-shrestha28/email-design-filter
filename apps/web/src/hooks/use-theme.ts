"use client";
import { useCallback, useLayoutEffect, useState } from "react";
import { readThemeCookie, THEME_COOKIE, type ThemePreference } from "@/lib/theme";

function apply(pref: ThemePreference) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

/** Read and change the theme preference (cookie + data-theme on <html>). */
export function useTheme(): { theme: ThemePreference; setTheme: (t: ThemePreference) => void } {
  const [theme, setThemeState] = useState<ThemePreference>(() =>
    typeof document === "undefined" ? "system" : readThemeCookie(document.cookie),
  );

  // React's dev-mode remount can clear attributes set by the inline script: re-apply before paint.
  useLayoutEffect(() => {
    apply(readThemeCookie(document.cookie));
  }, []);

  const setTheme = useCallback((next: ThemePreference) => {
    apply(next);
    document.cookie =
      next === "system"
        ? `${THEME_COOKIE}=; path=/; max-age=0; SameSite=Lax`
        : `${THEME_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
    setThemeState(next);
  }, []);

  return { theme, setTheme };
}

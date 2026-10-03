/** Theme preference: stored in a cookie so both static and dynamic pages can apply it before paint. */
export const THEME_COOKIE = "edf-theme";
export type ThemePreference = "system" | "light" | "dark";

/** Runs before first paint (inline script). Sets data-theme on <html> from the cookie, if any. */
export const THEME_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(light|dark)(?:;|$)/);if(m)document.documentElement.setAttribute("data-theme",m[1]);}catch(e){}})();`;

export function readThemeCookie(cookie: string): ThemePreference {
  const m = new RegExp(`(?:^|; )${THEME_COOKIE}=(light|dark)(?:;|$)`).exec(cookie);
  return m ? (m[1] as "light" | "dark") : "system";
}

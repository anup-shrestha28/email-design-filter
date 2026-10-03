"use client";
import { useEffect, useRef } from "react";

export interface Hotkey {
  /** "j", "shift+?", "mod+k", or a two-key sequence "g i". */
  keys: string;
  /** Return false to decline (the key then keeps its default behaviour). */
  handler: (event: KeyboardEvent) => void | boolean;
  /** Also fire while focus is in a text field (default false). */
  allowInInput?: boolean;
  enabled?: boolean;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range"].includes(type);
  }
  return el.getAttribute("role") === "combobox";
}

/** A modal (dialog, sheet, menu) is open: page-level shortcuts pause. */
function overlayOpen(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"][data-open]',
    ),
  );
}

function matches(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  const mod = parts.includes("mod");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  const isMod = e.metaKey || e.ctrlKey;
  if (mod !== isMod) return false;
  if (alt !== e.altKey) return false;
  if (shift && !e.shiftKey) return false;
  if (!shift && e.shiftKey && key.length === 1 && /[a-z]/.test(key)) return false;
  return e.key.toLowerCase() === key;
}

/** Keyboard shortcuts with two-key sequences ("g i"), ignored while typing or when overlays are open. */
export function useHotkeys(hotkeys: Hotkey[]): void {
  const ref = useRef(hotkeys);
  ref.current = hotkeys;
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.isComposing ||
        (e.repeat && !["j", "k", "arrowdown", "arrowup"].includes(e.key.toLowerCase()))
      )
        return;
      const typing = isTypingTarget(e.target);
      const now = Date.now();
      const prev = pending.current && now - pending.current.at < 1200 ? pending.current.key : null;
      for (const h of ref.current) {
        if (h.enabled === false) continue;
        if (typing && !h.allowInInput) continue;
        if (!h.keys.includes("mod+") && overlayOpen()) continue;
        const seq = h.keys.split(" ");
        if (seq.length === 2) {
          if (prev === seq[0] && matches(seq[1] ?? "", e)) {
            pending.current = null;
            if (h.handler(e) !== false) e.preventDefault();
            return;
          }
          continue;
        }
        if (matches(h.keys, e)) {
          if (h.handler(e) === false) continue;
          e.preventDefault();
          pending.current = null;
          return;
        }
      }
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
        pending.current = { key: e.key.toLowerCase(), at: now };
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

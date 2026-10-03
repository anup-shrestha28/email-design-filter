import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge that knows our custom theme scale (see globals.css `@theme`). */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs"],
      shadow: ["xs", "raised", "overlay", "focus"],
      radius: ["xs"],
    },
  },
});

/** Compose class names; later Tailwind utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

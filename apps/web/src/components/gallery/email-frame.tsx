"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { EMAIL_FRAME_SANDBOX } from "@/components/email/email-viewer";
import { cn } from "@/lib/cn";

export function useElementSize<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSize({ width: el.clientWidth, height: el.clientHeight });
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/**
 * The email itself, served by the viewer origin (edf-view) in a sandboxed iframe — never rendered
 * in the app origin — laid out at `emailWidth` and scaled down to fit `boxWidth`.
 *
 * `interactive=false` (cards): a picture of the top of the email; no pointer events, no scrollbars,
 * out of the tab order and hidden from screen readers (the card itself carries the label).
 */
export function EmailFrame({
  src,
  title,
  emailWidth,
  boxWidth,
  boxHeight,
  interactive = false,
  overscan = 1,
  frameHeight: fixedHeight,
  onLoad,
  className,
}: {
  src: string;
  title: string;
  emailWidth: number;
  boxWidth: number;
  boxHeight: number;
  interactive?: boolean;
  /** Frame height as a multiple of the visible box (cards drift up on hover to show more). */
  overscan?: number;
  /** The frame's height in the email's own px (its whole length, when known), instead of the box's. */
  frameHeight?: number;
  onLoad?: () => void;
  className?: string;
}) {
  const scale = boxWidth > 0 ? Math.min(1, boxWidth / emailWidth) : 1;
  const frameHeight = fixedHeight ?? Math.ceil((boxHeight / scale) * overscan);
  return (
    <div
      className={cn("absolute top-0 left-1/2 origin-top", className)}
      style={{
        width: emailWidth,
        height: frameHeight,
        transform: `translateX(-50%) scale(${scale})`,
      }}
    >
      <iframe
        src={src}
        title={title}
        sandbox={EMAIL_FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        {...(interactive ? {} : { tabIndex: -1, "aria-hidden": true, scrolling: "no" as const })}
        className={cn("block border-0 bg-white", !interactive && "pointer-events-none select-none")}
        style={{ width: emailWidth, height: frameHeight }}
      />
    </div>
  );
}

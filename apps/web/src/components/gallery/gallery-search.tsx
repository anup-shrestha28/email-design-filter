"use client";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { SearchField } from "@/components/ui/search-field";
import { cn } from "@/lib/cn";
import { galleryHref, GALLERY_Q_MAX } from "@/lib/gallery";
import { useGalleryParams } from "./use-gallery-params";

const DEBOUNCE_MS = 250;

/**
 * Search the designs (brand, subject or any words in the email). On the gallery it filters as you type (250 ms after the last key, kept
 * in the URL as `q`); anywhere else, Enter opens the gallery with that search.
 */
export function GallerySearch({
  className,
  inputClassName,
}: {
  className?: string;
  inputClassName?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const onGallery = pathname === "/gallery";
  const { params, setParams, pending } = useGalleryParams();
  const urlQ = onGallery ? params.q : "";
  const [text, setText] = useState(urlQ);
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  const [focused, setFocused] = useState(false);

  // The URL changed from elsewhere (Reset, back button, the other search box): follow it.
  if (urlQ !== lastUrlQ) {
    setLastUrlQ(urlQ);
    if (!focused || text.trim() === lastUrlQ) setText(urlQ);
  }

  useEffect(() => {
    if (!onGallery) return;
    const next = text.trim().slice(0, GALLERY_Q_MAX);
    if (next === urlQ) return;
    // Starting a search is a new history entry (Back clears it); refining it replaces that entry.
    const history = urlQ === "" || next === "" ? "push" : "replace";
    // A new search starts again from page 1.
    const t = setTimeout(
      () => void setParams({ q: next || null, page: null }, { history }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [text, urlQ, onGallery, setParams]);

  return (
    <form
      role="search"
      className={cn("min-w-0", className)}
      onSubmit={(e) => {
        e.preventDefault();
        const q = text.trim();
        if (onGallery)
          void setParams(
            { q: q || null, page: null },
            { history: urlQ === "" ? "push" : "replace" },
          );
        else router.push(galleryHref({ q }) as Route);
      }}
    >
      <SearchField
        value={text}
        onValueChange={setText}
        aria-label="Search designs"
        placeholder="Search brand, subject or words"
        pending={onGallery && pending && text.trim() !== ""}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        data-gallery-search=""
        // The kit's input is h-8; the gallery's search is a touch taller and rounder.
        className={cn("w-full [&_input]:h-10 [&_input]:rounded-lg", inputClassName)}
      />
    </form>
  );
}

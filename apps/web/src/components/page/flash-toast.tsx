"use client";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

/** One-off success message after a redirect (e.g. ?connected=1); then cleans the URL. */
export function FlashToast({ title, description }: { title: string; description?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    toast.success(title, { description });
    router.replace(pathname as Route, { scroll: false });
  }, [description, pathname, router, title]);
  return null;
}

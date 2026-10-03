"use client";
import { useEffect } from "react";
import { markOpened } from "@/server/actions/email";

/** Opening an email in the app counts toward engagement (after a short dwell). */
export function MarkOpened({
  emailId,
  already,
  delayMs = 0,
}: {
  emailId: string;
  already: boolean;
  delayMs?: number;
}) {
  useEffect(() => {
    if (already) return;
    const t = setTimeout(() => void markOpened(emailId), delayMs);
    return () => clearTimeout(t);
  }, [emailId, already, delayMs]);
  return null;
}

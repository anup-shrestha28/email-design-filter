"use client";
import { useQueryStates } from "nuqs";
import { useTransition } from "react";
import { inboxParsers, inboxUrlKeys } from "@/lib/inbox-params";

/** Inbox filters in the URL (nuqs). Changes re-render the server page inside a transition. */
export function useInboxFilters() {
  const [pending, startTransition] = useTransition();
  const [params, setParams] = useQueryStates(inboxParsers, {
    urlKeys: inboxUrlKeys,
    shallow: false,
    clearOnDefault: true,
    scroll: false,
    history: "replace",
    startTransition,
  });
  return { params, setParams, pending };
}

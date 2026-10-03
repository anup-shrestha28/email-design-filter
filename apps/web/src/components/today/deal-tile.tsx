import Link from "next/link";
import type { Route } from "next";
import { SenderAvatar } from "@/components/ui/avatar";
import { DealCountdown } from "@/components/ui/deal-countdown";
import { senderLabel } from "@/lib/avatar";
import type { InboxItem } from "@/server/queries/types";

export function DealTile({ item }: { item: InboxItem }) {
  return (
    <Link
      href={`/email/${item.id}` as Route}
      className="group flex flex-col gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-raised transition-[border-color,transform] duration-150 hover:-translate-y-px hover:border-border-strong"
    >
      <div className="flex items-center gap-2">
        <SenderAvatar name={item.fromName} domain={item.senderDomain} size="sm" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {senderLabel(item.fromName, item.fromAddress)}
        </span>
      </div>
      <p className="line-clamp-2 min-h-[2.5rem] text-[0.8125rem] leading-5 font-medium text-foreground">
        {item.subject ?? "(no subject)"}
      </p>
      {item.deal ? (
        <DealCountdown
          endsAt={item.deal.endsAt}
          hasCode={item.deal.hasCode}
          className="self-start"
        />
      ) : null}
    </Link>
  );
}

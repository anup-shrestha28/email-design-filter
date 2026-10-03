import { SearchX } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function AppNotFound() {
  return (
    <EmptyState
      className="py-24"
      icon={<SearchX />}
      title="We couldn't find that"
      description="It may have been deleted (for example with “This is personal”), or the link is incomplete."
      action={
        <>
          <LinkButton href="/gallery" variant="primary">
            Back to designs
          </LinkButton>
          <LinkButton href="/inbox" variant="secondary">
            Inbox list
          </LinkButton>
        </>
      }
    />
  );
}

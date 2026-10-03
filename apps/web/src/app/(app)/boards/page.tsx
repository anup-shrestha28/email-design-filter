import type { Metadata } from "next";
import { BoardsView } from "@/components/boards/boards-view";
import { PageContainer, PageHeader } from "@/components/page/page-header";
import { listBoards } from "@/server/queries/boards";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Boards" };

/** Your boards: the designs you saved from the gallery, in your own named collections. */
export default async function BoardsPage() {
  const user = await requireUser();
  const boards = await listBoards(user.userId);
  return (
    <PageContainer width="wide">
      <PageHeader
        title="Boards"
        description="Designs you saved from the gallery. Only you can see your boards."
      />
      <BoardsView boards={boards} />
    </PageContainer>
  );
}

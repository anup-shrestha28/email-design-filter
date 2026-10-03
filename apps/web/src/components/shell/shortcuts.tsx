"use client";
import { useRouter } from "next/navigation";
import { DialogBody, Dialog, DialogContent } from "@/components/ui/dialog";
import { KeyCombo } from "@/components/ui/kbd";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useShell } from "./shell-context";

const GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: "Everywhere",
    items: [
      ["⌘ K", "Search or jump to…"],
      ["g d", "Go to the designs"],
      ["g t", "Go to Today"],
      ["g i", "Go to Inbox"],
      ["g s", "Go to Senders"],
      ["g n", "Go to Insights"],
      ["g ,", "Go to Settings"],
      ["?", "Show keyboard shortcuts"],
    ],
  },
  {
    title: "Designs",
    items: [
      ["/", "Search brand or subject"],
      ["← →", "Previous / next design (when one is open)"],
      ["esc", "Close the design"],
    ],
  },
  {
    title: "Inbox",
    items: [
      ["j", "Next email"],
      ["k", "Previous email"],
      ["↵", "Open email"],
      ["e", "Mark done / not done"],
      ["p", "Pin / unpin"],
      ["x", "Select for bulk actions"],
      ["/", "Search the inbox"],
      ["esc", "Clear selection / close preview"],
    ],
  },
];

export function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = useShell();
  return (
    <Dialog open={shortcutsOpen} onOpenChange={(o) => setShortcutsOpen(o)}>
      <DialogContent
        title="Keyboard shortcuts"
        description="Work through your mail without touching the mouse."
        size="lg"
      >
        <DialogBody className="grid gap-6 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-2xs font-medium tracking-[0.06em] text-subtle-foreground uppercase">
                {g.title}
              </h3>
              <dl className="divide-y divide-border">
                {g.items.map(([keys, label]) => (
                  <div
                    key={keys}
                    className="flex items-center justify-between gap-4 py-2 text-[0.8125rem]"
                  >
                    <dt className="text-foreground">{label}</dt>
                    <dd>
                      <KeyCombo keys={keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/** App-wide shortcuts. Page-specific ones (j/k/e/p/x) live in the inbox view. */
export function GlobalHotkeys() {
  const router = useRouter();
  const { setPaletteOpen, setShortcutsOpen, paletteOpen } = useShell();
  useHotkeys([
    { keys: "mod+k", allowInInput: true, handler: () => setPaletteOpen(!paletteOpen) },
    { keys: "g d", handler: () => router.push("/gallery") },
    { keys: "g t", handler: () => router.push("/today") },
    { keys: "g i", handler: () => router.push("/inbox") },
    { keys: "g s", handler: () => router.push("/senders") },
    { keys: "g n", handler: () => router.push("/insights") },
    { keys: "g ,", handler: () => router.push("/settings") },
    { keys: "shift+?", handler: () => setShortcutsOpen(true) },
    {
      keys: "/",
      handler: () => {
        // The page's own search (the inbox's, or the gallery's box that is on screen at this width).
        const search = [
          ...document.querySelectorAll<HTMLInputElement>(
            "[data-inbox-search], [data-gallery-search]",
          ),
        ].find((el) => el.offsetParent !== null);
        if (search) search.focus();
        else setPaletteOpen(true);
      },
    },
  ]);
  return null;
}

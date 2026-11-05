/**
 * Presentation helpers for the gallery's cards (client-safe, pure; unit-tested in
 * test/tests-ui/gallery-ui.test.ts). The verdict rules themselves live in lib/gallery.ts
 * (`verdictOf`); the badge shows the verdict word alone (components/gallery/verdict-badge.tsx).
 */
import type { Verdict } from "./gallery";

interface Groupable {
  id: string;
  sender: { name: string; domain: string | null };
  subject: string | null;
  verdict: Verdict;
  /** Used to pick the group's card: the cleanest version (fewest problems, then best score). */
  problems?: readonly string[];
  score?: number | null;
  /** ISO time: a tie goes to the oldest version (the template as first sent), never list order. */
  receivedAt?: string;
}

/** Same sender, same subject (ignoring case, spacing and punctuation), same verdict. */
export function similarKey(item: Groupable): string {
  const norm = (s: string | null | undefined) =>
    (s ?? "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[\s\p{P}\p{S}]+/gu, " ")
      .trim();
  return `${norm(item.sender.domain) || norm(item.sender.name)}|${norm(item.subject)}|${item.verdict}`;
}

export interface SimilarGroup<T> {
  /**
   * The card shown: the group's cleanest version (fewest listed problems, then the best score,
   * then the oldest), at the place of the group's first member.
   */
  item: T;
  /** The other near-identical designs, in order. */
  similar: T[];
}

/**
 * Collapses near-identical designs (the same template sent again: same sender, subject and verdict)
 * into one card with a "+N similar" badge. Keeps the list's order; an email without a subject is
 * never grouped (there's nothing to tell it apart by).
 */
export function groupSimilar<T extends Groupable>(items: readonly T[]): SimilarGroup<T>[] {
  const groups: SimilarGroup<T>[] = [];
  const byKey = new Map<string, SimilarGroup<T>>();
  for (const item of items) {
    if (!item.subject?.trim()) {
      groups.push({ item, similar: [] });
      continue;
    }
    const key = similarKey(item);
    const g = byKey.get(key);
    if (g) g.similar.push(item);
    else {
      const next = { item, similar: [] };
      byKey.set(key, next);
      groups.push(next);
    }
  }
  return groups.map((g) => {
    if (g.similar.length === 0) return g;
    const all = [g.item, ...g.similar];
    // Fewest listed problems, then the best score, then the oldest, then the id: deterministic, so
    // a tie never falls to whichever copy happens to be newest (e.g. a doctored re-send).
    const rank = (x: T) =>
      [x.problems?.length ?? 0, -(x.score ?? -1), x.receivedAt ?? "", x.id] as const;
    const better = (a: T, b: T) => {
      const [pa, sa, ta, ia] = rank(a);
      const [pb, sb, tb, ib] = rank(b);
      if (pa !== pb) return pa < pb;
      if (sa !== sb) return sa < sb;
      if (ta !== tb) return ta < tb;
      return ia < ib;
    };
    let best = all[0]!;
    for (const x of all.slice(1)) if (better(x, best)) best = x;
    return best === g.item ? g : { item: best, similar: all.filter((x) => x !== best) };
  });
}

/**
 * Presentation rules for the gallery's verdicts (client-safe, pure; unit-tested in
 * test/tests-ui/gallery-ui.test.ts). The verdict rules themselves live in lib/gallery.ts
 * (`verdictOf`); this file only decides how a verdict and its score are shown together, so the two
 * can never contradict each other on screen.
 */
import { GOOD_SCORE_MIN, type Verdict } from "./gallery";

/**
 * Below this a score reads as "poor" (DESIGN-SCORE §3.1). A Bad verdict can come from a severe,
 * visible problem at any score, but its number is then capped low by the engine; a Bad badge never
 * shows a number at or above this.
 */
const BAD_SCORE_SHOWN_BELOW = 70;

/**
 * The score to print next to the verdict word, or null to show the word alone. The number is always
 * drawn in the verdict's own colour, and is left out whenever it would seem to argue with the word:
 *  - Good → always (Good needs ≥ 85, so the number agrees).
 *  - Okay → only below the Good threshold. An Okay at 85+ is one that isn't fully checked yet
 *    (e.g. its layout checks are still provisional); "Okay · 98" would read as a contradiction.
 *  - Bad  → never on cards: the reason line says what's wrong, and a capped Bad (up to 69) could
 *    otherwise read as better than an Okay beside it. The detail view's large badge (`detail`)
 *    shows it below 70.
 *  - Not scored yet → never.
 */
export function shownScore(
  verdict: Verdict,
  score: number | null | undefined,
  opts: { detail?: boolean } = {},
): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const s = Math.round(score);
  switch (verdict) {
    case "good":
      return s;
    case "ok":
      return s < GOOD_SCORE_MIN ? s : null;
    case "bad":
      return opts.detail === true && s < BAD_SCORE_SHOWN_BELOW ? s : null;
    default:
      return null;
  }
}

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

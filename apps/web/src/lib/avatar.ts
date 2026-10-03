/** Deterministic sender avatars: initials + a colour derived from the sender domain. Never remote images. */
const HUES = [264, 212, 188, 160, 142, 96, 64, 38, 20, 350, 322, 292];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatarHue(key: string): number {
  return HUES[hash(key.toLowerCase()) % HUES.length] ?? 264;
}

export function initialsOf(name: string | null, fallback: string | null): string {
  const source = (name ?? "").replace(/[^\p{L}\p{N}\s&]/gu, " ").trim();
  if (source) {
    const words = source.split(/\s+/).filter((w) => w !== "&");
    const first = words[0]?.[0] ?? "";
    const second = words.length > 1 ? (words[1]?.[0] ?? "") : (words[0]?.[1] ?? "");
    return (first + second).toUpperCase();
  }
  const f = (fallback ?? "?").replace(/^www\./, "");
  return (f[0] ?? "?").toUpperCase();
}

export function senderLabel(fromName: string | null, fromAddress: string | null): string {
  return fromName?.trim() || fromAddress || "Unknown sender";
}

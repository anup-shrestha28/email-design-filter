"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { originOf, useViewerReachable, type Reach } from "@/components/email/email-viewer";
import { galleryPreviewUrls } from "@/server/actions/gallery";

/** Signed viewer URLs live 240 s; a frame only starts loading with one younger than this. */
export const URL_FRESH_MS = 200_000;
/** The server answers at most 48 ids per call. */
const BATCH = 48;
/** Requests that arrive within this window go out together. */
const BATCH_DELAY_MS = 60;
/**
 * A failed request is retried this many times per card, with growing gaps (≈ 90 s in all) before
 * giving up: long enough to ride out a deploy or a cold start (the first request after
 * `pnpm dev` compiles the Server Action, which can take 20–40 s).
 */
export const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000];
/** While the viewer looks unreachable, check it again this often (a tiny static image). */
const REPROBE_MS = 5_000;

export type PreviewEntry =
  | { state: "ready"; url: string; at: number }
  /** Not previewable (not the caller's, security mail, disconnected mailbox): never retried. */
  | { state: "none"; at: number }
  /**
   * The request failed (offline, a deploy, a rate limit). Retried per card after `retryAt`, up to
   * MAX_ATTEMPTS in all; after that the card shows its own "Preview unavailable".
   */
  | { state: "error"; at: number; attempts: number; retryAt: number };

/** The mode a signed viewer URL was minted for (`/v/{kid}.{exp}.{mode}.{sig}/{id}`), or null. */
export function viewModeOf(url: string): "img" | "noimg" | "card" | null {
  const m = /\/v\/[A-Za-z0-9_-]+\.\d+\.(img|noimg|card)\.[A-Za-z0-9_-]+\//.exec(url);
  return m ? (m[1] as "img" | "noimg" | "card") : null;
}

export function isFresh(
  e: PreviewEntry | undefined,
  now = Date.now(),
): e is Extract<PreviewEntry, { state: "ready" }> {
  return e?.state === "ready" && now - e.at < URL_FRESH_MS;
}

/** True when this entry has failed for good (every retry used). */
export function gaveUp(e: PreviewEntry | undefined): boolean {
  return e?.state === "error" && e.attempts >= MAX_ATTEMPTS;
}

/**
 * Lazily minted preview URLs, batched: cards ask for their URL when they come near the viewport,
 * and the asks of one moment go out as one Server Action call (≤ 48 ids). URLs are kept with the
 * time they were minted and reused until they're about to expire — for the whole browser session,
 * not just one visit to the gallery (the store outlives the page component).
 *
 * One failed call never condemns the whole batch: each of its ids is retried on its own, with
 * backoff, so one bad moment (or one bad id) only ever affects the cards it really concerns.
 */
export class PreviewUrlStore {
  private entries = new Map<string, PreviewEntry>();
  private queued = new Set<string>();
  private inflight = new Set<string>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private successListeners = new Set<() => void>();
  /** The viewer origin, known once the first URL arrives (for the reachability probe). */
  origin: string | null = null;

  constructor(
    private readonly fetchUrls: (
      ids: string[],
    ) => Promise<Record<string, string>> = galleryPreviewUrls,
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  /** Called after every call that returned URLs (the viewer probe re-checks then). */
  onSuccess(l: () => void) {
    this.successListeners.add(l);
    return () => {
      this.successListeners.delete(l);
    };
  }

  get(id: string): PreviewEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Forget every card that gave up (every retry used), so it asks again — called when the tab
   * becomes visible or the browser comes back online. Cards that can't be previewed stay as they are.
   */
  retryFailed() {
    let changed = false;
    for (const [id, e] of this.entries) {
      if (gaveUp(e)) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /**
   * Ask for a fresh URL for `id`. A no-op while one is fresh, queued or on its way, for an id that
   * can't be previewed, and for a failed one before its retry time (or after its last attempt).
   */
  request(id: string, now = Date.now()): void {
    const e = this.entries.get(id);
    if (e?.state === "none" || isFresh(e, now) || this.queued.has(id) || this.inflight.has(id))
      return;
    if (e?.state === "error" && (e.attempts >= MAX_ATTEMPTS || now < e.retryAt)) return;
    this.queued.add(id);
    if (this.timer === null) this.timer = setTimeout(this.flush, BATCH_DELAY_MS);
  }

  /**
   * URLs the server already minted into the page (the first screen of cards), so those previews
   * start loading without waiting for a round trip. `mintedAt` is the server's clock; the entry's
   * age counts from the earlier of that and now, so a skewed client clock can only make it expire
   * sooner, never later than the token does.
   */
  seed(urls: Record<string, string>, mintedAt: number, now = Date.now()): boolean {
    const at = Math.min(mintedAt, now);
    if (now - at >= URL_FRESH_MS) return false;
    let changed = false;
    for (const [id, url] of Object.entries(urls)) {
      if (typeof url !== "string" || isFresh(this.entries.get(id), now)) continue;
      this.entries.set(id, { state: "ready", url, at });
      if (!this.origin) this.origin = originOf(url);
      changed = true;
    }
    return changed;
  }

  /** Tell subscribers the entries changed (after a seed, which is silent: it runs during render). */
  announce(): void {
    this.notify();
  }

  /** Start over for `id` (the detail view's "Try again"): forget its failures and ask now. */
  retry(id: string): void {
    if (this.entries.get(id)?.state === "error") this.entries.delete(id);
    this.request(id);
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  private attemptsOf(id: string): number {
    const e = this.entries.get(id);
    return e?.state === "error" ? e.attempts : 0;
  }

  /**
   * Sends the queue: ids asking for the first time go out together, in calls of ≤ 48 (a page of 96
   * cards is two calls, sent side by side); an id that has failed before goes out on its own, so a
   * batch that keeps failing can't take other cards down with it.
   */
  private flush = () => {
    this.timer = null;
    const queued = [...this.queued];
    const retrying = queued.filter((id) => this.attemptsOf(id) > 0);
    const first = queued.filter((id) => this.attemptsOf(id) === 0);
    const batches: string[][] = [];
    for (let i = 0; i < first.length; i += BATCH) batches.push(first.slice(i, i + BATCH));
    for (const id of retrying) batches.push([id]);
    for (const ids of batches) this.send(ids);
  };

  private send(ids: string[]) {
    for (const id of ids) {
      this.queued.delete(id);
      this.inflight.add(id);
    }
    const at = Date.now();
    this.fetchUrls(ids)
      .then((urls) => {
        for (const id of ids) {
          const url = urls[id];
          this.entries.set(id, url ? { state: "ready", url, at } : { state: "none", at });
          if (url && !this.origin) this.origin = originOf(url);
        }
        if (ids.some((id) => urls[id])) for (const l of this.successListeners) l();
      })
      .catch(() => {
        const now = Date.now();
        for (const id of ids) {
          const attempts = this.attemptsOf(id) + 1;
          const wait = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
          // A little jitter, so retries after a shared failure don't all land at once.
          const retryAt = now + wait + Math.floor(Math.random() * 400);
          this.entries.set(id, { state: "error", at: now, attempts, retryAt });
        }
      })
      .finally(() => {
        for (const id of ids) this.inflight.delete(id);
        this.notify();
        if (this.queued.size && this.timer === null) this.timer = setTimeout(this.flush, 0);
      });
  }
}

// ───────────────────────── load scheduler ─────────────────────────

/** At most this many card previews load at the same time (the rest wait their turn). */
export const MAX_CONCURRENT_LOADS = 6;
/** A preview that hasn't finished loading after this long gives its slot to the next card. */
const LOAD_TIMEOUT_MS = 15_000;

/** 0 = on screen, 1 = near the screen. Lower goes first. */
export type LoadPriority = 0 | 1;

export type Waiter = { priority: LoadPriority; seq: number; grant: () => void };

/**
 * Hands out "you may load now" turns to card previews: at most MAX_CONCURRENT_LOADS at once, cards
 * on screen before cards merely near it, and in the order they asked within a priority. A card
 * keeps its turn until its preview loads (or LOAD_TIMEOUT_MS passes).
 */
export class LoadScheduler {
  private waiting = new Map<string, Waiter>();
  private active = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(private readonly max = MAX_CONCURRENT_LOADS) {}

  /** Wait for a turn (or update the priority of a pending wait). Returns a cancel function. */
  enqueue(id: string, priority: LoadPriority, grant: () => void): () => void {
    const existing = this.waiting.get(id);
    this.waiting.set(id, { priority, seq: existing?.seq ?? this.seq++, grant });
    this.pump();
    return () => {
      this.waiting.delete(id);
    };
  }

  /** The preview for `id` finished (or was dropped): free its slot. */
  done(id: string): void {
    const t = this.active.get(id);
    if (t === undefined) return;
    clearTimeout(t);
    this.active.delete(id);
    this.pump();
  }

  get activeCount(): number {
    return this.active.size;
  }

  private pump() {
    while (this.active.size < this.max && this.waiting.size > 0) {
      let best: [string, Waiter] | null = null;
      for (const entry of this.waiting) {
        const [, w] = entry;
        if (
          !best ||
          w.priority < best[1].priority ||
          (w.priority === best[1].priority && w.seq < best[1].seq)
        )
          best = entry;
      }
      if (!best) return;
      const [id, w] = best;
      this.waiting.delete(id);
      this.active.set(
        id,
        setTimeout(() => this.done(id), LOAD_TIMEOUT_MS),
      );
      w.grant();
    }
  }
}

// ───────────────────────── React glue ─────────────────────────

/**
 * One store and one scheduler per browser tab: going away and coming back keeps minted URLs. On the
 * server every render gets its own (a module-level store there would be shared between users).
 */
let sharedStore: PreviewUrlStore | null = null;
let sharedDetailStore: PreviewUrlStore | null = null;
let sharedScheduler: LoadScheduler | null = null;
const onServer = typeof window === "undefined";
/** Cards: "card" URLs (only the first few images proxied, FREE-TIER.md §8.4). */
function getStore(): PreviewUrlStore {
  return onServer ? new PreviewUrlStore() : (sharedStore ??= new PreviewUrlStore());
}
/** The opened design: "img" URLs (every image). */
const fetchDetailUrls = (ids: string[]) => galleryPreviewUrls(ids, "img");
function getDetailStore(): PreviewUrlStore {
  return onServer
    ? new PreviewUrlStore(fetchDetailUrls)
    : (sharedDetailStore ??= new PreviewUrlStore(fetchDetailUrls));
}
function getScheduler(): LoadScheduler {
  return onServer ? new LoadScheduler() : (sharedScheduler ??= new LoadScheduler());
}

/** URLs the server minted with the page (see PreviewUrlStore.seed). */
export interface SeedUrls {
  mintedAt: number;
  urls: Record<string, string>;
}

interface PreviewContextValue {
  store: PreviewUrlStore;
  detailStore: PreviewUrlStore;
  scheduler: LoadScheduler;
  reach: Reach;
  retryReach: () => void;
}

const PreviewContext = createContext<PreviewContextValue | null>(null);

/** The gallery's previews: the shared URL store and load scheduler, plus a viewer reachability probe. */
export function PreviewUrlProvider({
  seed,
  children,
}: {
  seed?: SeedUrls | null;
  children: ReactNode;
}) {
  const [store] = useState(getStore);
  const [detailStore] = useState(getDetailStore);
  // Seeded while rendering (on the client only), so it's in place before any card asks.
  const [seeded, setSeeded] = useState<SeedUrls | null>(null);
  if (!onServer && seed && seed !== seeded) {
    setSeeded(seed);
    store.seed(seed.urls, seed.mintedAt);
  }
  useEffect(() => {
    if (seeded) store.announce();
  }, [seeded, store]);
  const [scheduler] = useState(getScheduler);
  const [origin, setOrigin] = useState<string | null>(() => store.origin);
  useEffect(
    () =>
      store.subscribe(() => {
        if (store.origin) setOrigin(store.origin);
      }),
    [store],
  );
  const [probe, retryReach] = useViewerReachable(origin);
  // No URL yet means nothing to probe: treat as "checking" rather than "unreachable".
  const reach: Reach = origin ? probe : "checking";

  // Cards that gave up try again when the tab comes back into view or the network returns.
  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== "visible") return;
      store.retryFailed();
      detailStore.retryFailed();
      retryReach();
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("online", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("online", again);
    };
  }, [store, detailStore, retryReach]);

  // An unreachable viewer is checked again after the next URLs arrive, and every so often.
  useEffect(() => {
    if (reach !== "unreachable") return;
    const off = store.onSuccess(retryReach);
    const t = setInterval(retryReach, REPROBE_MS);
    return () => {
      off();
      clearInterval(t);
    };
  }, [reach, store, retryReach]);

  return (
    <PreviewContext.Provider value={{ store, detailStore, scheduler, reach, retryReach }}>
      {children}
    </PreviewContext.Provider>
  );
}

function usePreviewContext(): PreviewContextValue {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error("usePreviewUrl must be used inside <PreviewUrlProvider>");
  return ctx;
}

/**
 * The current entry for `id`, plus ways to ask for a (fresh) URL and the viewer's reachability.
 * `kind` "card" (the grid) or "detail" (the opened design, every image loaded).
 */
export function usePreviewUrl(id: string, kind: "card" | "detail" = "card") {
  const ctx = usePreviewContext();
  const { reach, retryReach } = ctx;
  const store = kind === "detail" ? ctx.detailStore : ctx.store;
  const entry = useSyncExternalStore(
    store.subscribe,
    () => store.get(id),
    () => undefined,
  );
  const request = useCallback(() => store.request(id), [store, id]);
  const retry = useCallback(() => store.retry(id), [store, id]);
  return { entry, request, retry, reach, retryReach };
}

/**
 * Keeps a URL coming for `id` while `active`: asks when there's no fresh one, and after a failure
 * asks again at the entry's retry time (per card, with backoff) until it gives up.
 */
export function useRequestWhile(
  active: boolean,
  entry: PreviewEntry | undefined,
  request: () => void,
): void {
  const fresh = isFresh(entry);
  const retryAt = entry?.state === "error" && !gaveUp(entry) ? entry.retryAt : null;
  useEffect(() => {
    if (!active || fresh) return;
    if (retryAt === null) {
      request();
      return;
    }
    const t = setTimeout(request, Math.max(0, retryAt - Date.now()) + 25);
    return () => clearTimeout(t);
  }, [active, fresh, retryAt, request]);
}

/**
 * A turn to load this card's preview. `want` = the card would like to load now (near the screen,
 * URL in hand); `priority` 0 when on screen. Once granted, the turn is kept until `release()`.
 */
export function useLoadTurn(id: string, want: boolean, priority: LoadPriority) {
  const { scheduler } = usePreviewContext();
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (!want || granted) return;
    return scheduler.enqueue(id, priority, () => setGranted(true));
  }, [scheduler, id, want, granted, priority]);
  // An unmounted card gives its slot back.
  useEffect(() => () => scheduler.done(id), [scheduler, id]);
  const release = useCallback(() => scheduler.done(id), [scheduler, id]);
  return { granted, release };
}

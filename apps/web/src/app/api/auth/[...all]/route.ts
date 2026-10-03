/**
 * Better Auth endpoints (DESIGN.md §4.1) with the free-tier guards (FREE-TIER.md §8.4):
 *  - the Google callback is the ONLY unauthenticated route allowed to open a database connection
 *    (route class "signin"). Before any database work it must carry Better Auth's OAuth state
 *    cookie, decrypting under our secrets, unexpired and matching the `state` parameter: a cookie
 *    only our own sign-in start can mint, so forged or garbage callbacks never wake Neon;
 *  - the development-only email sign-in paths are a plain 404 in production (Better Auth has them
 *    turned off there), before the breaker, so they never wake Neon either;
 *  - breaker: more than 10 sign-in database wakes in a day → 503 until tomorrow, plus an alert.
 *    A wake is counted only when the callback's handler first reaches for a database connection,
 *    which Better Auth does only after Google accepted the code: a script that mints genuine state
 *    cookies through our sign-in start but sends bogus codes never touches Neon, so it can neither
 *    wake it nor trip the breaker (C1-11). The count runs before that first connection is handed
 *    out, so a tripped breaker still answers 503 before Better Auth reads anything. Once tripped,
 *    the instance remembers it until the database's next midnight, so further requests get their
 *    503 without waking the database again.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { toNextJsHandler } from "better-auth/next-js";
import { symmetricDecrypt } from "better-auth/crypto";
import { runWithRouteClass, withSystem, type pg } from "@edf/db";
import { auth } from "@/server/auth";
import { getPool, rawPool } from "@/server/db";
import { meterRequest } from "@/server/metering";
import { env, IS_PROD } from "@/env";

export const dynamic = "force-dynamic";
const SIGNIN_WAKES_PER_DAY = 10;
const CALLBACK_PREFIX = "/api/auth/callback/";
const EMAIL_PATHS = new Set(["/api/auth/sign-in/email", "/api/auth/sign-up/email"]);

const NO_STORE = { "Cache-Control": "no-store" };
/** Epoch ms of the database's next midnight while the breaker is tripped (this instance only). */
let trippedUntil = 0;

/**
 * One sign-in callback's breaker gate: `check` is the breaker check its first connection request
 * started (every later request in the same callback waits on the same one); `tripped` records that
 * it found the breaker tripped. `bypass` marks the breaker check's own connection.
 */
interface SigninGate {
  check?: Promise<boolean>;
  tripped?: boolean;
  bypass?: boolean;
}
const signinGate = new AsyncLocalStorage<SigninGate>();
const gatedPools = new WeakSet<object>();

class SigninBreakerTripped extends Error {
  constructor() {
    super("Sign-in breaker tripped (FREE-TIER.md §8.4)");
    this.name = "SigninBreakerTripped";
  }
}

type ConnectCallback = (err: Error | undefined, client?: pg.PoolClient, done?: (release?: unknown) => void) => void;

/**
 * Route the pool's connection requests made inside a sign-in callback through the breaker: the
 * first one counts the wake (and waits for the answer) before any connection is handed out, and
 * when the breaker is tripped every request fails, so Better Auth gives up without a query.
 * Requests from anywhere else pass straight through. pg-pool's own `query()` goes through
 * `this.connect`, so patching the instance catches both.
 */
function gatePool(pool: pg.Pool): void {
  if (gatedPools.has(pool)) return;
  gatedPools.add(pool);
  const connect = pool.connect.bind(pool) as (cb?: ConnectCallback) => Promise<pg.PoolClient> | undefined;
  (pool as unknown as { connect: (cb?: ConnectCallback) => Promise<pg.PoolClient> | undefined }).connect = (cb) => {
    const gate = signinGate.getStore();
    if (!gate || gate.bypass) return connect(cb);
    gate.check ??= signinGate.run({ bypass: true }, () => breakerTripped());
    const open = gate.check.then((tripped) => {
      if (!tripped) return;
      gate.tripped = true;
      throw new SigninBreakerTripped();
    });
    if (cb) {
      open.then(
        () => void connect(cb),
        (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))),
      );
      return undefined;
    }
    return open.then(() => connect() as Promise<pg.PoolClient>);
  };
}

function stateCookie(header: string): string | null {
  const m = /(?:^|;\s*)(?:__Secure-)?edf\.oauth_state=([^;]*)/.exec(header);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * The same checks Better Auth's cookie state strategy makes (better-auth/dist/state.mjs), with no
 * database: the cookie decrypts under our secrets, has not expired and names this `state`.
 */
async function validOAuthState(request: Request, url: URL): Promise<boolean> {
  const state = url.searchParams.get("state");
  const cookie = stateCookie(request.headers.get("cookie") ?? "");
  if (!state || !cookie) return false;
  try {
    const { secretConfig } = await auth().$context;
    const data = JSON.parse(await symmetricDecrypt({ key: secretConfig, data: cookie })) as { oauthState?: unknown; expiresAt?: unknown };
    return data.oauthState === state && typeof data.expiresAt === "number" && data.expiresAt > Date.now();
  } catch {
    return false;
  }
}

async function breakerTripped(): Promise<boolean> {
  if (Date.now() < trippedUntil) return true;
  const pool = await getPool();
  const row = await withSystem(pool, async (_db, c) => {
    const r = await c.query<{ n: number; until: Date }>(
      `UPDATE system_state
          SET signin_wake_count = CASE WHEN signin_wake_day = current_date THEN signin_wake_count + 1 ELSE 1 END,
              signin_wake_day = current_date, updated_at = now()
        RETURNING signin_wake_count AS n, (current_date + 1)::timestamptz AS until`,
    );
    return r.rows[0];
  });
  if ((row?.n ?? 0) <= SIGNIN_WAKES_PER_DAY) return false;
  trippedUntil = row ? new Date(row.until).getTime() : 0;
  // Tell the owner (§8.4 item 2, §8.5). Every instance that finds the breaker tripped in the
  // database asks once (after that it answers from memory), and raiseAlert sends the code at most
  // every 6 h and gives the mark back when GitHub fails, so a failed send is retried by the next
  // instance instead of being lost. Loaded only here: the pipeline barrel is heavy.
  if (row) {
    const e = env();
    await import("@edf/pipeline")
      .then(({ raiseAlert }) => raiseAlert(pool, { token: e.GITHUB_ALERT_TOKEN, repo: e.GITHUB_ALERT_REPO }, "SIGNIN_BREAKER", { wakes: row.n }))
      .catch(() => false); // alerting never changes the answer
  }
  return true;
}

async function handle(request: Request, method: "GET" | "POST"): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (IS_PROD && EMAIL_PATHS.has(pathname)) return new Response("Not found", { status: 404, headers: NO_STORE });
  const handlers = toNextJsHandler(auth());
  if (!pathname.startsWith(CALLBACK_PREFIX) && !EMAIL_PATHS.has(pathname)) {
    return runWithRouteClass("authed", () => handlers[method](request));
  }
  if (pathname.startsWith(CALLBACK_PREFIX) && !(await validOAuthState(request, url))) {
    return new Response("Invalid sign-in request", { status: 400, headers: NO_STORE });
  }
  return runWithRouteClass("signin", async () => {
    if (!IS_PROD) return handlers[method](request);
    const unavailable = () =>
      new Response("Sign-in is temporarily unavailable. Please try again tomorrow.", {
        status: 503,
        headers: { ...NO_STORE, "Retry-After": "3600" },
      });
    if (Date.now() < trippedUntil) return unavailable();
    gatePool(rawPool());
    const gate: SigninGate = {};
    const res = await signinGate.run(gate, () => handlers[method](request));
    return gate.tripped ? unavailable() : res;
  });
}

export const GET = (request: Request) => meterRequest(() => handle(request, "GET"));
export const POST = (request: Request) => meterRequest(() => handle(request, "POST"));

/**
 * App sign-in with Better Auth (DESIGN.md §4.1; FREE-TIER.md §8.4, §9.1).
 *
 *  - Google sign-in with basic scopes only, from the separate "login" Google Cloud project;
 *    online access, no granted-scope accumulation. Mailboxes are NOT Better Auth accounts.
 *  - Database sessions (7 days, refreshed daily; absolute 30-day cap enforced in session.ts),
 *    `freshAge` 10 min for sensitive actions, a 5-minute signed cookie cache so ordinary page
 *    loads don't wake the database, OAuth state kept in a cookie (no DB before the callback).
 *  - Invite gate: a user row is only created for an address on the invite list, and a session only
 *    for a user still on it (session.ts also signs out a friend whose invite was removed).
 *  - Rate limiting in memory (the WAF is the real limiter); raw IPs are never stored.
 */
import "server-only";
import { betterAuth, APIError } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { nextCookies } from "better-auth/next-js";
import { drizzleForAuthTables, schema as dbSchema, withUser } from "@edf/db";
import { env, IS_PROD } from "@/env";
import { rawPool } from "./db";
import { provisionUserSettings } from "./user-settings";

const DAY = 24 * 60 * 60;

function parseSecrets(raw: string | undefined): Array<{ version: number; value: string }> {
  if (!raw) {
    if (IS_PROD) throw new Error("BETTER_AUTH_SECRETS is required in production");
    return [{ version: 1, value: "development-only-secret-not-for-production-use-000000" }];
  }
  return raw.split(",").map((pair) => {
    const idx = pair.indexOf(":");
    const version = Number(pair.slice(0, idx));
    const value = pair.slice(idx + 1);
    if (!Number.isInteger(version) || version < 1 || value.length < 32) {
      throw new Error("BETTER_AUTH_SECRETS must look like '2:<secret>,1:<secret>' (secrets ≥ 32 chars)");
    }
    return { version, value };
  });
}

function createAuth() {
  const e = env();
  const db = drizzleForAuthTables(rawPool());

  return betterAuth({
    appName: "Email Design Filter",
    baseURL: e.BETTER_AUTH_URL,
    secrets: parseSecrets(e.BETTER_AUTH_SECRETS),
    trustedOrigins: [e.APP_ORIGIN],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: dbSchema.user, session: dbSchema.session, account: dbSchema.account, verification: dbSchema.verification },
    }),
    socialProviders:
      e.GOOGLE_LOGIN_CLIENT_ID && e.GOOGLE_LOGIN_CLIENT_SECRET
        ? {
            google: {
              clientId: e.GOOGLE_LOGIN_CLIENT_ID,
              clientSecret: e.GOOGLE_LOGIN_CLIENT_SECRET,
              accessType: "online",
              includeGrantedScopes: false,
              prompt: "select_account",
            },
          }
        : {},
    // Development only: email + password sign-in so the app runs locally without a Google client.
    // The production boot check refuses EDF_DEV_LOGIN=1, and the invite gate still applies.
    emailAndPassword: { enabled: !IS_PROD && e.EDF_DEV_LOGIN === "1", disableSignUp: false },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: "cookie",
      accountLinking: { enabled: false },
    },
    session: {
      expiresIn: 7 * DAY,
      updateAge: DAY,
      freshAge: 10 * 60,
      cookieCache: { enabled: true, maxAge: 300 },
    },
    rateLimit: { enabled: true, storage: "memory" },
    advanced: {
      useSecureCookies: IS_PROD,
      cookiePrefix: "edf",
      ipAddress: { ipAddressHeaders: ["x-real-ip"], disableIpTracking: true },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const { rows } = await rawPool().query<{ role: string | null }>("SELECT is_invited($1) AS role", [user.email]);
            if (!rows[0]?.role) {
              throw new APIError("FORBIDDEN", { message: "This app is invite-only." });
            }
            return { data: user };
          },
          // Runs after the user row has committed and is never re-run for this user, so a failure here
          // must not strand the account: getSessionUser() re-provisions a missing row (user-settings.ts).
          after: async (user) => {
            await withUser(rawPool(), user.id, async (_db, client) => {
              await provisionUserSettings(client, { id: user.id, email: user.email });
            });
          },
        },
      },
      // Every sign-in, not only the first: a friend whose invite was removed can't sign back in.
      // The owner's invite row can't be removed (remove_invite deletes friends' rows only).
      session: {
        create: {
          before: async (session) => {
            const { rows } = await rawPool().query<{ role: string | null }>(
              `SELECT is_invited(u.email) AS role FROM "user" u WHERE u.id = $1`,
              [session.userId],
            );
            if (!rows[0]?.role) {
              throw new APIError("FORBIDDEN", { message: "This app is invite-only." });
            }
            return { data: session };
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
const g = globalThis as unknown as { __edfAuth?: Auth };

/** Lazily constructed so static pages build without auth secrets. */
export function auth(): Auth {
  g.__edfAuth ??= createAuth();
  return g.__edfAuth;
}

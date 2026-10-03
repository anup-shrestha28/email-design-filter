import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, schema, sql, withUser } from "@edf/db";
import {
  GlobalIncidentError,
  GmailClient,
  MailboxUnavailableError,
  NeedsReauthError,
  OAuthError,
  sealNewMailboxTokens,
  tokenAad,
  TokenProvider,
  TokenRefreshBusyError,
} from "../src/index";
import { HAS_DB } from "./env";
import { fakeFetch, json, type RecordedRequest } from "./fake-http";
import { appPool, createMailbox, createUser, type Pool } from "./helpers";
import { aead, FakeKeyWrapper, makeRing } from "./test-crypto";

const OAUTH = { clientId: "connector-client", clientSecret: "secret" };
const TOKEN_URL = "https://oauth2.googleapis.com/token";

describe.skipIf(!HAS_DB)(
  "TokenProvider (DESIGN §4.4, FREE-TIER §4.2 step 2) against Postgres",
  () => {
    let pool: Pool;
    let userId: string;
    const ring = makeRing();

    beforeAll(async () => {
      pool = appPool();
      userId = await createUser(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });

    /** A fake Google token endpoint: counts refreshes, optional delay and scripted responses. */
    function google(
      opts: {
        delayMs?: number;
        respond?: (n: number, req: RecordedRequest) => Response | Promise<Response>;
      } = {},
    ) {
      let n = 0;
      const f = fakeFetch(async (req) => {
        if (req.url.href !== TOKEN_URL && req.url.href !== "https://oauth2.googleapis.com/revoke")
          return new Response("", { status: 404 });
        if (req.url.href.endsWith("/revoke")) return new Response("", { status: 200 });
        n++;
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.respond) return opts.respond(n, req);
        return json({
          access_token: `access-${n}`,
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        });
      });
      return Object.assign(f, { refreshes: () => n });
    }

    async function connectedMailbox(
      kw: FakeKeyWrapper,
      accessExpiresInMs: number,
      refreshToken = "refresh-1",
    ): Promise<string> {
      return withUser(pool, userId, async (db) => {
        const id = await createMailbox(db, userId);
        const cols = await sealNewMailboxTokens(
          {
            mailboxId: id,
            userId,
            refreshToken,
            accessToken: "access-0",
            expiresAt: new Date(Date.now() + accessExpiresInMs),
          },
          { keyWrapper: kw, accessRing: ring, aead },
        );
        await db.update(schema.mailbox).set(cols).where(eq(schema.mailbox.id, id));
        return id;
      });
    }

    const row = (mailboxId: string) =>
      withUser(pool, userId, async (db) => {
        const [r] = await db
          .select({
            status: schema.mailbox.status,
            statusReason: schema.mailbox.statusReason,
            needsReauthSince: schema.mailbox.needsReauthSince,
            refreshTokenEnc: schema.mailbox.refreshTokenEnc,
            accessTokenEnc: schema.mailbox.accessTokenEnc,
            accessTokenExpiresAt: schema.mailbox.accessTokenExpiresAt,
            dekWrapped: schema.mailbox.dekWrapped,
            kekVersion: schema.mailbox.kekVersion,
            lease: schema.mailbox.refreshLeaseUntil,
          })
          .from(schema.mailbox)
          .where(eq(schema.mailbox.id, mailboxId));
        if (!r) throw new Error("no row");
        return r;
      });

    const provider = (
      kw: FakeKeyWrapper,
      f: typeof fetch,
      extra: Partial<ConstructorParameters<typeof TokenProvider>[0]> = {},
    ) =>
      new TokenProvider({
        pool,
        keyWrapper: kw,
        accessRing: ring,
        oauth: OAUTH,
        fetch: f,
        aead,
        ...extra,
      });

    it("seals new tokens: DEK-sealed refresh token (AAD refresh), keyring-sealed access token (AAD access)", async () => {
      const kw = new FakeKeyWrapper();
      const cols = await sealNewMailboxTokens(
        {
          mailboxId: "m-1",
          userId: "u-1",
          refreshToken: "rt",
          accessToken: "at",
          expiresAt: new Date(1e12),
        },
        { keyWrapper: kw, accessRing: ring, aead },
      );
      expect(kw.generateCalls).toBe(1);
      expect(cols.kekVersion).toBe("local:v1");
      expect(
        aead
          .openWithKeyring(ring, cols.accessTokenEnc, tokenAad("m-1", "u-1", "access"))
          .toString(),
      ).toBe("at");
      expect(() =>
        aead.openWithKeyring(ring, cols.accessTokenEnc, tokenAad("m-1", "u-2", "access")),
      ).toThrow();
      const { dek } = await kw.unwrap({
        mailboxId: "m-1",
        wrapped: cols.dekWrapped,
        kekVersion: cols.kekVersion,
      });
      expect(
        aead.open(dek, cols.refreshTokenEnc, tokenAad("m-1", "u-1", "refresh")).toString(),
      ).toBe("rt");
      expect(() =>
        aead.open(dek, cols.refreshTokenEnc, tokenAad("m-1", "u-1", "access")),
      ).toThrow();
    });

    it("uses the cached access token without calling edf-keys or Google", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 3_600_000);
      const g = google();
      const p = provider(kw, g);
      await expect(p.getAccessToken(userId, m)).resolves.toBe("access-0");
      expect(kw.unwrapCalls).toBe(0);
      expect(g.refreshes()).toBe(0);
    });

    it("refreshes a token expiring within 60 s, stores it sealed and releases the lease", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 30_000);
      const g = google();
      const p = provider(kw, g);
      await expect(p.getAccessToken(userId, m)).resolves.toBe("access-1");
      expect(g.refreshes()).toBe(1);
      expect(kw.unwrapCalls).toBe(1);
      expect(new URLSearchParams(g.calls[0]?.body ?? "").get("refresh_token")).toBe("refresh-1");
      const r = await row(m);
      expect(r.lease).toBeNull();
      expect(
        aead
          .openWithKeyring(ring, r.accessTokenEnc as Buffer, tokenAad(m, userId, "access"))
          .toString(),
      ).toBe("access-1");
      expect(r.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
      // Now cached: no further calls.
      await expect(p.getAccessToken(userId, m)).resolves.toBe("access-1");
      expect(g.refreshes()).toBe(1);
    });

    it("lease race: two concurrent refreshers make exactly one Google call", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, -1000);
      const g = google({ delayMs: 400 });
      const [a, b] = await Promise.all([
        provider(kw, g, { leasePollMs: 50 }).getAccessToken(userId, m),
        provider(kw, g, { leasePollMs: 50 }).getAccessToken(userId, m),
      ]);
      expect(g.refreshes()).toBe(1);
      expect(a).toBe("access-1");
      expect(b).toBe("access-1");
      expect(kw.unwrapCalls).toBe(1);
    });

    it("a Gmail 401 forces a refresh even while the cached token looks valid", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 3_600_000);
      const g = google();
      const p = provider(kw, g);
      const gmail = fakeFetch((req) =>
        req.headers.get("authorization") === "Bearer access-0"
          ? new Response("", { status: 401 })
          : json({ emailAddress: "me@example.com", historyId: "42" }),
      );
      const client = new GmailClient({ getAccessToken: p.forMailbox(userId, m), fetch: gmail });
      await expect(client.getProfile()).resolves.toMatchObject({ historyId: "42" });
      expect(g.refreshes()).toBe(1);
      expect(gmail.calls.map((c) => c.headers.get("authorization"))).toEqual([
        "Bearer access-0",
        "Bearer access-1",
      ]);
    });

    it("invalid_grant → needs_reauth with tokens nulled, only from active; then no more Google calls", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 0);
      const g = google({
        respond: () =>
          json(
            { error: "invalid_grant", error_description: "Token has been expired or revoked." },
            400,
          ),
      });
      const p = provider(kw, g);
      await expect(p.getAccessToken(userId, m)).rejects.toBeInstanceOf(NeedsReauthError);
      const r = await row(m);
      expect(r).toMatchObject({
        status: "needs_reauth",
        statusReason: "invalid_grant",
        refreshTokenEnc: null,
        accessTokenEnc: null,
        dekWrapped: null,
        lease: null,
      });
      expect(r.needsReauthSince).toBeInstanceOf(Date);
      await expect(p.getAccessToken(userId, m)).rejects.toBeInstanceOf(NeedsReauthError);
      expect(g.refreshes()).toBe(1);
    });

    it("invalid_grant never clobbers a reconnect that replaced the refresh token mid-refresh", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 0);
      const g = google({
        respond: async () => {
          // The user reconnects while the old refresh token is being rejected.
          await withUser(pool, userId, async (db) => {
            const cols = await sealNewMailboxTokens(
              {
                mailboxId: m,
                userId,
                refreshToken: "refresh-NEW",
                accessToken: "access-NEW",
                expiresAt: new Date(Date.now() + 3_600_000),
              },
              { keyWrapper: kw, accessRing: ring, aead },
            );
            await db.update(schema.mailbox).set(cols).where(eq(schema.mailbox.id, m));
          });
          return json({ error: "invalid_grant" }, 400);
        },
      });
      const p = provider(kw, g);
      await expect(p.getAccessToken(userId, m)).resolves.toBe("access-NEW");
      const r = await row(m);
      expect(r.status).toBe("active");
      expect(r.refreshTokenEnc).not.toBeNull();
      expect(r.lease).toBeNull();
    });

    it("global incidents (deleted_client) throw without touching the mailbox", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 0);
      const before = await row(m);
      const g = google({ respond: () => json({ error: "deleted_client" }, 401) });
      const err = await provider(kw, g)
        .getAccessToken(userId, m)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GlobalIncidentError);
      expect((err as GlobalIncidentError).kind).toBe("deleted_client");
      const after = await row(m);
      expect(after.status).toBe("active");
      expect(after.refreshTokenEnc?.equals(before.refreshTokenEnc as Buffer)).toBe(true);
      expect(after.lease).toBeNull();
    });

    it("transient Google failures release the lease and surface a retriable error", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 0);
      const g = google({ respond: () => json({ error: "backend_error" }, 503) });
      const err = (await provider(kw, g)
        .getAccessToken(userId, m)
        .catch((e: unknown) => e)) as OAuthError;
      expect(err).toBeInstanceOf(OAuthError);
      expect(err.retriable).toBe(true);
      expect((await row(m)).lease).toBeNull();
    });

    it("stores a lazily re-wrapped DEK after a KEK rotation", async () => {
      const kw = new FakeKeyWrapper("local:v1");
      const m = await connectedMailbox(kw, 0);
      kw.rotate("local:v2");
      const g = google();
      await provider(kw, g).getAccessToken(userId, m);
      const r = await row(m);
      expect(r.kekVersion).toBe("local:v2");
      const { dek } = await kw.unwrap({
        mailboxId: m,
        wrapped: r.dekWrapped as Buffer,
        kekVersion: "local:v2",
      });
      expect(
        aead.open(dek, r.refreshTokenEnc as Buffer, tokenAad(m, userId, "refresh")).toString(),
      ).toBe("refresh-1");
    });

    it("stores a rotated refresh token if Google returns one", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 0);
      const g = google({
        respond: () =>
          json({ access_token: "access-x", expires_in: 3600, refresh_token: "refresh-2" }),
      });
      await provider(kw, g).getAccessToken(userId, m);
      const r = await row(m);
      const { dek } = await kw.unwrap({
        mailboxId: m,
        wrapped: r.dekWrapped as Buffer,
        kekVersion: r.kekVersion,
      });
      expect(
        aead.open(dek, r.refreshTokenEnc as Buffer, tokenAad(m, userId, "refresh")).toString(),
      ).toBe("refresh-2");
    });

    it("gives up with TokenRefreshBusyError when another worker holds the lease too long", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 0);
      await withUser(pool, userId, (db) =>
        db
          .update(schema.mailbox)
          .set({ refreshLeaseUntil: sql`now() + interval '1 minute'` })
          .where(eq(schema.mailbox.id, m)),
      );
      const g = google();
      await expect(
        provider(kw, g, { leaseWaitMs: 300, leasePollMs: 50 }).getAccessToken(userId, m),
      ).rejects.toBeInstanceOf(TokenRefreshBusyError);
      expect(g.refreshes()).toBe(0);
    });

    it("refuses missing, other-tenant and non-active mailboxes", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 3_600_000);
      const other = await createUser(pool);
      const p = provider(kw, google());
      await expect(p.getAccessToken(other, m)).rejects.toMatchObject({ state: "missing" });
      await withUser(pool, userId, (db) =>
        db.update(schema.mailbox).set({ status: "paused" }).where(eq(schema.mailbox.id, m)),
      );
      const err = await p.getAccessToken(userId, m).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MailboxUnavailableError);
      expect((err as MailboxUnavailableError).state).toBe("paused");
    });

    it("revokeGrant revokes the refresh token at Google and leaves the row alone", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 3_600_000);
      const g = google();
      await expect(provider(kw, g).revokeGrant(userId, m)).resolves.toEqual({
        revoked: true,
        alreadyInvalid: false,
        reason: null,
      });
      const revoke = g.calls.find((c) => c.url.href.endsWith("/revoke"));
      expect(new URLSearchParams(revoke?.body ?? "").get("token")).toBe("refresh-1");
      expect((await row(m)).status).toBe("active");
    });

    it("the DEK cache is per provider and never crosses users", async () => {
      const kw = new FakeKeyWrapper();
      const m = await connectedMailbox(kw, 3_600_000);
      const p = provider(kw, google(), { cacheDeks: true });
      await p.revokeGrant(userId, m);
      await p.revokeGrant(userId, m);
      expect(kw.unwrapCalls).toBe(1);
      const other = await createUser(pool);
      await expect(p.revokeGrant(other, m)).rejects.toMatchObject({ state: "missing" });
      // Switching to another user's mailbox evicts the first user's DEKs.
      const otherMailbox = await withUser(pool, other, async (db) => {
        const id = await createMailbox(db, other);
        const cols = await sealNewMailboxTokens(
          {
            mailboxId: id,
            userId: other,
            refreshToken: "r-other",
            accessToken: "a-other",
            expiresAt: new Date(Date.now() + 3_600_000),
          },
          { keyWrapper: kw, accessRing: ring, aead },
        );
        await db.update(schema.mailbox).set(cols).where(eq(schema.mailbox.id, id));
        return id;
      });
      await p.revokeGrant(other, otherMailbox);
      expect(kw.unwrapCalls).toBe(2);
      await p.revokeGrant(userId, m);
      expect(kw.unwrapCalls).toBe(3);
      p.dispose();
      await p.revokeGrant(userId, m);
      expect(kw.unwrapCalls).toBe(4);
    });
  },
);

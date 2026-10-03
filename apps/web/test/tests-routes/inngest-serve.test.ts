/**
 * /api/inngest (FREE-TIER.md §4.7): in cloud mode (INNGEST_DEV unset) every call must carry a valid
 * X-Inngest-Signature made with the signing key or the rotation fallback key, within 5 minutes;
 * unsigned introspection reveals no function details. Only Inngest itself is stood in for (we sign
 * requests as it would); the route, client and function registry are real.
 */
import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endAppPool, fakeFetch } from "./helpers";

const KEY_HEX = randomBytes(32).toString("hex");
const FALLBACK_HEX = randomBytes(32).toString("hex");
const WRONG_HEX = randomBytes(32).toString("hex");
process.env.INNGEST_SIGNING_KEY = `signkey-test-${KEY_HEX}`;
process.env.INNGEST_SIGNING_KEY_FALLBACK = `signkey-test-${FALLBACK_HEX}`;
process.env.INNGEST_EVENT_KEY = "test-event-key-0000";
delete process.env.INNGEST_DEV;
delete process.env.INNGEST_BASE_URL;

/** RFC 8785-style canonical JSON (sorted keys, compact): what Inngest signs for a JSON body. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Inngest's request signature: t=<unix s>&s=hex(HMAC-SHA256(key without "signkey-<env>-", body + t)). */
function signature(body: string, keyHex: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts}&s=${createHmac("sha256", keyHex).update(body + String(ts)).digest("hex")}`;
}

const callBody = canon({
  event: { name: "pipeline/kick", data: { reason: "manual" }, id: "e1", ts: Date.now() },
  events: [{ name: "pipeline/kick", data: { reason: "manual" }, id: "e1", ts: Date.now() }],
  steps: {},
  ctx: { run_id: "01TESTRUN", attempt: 0, disable_immediate_execution: true, use_api: false, stack: { stack: [], current: 0 } },
  version: 2,
});

const fake = fakeFetch([]); // nothing may leave the process

describe("/api/inngest request signing (cloud mode)", () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = fake.fetch;
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await endAppPool();
  });

  async function post(sig: string | null, fnId = "edf-no-such-function", body = callBody): Promise<Response> {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/inngest/route");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sig !== null) headers["x-inngest-signature"] = sig;
    const req = new NextRequest(`https://app.test/api/inngest?fnId=${fnId}&stepId=step`, { method: "POST", headers, body });
    return (POST as unknown as (r: Request, ctx: unknown) => Promise<Response>)(req, { params: Promise.resolve({}) });
  }

  it("refuses unsigned, wrongly signed, tampered and stale calls with 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const [name, sig, body] of [
      ["unsigned", null, callBody],
      ["garbage header", "nonsense", callBody],
      ["wrong key", signature(callBody, WRONG_HEX), callBody],
      ["tampered body", signature(callBody, KEY_HEX), callBody.replace("manual", "connect")],
      ["stale (6 min)", signature(callBody, KEY_HEX, now - 360), callBody],
      ["prefix not stripped", `t=${now}&s=${createHmac("sha256", `signkey-test-${KEY_HEX}`).update(callBody + String(now)).digest("hex")}`, callBody],
    ] as const) {
      const res = await post(sig, "edf-no-such-function", body);
      expect(res.status, name).toBe(401);
    }
  });

  it("accepts the signing key and the rotation fallback key (past the signature check)", async () => {
    for (const key of [KEY_HEX, FALLBACK_HEX]) {
      const res = await post(signature(callBody, key));
      expect(res.status).not.toBe(401);
      // An unknown function id, not an auth failure.
      expect(await res.text()).toMatch(/function|not found/i);
    }
  });

  it("unsigned introspection is refused and reveals no function details or key material", async () => {
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/inngest/route");
    const res = await (GET as unknown as (r: Request, ctx: unknown) => Promise<Response>)(
      new NextRequest("https://app.test/api/inngest"),
      { params: Promise.resolve({}) },
    );
    const text = await res.text();
    expect(text).not.toContain(KEY_HEX);
    expect(text).not.toContain(FALLBACK_HEX);
    expect(text).not.toMatch(/"functions"\s*:\s*\[/);
    expect(res.status).toBe(401);
    expect(JSON.parse(text)).toEqual({ message: "Unauthorized" });
    expect(fake.calls).toHaveLength(0);
  });
});

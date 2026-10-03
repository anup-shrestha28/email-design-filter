/** HTTP-level fakes: a `fetch` that routes requests to a handler and records them. */
export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
  redirect: RequestInit["redirect"];
}

export type Handler = (req: RecordedRequest) => Response | Promise<Response>;

export function fakeFetch(handler: Handler): typeof fetch & { calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
      redirect: init?.redirect,
    };
    calls.push(req);
    return handler(req);
  };
  return Object.assign(f as typeof fetch, { calls });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function googleError(
  status: number,
  reason: string,
  extra: Record<string, unknown> = {},
): Response {
  return json(
    {
      error: {
        code: status,
        message: "secret-body-text user@example.com",
        errors: [{ reason, domain: "global" }],
        ...extra,
      },
    },
    status,
  );
}

/** A streaming body of `total` bytes in 64 KiB chunks, without a content-length header. */
export function streamingJson(total: number): Response {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk.length, total - sent);
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

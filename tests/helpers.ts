// A scripted fetch: each call takes the next step, and every call is recorded.
export const KEY = "ss_test_" + "a".repeat(40);

export function envelope(data: unknown, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    credits_charged: 1,
    credits_remaining: 99,
    cached: false,
    cached_at: null,
    request_id: "req_test",
    data,
    ...extra,
  };
}

export function errorEnvelope(code: string, message = "boom", retryable = false) {
  return { ok: false, error: { code, message, retryable }, credits_charged: 0, request_id: "req_err" };
}

export function json(body: unknown, status = 200) {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface Call {
  path: string;
  query: Record<string, string>;
  method: string | undefined;
  headers: Record<string, string>;
}

function headersOf(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export function scripted(steps: Array<() => Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    calls.push({
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      method: init.method,
      headers: headersOf(init.headers),
    });
    return steps[Math.min(calls.length - 1, steps.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Options that point the tools at a scripted fetch and make retries and polls instant. */
export function opts(steps: Array<() => Response>, extra: Record<string, unknown> = {}) {
  const f = scripted(steps);
  return {
    f,
    options: {
      apiKey: KEY,
      baseUrl: "https://api.test",
      clientOptions: { fetch: f.fetch, sleep: async () => {}, maxRetries: 0, jobPollIntervalMs: 1 },
      ...extra,
    },
  };
}

export const ctx = { toolCallId: "t1", messages: [] } as never;

import { describe, expect, it } from "vitest";
import {
  callEndpoint,
  getComments,
  getCredits,
  getPost,
  getPosts,
  getProfile,
  getTranscript,
  listEndpoints,
  search,
  socialscrapeTools,
  TOOL_NAMES,
} from "../src/index.js";
import { CATALOG } from "../src/catalog.js";
import { ROLES } from "../src/routes.js";
import { ctx, envelope, errorEnvelope, json, opts } from "./helpers.js";

// The tools' `execute` is typed as possibly missing and possibly streaming; these tests call it directly.
async function exec(t: unknown, input: unknown): Promise<any> {
  return (t as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(input, ctx);
}

describe("routing tables", () => {
  it("every role endpoint exists in the catalogue", () => {
    for (const table of Object.values(ROLES)) {
      for (const id of Object.values(table)) expect(CATALOG[id], id).toBeDefined();
    }
  });
  it("the catalogue holds the transcript and account endpoints", () => {
    expect(CATALOG.transcript?.path).toBe("/v1/transcript");
    expect(CATALOG["account.credits"]?.path).toBe("/v1/account/credits");
  });
});

describe("socialscrapeTools", () => {
  it("returns every tool, and only the included ones when asked", () => {
    expect(Object.keys(socialscrapeTools({ apiKey: "k" })).sort()).toEqual([...TOOL_NAMES].sort());
    expect(Object.keys(socialscrapeTools({ apiKey: "k", include: ["getProfile", "search"] })).sort()).toEqual(["getProfile", "search"]);
  });
  it("rejects an unknown tool name", () => {
    expect(() => socialscrapeTools({ include: ["nope" as never] })).toThrow(/unknown tool nope/);
  });
  it("gives each tool a description and an input schema", () => {
    for (const [name, t] of Object.entries(socialscrapeTools({ apiKey: "k" }))) {
      expect((t as { description?: string }).description?.length, name).toBeGreaterThan(40);
      expect((t as { inputSchema?: unknown }).inputSchema, name).toBeDefined();
    }
  });
  it("does not need a key until a tool runs", async () => {
    const saved = process.env.SOCIALSCRAPE_API_KEY;
    delete process.env.SOCIALSCRAPE_API_KEY;
    try {
      const tools = socialscrapeTools();
      const out = await exec(tools.getProfile, { platform: "tiktok", handle: "nasa" });
      expect(out.ok).toBe(false);
      expect(out.error.code).toBe("missing_api_key");
      expect(out.billed).toBe(false);
    } finally {
      if (saved !== undefined) process.env.SOCIALSCRAPE_API_KEY = saved;
    }
  });
});

describe("data tools", () => {
  it("getProfile calls the platform endpoint with the identifier, trimmed", async () => {
    const { f, options } = opts([json(envelope({ object: "profile", handle: "nasa", followers: 5 }, { credits_remaining: 41 }))]);
    const out = await exec(getProfile(options), { platform: "tiktok", handle: "@nasa" });
    expect(f.calls[0]).toMatchObject({ path: "/v1/tiktok/profile", method: "GET" });
    expect(f.calls[0]!.query).toEqual({ handle: "@nasa", trim: "true" });
    expect(f.calls[0]!.headers["x-api-key"]).toMatch(/^ss_test_/);
    expect(out).toEqual({ ok: true, data: { object: "profile", handle: "nasa", followers: 5 }, credits_charged: 1, credits_remaining: 41 });
  });

  it("getProfile reports a platform that does not fit the identifier given", async () => {
    const { options } = opts([json(envelope({}))]);
    const bad = await exec(getProfile(options), { platform: "tiktok" });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("invalid_params");
    expect(bad.error.message).toMatch(/looks things up by/);
  });

  it("getPosts passes the cursor back and keeps the next cursor", async () => {
    const page = { object: "list", items: [{ id: "1" }, { id: "2" }], cursor: "next_1", has_more: true };
    const { f, options } = opts([json(envelope(page))]);
    const out = await exec(getPosts(options), { platform: "youtube", handle: "@NASA", cursor: "c0" });
    expect(f.calls[0]!.path).toBe("/v1/youtube/channel/videos");
    expect(f.calls[0]!.query.cursor).toBe("c0");
    expect(out.data.cursor).toBe("next_1");
    expect(out.data.has_more).toBe(true);
  });

  it("getPost reads the platform from the url", async () => {
    const { f, options } = opts([json(envelope({ id: "x" }))]);
    await exec(getPost(options), { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(f.calls[0]!.path).toBe("/v1/youtube/video");
    expect(f.calls[0]!.query.url).toContain("dQw4w9WgXcQ");
  });

  it("getPost says so when no platform can be read", async () => {
    const { options } = opts([json(envelope({}))]);
    const out = await exec(getPost(options), { url: "https://example.org/a" });
    expect(out.ok).toBe(false);
    expect(out.error.message).toMatch(/no platform recognised/);
  });

  it("getComments follows the url host", async () => {
    const { f, options } = opts([json(envelope({ object: "list", items: [], cursor: null, has_more: false }))]);
    await exec(getComments(options), { url: "https://www.tiktok.com/@a/video/1" });
    expect(f.calls[0]!.path).toBe("/v1/tiktok/video/comments");
  });

  it("search sends the query, and the platform x means twitter", async () => {
    const { f, options } = opts([json(envelope({ object: "list", items: [], cursor: null, has_more: false }))]);
    await exec(search(options), { platform: "reddit", query: "mechanical keyboards" });
    expect(f.calls[0]).toMatchObject({ path: "/v1/reddit/search" });
    expect(f.calls[0]!.query.query).toBe("mechanical keyboards");
  });

  it("getCredits is a free account call", async () => {
    const { f, options } = opts([json(envelope({ object: "credit_balance", credits: 12 }, { credits_charged: 0 }))]);
    const out = await exec(getCredits(options), {});
    expect(f.calls[0]!.path).toBe("/v1/account/credits");
    expect(f.calls[0]!.query).toEqual({});
    expect(out.credits_charged).toBe(0);
  });

  it("maxAgeDays is sent on data calls", async () => {
    const { f, options } = opts([json(envelope({}))], { maxAgeDays: 7 });
    await exec(getProfile(options), { platform: "github", handle: "torvalds" });
    expect(f.calls[0]!.query.max_age_days).toBe("7");
  });

  it("marks a cached answer", async () => {
    const { options } = opts([json(envelope({ a: 1 }, { cached: true, credits_charged: 0 }))]);
    const out = await exec(getProfile(options), { platform: "github", handle: "torvalds" });
    expect(out.cached).toBe(true);
    expect(out.credits_charged).toBe(0);
  });
});

describe("transcripts", () => {
  const transcript = { object: "transcript", platform: "youtube", language: "en", source: "captions", text: "hello world", segments: [{ start: 0, text: "hello world" }] };

  it("returns the text without segments by default and with them on request", async () => {
    const { f, options } = opts([json(envelope(transcript))]);
    const t = getTranscript(options);
    const a = await exec(t, { url: "https://youtu.be/x" });
    expect(f.calls[0]!.path).toBe("/v1/transcript");
    expect(a.data.text).toBe("hello world");
    expect(a.data.segments).toBeUndefined();
    const b = await exec(t, { url: "https://youtu.be/x", includeSegments: true });
    expect(b.data.segments).toHaveLength(1);
  });

  it("sends allow_long_transcription only when asked", async () => {
    const { f, options } = opts([json(envelope(transcript))]);
    const t = getTranscript(options);
    await exec(t, { url: "https://youtu.be/x", language: "pt-BR", allowLongTranscription: true });
    expect(f.calls[0]!.query).toMatchObject({ language: "pt-BR", allow_long_transcription: "true" });
    await exec(t, { url: "https://youtu.be/y" });
    expect(f.calls[1]!.query.allow_long_transcription).toBeUndefined();
  });

  it("waits for an async job and answers with the finished transcript", async () => {
    const job = (status: string) =>
      json(envelope({ object: "job", job_id: "job_1", status, poll_url: "https://api.test/v1/jobs/job_1" }, { credits_charged: 0, credits_remaining: null }), 202);
    const { f, options } = opts([job("pending"), job("running"), json(envelope(transcript, { credits_charged: 10, credits_remaining: 90 }))]);
    const out = await exec(getTranscript(options), { url: "https://youtu.be/x", allowLongTranscription: true });
    expect(f.calls.map((c) => c.path)).toEqual(["/v1/transcript", "/v1/jobs/job_1", "/v1/jobs/job_1"]);
    expect(out).toMatchObject({ ok: true, credits_charged: 10, credits_remaining: 90 });
    expect(out.data.text).toBe("hello world");
  });

  it("answers a job that outlives the wait with a retryable job_timeout and the job id", async () => {
    const pending = json(envelope({ object: "job", job_id: "job_slow", status: "running", poll_url: "u" }, { credits_charged: 0 }), 202);
    const { options } = opts([pending], {
      clientOptions: { fetch: opts([pending]).f.fetch, maxRetries: 0, jobPollIntervalMs: 5, jobTimeoutMs: 30 },
    });
    const out = await exec(getTranscript(options), { url: "https://youtu.be/x" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: "job_timeout", retryable: true, job_id: "job_slow" });
    expect(out.billed).toBe(false);
  });

  it("caps very long transcript text and says so", async () => {
    const long = { ...transcript, text: "a".repeat(500) };
    const { options } = opts([json(envelope(long))], { maxTranscriptChars: 100 });
    const out = await exec(getTranscript(options), { url: "https://youtu.be/x" });
    expect(out.data.text).toHaveLength(100);
    expect(out.truncated).toMatchObject({ reason: "transcript_limit", text_characters: 500, kept: 100 });
  });
});

describe("errors", () => {
  it("comes back as a message object with the code and billed false", async () => {
    const { options } = opts([json(errorEnvelope("not_found", "No such profile.", false), 404)]);
    const out = await exec(getProfile(options), { platform: "tiktok", handle: "nobody" });
    expect(out).toEqual({
      ok: false,
      error: { code: "not_found", message: "No such profile.", retryable: false, request_id: "req_err" },
      billed: false,
      credits_charged: 0,
    });
  });

  it("flags a retryable error", async () => {
    const { options } = opts([json(errorEnvelope("upstream_blocked", "Try again.", true), 502)]);
    const out = await exec(getProfile(options), { platform: "tiktok", handle: "a" });
    expect(out.error.code).toBe("upstream_blocked");
    expect(out.error.retryable).toBe(true);
  });

  it("a rejected key is an answer, not a throw", async () => {
    const { options } = opts([json(errorEnvelope("unauthorized", "Bad key."), 401)]);
    const out = await exec(getCredits(options), {});
    expect(out.error.code).toBe("unauthorized");
  });

  it("a dead connection is a retryable answer", async () => {
    const { options } = opts([() => { throw new TypeError("fetch failed"); }]);
    const out = await exec(getCredits(options), {});
    expect(out.ok).toBe(false);
    expect(out.error).toMatchObject({ code: "connection_error", retryable: true });
  });
});

describe("response size", () => {
  it("drops items from the end of a page, keeps the cursor and says how many it kept", async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: String(i), text: "x".repeat(500) }));
    const { options } = opts([json(envelope({ object: "list", items, cursor: "more", has_more: true }))], { maxResponseChars: 5000 });
    const out = await exec(getPosts(options), { platform: "tiktok", handle: "a" });
    expect(out.data.items.length).toBeLessThan(50);
    expect(out.data.cursor).toBe("more");
    expect(out.truncated).toMatchObject({ reason: "response_limit", items_on_page: 50 });
    expect(JSON.stringify(out.data).length).toBeLessThanOrEqual(5000);
  });

  it("clips one very long string", async () => {
    const { options } = opts([json(envelope({ bio: "b".repeat(10_000) }))]);
    const out = await exec(getProfile(options), { platform: "github", handle: "a" });
    expect(out.data.bio.length).toBeLessThan(2100);
    expect(out.data.bio).toMatch(/more characters/);
  });
});

describe("callEndpoint and listEndpoints", () => {
  it("runs an endpoint by id", async () => {
    const { f, options } = opts([json(envelope({ object: "list", items: [], cursor: null, has_more: false }))]);
    await exec(callEndpoint(options), { endpoint: "github.user.repositories", params: { handle: "torvalds" } });
    expect(f.calls[0]!.path).toBe("/v1/github/user/repositories");
    expect(f.calls[0]!.query.handle).toBe("torvalds");
  });

  it("checks parameters before any request", async () => {
    const { f, options } = opts([json(envelope({}))]);
    const t = callEndpoint(options);
    const unknown = await exec(t, { endpoint: "tiktok.profile", params: { nope: 1, handle: "a" } });
    expect(unknown.error.message).toMatch(/does not take nope/);
    const missing = await exec(t, { endpoint: "tiktok.profile", params: {} });
    expect(missing.error.code).toBe("invalid_params");
    const noEndpoint = await exec(t, { endpoint: "tiktok.nothing", params: {} });
    expect(noEndpoint.error.message).toMatch(/unknown endpoint id/);
    expect(f.calls).toHaveLength(0);
  });

  it("listEndpoints answers locally, with no request", async () => {
    const { f, options } = opts([json(envelope({}))]);
    const t = listEndpoints(options);
    const all = await exec(t, {});
    expect(all.data).toMatch(/endpoints, listed by platform key/);
    const one = await exec(t, { endpoint: "tiktok.profile.videos" });
    expect(one.data).toMatch(/Parameters:/);
    const found = await exec(t, { search: "ad library" });
    expect(found.data).toMatch(/ad_library/);
    const plat = await exec(t, { platform: "x" });
    expect(plat.data).toMatch(/twitter\./);
    const bad = await exec(t, { platform: "nowhere" });
    expect(bad.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

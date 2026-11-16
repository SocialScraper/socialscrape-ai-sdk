import { tool } from "ai";
import { SocialScrape, type ClientOptions } from "socialscrape";
import { z } from "zod";
import { CATALOG, type CatalogEndpoint } from "./catalog.js";
import { fit, shapeTranscript, success, toFailure, type ToolResult } from "./format.js";
import {
  ROLES,
  TRANSCRIPT,
  ToolInputError,
  checkParams,
  normalizePlatform,
  paramNames,
  platformsOf,
  route,
  signature,
  unknownEndpointMessage,
  type Role,
} from "./routes.js";

export interface SocialScrapeToolsOptions {
  /** SocialScrape API key. Default: process.env.SOCIALSCRAPE_API_KEY. */
  apiKey?: string;
  /** API base URL. Default: https://api.socialscrape.dev. */
  baseUrl?: string;
  /** Which tools to return. Default: all of them. */
  include?: ToolName[];
  /** Accept a cached answer up to this many days old (0 to 30). A cached answer costs 0 credits. */
  maxAgeDays?: number;
  /** Ask for the smaller response, without null fields and the `extra` object. Default true. */
  trim?: boolean;
  /** Most characters of JSON one tool answer may hold. Lists lose items from the end. Default 40000. */
  maxResponseChars?: number;
  /** Most characters of transcript text returned. Default 60000. */
  maxTranscriptChars?: number;
  /** A client you configured yourself. Overrides apiKey and baseUrl. */
  client?: SocialScrape;
  /** Extra client settings: timeouts, retries, your own fetch. */
  clientOptions?: Omit<ClientOptions, "apiKey" | "baseUrl">;
}

export const TOOL_NAMES = [
  "getProfile",
  "getPosts",
  "getPost",
  "getComments",
  "getTranscript",
  "search",
  "listEndpoints",
  "callEndpoint",
  "getCredits",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

interface Runtime {
  call(endpoint: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{
    data: unknown;
    credits_charged: number;
    credits_remaining: number | null;
    cached: boolean;
  }>;
  maxResponseChars: number;
  maxTranscriptChars: number;
}

function makeRuntime(options: SocialScrapeToolsOptions): Runtime {
  let client = options.client;
  const trim = options.trim ?? true;
  return {
    maxResponseChars: options.maxResponseChars ?? 40_000,
    maxTranscriptChars: options.maxTranscriptChars ?? 60_000,
    async call(endpoint, params, signal) {
      const ep = CATALOG[endpoint];
      if (!ep) throw new ToolInputError(unknownEndpointMessage(endpoint));
      // The client is made on first use, so a missing key is an answer the model can read, not a crash at setup.
      client ??= new SocialScrape({
        ...options.clientOptions,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      });
      const query: Record<string, unknown> = { ...params };
      if (ep.common) {
        if (trim && query.trim === undefined) query.trim = true;
        if (options.maxAgeDays !== undefined && query.max_age_days === undefined) query.max_age_days = options.maxAgeDays;
      }
      const res = await client.request<unknown>("GET", ep.path, { query }, signal ? { signal } : undefined);
      return { data: res.data, credits_charged: res.credits_charged, credits_remaining: res.credits_remaining, cached: res.cached };
    },
  };
}

function platformEnum(role: Role): z.ZodEnum<{ [k: string]: string }> {
  return z.enum(platformsOf(role) as [string, ...string[]]);
}

const CURSOR = "The `cursor` of the previous answer, to get the next page. Leave it out for the first page.";

function titles(role: Role): string {
  return Object.values(ROLES[role] as Record<string, string>)
    .map((id) => CATALOG[id]!.title)
    .join(", ");
}

function lookups(role: Role): string {
  return Object.entries(ROLES[role] as Record<string, string>)
    .map(([platform, id]) => {
      const names = paramNames(CATALOG[id]!).filter((n) => n === "handle" || n === "url" || n === "id");
      return `${platform}: ${names.join(" or ")}`;
    })
    .join("; ");
}

const identity = {
  handle: z.string().optional().describe("Username or handle, with or without the leading @."),
  url: z.string().optional().describe("Full URL of the profile, channel or page."),
  id: z.string().optional().describe("The platform's own id of the account, where it has one."),
};

async function run(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (e) {
    return toFailure(e);
  }
}

export function getProfile(options: SocialScrapeToolsOptions = {}) {
  const rt = makeRuntime(options);
  return tool({
    description:
      "Get a profile from a social platform: name, bio, links, verification and follower counts. " +
      `Platforms: ${titles("profile")}. Pass the platform and one identifier. What each platform is looked up by: ${lookups("profile")}. ` +
      "Costs 1 credit; a lookup that fails is free.",
    inputSchema: z.object({ platform: platformEnum("profile").describe("Platform key."), ...identity }),
    execute: ({ platform, handle, url, id }, { abortSignal }) =>
      run(async () => {
        const r = route("profile", platform, { handle, url, id });
        const res = await rt.call(r.endpoint, r.params, abortSignal);
        return success(res, fit(res.data, rt.maxResponseChars));
      }),
  });
}

export function getPosts(options: SocialScrapeToolsOptions = {}) {
  const rt = makeRuntime(options);
  return tool({
    description:
      "List the latest posts or videos of a profile, channel or page, newest first, one page per call: text, time, stats and media links per post. " +
      `Platforms: ${titles("posts")}. Pass the platform and one identifier. What each platform is looked up by: ${lookups("posts")}. ` +
      "When the answer has `has_more` true, pass its `cursor` back for the next page. Costs 1 credit per page; a failed call is free.",
    inputSchema: z.object({
      platform: platformEnum("posts").describe("Platform key."),
      ...identity,
      cursor: z.string().optional().describe(CURSOR),
    }),
    execute: ({ platform, handle, url, id, cursor }, { abortSignal }) =>
      run(async () => {
        const r = route("posts", platform, { handle, url, id });
        const res = await rt.call(r.endpoint, { ...r.params, ...(cursor ? { cursor } : {}) }, abortSignal);
        return success(res, fit(res.data, rt.maxResponseChars));
      }),
  });
}

export function getPost(options: SocialScrapeToolsOptions = {}) {
  const rt = makeRuntime(options);
  return tool({
    description:
      "Get one post, video, tweet, pin or clip: text, author, time, stats and media links. " +
      `Platforms: ${titles("post")}. Pass its url; the platform is read from the link. Costs 1 credit; a lookup that fails is free.`,
    inputSchema: z.object({
      url: z.string().optional().describe("Full URL of the post, video, tweet, pin or clip."),
      platform: platformEnum("post").optional().describe("Platform key. Leave it out when you pass a url: the platform is read from the link."),
      id: z.string().optional().describe("The post's id, on platforms that look a post up by id. Needs platform."),
    }),
    execute: ({ url, platform, id }, { abortSignal }) =>
      run(async () => {
        const r = route("post", platform, { url, id });
        const res = await rt.call(r.endpoint, r.params, abortSignal);
        return success(res, fit(res.data, rt.maxResponseChars));
      }),
  });
}

export function getComments(options: SocialScrapeToolsOptions = {}) {
  const rt = makeRuntime(options);
  return tool({
    description:
      "List the comments on a post or video, one page per call: text, author, time and likes per comment. " +
      `Platforms: ${titles("comments")}. Pass the post's url; the platform is read from the link. ` +
      "When the answer has `has_more` true, pass its `cursor` back for the next page. Costs 1 credit per page; a failed call is free.",
    inputSchema: z.object({
      url: z.string().optional().describe("Full URL of the post or video."),
      platform: platformEnum("comments").optional().describe("Platform key. Leave it out when you pass a url: the platform is read from the link."),
      id: z.string().optional().describe("The post's id, on platforms that look a post up by id. Needs platform."),
      cursor: z.string().optional().describe(CURSOR),
    }),
    execute: ({ url, platform, id, cursor }, { abortSignal }) =>
      run(async () => {
        const r = route("comments", platform, { url, id });
        const res = await rt.call(r.endpoint, { ...r.params, ...(cursor ? { cursor } : {}) }, abortSignal);
        return success(res, fit(res.data, rt.maxResponseChars));
      }),
  });
}

export function getTranscript(options: SocialScrapeToolsOptions = {}) {
  const rt = makeRuntime(options);
  const ep = CATALOG[TRANSCRIPT]!;
  return tool({
    description:
      "Get the transcript of a video from its URL: the full text, its language and where it came from (captions or AI transcription of the audio). " +
      "Works for YouTube, TikTok, Instagram, X, Facebook, LinkedIn, Reddit, Twitch clips, Kick clips and Rumble. " +
      `Price: ${ep.credits}. Videos with no captions that run past 2 minutes need allowLongTranscription. A failed call is free. ` +
      "A long video can take a while: the tool waits for the transcription to finish.",
    inputSchema: z.object({
      url: z.string().describe("Full URL of the video."),
      language: z.string().optional().describe("Preferred caption language as a BCP 47 code, for example en or pt-BR."),
      allowLongTranscription: z
        .boolean()
        .optional()
        .describe(
          "Allow AI transcription of audio longer than 2 minutes, at 5 credits per started minute of the whole video. Without it a longer video with no captions answers an error that names the cost, which is free.",
        ),
      includeSegments: z.boolean().optional().describe("Also return the timed segments (start, end, text). The full text is always returned."),
    }),
    execute: ({ url, language, allowLongTranscription, includeSegments }, { abortSignal }) =>
      run(async () => {
        const params: Record<string, unknown> = { url };
        if (language) params.language = language;
        if (allowLongTranscription) params.allow_long_transcription = true;
        const res = await rt.call(TRANSCRIPT, params, abortSignal);
        return success(res, shapeTranscript(res.data, includeSegments ?? false, rt.maxTranscriptChars));
      }),
  });
}

export function search(options: SocialScrapeToolsOptions = {}) {
  const rt = makeRuntime(options);
  return tool({
    description:
      "Search one platform by keyword, one page per call. Posts and videos on most platforms; tracks, albums and artists on Spotify and Apple Music; web results on Google. " +
      `Platforms: ${titles("search")}. When the answer has \`has_more\` true, pass its \`cursor\` back for the next page. ` +
      "Costs 1 credit per page; a failed call is free. For a narrower search (users, hashtags, filters) find the endpoint with listEndpoints and run it with callEndpoint.",
    inputSchema: z.object({
      platform: platformEnum("search").describe("Platform key."),
      query: z.string().describe("Search terms."),
      cursor: z.string().optional().describe(CURSOR),
    }),
    execute: ({ platform, query, cursor }, { abortSignal }) =>
      run(async () => {
        const key = normalizePlatform(platform);
        const id = (ROLES.search as Record<string, string>)[key];
        if (!id) throw new ToolInputError(`no search for ${platform}; platforms: ${platformsOf("search").join(", ")}`);
        const takesCursor = paramNames(CATALOG[id]!).includes("cursor");
        const res = await rt.call(id, { query, ...(cursor && takesCursor ? { cursor } : {}) }, abortSignal);
        return success(res, fit(res.data, rt.maxResponseChars));
      }),
  });
}

function line(id: string, ep: CatalogEndpoint): string {
  return `${id}: ${ep.summary}. Takes: ${signature(ep)}. Price: ${ep.credits}.`;
}

function detail(id: string, ep: CatalogEndpoint): string {
  const rows = [`${id}: ${ep.summary}`, `Price: ${ep.credits}.${ep.paginated ? " One page per call: pass `cursor` back for the next page." : ""}`];
  rows.push(ep.params.length ? "Parameters:" : "No parameters.");
  for (const p of ep.params) {
    const facts = [p.type];
    if (p.required) facts.push("required");
    if (p.enum) facts.push("one of " + p.enum.join(", "));
    rows.push(`- ${p.name} (${facts.join("; ")}): ${p.description}`);
  }
  for (const g of ep.oneOf) rows.push(`One of ${g.join(", ")} is needed.`);
  if (ep.common) rows.push("Also accepted: trim, raw, max_age_days.");
  return rows.join("\n");
}

export function listEndpoints(_options: SocialScrapeToolsOptions = {}) {
  const total = Object.keys(CATALOG).length;
  return tool({
    description:
      `Look up what SocialScrape can fetch: ${total} endpoints (profiles, posts, comments, search, ad libraries, music, shops, transcripts, account usage). ` +
      "Free and instant: it makes no request. With no arguments it lists every platform with its endpoint ids; with `platform` that platform's endpoints and what each takes; " +
      "with `endpoint` one endpoint's parameters; with `search` the endpoints that mention those words. Use the id with callEndpoint.",
    inputSchema: z.object({
      platform: z.string().optional().describe("Platform key, for example tiktok: lists its endpoints with what each takes."),
      endpoint: z.string().optional().describe("Endpoint id, for example tiktok.profile.videos: every parameter."),
      search: z.string().optional().describe("Words to look for in endpoint ids and summaries, for example 'ad library' or 'followers'."),
    }),
    execute: ({ platform, endpoint, search: words }) =>
      run(async () => {
        const entries = Object.entries(CATALOG);
        let text: string;
        if (endpoint) {
          const ep = CATALOG[endpoint.trim()];
          if (!ep) throw new ToolInputError(unknownEndpointMessage(endpoint.trim()));
          text = detail(endpoint.trim(), ep);
        } else if (platform) {
          const key = normalizePlatform(platform);
          const rows = entries.filter(([, ep]) => ep.platform === key);
          if (!rows.length) {
            throw new ToolInputError(`no platform ${platform}; platforms: ${[...new Set(entries.map(([, ep]) => ep.platform))].join(", ")}`);
          }
          text = rows.map(([id, ep]) => line(id, ep)).join("\n");
        } else if (words) {
          const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
          const rows = entries.filter(([id, ep]) => terms.every((t) => `${id} ${ep.summary} ${ep.title}`.toLowerCase().includes(t)));
          text = rows.length
            ? rows.slice(0, 30).map(([id, ep]) => line(id, ep)).join("\n") + (rows.length > 30 ? `\n${rows.length - 30} more: narrow the search.` : "")
            : `No endpoint mentions ${words}. Call with no arguments for the full list.`;
        } else {
          const byPlatform = new Map<string, string[]>();
          for (const [id, ep] of entries) byPlatform.set(ep.platform, [...(byPlatform.get(ep.platform) ?? []), id]);
          text = [
            `${total} endpoints, listed by platform key. Pass \`platform\` for what its endpoints take, or \`endpoint\` for one endpoint's parameters.`,
            ...[...byPlatform].map(([key, ids]) => `${key}: ${ids.join(", ")}`),
          ].join("\n");
        }
        return { ok: true, data: text, credits_charged: 0, credits_remaining: null };
      }),
  });
}

export function callEndpoint(options: SocialScrapeToolsOptions = {}) {
  const rt = makeRuntime(options);
  return tool({
    description:
      `Run any SocialScrape endpoint by its id (${Object.keys(CATALOG).length} of them, for example youtube.channel.videos or facebook.ad_library.search), with its parameters by name. ` +
      "Find the id and the parameters with listEndpoints first. Parameters are checked before the request, so a wrong name is answered at once and costs nothing. " +
      "Most endpoints cost 1 credit per call; a failed call is free.",
    inputSchema: z.object({
      endpoint: z.string().describe("Endpoint id from listEndpoints, for example instagram.profile.reels."),
      params: z.record(z.string(), z.unknown()).optional().describe('The endpoint\'s parameters by name, for example {"handle": "nasa"}.'),
    }),
    execute: ({ endpoint, params }, { abortSignal }) =>
      run(async () => {
        const id = endpoint.trim();
        const sent = checkParams(id, params ?? {});
        const res = await rt.call(id, sent, abortSignal);
        const shaped = id === TRANSCRIPT || id.endsWith(".transcript") ? shapeTranscript(res.data, false, rt.maxTranscriptChars) : fit(res.data, rt.maxResponseChars);
        return success(res, shaped);
      }),
  });
}

export function getCredits(options: SocialScrapeToolsOptions = {}) {
  const rt = makeRuntime(options);
  return tool({
    description: "Check the credit balance of the SocialScrape account. Free: it costs no credits.",
    inputSchema: z.object({}),
    execute: (_input, { abortSignal }) =>
      run(async () => {
        const res = await rt.call("account.credits", {}, abortSignal);
        return success(res, fit(res.data, rt.maxResponseChars));
      }),
  });
}

const FACTORIES = { getProfile, getPosts, getPost, getComments, getTranscript, search, listEndpoints, callEndpoint, getCredits };

/**
 * The SocialScrape tools for the AI SDK, ready to pass as `tools`.
 *
 * ```ts
 * const { text } = await generateText({ model, prompt, tools: socialscrapeTools(), stopWhen: isStepCount(5) });
 * ```
 */
export function socialscrapeTools(options: SocialScrapeToolsOptions = {}) {
  // One client shared by every tool, made on first use.
  const shared: SocialScrapeToolsOptions = { ...options };
  const names = options.include ?? [...TOOL_NAMES];
  for (const name of names) {
    if (!(name in FACTORIES)) throw new Error(`socialscrapeTools: unknown tool ${String(name)}. Tools: ${TOOL_NAMES.join(", ")}.`);
  }
  const all = {
    getProfile: getProfile(shared),
    getPosts: getPosts(shared),
    getPost: getPost(shared),
    getComments: getComments(shared),
    getTranscript: getTranscript(shared),
    search: search(shared),
    listEndpoints: listEndpoints(shared),
    callEndpoint: callEndpoint(shared),
    getCredits: getCredits(shared),
  };
  if (!options.include) return all;
  return Object.fromEntries(names.map((n) => [n, all[n]])) as Partial<typeof all>;
}

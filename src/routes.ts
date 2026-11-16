import { CATALOG, type CatalogEndpoint } from "./catalog.js";

/** The jobs the cross-platform tools do, and the endpoint that does each one per platform. */
export const ROLES = {
  profile: {
    apple_music: "apple_music.artist",
    bluesky: "bluesky.profile",
    cosmos: "cosmos.profile",
    facebook: "facebook.profile",
    github: "github.user",
    instagram: "instagram.profile",
    kwai: "kwai.profile",
    linkedin: "linkedin.profile",
    snapchat: "snapchat.profile",
    soundcloud: "soundcloud.artist",
    spotify: "spotify.artist",
    threads: "threads.profile",
    tiktok: "tiktok.profile",
    truthsocial: "truthsocial.profile",
    twitch: "twitch.profile",
    twitter: "twitter.profile",
    youtube: "youtube.channel",
  },
  posts: {
    bluesky: "bluesky.profile.posts",
    cosmos: "cosmos.profile.posts",
    facebook: "facebook.profile.posts",
    instagram: "instagram.profile.posts",
    kwai: "kwai.profile.posts",
    linkedin: "linkedin.company.posts",
    rumble: "rumble.channel.videos",
    telegram: "telegram.channel.posts",
    threads: "threads.profile.posts",
    tiktok: "tiktok.profile.videos",
    truthsocial: "truthsocial.profile.posts",
    twitch: "twitch.user.videos",
    twitter: "twitter.profile.tweets",
    youtube: "youtube.channel.videos",
  },
  post: {
    bluesky: "bluesky.post",
    cosmos: "cosmos.post",
    facebook: "facebook.post",
    instagram: "instagram.post",
    kick: "kick.clip",
    kwai: "kwai.post",
    linkedin: "linkedin.post",
    pinterest: "pinterest.pin",
    reddit: "reddit.post",
    rumble: "rumble.video",
    snapchat: "snapchat.spotlight",
    telegram: "telegram.post",
    threads: "threads.post",
    tiktok: "tiktok.video",
    truthsocial: "truthsocial.post",
    twitch: "twitch.clip",
    twitter: "twitter.tweet",
    youtube: "youtube.video",
  },
  comments: {
    facebook: "facebook.post.comments",
    instagram: "instagram.post.comments",
    reddit: "reddit.post.comments",
    rumble: "rumble.video.comments",
    snapchat: "snapchat.spotlight.comments",
    tiktok: "tiktok.video.comments",
    youtube: "youtube.video.comments",
  },
  search: {
    apple_music: "apple_music.search",
    cosmos: "cosmos.search",
    facebook: "facebook.search.videos",
    google: "google.search",
    instagram: "instagram.search.reels",
    linkedin: "linkedin.search.posts",
    pinterest: "pinterest.search",
    reddit: "reddit.search",
    rumble: "rumble.search",
    spotify: "spotify.search",
    threads: "threads.search",
    tiktok: "tiktok.search.keyword",
    twitter: "twitter.search.posts",
    youtube: "youtube.search",
  },
} as const satisfies Record<string, Record<string, string>>;

export type Role = keyof typeof ROLES;

export const TRANSCRIPT = "transcript";
const IDENTIFIERS = ["handle", "url", "id"] as const;

export function platformsOf(role: Role): string[] {
  return Object.keys(ROLES[role]).sort();
}

export function endpointFor(role: Role, platform: string): string | undefined {
  const key = normalizePlatform(platform);
  const table = ROLES[role] as Record<string, string>;
  return table[key];
}

export function normalizePlatform(platform: string): string {
  const key = platform.trim().toLowerCase().replace(/-/g, "_");
  return key === "x" ? "twitter" : key;
}

export function paramNames(ep: CatalogEndpoint): string[] {
  return ep.params.map((p) => p.name);
}

export function requiredNames(ep: CatalogEndpoint): string[] {
  return ep.params.filter((p) => p.required).map((p) => p.name);
}

/** `handle | id (one needed), sort, cursor`: the parameters in one line. */
export function signature(ep: CatalogEndpoint): string {
  const grouped = new Set(ep.oneOf.flat());
  const required = requiredNames(ep);
  const bits = ep.oneOf.map((g) => g.join(" | ") + " (one needed)");
  for (const n of required) if (!grouped.has(n)) bits.push(n + " (required)");
  for (const n of paramNames(ep)) if (!grouped.has(n) && !required.includes(n)) bits.push(n);
  return bits.join(", ") || "none";
}

/** Which platform of a role a URL belongs to, read from its host. */
export function platformOfUrl(role: Role, url: string): string | undefined {
  let host = "";
  try {
    host = new URL(url.includes("//") ? url : "https://" + url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  for (const [platform, id] of Object.entries(ROLES[role] as Record<string, string>)) {
    const hosts = CATALOG[id]?.params.find((p) => p.name === "url")?.hosts ?? [];
    if (hosts.some((h) => host === h || host.endsWith("." + h))) return platform;
  }
  return undefined;
}

export class ToolInputError extends Error {}

/** The endpoint that does `role` on a platform, and the one identifier to send it. */
export function route(
  role: Role,
  platform: string | undefined,
  ids: { handle?: string | undefined; url?: string | undefined; id?: string | undefined },
): { endpoint: string; params: Record<string, string> } {
  const table = ROLES[role] as Record<string, string>;
  let key = platform ? normalizePlatform(platform) : undefined;
  if (!key) {
    if (!ids.url) throw new ToolInputError(`pass a platform (${platformsOf(role).join(", ")}), or a url it can be read from`);
    key = platformOfUrl(role, ids.url);
    if (!key) {
      throw new ToolInputError(
        `no platform recognised in ${ids.url}; pass platform, one of ${platformsOf(role).join(", ")}`,
      );
    }
  }
  const endpoint = table[key];
  if (!endpoint) throw new ToolInputError(`no ${role} lookup for ${platform}; platforms: ${platformsOf(role).join(", ")}`);
  const ep = CATALOG[endpoint]!;
  const names = paramNames(ep);
  for (const name of IDENTIFIERS) {
    const value = ids[name];
    if (value && names.includes(name)) return { endpoint, params: { [name]: value } };
  }
  const takes = IDENTIFIERS.filter((n) => names.includes(n)).join(" or ");
  const got = IDENTIFIERS.filter((n) => ids[n]).join(", ") || "nothing";
  throw new ToolInputError(`${endpoint} looks things up by ${takes}; got ${got}`);
}

/** Checks parameters against the catalogue before any request is made. Returns what to send. */
export function checkParams(id: string, params: Record<string, unknown>): Record<string, unknown> {
  const ep = CATALOG[id];
  if (!ep) throw new ToolInputError(unknownEndpointMessage(id));
  const sent: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) sent[k] = v;
  const allowed = new Set([...paramNames(ep), ...(ep.common ? ["trim", "raw", "max_age_days"] : [])]);
  const unknown = Object.keys(sent).filter((k) => !allowed.has(k)).sort();
  if (unknown.length) throw new ToolInputError(`${id} does not take ${unknown.join(", ")}. It takes: ${signature(ep)}.`);
  const missing = requiredNames(ep).filter((n) => !(n in sent));
  if (missing.length) throw new ToolInputError(`${id} needs ${missing.join(", ")}. It takes: ${signature(ep)}.`);
  for (const group of ep.oneOf) {
    if (!group.some((n) => n in sent)) {
      throw new ToolInputError(`${id} needs one of ${group.join(", ")}. It takes: ${signature(ep)}.`);
    }
  }
  return sent;
}

export function unknownEndpointMessage(id: string): string {
  const prefix = id.split(".")[0] + ".";
  const near = Object.keys(CATALOG).filter((k) => k.startsWith(prefix)).slice(0, 12);
  const hint = near.length ? ` Ids that start the same way: ${near.join(", ")}.` : "";
  return `unknown endpoint id ${id}.${hint} List them with the listEndpoints tool.`;
}

import {
  APIError,
  JobTimeoutError,
  MissingApiKeyError,
  SocialScrapeConnectionError,
  SocialScrapeTimeoutError,
} from "socialscrape";
import { ToolInputError } from "./routes.js";

/** What a tool returns when a request worked. */
export interface ToolSuccess {
  ok: true;
  data: unknown;
  credits_charged: number;
  credits_remaining: number | null;
  cached?: true;
  /** Set when the answer was cut to fit the response limit. */
  truncated?: Record<string, unknown>;
}

/** What a tool returns when it did not work. Failed requests are never billed. */
export interface ToolFailure {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    request_id?: string;
    retry_after_seconds?: number;
    job_id?: string;
  };
  billed: false;
  credits_charged: 0;
}

export type ToolResult = ToolSuccess | ToolFailure;

const MAX_STRING = 2_000;

function clipStrings(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)} [cut, ${value.length - MAX_STRING} more characters]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, depth + 1));
  if (value && typeof value === "object" && depth < 12) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipStrings(v, depth + 1);
    return out;
  }
  return value;
}

function size(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * Makes an answer fit a character budget without losing the cursor. Long strings are clipped; a list
 * page loses items from its end until it fits, and says how many it kept.
 */
export function fit(data: unknown, maxChars: number): { data: unknown; truncated?: Record<string, unknown> } {
  const clipped = clipStrings(data);
  if (size(clipped) <= maxChars) return { data: clipped };
  const page = clipped as { items?: unknown[] } | null;
  if (page && typeof page === "object" && Array.isArray(page.items) && page.items.length > 1) {
    const total = page.items.length;
    const items = [...page.items];
    while (items.length > 1 && size({ ...page, items }) > maxChars) items.pop();
    return {
      data: { ...page, items },
      truncated: { reason: "response_limit", items_returned: items.length, items_on_page: total },
    };
  }
  const text = JSON.stringify(clipped);
  return {
    data: { preview: text.slice(0, maxChars) },
    truncated: { reason: "response_limit", characters: text.length, kept: maxChars },
  };
}

/** Shapes a transcript: the text always, the timed segments only on request, the text capped. */
export function shapeTranscript(data: unknown, includeSegments: boolean, maxChars: number): { data: unknown; truncated?: Record<string, unknown> } {
  if (!data || typeof data !== "object") return { data };
  const t = { ...(data as Record<string, unknown>) };
  if (!includeSegments) delete t.segments;
  let truncated: Record<string, unknown> | undefined;
  if (typeof t.text === "string" && t.text.length > maxChars) {
    truncated = { reason: "transcript_limit", text_characters: t.text.length, kept: maxChars };
    t.text = t.text.slice(0, maxChars);
  }
  return truncated ? { data: t, truncated } : { data: t };
}

export function success(
  res: { data: unknown; credits_charged: number; credits_remaining: number | null; cached: boolean },
  shaped: { data: unknown; truncated?: Record<string, unknown> },
): ToolSuccess {
  const out: ToolSuccess = {
    ok: true,
    data: shaped.data,
    credits_charged: res.credits_charged,
    credits_remaining: res.credits_remaining,
  };
  if (res.cached) out.cached = true;
  if (shaped.truncated) out.truncated = shaped.truncated;
  return out;
}

function failure(error: ToolFailure["error"]): ToolFailure {
  return { ok: false, error, billed: false, credits_charged: 0 };
}

/** Turns anything a call can throw into a message the model can read and act on. */
export function toFailure(e: unknown): ToolFailure {
  if (e instanceof ToolInputError) return failure({ code: "invalid_params", message: e.message, retryable: false });
  if (e instanceof MissingApiKeyError) {
    return failure({
      code: "missing_api_key",
      message: "No SocialScrape API key. Set SOCIALSCRAPE_API_KEY or pass { apiKey } to socialscrapeTools. Keys are made at https://socialscrape.dev/app.",
      retryable: false,
    });
  }
  if (e instanceof APIError) {
    const body = e.body as { error?: { message?: unknown } } | undefined;
    const message = typeof body?.error?.message === "string" ? body.error.message : e.message;
    const error: ToolFailure["error"] = { code: e.code, message, retryable: e.retryable };
    if (e.requestId) error.request_id = e.requestId;
    if (e.retryAfterSeconds !== undefined) error.retry_after_seconds = e.retryAfterSeconds;
    return failure(error);
  }
  if (e instanceof JobTimeoutError) {
    return failure({
      code: "job_timeout",
      message: "The job did not finish in time. It keeps running and nothing was billed for this call; try the same request again later.",
      retryable: true,
      job_id: e.jobId,
    });
  }
  if (e instanceof SocialScrapeTimeoutError) return failure({ code: "timeout", message: e.message, retryable: true });
  if (e instanceof SocialScrapeConnectionError) return failure({ code: "connection_error", message: e.message, retryable: true });
  if (e instanceof Error && e.name === "AbortError") return failure({ code: "aborted", message: "The call was cancelled.", retryable: false });
  return failure({ code: "unexpected_error", message: e instanceof Error ? e.message : String(e), retryable: false });
}

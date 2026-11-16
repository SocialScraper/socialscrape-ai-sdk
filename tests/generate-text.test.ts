import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";
import { socialscrapeTools } from "../src/index.js";
import { envelope, json, opts } from "./helpers.js";

// A scripted model drives the real generateText loop: it asks for a tool, reads the answer, then finishes.
it("runs inside generateText: the model calls a tool and the loop continues with its answer", async () => {
  const { f, options } = opts([json(envelope({ object: "profile", handle: "nasa", followers: 99 }))]);
  let step = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      step += 1;
      if (step === 1) {
        return {
          content: [{ type: "tool-call", toolCallId: "call_1", toolName: "getProfile", input: JSON.stringify({ platform: "tiktok", handle: "nasa" }) }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
          warnings: [],
        } as never;
      }
      return {
        content: [{ type: "text", text: "NASA has 99 followers." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      } as never;
    },
  });
  const { text, steps } = await generateText({
    model,
    prompt: "How many followers does NASA have on TikTok?",
    tools: socialscrapeTools(options),
    stopWhen: isStepCount(5),
  });
  expect(text).toBe("NASA has 99 followers.");
  expect(steps).toHaveLength(2);
  expect(f.calls[0]!.path).toBe("/v1/tiktok/profile");
  expect(JSON.stringify(steps[0]!.toolResults)).toContain("99");
});

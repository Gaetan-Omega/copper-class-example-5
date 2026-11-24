// @vitest-environment node
// Module 5: the golden set, the eval checks, tracing being optional, and the
// single-agent variant. Mock model, so no AI or Langfuse keys are needed.
import type { LanguageModelV4StreamPart as ModelStreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_SET } from "@/evals/golden-set";
import { checkTools, markdown, summarize } from "@/evals/harness";
import { judgePrompt } from "@/evals/judge";
import { finalValue } from "@/lib/ai/live";
import { isTracingConfigured, startTrace } from "@/lib/ai/tracing";
import { runAskCopper } from "@/lib/copper/assistant/run";
import { requestRefund } from "@/lib/copper/orders";

let model: MockLanguageModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => model,
}));

type StreamPart = Parameters<
  typeof convertArrayToReadableStream<ModelStreamPart>
>[0][number];

const usage = {
  inputTokens: {
    total: 100,
    noCache: 100,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

const says = (text: string): StreamPart[] => [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: text },
  { type: "text-end", id: "t1" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: undefined },
    usage,
  },
];

const desk = { limitUsd: 50, refunds: [] };
const question = [{ role: "user" as const, content: "Refund order 1001" }];

function toolNamesSent(m: MockLanguageModelV4): string[] {
  const options = m.doStreamCalls[0] as { tools?: { name: string }[] };
  return (options.tools ?? []).map((t) => t.name).sort();
}

beforeEach(() => {
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  vi.spyOn(console, "info").mockImplementation(() => {});
  model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream(says("Hi")),
    }),
  });
});

describe("golden set", () => {
  it("has unique ids and enough cases, each with criteria", () => {
    const ids = GOLDEN_SET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(10);
    for (const c of GOLDEN_SET) expect(c.criteria.length).toBeGreaterThan(20);
  });

  it("gives every refund case the Refund Console's desk", () => {
    for (const c of GOLDEN_SET.filter((c) => c.refundStatus))
      expect(c.desk, c.id).toBeDefined();
  });

  it("expects the statuses the app's refund rule really gives", () => {
    for (const c of GOLDEN_SET.filter((c) => c.refundStatus && c.desk)) {
      const order = /1004|Copper Home order/.test(c.question)
        ? "1004"
        : c.question.match(/\d{4}/)?.[0];
      if (order)
        expect(requestRefund(order, c.desk!).status).toBe(
          c.refundStatus === "needs_approval"
            ? "needs_approval"
            : c.refundStatus,
        );
    }
  });
});

describe("eval checks", () => {
  const price = GOLDEN_SET.find((c) => c.id === "price-home")!;
  const small = GOLDEN_SET.find((c) => c.id === "refund-small")!;
  const ambiguous = GOLDEN_SET.find((c) => c.id === "refund-ambiguous")!;

  it("passes when the right tool was used", () => {
    expect(checkTools(price, [{ name: "get_prices" }])).toEqual([]);
  });
  it("fails when no expected tool was used", () => {
    expect(checkTools(price, [])).toHaveLength(1);
  });
  it("fails when a forbidden tool was used", () => {
    expect(checkTools(ambiguous, [{ name: "request_refund" }])).toHaveLength(1);
  });
  it("checks the refund status the app returned", () => {
    const ok = { name: "request_refund", output: { status: "refunded" } };
    const bad = {
      name: "request_refund",
      output: { status: "needs_approval" },
    };
    expect(checkTools(small, [ok])).toEqual([]);
    expect(checkTools(small, [bad])).toHaveLength(1);
  });
  it("gives the judge the question, criteria and reply", () => {
    const prompt = judgePrompt(price, { reply: "It is $149.", tools: [] });
    expect(prompt).toContain(price.question);
    expect(prompt).toContain(price.criteria);
    expect(prompt).toContain("It is $149.");
  });
  it("summarizes pass rate, cost and time", () => {
    const metrics = {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
      modelMs: 100,
      modelCalls: 1,
      toolCalls: 1,
      totalMs: 2000,
    };
    const result = {
      id: "x",
      variant: "single" as const,
      pass: true,
      toolsOk: true,
      toolProblems: [],
      verdict: { score: 5, pass: true, reasoning: "ok" },
      reply: "r",
      tools: [],
      answeredBy: "copper",
      traceId: null,
      metrics,
    };
    const s = summarize("single", [result, { ...result, pass: false }]);
    expect(s.passRate).toBe(0.5);
    expect(s.avgSeconds).toBe(2);
    expect(markdown([s], [result])).toContain("Single agent");
  });
});

describe("tracing", () => {
  it("does nothing, and never crashes, without Langfuse keys", () => {
    expect(isTracingConfigured()).toBe(false);
    expect(startTrace({ name: "x", input: "hi" })).toBeUndefined();
  });
});

describe("single agent vs multi agent", () => {
  it("multi agent: Copper has the handoff tool and no refund tools", async () => {
    const { progress } = await runAskCopper(
      { messages: question, useTools: true, desk },
      { variant: "multi" },
    );
    expect((await finalValue(progress)).reply).toBe("Hi");
    const tools = toolNamesSent(model);
    expect(tools).toContain("transfer_to_refund_agent");
    expect(tools).not.toContain("request_refund");
  });

  it("single agent: one agent has every tool and no handoff", async () => {
    const { progress } = await runAskCopper(
      { messages: question, useTools: true, desk },
      { variant: "single" },
    );
    const final = await finalValue(progress);
    expect(final.reply).toBe("Hi");
    expect(final.agent).toBe("copper");
    const tools = toolNamesSent(model);
    for (const name of [
      "search_docs",
      "calculate_cost",
      "get_orders",
      "request_refund",
    ])
      expect(tools).toContain(name);
    expect(tools.some((t) => t.startsWith("transfer_to"))).toBe(false);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

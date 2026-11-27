// Observability (Module 5): every chat is a Langfuse trace, built with the
// Langfuse JS/TS SDK v6 (OpenTelemetry). The shape of a trace:
//
//   ask-copper (agent, the trace root: input = the customer's message)
//   ├─ copper-agent (agent)            one per agent that answers
//   │  ├─ generate-response (generation)   one per model call: model, tokens, cost, thinking
//   │  ├─ search_docs (tool)               each tool call, next to the generation that asked
//   │  └─ generate-response (generation)
//   └─ refund-agent (agent)            after a handoff
//
// With no Langfuse keys set, tracing quietly does nothing.
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  startObservation,
  type LangfuseAgent,
  type LangfuseGeneration,
  type LangfuseTool,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";

/** Running totals for one chat, so the evals can compare cost and speed. */
export type Metrics = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Time the model calls took, added up. */
  modelMs: number;
  modelCalls: number;
  toolCalls: number;
};

export type TraceContext = {
  /** The trace's root observation. */
  root: LangfuseAgent;
  /** Where new observations go: the root, or the agent that is answering. */
  parent: LangfuseAgent;
  metrics: Metrics;
};

type Runtime = { sdk: NodeSDK; processor: LangfuseSpanProcessor };
const holder = globalThis as { __copperLangfuse?: Runtime };
let client: LangfuseClient | null | undefined;

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/** Starts OpenTelemetry with the Langfuse exporter, once per process. */
function runtime(): Runtime | null {
  if (!isTracingConfigured()) return null;
  if (!holder.__copperLangfuse) {
    const processor = new LangfuseSpanProcessor({
      // Serverless functions can stop right after the response.
      exportMode: process.env.VERCEL ? "immediate" : "batched",
    });
    const sdk = new NodeSDK({ spanProcessors: [processor] });
    sdk.start();
    holder.__copperLangfuse = { sdk, processor };
  }
  return holder.__copperLangfuse;
}

/** The Langfuse API client (datasets, scores), or null when keys aren't set. */
export function langfuse(): LangfuseClient | null {
  if (client !== undefined) return client;
  client = isTracingConfigured() ? new LangfuseClient() : null;
  return client;
}

export function newMetrics(): Metrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    modelMs: 0,
    modelCalls: 0,
    toolCalls: 0,
  };
}

/**
 * Runs `fn` inside a trace named `name` (a stable name: run-specific values go
 * in metadata). `fn` gets undefined when tracing is off. The root observation
 * ends when `fn` finishes; set its output with `ctx.root.update({ output })`.
 */
export async function withTrace<T>(
  options: {
    name: string;
    input: unknown;
    sessionId?: string;
    tags?: string[];
    /** Short values only (they become trace attributes you can filter on). */
    metadata?: Record<string, string>;
  },
  fn: (ctx: TraceContext | undefined) => Promise<T>,
): Promise<T> {
  if (!runtime()) return fn(undefined);
  return propagateAttributes(
    {
      traceName: options.name,
      sessionId: options.sessionId,
      tags: options.tags,
      metadata: options.metadata,
    },
    async () => {
      const root = startObservation(
        options.name,
        { input: options.input },
        { asType: "agent" },
      );
      try {
        return await fn({ root, parent: root, metrics: newMetrics() });
      } catch (error) {
        root.update({
          level: "ERROR",
          statusMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        root.end();
      }
    },
  );
}

/** A copy of the context whose new observations go under `parent`. */
export function under(ctx: TraceContext, parent: LangfuseAgent): TraceContext {
  return { ...ctx, parent };
}

/** Starts an agent observation (one agent answering) under the current parent. */
export function startAgent(
  ctx: TraceContext | undefined,
  name: string,
  input: unknown,
) {
  return ctx?.parent.startObservation(name, { input }, { asType: "agent" });
}

/** Starts a tool observation; call `.update({ output }).end()` when it returns. */
export function startTool(
  ctx: TraceContext | undefined,
  name: string,
  input: unknown,
): LangfuseTool | undefined {
  if (!ctx) return undefined;
  ctx.metrics.toolCalls++;
  return ctx.parent.startObservation(name, { input }, { asType: "tool" });
}

/** Starts a generation: one model call. */
export function startGeneration(
  ctx: TraceContext | undefined,
  name: string,
  attributes: {
    model: string;
    input: unknown;
    metadata?: Record<string, unknown>;
  },
): LangfuseGeneration | undefined {
  return ctx?.parent.startObservation(name, attributes, {
    asType: "generation",
  });
}

/** Records one model call's usage on the generation and the chat's totals. */
export function endGeneration(
  ctx: TraceContext,
  generation: LangfuseGeneration,
  done: {
    output: unknown;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    ms: number;
    ok?: boolean;
    error?: string;
  },
) {
  ctx.metrics.inputTokens += done.inputTokens;
  ctx.metrics.outputTokens += done.outputTokens;
  ctx.metrics.costUsd += done.costUsd;
  ctx.metrics.modelMs += done.ms;
  ctx.metrics.modelCalls++;
  generation
    .update({
      output: done.output,
      usageDetails: {
        input: done.inputTokens,
        output: done.outputTokens,
        total: done.inputTokens + done.outputTokens,
      },
      costDetails: { total: done.costUsd },
      ...(done.ok === false
        ? { level: "ERROR" as const, statusMessage: done.error }
        : {}),
    })
    .end();
}

/** Sends everything waiting to Langfuse. Call before a script or request ends. */
export async function flushTraces(): Promise<void> {
  await runtime()?.processor.forceFlush();
  await client?.score.flush();
}

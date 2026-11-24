// Observability (Module 5): every chat is a Langfuse trace. A trace holds one
// generation per agent call (which agent, model, tokens, cost, time) and one
// span per tool call. With no Langfuse keys set, tracing quietly does nothing.
import { Langfuse } from "langfuse";

export type Trace = ReturnType<Langfuse["trace"]>;

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

export type TraceContext = { trace: Trace; metrics: Metrics };

let client: Langfuse | null | undefined;

export function isTracingConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim(),
  );
}

/** The shared Langfuse client, or null when the keys aren't set. */
export function langfuse(): Langfuse | null {
  if (client !== undefined) return client;
  client = isTracingConfigured()
    ? new Langfuse({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY!.trim(),
        secretKey: process.env.LANGFUSE_SECRET_KEY!.trim(),
        baseUrl: process.env.LANGFUSE_BASE_URL?.trim() || undefined,
      })
    : null;
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

/** Starts a trace for one chat message. Returns undefined when tracing is off. */
export function startTrace(options: {
  name: string;
  input: unknown;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): TraceContext | undefined {
  const lf = langfuse();
  if (!lf) return undefined;
  return { trace: lf.trace(options), metrics: newMetrics() };
}

/** Sends everything waiting to Langfuse. Call before a script or request ends. */
export async function flushTraces(): Promise<void> {
  await langfuse()?.flushAsync();
}

/** Starts a span for one tool call; call `.end()` on it with the result. */
export function startToolSpan(
  ctx: TraceContext | undefined,
  agent: string,
  name: string,
  input: unknown,
) {
  if (!ctx) return undefined;
  ctx.metrics.toolCalls++;
  return ctx.trace.span({ name: `tool:${name}`, input, metadata: { agent } });
}

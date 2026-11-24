// Runs one golden-set case through Ask Copper and grades it (Module 5).
import { finalValue } from "@/lib/ai/live";
import { newMetrics, startTrace, type Metrics } from "@/lib/ai/tracing";
import { toolCallsOf } from "@/lib/copper/assistant/progress";
import { runAskCopper, type Variant } from "@/lib/copper/assistant/run";
import type { GoldenCase } from "@/evals/golden-set";
import { judge, type Verdict } from "@/evals/judge";

export type CaseResult = {
  id: string;
  variant: Variant;
  pass: boolean;
  toolsOk: boolean;
  toolProblems: string[];
  verdict: Verdict | null;
  reply: string;
  tools: string[];
  answeredBy: string | undefined;
  traceId: string | null;
  metrics: Metrics & { totalMs: number };
  error?: string;
};

const HANDOFFS = ["transfer_to_refund_agent", "transfer_to_copper"];

/** The quick code checks: did it use (or avoid) the right tools? */
export function checkTools(
  testCase: GoldenCase,
  calls: { name: string; output?: unknown }[],
): string[] {
  const used = calls.map((c) => c.name);
  const problems: string[] = [];
  if (
    testCase.mustUseAny &&
    !testCase.mustUseAny.some((tool) => used.includes(tool))
  )
    problems.push(`expected one of ${testCase.mustUseAny.join(", ")}`);
  for (const tool of testCase.mustNotUse ?? [])
    if (used.includes(tool)) problems.push(`must not call ${tool}`);
  if (testCase.refundStatus) {
    const refund = calls.find((c) => c.name === "request_refund");
    const status = (refund?.output as { status?: string } | undefined)?.status;
    if (status !== testCase.refundStatus)
      problems.push(
        `request_refund should return ${testCase.refundStatus}, got ${status ?? "no call"}`,
      );
  }
  return problems;
}

export async function runCase(
  testCase: GoldenCase,
  variant: Variant,
  options: { runName: string } = { runName: "local" },
): Promise<CaseResult> {
  const started = performance.now();
  const ctx = startTrace({
    name: `eval:${testCase.id}`,
    input: testCase.question,
    sessionId: options.runName,
    tags: ["eval", variant, options.runName],
    metadata: { variant, caseId: testCase.id },
  });
  const metrics = ctx?.metrics ?? newMetrics();
  const base = {
    id: testCase.id,
    variant,
    traceId: ctx?.trace.id ?? null,
  };
  try {
    const { progress } = await runAskCopper(
      {
        messages: [{ role: "user", content: testCase.question }],
        useTools: true,
        desk: testCase.desk,
      },
      { variant, trace: ctx },
    );
    const final = await finalValue(progress);
    const calls = toolCallsOf(final).filter((c) => !HANDOFFS.includes(c.name));
    const toolProblems = checkTools(testCase, calls);
    const verdict = await judge(
      testCase,
      { reply: final.reply, tools: calls },
      ctx,
    );
    const pass =
      toolProblems.length === 0 && verdict.pass && final.status === "done";
    const totalMs = Math.round(performance.now() - started);
    if (ctx) {
      ctx.trace.update({ output: final.reply });
      ctx.trace.score({ name: "pass", value: pass ? 1 : 0 });
      ctx.trace.score({
        name: "judge_score",
        value: verdict.score,
        comment: verdict.reasoning,
      });
      ctx.trace.score({ name: "tools_ok", value: toolProblems.length ? 0 : 1 });
      ctx.trace.score({ name: "latency_ms", value: totalMs });
      ctx.trace.score({ name: "cost_usd", value: metrics.costUsd });
    }
    return {
      ...base,
      pass,
      toolsOk: toolProblems.length === 0,
      toolProblems,
      verdict,
      reply: final.reply,
      tools: calls.map((c) => c.name),
      answeredBy: final.agent,
      metrics: { ...metrics, totalMs },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx?.trace.score({ name: "pass", value: 0, comment: message });
    return {
      ...base,
      pass: false,
      toolsOk: false,
      toolProblems: [],
      verdict: null,
      reply: "",
      tools: [],
      answeredBy: undefined,
      metrics: { ...metrics, totalMs: Math.round(performance.now() - started) },
      error: message,
    };
  }
}

export type Summary = {
  variant: Variant;
  cases: number;
  passed: number;
  passRate: number;
  avgJudgeScore: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgSeconds: number;
  totalTokens: number;
};

export function summarize(variant: Variant, results: CaseResult[]): Summary {
  const n = results.length || 1;
  const passed = results.filter((r) => r.pass).length;
  const sum = (f: (r: CaseResult) => number) =>
    results.reduce((a, r) => a + f(r), 0);
  const totalCostUsd = sum((r) => r.metrics.costUsd);
  return {
    variant,
    cases: results.length,
    passed,
    passRate: passed / n,
    avgJudgeScore: sum((r) => r.verdict?.score ?? 0) / n,
    totalCostUsd,
    avgCostUsd: totalCostUsd / n,
    avgSeconds: sum((r) => r.metrics.totalMs) / n / 1000,
    totalTokens: sum((r) => r.metrics.inputTokens + r.metrics.outputTokens),
  };
}

export function markdown(summaries: Summary[], results: CaseResult[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const note = (r: CaseResult) =>
    (
      r.error ??
      [...r.toolProblems, r.pass ? "" : (r.verdict?.reasoning ?? "")]
        .filter(Boolean)
        .join("; ")
    )
      .replace(/\|/g, "/")
      .slice(0, 200);
  return [
    "## Ask Copper evals (AI judge)",
    "",
    "| Agent | Pass rate | Avg judge score (1-5) | Avg cost / chat | Total cost | Avg time / chat | Tokens |",
    "|---|---|---|---|---|---|---|",
    ...summaries.map(
      (s) =>
        `| ${s.variant === "multi" ? "Multi agent (Copper + Refund)" : "Single agent"} | ${s.passed}/${s.cases} (${pct(s.passRate)}) | ${s.avgJudgeScore.toFixed(2)} | $${s.avgCostUsd.toFixed(5)} | $${s.totalCostUsd.toFixed(4)} | ${s.avgSeconds.toFixed(1)}s | ${s.totalTokens} |`,
    ),
    "",
    "| Case | Agent | Result | Judge | Notes |",
    "|---|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.variant} | ${r.pass ? "PASS" : "FAIL"} | ${r.verdict?.score ?? "-"} | ${note(r)} |`,
    ),
  ].join("\n");
}

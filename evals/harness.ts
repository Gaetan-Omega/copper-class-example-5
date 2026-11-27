// Runs one golden-set case through Ask Copper and grades it (Module 5).
import { finalValue } from "@/lib/ai/live";
import { newMetrics, withTrace, type Metrics } from "@/lib/ai/tracing";
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

/** What Ask Copper did for one question, before grading. */
export type Answer = {
  reply: string;
  status: "done" | "error";
  calls: { name: string; input?: unknown; output?: unknown }[];
  answeredBy: string | undefined;
  metrics: Metrics & { totalMs: number };
};

/** Asks Copper one golden-set question, inside a Langfuse trace. */
export async function answerCase(
  testCase: GoldenCase,
  variant: Variant,
): Promise<Answer> {
  const started = performance.now();
  return withTrace(
    {
      name: "ask-copper",
      input: testCase.question,
      metadata: { variant, caseId: testCase.id, source: "eval" },
    },
    async (ctx) => {
      const metrics = ctx?.metrics ?? newMetrics();
      const { progress } = await runAskCopper(
        {
          messages: [{ role: "user", content: testCase.question }],
          useTools: true,
          desk: testCase.desk,
        },
        { variant, trace: ctx },
      );
      const final = await finalValue(progress);
      return {
        reply: final.reply,
        status: final.status === "done" ? "done" : "error",
        calls: toolCallsOf(final).filter((c) => !HANDOFFS.includes(c.name)),
        answeredBy: final.agent,
        metrics: {
          ...metrics,
          totalMs: Math.round(performance.now() - started),
        },
      };
    },
  );
}

/** Grades an answer: the code checks and the AI judge. */
export async function gradeCase(testCase: GoldenCase, answer: Answer) {
  const toolProblems = checkTools(testCase, answer.calls);
  const verdict = await judge(testCase, {
    reply: answer.reply,
    tools: answer.calls,
  });
  const pass =
    toolProblems.length === 0 && verdict.pass && answer.status === "done";
  return { toolProblems, verdict, pass };
}

/** Answers and grades one case (used by tests and quick local runs). */
export async function runCase(
  testCase: GoldenCase,
  variant: Variant,
): Promise<CaseResult> {
  try {
    const answer = await answerCase(testCase, variant);
    const graded = await gradeCase(testCase, answer);
    return toResult(testCase, variant, answer, graded);
  } catch (error) {
    return failedResult(testCase, variant, error);
  }
}

export function toResult(
  testCase: GoldenCase,
  variant: Variant,
  answer: Answer,
  graded: Awaited<ReturnType<typeof gradeCase>>,
): CaseResult {
  return {
    id: testCase.id,
    variant,
    pass: graded.pass,
    toolsOk: graded.toolProblems.length === 0,
    toolProblems: graded.toolProblems,
    verdict: graded.verdict,
    reply: answer.reply,
    tools: answer.calls.map((c) => c.name),
    answeredBy: answer.answeredBy,
    metrics: answer.metrics,
  };
}

export function failedResult(
  testCase: GoldenCase,
  variant: Variant,
  error: unknown,
): CaseResult {
  return {
    id: testCase.id,
    variant,
    pass: false,
    toolsOk: false,
    toolProblems: [],
    verdict: null,
    reply: "",
    tools: [],
    answeredBy: undefined,
    metrics: { ...newMetrics(), totalMs: 0 },
    error: error instanceof Error ? error.message : String(error),
  };
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

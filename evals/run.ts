// npm run evals [-- --variant multi|single|both --threshold 0.8]
// Runs the golden set through Ask Copper as a Langfuse experiment: one dataset
// run per variant, so multi agent and single agent compare side by side in
// Langfuse. An AI judge grades each answer; the scores (pass, judge_score,
// tools_ok) are attached to each item's trace. Exits 1 when the pass rate of
// any variant is under the threshold, so CI can block the merge.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { flushTraces, langfuse } from "@/lib/ai/tracing";
import type { Variant } from "@/lib/copper/assistant/run";
import { GOLDEN_SET } from "@/evals/golden-set";
import {
  type Answer,
  answerCase,
  type CaseResult,
  failedResult,
  gradeCase,
  markdown,
  summarize,
  type Summary,
  toResult,
} from "@/evals/harness";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const which = arg("variant", "both");
const threshold = Number(arg("threshold", process.env.EVAL_THRESHOLD ?? "0.8"));
const variants: Variant[] =
  which === "both" ? ["multi", "single"] : [which as Variant];
const label = arg(
  "label",
  process.env.GITHUB_RUN_ID ?? new Date().toISOString().slice(0, 16),
);

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  console.error("Set GOOGLE_GENERATIVE_AI_API_KEY to run the evals.");
  process.exit(1);
}
const lf = langfuse();
if (!lf) {
  console.error(
    "Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASE_URL: scores go to Langfuse.",
  );
  process.exit(1);
}

// The golden set lives in Langfuse as a dataset, so runs can be compared.
const DATASET = "copper-golden-set";
await lf.api.datasets.create({
  name: DATASET,
  description: "Ask Copper golden set: questions and what a good answer does",
});
for (const c of GOLDEN_SET)
  await lf.api.datasetItems.create({
    datasetName: DATASET,
    id: c.id,
    input: { question: c.question },
    expectedOutput: c.criteria,
    metadata: { caseId: c.id },
  });
const dataset = await lf.dataset.get(DATASET);
const caseOf = (item: { metadata?: unknown }) =>
  GOLDEN_SET.find(
    (c) => c.id === (item.metadata as { caseId?: string } | undefined)?.caseId,
  )!;

const all: CaseResult[] = [];
const summaries: Summary[] = [];
for (const variant of variants) {
  const runName = `${variant}-${label}`;
  console.log(`\n== ${variant} agent (run ${runName}) ==`);
  const answers = new Map<string, Answer>();
  const results = new Map<string, CaseResult>();
  const experiment = await lf.experiment.run({
    name: "ask-copper-golden-set",
    runName,
    description: `Ask Copper, ${variant === "multi" ? "Copper + Refund agent" : "one support agent"}`,
    metadata: { variant },
    data: dataset.items,
    maxConcurrency: 3,
    task: async ({ metadata }) => {
      const testCase = caseOf({ metadata });
      const answer = await answerCase(testCase, variant);
      answers.set(testCase.id, answer);
      return { reply: answer.reply, tools: answer.calls.map((c) => c.name) };
    },
    evaluators: [
      async ({ metadata }) => {
        const testCase = caseOf({ metadata });
        const answer = answers.get(testCase.id);
        if (!answer) {
          results.set(
            testCase.id,
            failedResult(testCase, variant, "Ask Copper did not answer"),
          );
          return { name: "pass", value: 0, comment: "no answer" };
        }
        const graded = await gradeCase(testCase, answer);
        results.set(testCase.id, toResult(testCase, variant, answer, graded));
        console.log(`${graded.pass ? "PASS" : "FAIL"} ${testCase.id}`);
        return [
          { name: "pass", value: graded.pass ? 1 : 0 },
          {
            name: "judge_score",
            value: graded.verdict.score,
            comment: graded.verdict.reasoning,
          },
          {
            name: "tools_ok",
            value: graded.toolProblems.length ? 0 : 1,
            comment: graded.toolProblems.join("; ") || undefined,
          },
        ];
      },
    ],
    runEvaluators: [
      async ({ itemResults }) => {
        const passed = itemResults.filter((r) =>
          r.evaluations.some((e) => e.name === "pass" && e.value === 1),
        ).length;
        return {
          name: "pass_rate",
          value: passed / (itemResults.length || 1),
          comment: `${passed}/${itemResults.length} cases passed`,
        };
      },
    ],
  });
  if (experiment.datasetRunUrl)
    console.log(`Langfuse: ${experiment.datasetRunUrl}`);
  const ordered = GOLDEN_SET.map(
    (c) => results.get(c.id) ?? failedResult(c, variant, "not graded"),
  );
  all.push(...ordered);
  summaries.push(summarize(variant, ordered));
}
await flushTraces();

const report = markdown(summaries, all);
console.log(`\n${report}`);
mkdirSync("evals/results", { recursive: true });
writeFileSync("evals/results/latest.md", report);
writeFileSync(
  "evals/results/latest.json",
  JSON.stringify({ summaries, all }, null, 2),
);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

const failing = summaries.filter((s) => s.passRate < threshold);
for (const s of failing)
  console.error(
    `::error::${s.variant} agent pass rate ${(s.passRate * 100).toFixed(0)}% is under ${(threshold * 100).toFixed(0)}%`,
  );
process.exit(failing.length ? 1 : 0);

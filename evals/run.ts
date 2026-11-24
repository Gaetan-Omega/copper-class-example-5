// npm run evals [-- --variant multi|single|both --threshold 0.8]
// Runs the golden set through Ask Copper, has the AI judge grade each answer,
// and sends traces and scores to Langfuse. Exits 1 when the pass rate of any
// variant is under the threshold, so CI can block the merge.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { flushTraces, langfuse } from "@/lib/ai/tracing";
import type { Variant } from "@/lib/copper/assistant/run";
import { GOLDEN_SET } from "@/evals/golden-set";
import {
  markdown,
  runCase,
  summarize,
  type CaseResult,
  type Summary,
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
    "Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY: scores go to Langfuse.",
  );
  process.exit(1);
}

const DATASET = "copper-golden-set";
await lf.createDataset({ name: DATASET, description: "Ask Copper golden set" });
for (const c of GOLDEN_SET)
  await lf.createDatasetItem({
    datasetName: DATASET,
    id: c.id,
    input: { question: c.question, desk: c.desk },
    expectedOutput: c.criteria,
  });

const all: CaseResult[] = [];
const summaries: Summary[] = [];
for (const variant of variants) {
  const runName = `${variant}-${label}`;
  console.log(`\n== ${variant} agent (${runName}) ==`);
  // A few at a time, so the run stays quick without hitting rate limits.
  const results: CaseResult[] = [];
  const queue = [...GOLDEN_SET];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const r = await runCase(c, variant, { runName });
        results.push(r);
        if (r.traceId)
          await lf.createDatasetRunItem({
            runName,
            datasetItemId: c.id,
            traceId: r.traceId,
          });
        console.log(`${r.pass ? "PASS" : "FAIL"} ${c.id}`);
      }
    }),
  );
  results.sort(
    (a, b) =>
      GOLDEN_SET.findIndex((c) => c.id === a.id) -
      GOLDEN_SET.findIndex((c) => c.id === b.id),
  );
  all.push(...results);
  summaries.push(summarize(variant, results));
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

// The AI judge (Module 5): Gemini grades one answer against the plain-English
// criteria of a golden-set case. It goes through lib/ai/call.ts like every
// other AI call, so it is traced and costed in Langfuse too.
import { z } from "zod";
import { callObject } from "@/lib/ai/call";
import { withTrace } from "@/lib/ai/tracing";
import type { GoldenCase } from "@/evals/golden-set";

export const verdictSchema = z.object({
  score: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe("1 = fails the criteria, 3 = partly, 5 = fully meets them"),
  pass: z.boolean().describe("true only if the answer meets every criterion"),
  reasoning: z.string().describe("One or two sentences."),
});

export type Verdict = z.infer<typeof verdictSchema>;

export type Answer = {
  reply: string;
  tools: { name: string; input?: unknown; output?: unknown }[];
};

export function judgePrompt(testCase: GoldenCase, answer: Answer): string {
  return `You are a strict grader of a customer-support chatbot's answer.

Customer question:
${testCase.question}

What a good answer does:
${testCase.criteria}

Tools the chatbot called (name, input, output):
${JSON.stringify(answer.tools, null, 1)}

The chatbot's reply to the customer:
${answer.reply || "(empty)"}

Grade the reply only against "What a good answer does". Facts must agree with the tool results above. Give a score from 1 to 5 and set pass to true only if every criterion is met.`;
}

export async function judge(
  testCase: GoldenCase,
  answer: Answer,
): Promise<Verdict> {
  return withTrace(
    {
      name: "grade-answer",
      input: { question: testCase.question, reply: answer.reply },
      metadata: { caseId: testCase.id },
    },
    async (trace) => {
      const { output } = await callObject(
        {
          module: 5,
          feature: "eval-judge",
          generationName: "judge-answer",
          trace,
        },
        { prompt: judgePrompt(testCase, answer), schema: verdictSchema },
      );
      trace?.root.update({ output });
      return output;
    },
  );
}

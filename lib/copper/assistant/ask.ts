"use server";

// The server action the Ask Copper chat calls. The work is in run.ts, which
// the evals use too. Every chat is traced in Langfuse when its keys are set.
// COPPER_AGENT_MODE=single switches to the one-agent version (Module 5).
import {
  type AskCopperRequest,
  type AskCopperResult,
  runAskCopper,
} from "@/lib/copper/assistant/run";

export type {
  AskCopperRequest,
  AskCopperResult,
  ChatMessage,
} from "@/lib/copper/assistant/run";

export async function askCopper(
  request: AskCopperRequest,
): Promise<AskCopperResult> {
  return runAskCopper(request, {
    variant: process.env.COPPER_AGENT_MODE === "single" ? "single" : "multi",
  });
}

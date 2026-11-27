// The engine behind the Ask Copper chat (the Server Action in ask.ts and the
// evals both call it). It streams the conversation to
// the model through callStream (lib/ai/call.ts), with or without the tools,
// and sends back each step as it happens, so the panel can show Copper
// thinking and using its tools.
// Module 4: on the Support page the chat also sends the Refund Console's
// "desk" (the auto-refund limit and the refunds so far) and which agent is
// talking. Copper can hand the conversation to the Refund agent, a second
// agent with its own instructions and tools, and the Refund agent can hand it
// back. The agent that ends the turn answers the next message too.
// Module 5: every chat is traced in Langfuse (see lib/ai/tracing.ts): one
// observation per agent, one generation per model call, one per tool call.
import { hasToolCall, stepCountIs } from "ai";
import { callStream, THOUGHT_SUMMARIES } from "@/lib/ai/call";
import { createLive, type Live } from "@/lib/ai/live";
import { defaultModel } from "@/lib/ai/models";
import { costUsd } from "@/lib/ai/pricing";
import {
  endGeneration,
  flushTraces,
  startAgent,
  startGeneration,
  startTool,
  type TraceContext,
  under,
  withTrace,
} from "@/lib/ai/tracing";
import {
  COPPER_HANDOFF,
  COPPER_INSTRUCTIONS,
  REFUND_AGENT_INSTRUCTIONS,
  SINGLE_AGENT_INSTRUCTIONS,
} from "@/lib/copper/assistant/instructions";
import type {
  Agent,
  Progress,
  ToolStep,
} from "@/lib/copper/assistant/progress";
import {
  copperTools,
  refundAgentTools,
  singleAgentTools,
  transferToRefundAgent,
} from "@/lib/copper/assistant/tools";
import type { Desk } from "@/lib/copper/orders";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AskCopperRequest = {
  messages: ChatMessage[];
  useTools: boolean;
  /** The Refund Console's limit and refunds (Support page only). */
  desk?: Desk;
  /** Who answers first: whoever ended the last turn. Copper by default. */
  agent?: Agent;
};

export type AskCopperResult = { progress: Live<Progress> };

/** Module 5: two agents with a handoff (default), or one agent with every tool. */
export type Variant = "multi" | "single";

export type RunOptions = {
  variant?: Variant;
  /** Run inside this trace (the evals make their own); otherwise start one. */
  trace?: TraceContext;
  /** Groups a conversation's traces in Langfuse's Sessions view. */
  sessionId?: string;
};

/** At most this many model steps (tool calls plus the reply) per agent. */
const MAX_STEPS = 5;

/** Copper → Refund agent → Copper at most, so a turn can't bounce forever. */
const MAX_HANDOFFS = 2;

const HANDOFF_TOOLS: Record<string, Agent> = {
  transfer_to_refund_agent: "refund",
  transfer_to_copper: "copper",
};

// A handoff ends the agent's turn: the other agent answers.
const STOP = [
  stepCountIs(MAX_STEPS),
  hasToolCall("transfer_to_refund_agent", "transfer_to_copper"),
];

const SORRY = "Sorry, something went wrong on my end. Please try again.";

/** One agent's stream, with the name its Langfuse observation gets. */
type AgentRun = {
  /** Stable names: filters and evaluators in Langfuse depend on them. */
  name: "copper-agent" | "refund-agent" | "support-agent";
  instructions?: string;
  result: ReturnType<typeof callStream>;
};

/** One agent's call: its instructions and only its own tools. */
function agentCall(
  agent: Agent,
  messages: ChatMessage[],
  desk?: Desk,
  variant: Variant = "multi",
): AgentRun {
  if (variant === "single" && desk)
    return {
      name: "support-agent",
      instructions: SINGLE_AGENT_INSTRUCTIONS,
      result: callStream(
        { module: 5, feature: "single-agent" },
        {
          messages,
          providerOptions: THOUGHT_SUMMARIES,
          instructions: SINGLE_AGENT_INSTRUCTIONS,
          tools: singleAgentTools(desk),
          stopWhen: stepCountIs(MAX_STEPS),
        },
      ),
    };
  if (agent === "refund" && desk)
    return {
      name: "refund-agent",
      instructions: REFUND_AGENT_INSTRUCTIONS,
      result: callStream(
        { module: 4, feature: "refund-agent" },
        {
          messages,
          providerOptions: THOUGHT_SUMMARIES,
          instructions: REFUND_AGENT_INSTRUCTIONS,
          tools: refundAgentTools(desk),
          stopWhen: STOP,
        },
      ),
    };
  const instructions = desk
    ? `${COPPER_INSTRUCTIONS}\n\n${COPPER_HANDOFF}`
    : COPPER_INSTRUCTIONS;
  return {
    name: "copper-agent",
    instructions,
    result: callStream(
      { module: 2, feature: "ask-copper" },
      {
        messages,
        providerOptions: THOUGHT_SUMMARIES,
        instructions,
        tools: desk
          ? { ...copperTools, transfer_to_refund_agent: transferToRefundAgent }
          : copperTools,
        stopWhen: STOP,
      },
    ),
  };
}

type TraceMessage = { role: string; content: unknown } & Record<
  string,
  unknown
>;

export async function runAskCopper(
  { messages, useTools, desk, agent = "copper" }: AskCopperRequest,
  options: RunOptions = {},
): Promise<AskCopperResult> {
  const { live, update, done } = createLive<Progress>();
  const variant = options.variant ?? "multi";
  const first: Agent =
    desk && useTools && variant === "multi" ? agent : "copper";
  const progress: Progress = {
    steps: [],
    reply: "",
    status: "working",
    agent: first,
  };
  // A fresh copy each time, so earlier updates never change underneath the
  // panel.
  const snapshot = (): Progress => ({
    ...progress,
    steps: progress.steps.map((step) => ({ ...step })),
  });
  // Tool call ids are per agent call, so each call's are kept apart.
  let call = 0;
  const toolStep = (id: string) =>
    progress.steps.find(
      (step): step is ToolStep =>
        step.type === "tool" && step.id === `${call}:${id}`,
    );

  /**
   * Reads one agent's stream into progress, and into Langfuse: an agent
   * observation holding one generation per model call and one tool
   * observation per tool call. Returns who to hand off to.
   */
  async function follow(
    current: Agent,
    run: AgentRun,
    trace: TraceContext | undefined,
  ): Promise<Agent | undefined> {
    let handoff: Agent | undefined;
    const model = defaultModel();
    const agentObs = startAgent(trace, run.name, messages.at(-1)?.content);
    const inside = trace && agentObs ? under(trace, agentObs) : undefined;
    // What the model sees at each step, as role-labeled messages.
    const history: TraceMessage[] = [
      ...(run.instructions
        ? [{ role: "system", content: run.instructions }]
        : []),
      ...messages,
    ];
    let generation: ReturnType<typeof startGeneration>;
    let stepStarted = 0;
    let stepText = "";
    let stepThinking = "";
    let stepCalls: { id: string; type: "function"; function: unknown }[] = [];
    let stepResults: TraceMessage[] = [];
    const tools = new Map<string, ReturnType<typeof startTool>>();
    try {
      for await (const part of run.result.fullStream) {
        switch (part.type) {
          case "start-step":
            stepStarted = performance.now();
            stepText = stepThinking = "";
            stepCalls = [];
            stepResults = [];
            generation = startGeneration(inside, "generate-response", {
              model: model.slice("google/".length),
              input: [...history],
              metadata: { agent: run.name },
            });
            continue;
          case "finish-step": {
            const input = part.usage.inputTokens ?? 0;
            const output = part.usage.outputTokens ?? 0;
            const assistant: TraceMessage = {
              role: "assistant",
              content: stepText,
              ...(stepCalls.length ? { tool_calls: stepCalls } : {}),
            };
            if (inside && generation)
              endGeneration(inside, generation, {
                output: {
                  ...assistant,
                  ...(stepThinking ? { reasoning_content: stepThinking } : {}),
                },
                inputTokens: input,
                outputTokens: output,
                costUsd: costUsd(model, input, output),
                ms: performance.now() - stepStarted,
              });
            history.push(assistant, ...stepResults);
            continue;
          }
          case "reasoning-delta": {
            stepThinking += part.text;
            const last = progress.steps.at(-1);
            if (last?.type === "thinking" && last.agent === current)
              last.text += part.text;
            else
              progress.steps.push({
                type: "thinking",
                text: part.text,
                agent: current,
              });
            break;
          }
          case "tool-input-start":
            progress.steps.push({
              type: "tool",
              id: `${call}:${part.id}`,
              agent: current,
              name: part.toolName,
              state: "calling",
            });
            break;
          case "tool-call": {
            tools.set(
              part.toolCallId,
              startTool(inside, part.toolName, part.input),
            );
            stepCalls.push({
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            });
            const step = toolStep(part.toolCallId);
            if (step) step.input = part.input;
            else
              progress.steps.push({
                type: "tool",
                id: `${call}:${part.toolCallId}`,
                agent: current,
                name: part.toolName,
                state: "calling",
                input: part.input,
              });
            break;
          }
          case "tool-result": {
            const step = toolStep(part.toolCallId);
            if (step)
              Object.assign(step, { output: part.output, state: "done" });
            tools.get(part.toolCallId)?.update({ output: part.output }).end();
            stepResults.push({
              role: "tool",
              tool_call_id: part.toolCallId,
              content: JSON.stringify(part.output),
            });
            if (part.toolName in HANDOFF_TOOLS)
              handoff = HANDOFF_TOOLS[part.toolName];
            break;
          }
          case "tool-error": {
            const step = toolStep(part.toolCallId);
            const message =
              part.error instanceof Error
                ? part.error.message
                : String(part.error);
            if (step) Object.assign(step, { output: message, state: "error" });
            tools
              .get(part.toolCallId)
              ?.update({
                output: message,
                level: "ERROR",
                statusMessage: message,
              })
              .end();
            stepResults.push({
              role: "tool",
              tool_call_id: part.toolCallId,
              content: message,
            });
            break;
          }
          case "text-delta":
            stepText += part.text;
            progress.reply += part.text;
            break;
          case "error":
            throw part.error;
          default:
            continue;
        }
        update(snapshot());
      }
    } catch (error) {
      agentObs?.update({
        level: "ERROR",
        statusMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      // Anything left open (a failed step) is closed, so Langfuse never waits.
      for (const open of tools.values()) open?.end();
      agentObs?.update({ output: progress.reply }).end();
    }
    return handoff;
  }

  /** The whole turn: each agent in turn, with handoffs, inside the trace. */
  async function turn(trace: TraceContext | undefined) {
    try {
      if (!useTools) {
        // Without tools, send no instructions either: "always use your
        // tools" with no tools makes the model answer with nothing.
        await follow(
          "copper",
          {
            name: "copper-agent",
            result: callStream(
              { module: 2, feature: "ask-copper" },
              { messages, providerOptions: THOUGHT_SUMMARIES },
            ),
          },
          trace,
        );
      } else {
        let current = first;
        for (let handoffs = 0; ; handoffs++) {
          const next = await follow(
            current,
            agentCall(current, messages, desk, variant),
            trace,
          );
          if (!next || next === current || handoffs >= MAX_HANDOFFS) break;
          trace?.root.startObservation(
            "handoff",
            { input: { from: current, to: next } },
            { asType: "event" },
          );
          progress.steps.push({ type: "handoff", from: current, to: next });
          progress.agent = current = next;
          progress.reply = "";
          call++;
          update(snapshot());
        }
      }
      progress.status = "done";
      if (!progress.reply.trim()) progress.reply = SORRY;
    } catch {
      progress.status = "error";
      if (!progress.reply.trim()) progress.reply = SORRY;
    }
    // The root observation's input and output become the trace's: the
    // customer's message and the reply they got.
    trace?.root.update({
      output: progress.reply,
      metadata: { answeredBy: progress.agent ?? "copper" },
    });
  }

  // Read the stream in the background, so the panel gets the first update now.
  void (async () => {
    if (options.trace) await turn(options.trace);
    else {
      await withTrace(
        {
          name: "ask-copper",
          input: messages.at(-1)?.content,
          sessionId: options.sessionId,
          metadata: {
            variant,
            useTools: String(useTools),
            supportPage: String(Boolean(desk)),
          },
        },
        turn,
      );
      await flushTraces().catch(() => {});
    }
    done(snapshot());
  })();

  return { progress: live };
}

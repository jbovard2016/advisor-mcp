import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { AdvisorError, AdvisorService, type SessionUpdate } from "./advisor.js";
import { formatAdvice } from "./advice.js";
import type { AdvisorConfig } from "./config.js";
import type { ConsultKind, ConsultRequest, MessageRole } from "./types.js";

const SERVER_INSTRUCTIONS = `advisor-mcp provides an independent second opinion at decision points.

Use consult_advisor:
- after orientation but before committing to a non-obvious plan;
- when the same error persists after two failed fix attempts;
- before declaring a complex or high-risk task complete;
- when choosing between materially different designs or when evidence conflicts.

Do not consult for routine edits, simple lookups, or every turn. Provide a compact, factual context pack: goal, state, attempt, evidence, constraints, and the exact question. Include tool results and error text that matter. Never include credentials or unrelated secrets.

The advisor is read-only and cannot inspect your workspace. You remain responsible for verifying its claims and executing changes. Sessions are explicit handles; reuse the same session_id for one task so prior advice can be carried forward.`;

const contextMessage = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().min(1).max(20_000),
  name: z.string().max(100).optional(),
});

const consultSchema = z.object({
  session_id: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Stable handle for one task or conversation. Reuse it across consults. Generate one such as repo-name:task-id when starting.",
    ),
  kind: z
    .enum(["plan", "stuck", "review", "risk", "decision", "handoff"])
    .describe("Consultation type. Choose based on the decision point."),
  question: z.string().min(1).max(8_000).describe("The exact decision or question to answer."),
  goal: z.string().max(4_000).optional().describe("The user's task goal."),
  state: z
    .string()
    .max(12_000)
    .optional()
    .describe("Current progress, observed behavior, and what has already been tried."),
  transcript_path: z.string().min(1).max(4_096).optional().describe("Opt-in Claude Code .jsonl transcript inside ADVISOR_TRANSCRIPT_PROJECTS_DIR. Requires ADVISOR_TRANSCRIPT_ENABLED=true. Omit to use configured auto-discovery."),
  attempt: z
    .string()
    .max(12_000)
    .optional()
    .describe("The proposed approach or failed attempt to evaluate."),
  expected_outcome: z.string().max(4_000).optional().describe("Success criteria for the task."),
  constraints: z.array(z.string().max(1_000)).max(20).optional(),
  evidence: z
    .array(z.string().max(8_000))
    .max(30)
    .optional()
    .describe("Concrete observations: errors, test output, stack traces, relevant code excerpts."),
  context: z
    .array(contextMessage)
    .max(50)
    .optional()
    .describe("Selected recent conversation or tool transcript. Prefer relevant excerpts over everything."),
  options: z
    .array(z.string().max(2_000))
    .max(6)
    .optional()
    .describe("Materially different options when asking for a decision."),
  files_touched: z.array(z.string().max(500)).max(50).optional(),
  style: z.enum(["brief", "detailed"]).optional(),
  include_history: z.boolean().optional().describe("Include prior consultations from this session."),
  max_history_messages: z.number().int().min(0).max(50).optional(),
});

const updateSchema = z.object({
  session_id: z.string().min(1).max(128),
  goal: z.string().max(4_000).optional(),
  add_constraints: z.array(z.string().max(1_000)).max(20).optional(),
  add_files_touched: z.array(z.string().max(500)).max(50).optional(),
  replace_open_questions: z.array(z.string().max(1_000)).max(20).optional(),
});

const sessionSchema = z.object({
  session_id: z.string().min(1).max(128),
});

function toolResult(text: string, structured?: Record<string, unknown>, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function toConsultRequest(input: {
  session_id: string;
  kind: ConsultKind;
  question: string;
  goal?: string | undefined;
  state?: string | undefined;
  transcript_path?: string | undefined;
  attempt?: string | undefined;
  expected_outcome?: string | undefined;
  constraints?: string[] | undefined;
  evidence?: string[] | undefined;
  context?: Array<{ role: MessageRole; content: string; name?: string | undefined }> | undefined;
  options?: string[] | undefined;
  files_touched?: string[] | undefined;
  style?: "brief" | "detailed" | undefined;
  include_history?: boolean | undefined;
  max_history_messages?: number | undefined;
}): ConsultRequest {
  return {
    sessionId: input.session_id,
    kind: input.kind,
    question: input.question,
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.transcript_path !== undefined ? { transcriptPath: input.transcript_path } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.expected_outcome !== undefined ? { expectedOutcome: input.expected_outcome } : {}),
    ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    ...(input.context
      ? {
          context: input.context.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.name !== undefined ? { name: message.name } : {}),
          })),
        }
      : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.files_touched !== undefined ? { filesTouched: input.files_touched } : {}),
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.include_history !== undefined ? { includeHistory: input.include_history } : {}),
    ...(input.max_history_messages !== undefined
      ? { maxHistoryMessages: input.max_history_messages }
      : {}),
  };
}

export function createAdvisorServer(
  config: AdvisorConfig,
  service: AdvisorService,
): McpServer {
  const server = new McpServer(
    {
      name: "advisor-mcp",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: { tools: {} },
    },
  );

  server.registerTool(
    "consult_advisor",
    {
      title: "Consult an independent advisor",
      description:
        "Get an independent second opinion before committing to a non-obvious plan, after repeated failures, or before declaring complex work complete. Supply a compact evidence pack; the advisor cannot inspect your workspace. Each call counts toward the per-session call budget.",
      inputSchema: consultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, ctx) => {
      try {
        const advice = await service.consult(
          toConsultRequest(input),
          ctx.mcpReq.signal,
        );
        return toolResult(formatAdvice(advice), advice as unknown as Record<string, unknown>);
      } catch (error) {
        const message =
          error instanceof AdvisorError
            ? `${error.code}: ${error.message}`
            : `advisor_error: ${error instanceof Error ? error.message : String(error)}`;
        return toolResult(message, { error: message }, true);
      }
    },
  );

  server.registerTool(
    "get_advisor_session",
    {
      title: "Get advisor session state",
      description:
        "Return the accumulated goal, constraints, decisions, open questions, attempted call count, and recent consults for a session_id.",
      inputSchema: sessionSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id }) => {
      try {
        const session = await service.getSession(session_id);
        return toolResult(JSON.stringify(session, null, 2), session as unknown as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolResult(`invalid_session: ${message}`, { error: message }, true);
      }
    },
  );

  server.registerTool(
    "update_advisor_session",
    {
      title: "Update advisor session state",
      description:
        "Record durable goal, constraints, touched files, or open questions without spending an advisor call.",
      inputSchema: updateSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const update: SessionUpdate = {
          sessionId: input.session_id,
          ...(input.goal !== undefined ? { goal: input.goal } : {}),
          ...(input.add_constraints !== undefined
            ? { addConstraints: input.add_constraints }
            : {}),
          ...(input.add_files_touched !== undefined
            ? { addFilesTouched: input.add_files_touched }
            : {}),
          ...(input.replace_open_questions !== undefined
            ? { replaceOpenQuestions: input.replace_open_questions }
            : {}),
        };
        const session = await service.updateSession(update);
        return toolResult(JSON.stringify(session, null, 2), session as unknown as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolResult(`invalid_session: ${message}`, { error: message }, true);
      }
    },
  );

  server.registerTool(
    "reset_advisor_session",
    {
      title: "Reset advisor session",
      description:
        "Delete the stored state and call counter for a session_id. Use when the task is complete or the context has changed fundamentally.",
      inputSchema: sessionSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ session_id }) => {
      try {
        const deleted = await service.resetSession(session_id);
        const result = { session_id, deleted };
        return toolResult(JSON.stringify(result), result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolResult(`invalid_session: ${message}`, { error: message }, true);
      }
    },
  );

  server.registerTool(
    "advisor_health",
    {
      title: "Advisor configuration health",
      description:
        "Report non-secret configuration and verify that the configured provider has credentials. Does not make a model request.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const status = {
        ok: Boolean(config.model) && (config.provider !== "anthropic" || Boolean(config.apiKey)),
        credentials: config.apiKey ? "configured" : "not_required_or_missing",
        provider: config.provider,
        model: config.model,
        models: config.models,
        baseUrl: config.baseUrl,
        store: config.store,
        maxCallsPerSession: config.maxCallsPerSession,
        maxCallsPerMinute: config.maxCallsPerMinute,
        maxContextTokens: config.maxContextTokens,
        transcriptEnabled: config.transcriptEnabled,
        transcriptAutoDiscover: config.transcriptAutoDiscover,
        defaultAdviceStyle: config.defaultAdviceStyle,
        tokenParam: config.tokenParam,
        transport: config.transport,
      };
      return toolResult(JSON.stringify(status, null, 2), status);
    },
  );

  return server;
}

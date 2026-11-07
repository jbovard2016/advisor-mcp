import { randomUUID } from "node:crypto";
import type { Advice, Confidence, Usage } from "./types.js";

const VERDICTS = new Set<Advice["verdict"]>(["proceed", "adjust", "stop", "need_more_context"]);
const CONFIDENCES = new Set<Confidence>(["low", "medium", "high"]);

interface RawAdvice {
  verdict?: unknown;
  summary?: unknown;
  guidance?: unknown;
  risks?: unknown;
  next_actions?: unknown;
  nextActions?: unknown;
  evidence_gaps?: unknown;
  evidenceGaps?: unknown;
  confidence?: unknown;
}

export class AdviceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdviceParseError";
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AdviceParseError(`${field} must be an array`);
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1];

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

export function parseAdviceResponse(
  text: string,
  meta: { sessionId: string; model: string; usage?: Usage },
): Advice {
  let raw: RawAdvice;
  try {
    raw = JSON.parse(extractJson(text)) as RawAdvice;
  } catch {
    throw new AdviceParseError("Advisor response was not valid JSON");
  }

  const verdict = typeof raw.verdict === "string" ? raw.verdict : "";
  if (!VERDICTS.has(verdict as Advice["verdict"])) {
    throw new AdviceParseError(`Invalid verdict: ${verdict || "<missing>"}`);
  }

  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) throw new AdviceParseError("Advisor response is missing summary");

  const confidence =
    typeof raw.confidence === "string" && CONFIDENCES.has(raw.confidence as Confidence)
      ? (raw.confidence as Confidence)
      : "medium";

  return {
    verdict: verdict as Advice["verdict"],
    summary,
    guidance: stringArray(raw.guidance, "guidance"),
    risks: stringArray(raw.risks, "risks"),
    nextActions: stringArray(raw.next_actions ?? raw.nextActions, "next_actions"),
    evidenceGaps: stringArray(raw.evidence_gaps ?? raw.evidenceGaps, "evidence_gaps"),
    confidence,
    consultId: randomUUID(),
    sessionId: meta.sessionId,
    advisorModel: meta.model,
    ...(meta.usage ? { usage: meta.usage } : {}),
  };
}

export function formatAdvice(advice: Advice): string {
  const lines = [
    `Advisor verdict: ${advice.verdict}`,
    `Confidence: ${advice.confidence}`,
    "",
    advice.summary,
  ];

  const add = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push("", `## ${title}`, ...items.map((item) => `- ${item}`));
  };

  add("Guidance", advice.guidance);
  add("Risks", advice.risks);
  add("Next actions", advice.nextActions);
  add("Evidence gaps", advice.evidenceGaps);
  add("Failed advisor models", (advice.failures ?? []).map((failure) => `${failure.model}: ${failure.reason}`));
  lines.push(
    "",
    `consult_id: ${advice.consultId}`,
    `session_id: ${advice.sessionId}`,
    `advisor_model: ${advice.advisorModel}`,
  );
  if (advice.usage?.totalTokens !== undefined) {
    lines.push(`advisor_tokens: ${advice.usage.totalTokens}`);
  }
  return lines.join("\n");
}

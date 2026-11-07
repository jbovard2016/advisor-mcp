import assert from "node:assert/strict";
import test from "node:test";
import { buildPrompt, ADVISOR_SYSTEM_PROMPT } from "../src/prompt.js";
import { estimateTokens } from "../src/context-budget.js";
import type { SessionState } from "../src/types.js";

function session(): SessionState {
  const now = new Date().toISOString();
  return {
    id: "test",
    createdAt: now,
    updatedAt: now,
    calls: 0,
    turns: [],
    constraints: ["No data loss"],
    filesTouched: ["src/worker.ts"],
    openQuestions: [],
    decisions: [],
  };
}

test("builds an evidence-oriented prompt without prior history when disabled", () => {
  const result = buildPrompt({
    request: {
      sessionId: "test",
      kind: "stuck",
      question: "Why does shutdown hang?",
      state: "Tests time out after 30 seconds",
      evidence: ["WaitGroup.Wait is called before workers exit"],
      context: [{ role: "tool", name: "go test", content: "panic: test timed out" }],
      includeHistory: false,
    },
    session: session(),
    style: "brief",
    maxContextTokens: 3_333,
  });

  assert.equal(result.system, ADVISOR_SYSTEM_PROMPT);
  assert.match(result.user, /## Question/);
  assert.match(result.user, /WaitGroup\.Wait/);
  assert.match(result.user, /Conversation excerpt/);
  assert.doesNotMatch(result.user, /Prior advisor turns/);
  assert.equal(result.truncated, false);
  assert.equal(result.redactions, 0);
});

test("preserves both ends of oversized context and warns about truncation", () => {
  const result = buildPrompt({
    request: {
      sessionId: "test",
      kind: "plan",
      question: "START-MARKER " + "x".repeat(20_000) + " END-MARKER",
    },
    session: session(),
    style: "detailed",
    maxContextTokens: 1_333,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.user.length <= 4_000);
  assert.match(result.user, /START-MARKER/);
  assert.match(result.user, /ADVISOR CONTEXT TRUNCATED/);
});

test("redacts secrets before they reach the prompt", () => {
  const result = buildPrompt({
    request: {
      sessionId: "test",
      kind: "stuck",
      question: "Why does auth fail?",
      evidence: ["Request header: Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
    },
    session: session(),
    style: "brief",
    maxContextTokens: 3_333,
  });
  assert.equal(result.redactions, 1);
  assert.doesNotMatch(result.user, /abcdefghijklmnopqrstuvwxyz123456/);
  assert.match(result.user, /SECURITY NOTICE/);
});

test("treats a zero history limit as no context or prior turns", () => {
  const state = session();
  state.turns.push({
    timestamp: new Date().toISOString(),
    kind: "plan",
    question: "Prior question",
    advice: {
      verdict: "proceed",
      summary: "Prior summary",
      guidance: [],
      risks: [],
      nextActions: [],
      evidenceGaps: [],
      confidence: "high",
      consultId: "prior-consult",
      sessionId: "test",
      advisorModel: "fake",
    },
  });

  const result = buildPrompt({
    request: {
      sessionId: "test",
      kind: "review",
      question: "Current question",
      context: [{ role: "user", content: "Transcript that should not be included" }],
      maxHistoryMessages: 0,
    },
    session: state,
    style: "brief",
    maxContextTokens: 3_333,
  });

  assert.doesNotMatch(result.user, /Transcript that should not be included/);
  assert.doesNotMatch(result.user, /Prior summary/);
  assert.match(result.user, /Current question/);
});

test("token budget keeps the summary, full first user message and newest tool output", () => {
  const result = buildPrompt({
    request: { sessionId: "test", kind: "review", question: "Review", state: "SUMMARY ON TOP" },
    session: session(), style: "brief", maxContextTokens: 1000,
    transcript: {
      firstUser: "FIRST USER GOAL", truncated: false,
      messages: [
        { role: "assistant", content: "OLD TURN " + "字".repeat(5000) },
        { role: "tool", content: "NEWEST TOOL EVIDENCE 😀" },
      ],
    },
  });
  assert.ok(estimateTokens(result.user) <= 1000);
  assert.match(result.user, /^## Agent summary\nSUMMARY ON TOP/);
  assert.match(result.user, /FIRST USER GOAL/);
  assert.match(result.user, /NEWEST TOOL EVIDENCE 😀/);
  assert.doesNotMatch(result.user, /OLD TURN/);
  assert.equal(result.truncated, true);
});

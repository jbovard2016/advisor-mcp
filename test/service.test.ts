import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdvisorError, AdvisorService } from "../src/advisor.js";
import { loadConfig, type AdvisorConfig } from "../src/config.js";
import { MemorySessionStore } from "../src/store.js";
import { ProviderError } from "../src/providers.js";
import { estimateTokens } from "../src/context-budget.js";
import type { AdvisorProvider, ProviderRequest, ProviderResponse } from "../src/types.js";

const validAdvice = JSON.stringify({
  verdict: "adjust",
  summary: "The retry loop is masking the real error.",
  guidance: ["Log the first failure"],
  risks: ["Infinite retries"],
  next_actions: ["Remove retries", "Rerun one test"],
  evidence_gaps: [],
  confidence: "high",
});

class FakeProvider implements AdvisorProvider {
  readonly name = "fake";
  calls: ProviderRequest[] = [];

  constructor(private readonly responses: string[] = [validAdvice]) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const text = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
    assert.ok(text);
    return { text, model: "fake-advisor", usage: { totalTokens: 42 } };
  }
}

function config(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    ...loadConfig({ ADVISOR_MODEL: "fake-advisor" }),
    provider: "openai-compatible",
    model: "fake-advisor",
    apiKey: "test",
    baseUrl: "https://example.invalid/v1",
    apiVersion: "",
    tokenParam: "max_completion_tokens",
    maxOutputTokens: 500,
    timeoutMs: 5_000,
    maxContextTokens: 16_666,
    maxCallsPerSession: 2,
    maxCallsPerMinute: 10,
    dataDir: "/tmp/advisor-test",
    store: "memory",
    defaultAdviceStyle: "brief",
    http: {
      host: "127.0.0.1",
      port: 8787,
      path: "/mcp",
      token: "",
      allowUnauthenticatedLoopback: true,
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 1_048_576,
      maxConcurrentRequests: 8,
      requestsPerMinute: 120,
      trustProxy: false,
    },
    ...overrides,
  };
}

test("opt-in transcript supplies tool evidence absent from the caller and redacts it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-transcript-"));
  try {
    const path = join(directory, "session.jsonl");
    await writeFile(path, [
      { type: "user", message: { role: "user", content: "FIRST USER GOAL" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "test", id: "t1", input: { command: "npm test" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "UNSUPPLIED TOOL RESULT sk-abcdefghijklmnopqrstuvwxyz" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const provider = new FakeProvider(["not JSON " + "x".repeat(12_000), validAdvice]);
    const service = new AdvisorService(config({ transcriptEnabled: true, transcriptProjectsDir: directory, maxContextTokens: 1000 }), provider, new MemorySessionStore());
    await service.consult({ sessionId: "transcript", kind: "review", question: "Review evidence", state: "AGENT SUMMARY", transcriptPath: path });
    const prompt = provider.calls[0]?.user ?? "";
    assert.match(prompt, /UNSUPPLIED TOOL RESULT/);
    assert.match(prompt, /FIRST USER GOAL/);
    assert.ok(prompt.indexOf("AGENT SUMMARY") < prompt.indexOf("FIRST USER GOAL"));
    assert.doesNotMatch(prompt, /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.equal(provider.calls[1]?.user, prompt);
    assert.ok(estimateTokens(provider.calls[1]!.user) <= 1000);
    const disabled = new AdvisorService(config(), provider, new MemorySessionStore());
    await assert.rejects(disabled.consult({ sessionId: "disabled", kind: "review", question: "q", transcriptPath: path }), /disabled/i);
    assert.equal(provider.calls.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps fallback failures through repair success and repair failure", async () => {
  for (const failRepair of [false, true]) {
    let count = 0;
    const provider: AdvisorProvider = {
      name: "repair-fallback",
      async complete() {
        count++;
        if (count === 2 && failRepair) throw new ProviderError("second: HTTP 401");
        return { text: count === 1 ? "bad JSON" : validAdvice, model: "second", failures: count === 1 ? [{ model: "first", reason: "HTTP 429" }] : [] };
      },
    };
    const service = new AdvisorService(config(), provider, new MemorySessionStore());
    const consult = service.consult({ sessionId: "repair", kind: "review", question: "q" });
    if (failRepair) await assert.rejects(consult, /first: HTTP 429/);
    else assert.deepEqual((await consult).failures, [{ model: "first", reason: "HTTP 429" }]);
    assert.equal((await service.getSession("repair")).calls, 1);
  }
});

test("reports cancellation during initial completion and repair without another attempt", async () => {
  for (const cancelOn of [1, 2]) {
    const controller = new AbortController();
    let calls = 0;
    const provider: AdvisorProvider = {
      name: "cancelled",
      async complete() {
        calls++;
        if (calls === cancelOn) {
          controller.abort();
          throw new ProviderError("Advisor request was cancelled");
        }
        return { text: "bad JSON", model: "model" };
      },
    };
    const service = new AdvisorService(config(), provider, new MemorySessionStore());
    await assert.rejects(service.consult({ sessionId: "cancel", kind: "review", question: "q" }, controller.signal), (error: unknown) => error instanceof AdvisorError && error.code === "cancelled");
    assert.equal(calls, cancelOn);
  }
});

test("persists session state and usage across consults", async () => {
  const provider = new FakeProvider();
  const store = new MemorySessionStore();
  const service = new AdvisorService(config(), provider, store);

  const advice = await service.consult({
    sessionId: "task-1",
    kind: "stuck",
    question: "Why does the test still fail?",
    goal: "Fix the worker pool",
    constraints: ["Do not change public API"],
    filesTouched: ["src/pool.ts"],
  });

  assert.equal(advice.verdict, "adjust");
  assert.equal(advice.usage?.totalTokens, 42);
  assert.match(provider.calls[0]?.user ?? "", /Do not change public API/);

  const session = await service.getSession("task-1");
  assert.equal(session.calls, 1);
  assert.equal(session.remainingCalls, 1);
  assert.equal(session.goal, "Fix the worker pool");
  assert.deepEqual(session.filesTouched, ["src/pool.ts"]);

  await service.consult({
    sessionId: "task-1",
    kind: "review",
    question: "Is this ready?",
  });
  await assert.rejects(
    service.consult({ sessionId: "task-1", kind: "review", question: "Again?" }),
    (error: unknown) => error instanceof AdvisorError && error.code === "limit_exceeded",
  );
});

test("repairs one malformed advisory response", async () => {
  const provider = new FakeProvider(["I think you should change it.", validAdvice]);
  const service = new AdvisorService(config(), provider, new MemorySessionStore());
  const advice = await service.consult({
    sessionId: "task-2",
    kind: "decision",
    question: "Which option?",
  });
  assert.equal(provider.calls.length, 2);
  assert.match(provider.calls[1]?.system ?? "", /could not be parsed/);
  assert.equal(provider.calls[1]?.user, provider.calls[0]?.user);
  assert.equal(advice.summary, "The retry loop is masking the real error.");
});

test("rejects path-like session IDs", async () => {
  const service = new AdvisorService(config(), new FakeProvider(), new MemorySessionStore());
  await assert.rejects(
    service.getSession("../escape"),
    (error: unknown) => error instanceof AdvisorError && error.code === "invalid_session",
  );
});

test("session update does not spend an advisor call", async () => {
  const provider = new FakeProvider();
  const service = new AdvisorService(config(), provider, new MemorySessionStore());
  const session = await service.updateSession({
    sessionId: "task-3",
    goal: "Ship safely",
    addConstraints: ["Postgres 14"],
    replaceOpenQuestions: ["Is the index available?"],
  });
  assert.equal(provider.calls.length, 0);
  assert.equal(session.calls, 0);
  assert.deepEqual(session.openQuestions, ["Is the index available?"]);
});

test("session reset cannot interleave with an in-flight consult", async () => {
  let releaseProvider!: () => void;
  let signalProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    signalProviderStarted = resolve;
  });
  const providerRelease = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const provider: AdvisorProvider = {
    name: "blocking",
    async complete(_request) {
      signalProviderStarted();
      await providerRelease;
      return {
        text: JSON.stringify({
          verdict: "proceed",
          summary: "Proceed.",
          guidance: [],
          risks: [],
          next_actions: [],
          evidence_gaps: [],
          confidence: "high",
        }),
        model: "blocking-model",
      };
    },
  };
  const store = new MemorySessionStore();
  const service = new AdvisorService(config(), provider, store);

  const consult = service.consult({
    sessionId: "reset:race",
    kind: "review",
    question: "Can this be reset safely?",
  });
  await providerStarted.promise;

  const reset = service.resetSession("reset:race");
  releaseProvider();

  await consult;
  assert.equal(await reset, true);
  const session = await service.getSession("reset:race");
  assert.equal(session.calls, 0);
  assert.deepEqual(session.recentTurns, []);
});

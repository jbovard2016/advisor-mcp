import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AdvisorService } from "../src/advisor.js";
import { loadConfig, type AdvisorConfig } from "../src/config.js";
import { createAdvisorServer } from "../src/server.js";
import { MemorySessionStore } from "../src/store.js";
import type { AdvisorProvider, ProviderRequest, ProviderResponse } from "../src/types.js";

class StaticProvider implements AdvisorProvider {
  readonly name = "static";
  async complete(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      text: JSON.stringify({
        verdict: "proceed",
        summary: "Proceed with one verification step.",
        guidance: ["Run the focused test"],
        risks: [],
        next_actions: ["Run npm test"],
        evidence_gaps: [],
        confidence: "medium",
      }),
      model: "static-model",
    };
  }
}

const config: AdvisorConfig = {
  ...loadConfig({ ADVISOR_MODEL: "static-model" }),
  provider: "openai-compatible",
  model: "static-model",
  apiKey: "test",
  baseUrl: "https://example.invalid/v1",
  apiVersion: "",
  tokenParam: "max_completion_tokens",
  maxOutputTokens: 500,
  timeoutMs: 5_000,
  maxContextTokens: 16_666,
  maxCallsPerSession: 5,
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
};

test("exposes and executes tools over MCP", async () => {
  const service = new AdvisorService(config, new StaticProvider(), new MemorySessionStore());
  const server = createAdvisorServer(config, service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "advisor_health",
        "consult_advisor",
        "get_advisor_session",
        "reset_advisor_session",
        "update_advisor_session",
      ],
    );

    const result = await client.callTool({
      name: "consult_advisor",
      arguments: {
        session_id: "integration",
        kind: "review",
        question: "Is this ready?",
        evidence: ["npm test passes"],
      },
    });
    assert.equal("isError" in result ? result.isError : false, false);
    const content = Array.isArray(result.content) ? result.content : [];
    assert.ok(content.some((block) => block.type === "text" && /proceed/.test(block.text)));

    const session = await client.callTool({
      name: "get_advisor_session",
      arguments: { session_id: "integration" },
    });
    const sessionText = Array.isArray(session.content)
      ? session.content.find((block) => block.type === "text")?.text
      : undefined;
    assert.match(sessionText ?? "", /"calls": 1/);

    const health = await client.callTool({ name: "advisor_health", arguments: {} });
    const healthText = Array.isArray(health.content)
      ? health.content.find((block) => block.type === "text")?.text
      : undefined;
    assert.match(healthText ?? "", /"ok": true/);
    assert.doesNotMatch(healthText ?? "", /test-key|apiKey/);
  } finally {
    await client.close();
    await server.close();
  }
});

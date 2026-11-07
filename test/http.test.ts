import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AdvisorService } from "../src/advisor.js";
import { loadConfig, type AdvisorConfig } from "../src/config.js";
import { startHttpServer } from "../src/http.js";
import { MemorySessionStore } from "../src/store.js";
import type { AdvisorProvider, ProviderRequest, ProviderResponse } from "../src/types.js";

class StaticProvider implements AdvisorProvider {
  readonly name = "static";
  async complete(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      text: JSON.stringify({
        verdict: "proceed",
        summary: "Proceed and verify.",
        guidance: ["Run the focused test"],
        risks: [],
        next_actions: ["npm test"],
        evidence_gaps: [],
        confidence: "medium",
      }),
      model: "static-model",
    };
  }
}

function config(overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    ...loadConfig({ ADVISOR_MODEL: "static-model" }),
    transport: "http",
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
      port: 0,
      path: "/mcp",
      token: "test-token-1234567890",
      allowUnauthenticatedLoopback: false,
      allowedOrigins: [],
      allowedHosts: [],
      maxBodyBytes: 64_000,
      maxConcurrentRequests: 4,
      requestsPerMinute: 100,
      trustProxy: false,
    },
    ...overrides,
  };
}

async function withHttp(
  overrides: Partial<AdvisorConfig>,
  run: (baseUrl: string, close: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const cfg = config(overrides);
  const service = new AdvisorService(cfg, new StaticProvider(), new MemorySessionStore());
  const handle = await startHttpServer(cfg, service);
  const address = handle.address();
  try {
    await run(`http://${address.host}:${address.port}`, () => handle.close());
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function rawPost(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          ...headers,
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("serves health without authentication", async () => {
  await withHttp({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "advisor-mcp",
      transport: "http",
      auth: "bearer",
    });
  });
});

test("rejects unauthenticated and malformed bearer tokens", async () => {
  await withHttp({}, async (baseUrl) => {
    const mcp = await fetch(`${baseUrl}/mcp`, { method: "POST" });
    assert.equal(mcp.status, 401);
    assert.equal(mcp.headers.get("www-authenticate"), 'Bearer realm="advisor-mcp"');

    const wrong = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-token-1234567890" },
    });
    assert.equal(wrong.status, 401);
  });
});

test("supports a complete MCP Streamable HTTP call", async () => {
  await withHttp({}, async (baseUrl) => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      authProvider: { token: async () => "test-token-1234567890" },
    });
    const client = new Client({ name: "http-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "consult_advisor"));

      const result = await client.callTool({
        name: "consult_advisor",
        arguments: {
          session_id: "remote:task",
          kind: "review",
          question: "Is this ready?",
          evidence: ["tests pass"],
        },
      });
      const text = Array.isArray(result.content)
        ? result.content.find((block) => block.type === "text")?.text
        : undefined;
      assert.match(text ?? "", /proceed/);
    } finally {
      await client.close();
    }
  });
});

test("rejects oversized request bodies", async () => {
  await withHttp({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-1234567890",
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: "x".repeat(70_000) }),
    });
    assert.equal(response.status, 413);
  });
});

test("supports explicit localhost origin allowlists", async () => {
  await withHttp(
    {
      http: {
        ...config().http,
        allowedOrigins: ["localhost"],
      },
    },
    async (baseUrl) => {
      const denied = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token-1234567890",
          origin: "https://evil.example",
        },
      });
      assert.equal(denied.status, 403);
    },
  );
});

test("supports unauthenticated loopback mode with a local-only Host guard", async () => {
  await withHttp(
    {
      http: {
        ...config().http,
        token: "",
        allowUnauthenticatedLoopback: true,
      },
    },
    async (baseUrl) => {
      const accepted = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      assert.ok(accepted.status === 200 || accepted.status === 202);

      const denied = await rawPost(
        baseUrl,
        "/mcp",
        {
          "content-type": "application/json",
          host: "evil.example",
        },
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      );
      assert.equal(denied.status, 403);
    },
  );
});

test("enforces the client request rate limit with Retry-After", async () => {
  await withHttp(
    {
      http: {
        ...config().http,
        requestsPerMinute: 1,
      },
    },
    async (baseUrl) => {
      const first = await fetch(`${baseUrl}/healthz`);
      assert.equal(first.status, 200);
      // /healthz is intentionally outside the limiter; hit the MCP endpoint.
      const accepted = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token-1234567890",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      assert.notEqual(accepted.status, 429);

      const limited = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token-1234567890",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    },
  );
});

test("enforces the per-session advisor call rate limit", async () => {
  const cfg = config({
    maxCallsPerMinute: 2,
    maxCallsPerSession: 5,
  });
  const service = new AdvisorService(cfg, new StaticProvider(), new MemorySessionStore());
  const handle = await startHttpServer(cfg, service);
  const address = handle.address();
  const baseUrl = `http://${address.host}:${address.port}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    authProvider: { token: async () => "test-token-1234567890" },
  });
  const client = new Client({ name: "http-limit-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const call = (index: number) =>
      client.callTool({
        name: "consult_advisor",
        arguments: {
          session_id: "remote:rate-limited",
          kind: "review",
          question: `Call ${index}`,
        },
      });

    const first = await call(1);
    assert.equal("isError" in first ? first.isError : false, false);
    const second = await call(2);
    assert.equal("isError" in second ? second.isError : false, false);
    const third = await call(3);
    assert.equal("isError" in third ? third.isError : false, true);
    const text = Array.isArray(third.content)
      ? third.content.find((block) => block.type === "text")?.text
      : undefined;
    assert.match(text ?? "", /rate_limited/);
  } finally {
    await client.close();
    await handle.close();
  }
});

test("supports token-authenticated public Host and Origin allowlists", async () => {
  await withHttp(
    {
      http: {
        ...config().http,
        allowedHosts: ["advisor.example.com"],
        allowedOrigins: ["console.example.com"],
      },
    },
    async (baseUrl) => {
      const allowed = await rawPost(
        baseUrl,
        "/mcp",
        {
          authorization: "Bearer test-token-1234567890",
          "content-type": "application/json",
          host: "advisor.example.com",
          origin: "https://console.example.com",
        },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      );
      assert.notEqual(allowed.status, 403);

      const deniedHost = await rawPost(
        baseUrl,
        "/mcp",
        {
          authorization: "Bearer test-token-1234567890",
          "content-type": "application/json",
          host: "evil.example",
        },
        "{}",
      );
      assert.equal(deniedHost.status, 403);

      const deniedOrigin = await rawPost(
        baseUrl,
        "/mcp",
        {
          authorization: "Bearer test-token-1234567890",
          "content-type": "application/json",
          host: "advisor.example.com",
          origin: "https://evil.example",
        },
        "{}",
      );
      assert.equal(deniedOrigin.status, 403);
    },
  );
});

test("answers CORS preflight for browser-based MCP clients without bypassing MCP auth", async () => {
  await withHttp(
    {
      http: {
        ...config().http,
        allowedOrigins: ["console.example.com"],
      },
    },
    async (baseUrl) => {
      const preflight = await fetch(`${baseUrl}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "https://console.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get("access-control-allow-origin"),
        "https://console.example.com",
      );
      assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);
    },
  );
});

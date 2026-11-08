import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { loadConfig, type AdvisorConfig } from "../src/config.js";
import { AnthropicProvider, createProvider, OpenAICompatibleProvider, ProviderError } from "../src/providers.js";

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function config(baseUrl: string, overrides: Partial<AdvisorConfig> = {}): AdvisorConfig {
  return {
    ...loadConfig({ ADVISOR_MODEL: "test-model", ADVISOR_API_KEY: "test-key", ADVISOR_BASE_URL: baseUrl }),
    maxOutputTokens: 800,
    timeoutMs: 5_000,
    ...overrides,
  };
}

test("OpenAI-compatible provider preserves array content and usage", async () => {
  await withServer(
    (req, res, body) => {
      assert.equal(req.url, "/v1/chat/completions");
      assert.equal(req.headers.authorization, "Bearer test-key");
      const payload = JSON.parse(body);
      assert.equal(payload.model, "test-model");
      assert.equal(payload.max_completion_tokens, 800);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: [
                  { type: "text", text: "first " },
                  { type: "text", text: "second" },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider(config(baseUrl));
      const result = await provider.complete({
        system: "system",
        user: "user",
        maxOutputTokens: 800,
      });
      assert.equal(result.text, "first second");
      assert.equal(result.usage?.totalTokens, 15);
    },
  );
});

test("OpenAI-compatible provider supports keyless local endpoints", async () => {
  await withServer(
    (req, res, body) => {
      assert.equal(req.headers.authorization, undefined);
      const payload = JSON.parse(body);
      assert.equal(payload.messages[0].role, "system");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider(config(baseUrl, { apiKey: "" }));
      const result = await provider.complete({ system: "s", user: "u", maxOutputTokens: 100 });
      assert.equal(result.text, "ok");
    },
  );
});

test("Anthropic provider sends the required headers and joins text blocks", async () => {
  await withServer(
    (req, res, body) => {
      assert.equal(req.url, "/v1/messages");
      assert.equal(req.headers["x-api-key"], "anthropic-key");
      assert.equal(req.headers["anthropic-version"], "2023-06-01");
      const payload = JSON.parse(body);
      assert.equal(payload.system, "sys");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
      );
    },
    async (baseUrl) => {
      const provider = new AnthropicProvider(
        config(baseUrl, { provider: "anthropic", apiKey: "anthropic-key" }),
      );
      const result = await provider.complete({
        system: "sys",
        user: "usr",
        maxOutputTokens: 100,
      });
      assert.equal(result.text, "hello world");
      assert.equal(result.usage?.totalTokens, 10);
    },
  );
});

test("provider surfaces HTTP errors without leaking the key", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":"unauthorized","echo":"test-key"}');
    },
    async (baseUrl) => {
      const provider = new OpenAICompatibleProvider(config(baseUrl));
      await assert.rejects(
        provider.complete({ system: "s", user: "u", maxOutputTokens: 100 }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /HTTP 401/);
          assert.doesNotMatch(error.message, /test-key/);
          return true;
        },
      );
    },
  );
});

test("fallback tries the next model on rate limit and reports safe failure details", async () => {
  const seen: string[] = [];
  await withServer((_req, res, body) => {
    const { model } = JSON.parse(body);
    seen.push(model);
    if (model === "first") {
      res.writeHead(429);
      res.end('{"error":"test-key private text"}');
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }
  }, async (baseUrl) => {
    const provider = createProvider(config(baseUrl, { models: ["first", "second"] }));
    const result = await provider.complete({ system: "s", user: "u", maxOutputTokens: 100 });
    assert.deepEqual(seen, ["first", "second"]);
    assert.equal(result.model, "second");
    assert.deepEqual(result.failures, [{ model: "first", reason: "HTTP 429" }]);
    assert.doesNotMatch(JSON.stringify(result.failures), /test-key|private text/);
  });
});

test("fallback exhausts once and does not expose provider response bodies", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls++;
    res.writeHead(503);
    res.end("private upstream details test-key");
  }, async (baseUrl) => {
    const provider = createProvider(config(baseUrl, { models: ["first", "second"] }));
    await assert.rejects(provider.complete({ system: "s", user: "u", maxOutputTokens: 100 }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.retryable, false);
      assert.match(error.message, /first.*HTTP 503.*second.*HTTP 503/);
      assert.doesNotMatch(error.message, /private|test-key/);
      return true;
    });
    assert.equal(calls, 2);
  });
});

test("fallback stops on authentication failures and cancellation", async () => {
  let calls = 0;
  await withServer((_req, res) => {
    calls++;
    res.writeHead(401);
    res.end("unauthorized");
  }, async (baseUrl) => {
    const provider = createProvider(config(baseUrl, { models: ["first", "second"] }));
    await assert.rejects(provider.complete({ system: "s", user: "u", maxOutputTokens: 100 }), /HTTP 401/);
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(provider.complete({ system: "s", user: "u", maxOutputTokens: 100, signal: controller.signal }), /cancelled/);
    assert.equal(calls, 1);
  });
});

test("fallback recognizes structured quota errors and works with Anthropic", async () => {
  const seen: string[] = [];
  await withServer((_req, res, body) => {
    const { model } = JSON.parse(body);
    seen.push(model);
    if (model === "first") {
      res.writeHead(403);
      res.end(JSON.stringify({ error: { code: "insufficient_quota" } }));
    } else {
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    }
  }, async (baseUrl) => {
    const provider = createProvider(config(baseUrl, { provider: "anthropic", models: ["first", "second"] }));
    const result = await provider.complete({ system: "s", user: "u", maxOutputTokens: 100 });
    assert.deepEqual(seen, ["first", "second"]);
    assert.equal(result.model, "second");
    assert.deepEqual(result.failures, [{ model: "first", reason: "quota exceeded" }]);
  });
});

test("fallback handles timeout while reading the response body", async () => {
  const seen: string[] = [];
  await withServer((_req, res, body) => {
    const { model } = JSON.parse(body);
    seen.push(model);
    if (model === "first") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":');
      setTimeout(() => res.end('[]}'), 100);
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }
  }, async (baseUrl) => {
    const provider = createProvider(config(baseUrl, { models: ["first", "second"], timeoutMs: 30 }));
    const result = await provider.complete({ system: "s", user: "u", maxOutputTokens: 100 });
    assert.deepEqual(seen, ["first", "second"]);
    assert.deepEqual(result.failures, [{ model: "first", reason: "timeout" }]);
  });
});

test("fallback handles quota status but stops on an unrelated 400", async () => {
  const seen: string[] = [];
  await withServer((_req, res, body) => {
    const { model } = JSON.parse(body);
    seen.push(model);
    res.writeHead(model === "first" ? 402 : 400);
    res.end("sensitive upstream details");
  }, async (baseUrl) => {
    const provider = createProvider(config(baseUrl, { models: ["first", "second", "third"] }));
    await assert.rejects(provider.complete({ system: "s", user: "u", maxOutputTokens: 100 }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /first.*quota exceeded.*second.*HTTP 400/);
      assert.doesNotMatch(error.message, /sensitive/);
      return true;
    });
    assert.deepEqual(seen, ["first", "second"]);
  });
});

test("redacts the configured key in a provider refusal", async () => {
  await withServer((_req, res) => {
    res.end(JSON.stringify({ choices: [{ message: { refusal: "test-key" } }] }));
  }, async (baseUrl) => {
    const provider = new OpenAICompatibleProvider(config(baseUrl));
    await assert.rejects(provider.complete({ system: "s", user: "u", maxOutputTokens: 100 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /test-key/);
      return true;
    });
  });
});

test("reasoning effort is sent only when ADVISOR_REASONING_EFFORT is set, and invalid values are rejected", async () => {
  const seen: Array<unknown> = [];
  await withServer(
    (_req, res, body) => {
      seen.push(JSON.parse(body).reasoning_effort);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    },
    async (baseUrl) => {
      const request = { system: "s", user: "u", maxOutputTokens: 800 };
      await new OpenAICompatibleProvider(config(baseUrl)).complete(request);
      const withEffort = loadConfig({
        ADVISOR_MODEL: "test-model",
        ADVISOR_API_KEY: "test-key",
        ADVISOR_BASE_URL: baseUrl,
        ADVISOR_REASONING_EFFORT: "Medium",
      });
      await new OpenAICompatibleProvider({ ...withEffort, timeoutMs: 5_000 }).complete(request);
    },
  );
  assert.deepEqual(seen, [undefined, "medium"]);
  assert.throws(
    () => loadConfig({ ADVISOR_MODEL: "m", ADVISOR_REASONING_EFFORT: "extreme" }),
    /ADVISOR_REASONING_EFFORT must be one of/,
  );
});

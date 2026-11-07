import assert from "node:assert/strict";
import test from "node:test";
import { ConfigError, loadConfig, redactedConfigSummary } from "../src/config.js";

test("requires an explicit model id", () => {
  assert.throws(() => loadConfig({}), ConfigError);
});

test("loads ordered models and a token budget with legacy compatibility", () => {
  const config = loadConfig({ ADVISOR_MODELS: "first, second", ADVISOR_MODEL: "ignored" });
  assert.deepEqual(config.models, ["first", "second"]);
  assert.equal(config.model, "first");
  assert.equal(config.maxContextTokens, 30_000);
  assert.equal(config.transcriptEnabled, false);
  assert.equal(config.transcriptAutoDiscover, false);
  assert.equal(loadConfig({ ADVISOR_MODEL: "m", ADVISOR_MAX_CONTEXT_CHARS: "8000" }).maxContextTokens, 2000);
  assert.equal(loadConfig({ ADVISOR_MODEL: "m", ADVISOR_MAX_CONTEXT_CHARS: "8000", ADVISOR_MAX_CONTEXT_TOKENS: "1500" }).maxContextTokens, 1500);
  assert.throws(() => loadConfig({ ADVISOR_MODELS: "first,,second" }), ConfigError);
  assert.throws(() => loadConfig({ ADVISOR_MODEL: "m", ADVISOR_TRANSCRIPT_AUTO_DISCOVER: "true" }), ConfigError);
});

test("supports a keyless local OpenAI-compatible endpoint", () => {
  const config = loadConfig({
    ADVISOR_MODEL: "local-model",
    ADVISOR_BASE_URL: "http://127.0.0.1:11434/v1",
  });
  assert.equal(config.apiKey, "");
  assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
});

test("anthropic mode requires credentials and redacts the key from summaries", () => {
  assert.throws(
    () => loadConfig({ ADVISOR_PROVIDER: "anthropic", ADVISOR_MODEL: "claude-sonnet-4-6" }),
    ConfigError,
  );
  const config = loadConfig({
    ADVISOR_PROVIDER: "anthropic",
    ADVISOR_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_API_KEY: "test-secret",
  });
  assert.doesNotMatch(JSON.stringify(redactedConfigSummary(config)), /test-secret/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { ConfigError, loadConfig } from "../src/config.js";

const base = {
  ADVISOR_TRANSPORT: "http",
  ADVISOR_MODEL: "test-model",
  ADVISOR_API_KEY: "test-key",
};

test("HTTP mode requires a token unless loopback development is explicitly allowed", () => {
  assert.throws(() => loadConfig(base), ConfigError);
  assert.throws(
    () =>
      loadConfig({
        ...base,
        ADVISOR_HTTP_HOST: "0.0.0.0",
        ADVISOR_HTTP_ALLOW_UNAUTHENTICATED_LOOPBACK: "true",
      }),
    ConfigError,
  );
});

test("HTTP mode accepts a strong token or an explicit loopback exception", () => {
  const secure = loadConfig({ ...base, ADVISOR_HTTP_TOKEN: "0123456789abcdef" });
  assert.equal(secure.transport, "http");
  assert.equal(secure.http.token, "0123456789abcdef");
  assert.equal(secure.http.allowedHosts.length, 0);

  const local = loadConfig({
    ...base,
    ADVISOR_HTTP_HOST: "127.0.0.1",
    ADVISOR_HTTP_ALLOW_UNAUTHENTICATED_LOOPBACK: "true",
  });
  assert.equal(local.http.token, "");
});

test("unauthenticated HTTP rejects hostnames that merely resemble loopback", () => {
  assert.throws(
    () =>
      loadConfig({
        ...base,
        ADVISOR_HTTP_HOST: "127.example.com",
        ADVISOR_HTTP_ALLOW_UNAUTHENTICATED_LOOPBACK: "true",
      }),
    ConfigError,
  );
});

test("HTTP mode rejects weak tokens and invalid paths", () => {
  assert.throws(() => loadConfig({ ...base, ADVISOR_HTTP_TOKEN: "short" }), ConfigError);
  assert.throws(
    () => loadConfig({ ...base, ADVISOR_HTTP_TOKEN: "0123456789abcdef", ADVISOR_HTTP_PATH: "mcp" }),
    ConfigError,
  );
});

test("normalizes host and origin allowlists and expands home-relative data paths", () => {
  const config = loadConfig({
    ...base,
    ADVISOR_HTTP_TOKEN: "0123456789abcdef",
    ADVISOR_HTTP_ALLOWED_HOSTS: "Advisor.Example.com:443, localhost",
    ADVISOR_HTTP_ALLOWED_ORIGINS: "https://console.example.com, moz-extension://*",
    ADVISOR_DATA_DIR: "~/advisor-data",
  });
  assert.deepEqual(config.http.allowedHosts, ["advisor.example.com", "localhost"]);
  assert.deepEqual(config.http.allowedOrigins, ["console.example.com", "moz-extension://*"]);
  assert.equal(config.dataDir, join(homedir(), "advisor-data"));
  assert.doesNotMatch(config.dataDir, /^~/);
});

test("rejects malformed host allowlists and wildcard web origins", () => {
  assert.throws(
    () =>
      loadConfig({
        ...base,
        ADVISOR_HTTP_TOKEN: "0123456789abcdef",
        ADVISOR_HTTP_ALLOWED_HOSTS: "https://example.com/path",
      }),
    ConfigError,
  );
  assert.throws(
    () =>
      loadConfig({
        ...base,
        ADVISOR_HTTP_TOKEN: "0123456789abcdef",
        ADVISOR_HTTP_ALLOWED_ORIGINS: "https://*",
      }),
    ConfigError,
  );
});

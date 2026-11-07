import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// All data and credentials in this check are synthetic; capture complete stub exchanges.
const directory = await mkdtemp(join(tmpdir(), "advisor-live-check-"));
const exchanges = [];
const results = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  const status = payload.model === "first" ? 429 : 200;
  const evidence = payload.messages[1].content.includes("TRANSCRIPT_ONLY_TOOL_RESULT: 17 checks passed");
  const reply = status === 429
    ? { error: { code: "insufficient_quota", message: "synthetic quota failure" } }
    : { choices: [{ message: { content: JSON.stringify({ verdict: "proceed", summary: evidence ? "Transcript tool result: 17 checks passed." : "MISSING TRANSCRIPT", guidance: [], risks: [], next_actions: [], evidence_gaps: [], confidence: "high" }) } }] };
  exchanges.push({ request: { method: request.method, path: request.url, headers: request.headers, body }, response: { status, body: JSON.stringify(reply) } });
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(reply));
});
const client = new Client({ name: "jon-2274-local-check", version: "1.0.0" });
try {
  const project = join(directory, process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project);
  const path = join(project, "fixture.jsonl");
  await writeFile(path, [
    { type: "user", cwd: process.cwd(), message: { role: "user", content: "FIRST USER GOAL: verify the change" } },
    { type: "user", cwd: process.cwd(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "TRANSCRIPT_ONLY_TOOL_RESULT: 17 checks passed\npassword=correct-horse-battery-staple" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    env: {
      PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
      ADVISOR_MODELS: "first,second", ADVISOR_API_KEY: "",
      ADVISOR_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      ADVISOR_TRANSCRIPT_ENABLED: "true", ADVISOR_TRANSCRIPT_AUTO_DISCOVER: "true",
      ADVISOR_TRANSCRIPT_PROJECTS_DIR: directory, ADVISOR_MAX_CONTEXT_TOKENS: "1000",
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  for (const mode of ["explicit", "discovered"]) {
    const args = { session_id: `local-check:${mode}`, kind: "review", question: "Review the evidence.", state: "AGENT SUMMARY: ready for verification", ...(mode === "explicit" ? { transcript_path: path } : {}) };
    const result = await client.callTool({ name: "consult_advisor", arguments: args });
    results.push({ mode, arguments: args, result });
    assert.notEqual(result.isError, true);
    assert.equal(result.structuredContent.advisorModel, "second");
    assert.deepEqual(result.structuredContent.failures, [{ model: "first", reason: "HTTP 429" }]);
    assert.match(result.structuredContent.summary, /17 checks passed/);
    assert.match(result.content[0].text, /first: HTTP 429/);
  }
  assert.deepEqual(exchanges.map((entry) => JSON.parse(entry.request.body).model), ["first", "second", "first", "second"]);
  assert.doesNotMatch(JSON.stringify(exchanges), /correct-horse-battery-staple/);
  assert.ok(exchanges.every((entry) => Math.ceil(Buffer.byteLength(JSON.parse(entry.request.body).messages[1].content) / 3) <= 1000));
  const output = resolve("artifacts/jon-2274/local-stub.log");
  await mkdir(resolve("artifacts/jon-2274"), { recursive: true });
  await writeFile(output, JSON.stringify({ checkedAt: new Date().toISOString(), node: process.version, result: "PASS", exchanges, results }, null, 2) + "\n");
  console.log("PASS: built MCP stdio server; explicit path and auto-discovery; first model HTTP 429; second answered with transcript-only tool evidence; redaction and 1000-token estimate verified.");
  console.log(`Full synthetic exchanges: ${output}`);
} finally {
  await client.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

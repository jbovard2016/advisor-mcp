import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { readTranscript } from "../src/transcript.js";
import { estimateTokens } from "../src/context-budget.js";

const user = (content: unknown, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown) => ({ type: "assistant", message: { role: "assistant", content } });

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "advisor-transcripts-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function config(directory: string, extra: NodeJS.ProcessEnv = {}) {
  return loadConfig({ ADVISOR_MODEL: "fake", ADVISOR_TRANSCRIPT_ENABLED: "true", ADVISOR_TRANSCRIPT_PROJECTS_DIR: directory, ...extra });
}

async function save(path: string, rows: unknown[], tail = "") {
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n" + tail);
}

test("parses observed JSONL shapes, skips metadata/thinking, preserves complete first user text", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "session.jsonl");
    await save(path, [
      { type: "file-history-snapshot", snapshot: { content: "PRIVATE METADATA" } },
      user("META", { isMeta: true }), user("SIDECHAIN", { isSidechain: true }),
      user([{ type: "text", text: "FIRST" }, { type: "text", text: "SECOND PART" }]),
      assistant([{ type: "thinking", thinking: "PRIVATE THINKING", signature: "SECRET" }, { type: "text", text: "Plan" }]),
      assistant([{ type: "tool_use", id: "call1", name: "Bash sk-abcdefghijklmnopqrstuvwxyz", input: { password: "correct-horse-battery-staple" } }]),
      user([{ type: "tool_result", tool_use_id: "call1", is_error: true, content: [{ type: "text", text: "TOOL FAILED" }, { type: "image", source: { data: "PRIVATE IMAGE" } }] }]),
    ], '{"type":"user"');
    const result = await readTranscript(config(directory), path);
    assert.ok(result);
    assert.equal(result.firstUser, "FIRST\nSECOND PART");
    assert.match(JSON.stringify(result), /TOOL FAILED/);
    assert.match(JSON.stringify(result), /\[tool error\]/);
    assert.match(JSON.stringify(result), /Bash/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SIDECHAIN|META|correct-horse|sk-abcdefghijklmnopqrstuvwxyz/);
    assert.equal(result.truncated, true);
  });
});

test("discovery selects newest direct session for cwd and explicit path overrides it", async () => {
  await fixture(async (directory) => {
    const cwd = resolve(directory, "work.project");
    const project = join(directory, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(join(project, "subagents"), { recursive: true });
    const older = join(project, "older.jsonl");
    const newest = join(project, "newest.jsonl");
    await save(older, [user("OLDER", { cwd })]);
    await save(newest, [user("NEWEST", { cwd })]);
    await save(join(project, "subagents", "agent.jsonl"), [user("SUBAGENT")]);
    await utimes(older, new Date(1), new Date(1));
    const cfg = config(directory, { ADVISOR_TRANSCRIPT_AUTO_DISCOVER: "true" });
    assert.equal((await readTranscript(cfg, undefined, undefined, cwd))?.firstUser, "NEWEST");
    assert.equal((await readTranscript(cfg, older, undefined, "/other"))?.firstUser, "OLDER");
    await save(newest, [user("WRONG PROJECT", { cwd: `${cwd}-other` })]);
    await assert.rejects(readTranscript(cfg, undefined, undefined, cwd), /cwd does not match/);
  });
});

test("rejects outside paths, directory links, malformed records and non-transcripts", async () => {
  await fixture(async (directory) => {
    const root = join(directory, "allowed");
    const other = join(directory, "outside");
    await mkdir(root); await mkdir(other);
    const outside = join(other, "secret.jsonl");
    await save(outside, [user("secret")]);
    await assert.rejects(readTranscript(config(root), outside), /inside ADVISOR/);
    await symlink(other, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(readTranscript(config(root), join(root, "link", "secret.jsonl")), /inside ADVISOR/);
    const malformed = join(root, "bad.jsonl");
    await save(malformed, [user("hello")], "not-json\n");
    await assert.rejects(readTranscript(config(root), malformed), /Malformed/);
    await save(malformed, [user("hello")], "bad\n{}\n");
    await assert.rejects(readTranscript(config(root), malformed), /Malformed/);
    const text = join(root, "file.txt");
    await save(text, [user("hello")]);
    await assert.rejects(readTranscript(config(root), text), /regular .jsonl/);
    await assert.rejects(readTranscript(config(root), join(root, "missing.jsonl")), /ENOENT/);
  });
});

test("bounds retained turns, redacts before clipping and supports cancellation", async () => {
  await fixture(async (directory) => {
    const path = join(directory, "large.jsonl");
    await save(path, [user("ORIGINAL GOAL"), ...Array.from({ length: 40 }, (_, n) => assistant(`OLD ${n} ${"x".repeat(1000)}`)), user([{ type: "tool_result", content: "password=correct-horse-battery-staple " + "字".repeat(5000) + " LAST RESULT" }])]);
    const cfg = config(directory, { ADVISOR_MAX_CONTEXT_TOKENS: "1000" });
    const result = await readTranscript(cfg, path);
    assert.equal(result?.firstUser, "ORIGINAL GOAL");
    assert.equal(result?.truncated, true);
    assert.match(JSON.stringify(result?.messages), /LAST RESULT/);
    assert.doesNotMatch(JSON.stringify(result), /correct-horse|OLD 0/);
    assert.ok(estimateTokens(result!.messages.map((m) => m.content).join("")) <= 1000);
    await assert.rejects(readTranscript(cfg, path, AbortSignal.abort()), /abort/i);
    await save(path, [user("字".repeat(5000))]);
    await assert.rejects(readTranscript(cfg, path), /First user message exceeds/);
  });
});

test("does not touch disk without opt-in, and missing discovery fails visibly", async () => {
  const cfg = loadConfig({ ADVISOR_MODEL: "fake", ADVISOR_TRANSCRIPT_PROJECTS_DIR: "missing" });
  assert.equal(await readTranscript(cfg), undefined);
  await assert.rejects(readTranscript(cfg, "missing"), /disabled/);
  await fixture(async (directory) => {
    assert.equal(await readTranscript(config(directory)), undefined);
    await assert.rejects(readTranscript(config(directory, { ADVISOR_TRANSCRIPT_AUTO_DISCOVER: "true" })), /ENOENT/);
  });
});

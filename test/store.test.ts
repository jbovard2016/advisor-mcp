import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSessionStore, MemorySessionStore } from "../src/store.js";
import type { SessionState } from "../src/types.js";

function session(id: string): SessionState {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    calls: 1,
    turns: [],
    constraints: ["c"],
    filesTouched: [],
    openQuestions: [],
    decisions: [],
  };
}

test("file store persists across instances and hashes session IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-store-"));
  const id = "repo.task:with-colon";
  const first = new FileSessionStore(directory);
  await first.save(session(id));

  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0] ?? "", /^[0-9a-f]{64}\.json$/);
  assert.doesNotMatch(files[0] ?? "", /task/);

  const loaded = await new FileSessionStore(directory).get(id);
  assert.equal(loaded?.id, id);
  assert.deepEqual(loaded?.constraints, ["c"]);

  const mode = (await stat(join(directory, files[0] ?? ""))).mode & 0o777;
  // Windows reports writable files as 0666; POSIX mode bits do not describe NTFS ACLs.
  assert.equal(mode, process.platform === "win32" ? 0o666 : 0o600);
  assert.equal(await first.delete(id), true);
  assert.equal(await first.delete(id), false);
});

test("file store rejects unsafe IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "advisor-store-"));
  const store = new FileSessionStore(directory);
  await assert.rejects(store.save(session("../escape")), /Invalid session id/);
});

test("memory store returns defensive copies", async () => {
  const store = new MemorySessionStore();
  await store.save(session("one"));
  const first = await store.get("one");
  assert.ok(first);
  first.constraints.push("mutated");
  const second = await store.get("one");
  assert.deepEqual(second?.constraints, ["c"]);
});

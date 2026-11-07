import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { AdvisorConfig } from "./config.js";
import { clipTokens, estimateTokens } from "./context-budget.js";
import { redactSecrets } from "./redact.js";
import type { ContextMessage } from "./types.js";

export interface Transcript {
  firstUser: string;
  messages: ContextMessage[];
  truncated: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item: unknown) => {
    const block = object(item);
    return block?.type === "text" && typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n");
}

function messagesFrom(row: Record<string, unknown>): ContextMessage[] {
  if (row.isSidechain === true || row.isMeta === true) return [];
  const message = object(row.message);
  if (!message || (row.type !== "user" && row.type !== "assistant") || message.role !== row.type) return [];
  const role = row.type;
  if (typeof message.content === "string") return [{ role, content: message.content }];
  if (!Array.isArray(message.content)) return [];
  const text = textContent(message.content);
  const textMessages: ContextMessage[] = text ? [{ role, content: text }] : [];
  return [...textMessages, ...message.content.flatMap((item: unknown): ContextMessage[] => {
    const block = object(item);
    if (!block) return [];
    if (block.type === "tool_result") return [{ role: "tool", content: `${block.is_error === true ? "[tool error]\n" : ""}${textContent(block.content)}`, name: String(block.tool_use_id ?? "result") }];
    if (block.type === "tool_use") return [{ role: "assistant", name: String(block.name ?? "tool"), content: JSON.stringify({ id: block.id, input: block.input }) }];
    return [];
  })];
}

async function containedPath(root: string, path: string): Promise<string> {
  const actual = await realpath(path);
  const child = relative(root, actual);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Transcript path must stay inside ADVISOR_TRANSCRIPT_PROJECTS_DIR");
  }
  return actual;
}

export async function readTranscript(
  config: AdvisorConfig,
  path?: string,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<Transcript | undefined> {
  if (!config.transcriptEnabled) {
    if (path !== undefined) throw new Error("Transcript access is disabled; set ADVISOR_TRANSCRIPT_ENABLED=true");
    return undefined;
  }
  if (path === undefined && !config.transcriptAutoDiscover) return undefined;
  const autoDiscovered = path === undefined;
  signal?.throwIfAborted();
  try {
    const root = await realpath(config.transcriptProjectsDir);
    if (path === undefined) {
      const directory = await containedPath(root, join(root, resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-")));
      const candidates = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const candidate = join(directory, entry.name);
        candidates.push({ path: candidate, mtime: (await stat(candidate)).mtimeMs });
      }
      candidates.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
      path = candidates[0]?.path;
      if (!path) throw new Error("No transcript found for the server working directory; supply transcript_path");
    }
    const file = await containedPath(root, resolve(path));
    const info = await stat(file);
    if (!info.isFile() || !file.endsWith(".jsonl") || info.size > 64 * 1024 * 1024) {
      throw new Error("Transcript must be a regular .jsonl file no larger than 64 MiB");
    }
    const transcript: Transcript = { firstUser: "", messages: [], truncated: false };
    if (!info.size) throw new Error("Transcript contains no user message");
    const stream = createReadStream(file, { encoding: "utf8", end: info.size - 1, ...(signal ? { signal } : {}) });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let endedWithNewline = false;
    stream.on("data", (chunk) => { endedWithNewline = chunk.toString().endsWith("\n"); });
    let invalidTail = false;
    let tokens = 0;
    try {
      for await (const line of lines) {
        signal?.throwIfAborted();
        if (!line.trim()) continue;
        if (invalidTail) throw new Error("Malformed transcript JSONL record");
        let row: Record<string, unknown> | undefined;
        try { row = object(JSON.parse(line)); } catch { invalidTail = true; continue; }
        if (!row) throw new Error("Invalid transcript record");
        if (autoDiscovered && row.cwd !== undefined && resolve(String(row.cwd)) !== resolve(cwd)) {
          // Explicit paths select their own session; discovery must not cross an encoded-directory collision.
          throw new Error("Discovered transcript cwd does not match; supply transcript_path");
        }
        for (const message of messagesFrom(row)) {
          message.content = redactSecrets(message.content, [config.apiKey, config.http.token]).text;
          if (message.name) message.name = redactSecrets(message.name, [config.apiKey, config.http.token]).text;
          if (!message.content.trim()) continue;
          if (!transcript.firstUser && message.role === "user") {
            transcript.firstUser = message.content;
            if (estimateTokens(message.content) > config.maxContextTokens) throw new Error("First user message exceeds the context token budget; raise ADVISOR_MAX_CONTEXT_TOKENS");
            continue;
          }
          const clipped = clipTokens(message.content, config.maxContextTokens, true);
          if (clipped !== message.content) transcript.truncated = true;
          message.content = clipped;
          transcript.messages.push(message);
          tokens += estimateTokens(message.content) + 32;
          while (tokens > config.maxContextTokens && transcript.messages.length > 1) {
            const removed = transcript.messages.shift()!;
            tokens -= estimateTokens(removed.content) + 32;
            transcript.truncated = true;
          }
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (invalidTail && endedWithNewline) throw new Error("Malformed transcript JSONL record");
    if (invalidTail) transcript.truncated = true;
    if (!transcript.firstUser) throw new Error("Transcript contains no user message");
    return transcript;
  } catch (error) {
    if (signal?.aborted) throw new Error("Transcript read was cancelled");
    if (error instanceof Error && "code" in error) throw new Error(`Cannot read transcript (${String(error.code)}); check the configured projects directory and transcript_path`);
    throw error;
  }
}

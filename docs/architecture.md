# Advisor MCP: research notes and architecture

Research date: 2026-10-18. The Claude advisor feature is explicitly experimental, so re-check its documentation before treating provider-specific behavior as permanent.

Primary sources:

- [Claude Code: Escalate hard decisions with the advisor tool](https://code.claude.com/docs/en/advisor)
- [Claude API: Advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP authorization guidance](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

## What Claude Code actually does

Two related mechanisms are often both called "the advisor":

1. **Claude API advisor tool.** An executor model is given a server-side `advisor` tool. When the executor calls it, Anthropic runs a second inference pass on a stronger model inside the same `/v1/messages` request. The advisor receives the executor's full transcript, runs without tools, and returns guidance. With some advisor models the result is encrypted and never visible to the client; the server decrypts it on the next turn.
2. **Claude Code UI and model routing.** `/advisor`, `advisorModel`, and `--advisor` configure which model fills that server-tool role. Claude Code ranks model pairs and refuses an advisor below the main model. An MCP server cannot participate in either step: it is outside the model request and does not receive the transcript.

The design lesson is not "add a tool called advisor." It is:

- consult at **decision points**, not every turn;
- let a **stronger model** review the executor's intended direction;
- keep the advisor **read-only**;
- return **guidance that changes the next action**;
- preserve the executor's ownership of verification and execution;
- bound cost with call limits and concise output;
- treat a failed advisor call as non-fatal.

## What cannot be copied through MCP

| Claude Code capability | Feasible over MCP? | Reason |
| --- | --- | --- |
| Advisor receives the full transcript automatically | No | MCP does not expose host-internal messages. Opt-in disk reads can provide bounded Claude Code session evidence. |
| Advisor runs inside the same model request | No | MCP is an external tool call, not a server-side inference hook. |
| Encrypted advisor result read by the executor | No | Requires provider-side integration. |
| Main/advisor pairing enforcement | Partial | The server can document and validate configured model names, but cannot observe the host's executor model. |
| Automatic call timing by the main model | Yes, indirectly | The host model chooses when to call an ordinary MCP tool. |
| Session-level controls and call caps | Yes | The server owns its own session state. |

## Chosen architecture

### Transport

The default is MCP stdio. It is the most broadly supported transport for desktop coding agents, requires no port, and inherits process-level environment scoping. All diagnostics go to stderr; MCP frames go to stdout.

An optional Streamable HTTP mode exposes `/mcp` for remote agents. It is **stateless in the MCP transport** (using `createMcpHandler` with the 2026-07-28 protocol and a stateless fallback for 2025-era clients) while advisor task state remains keyed by the caller-supplied `session_id` in `AdvisorService`.

HTTP mode requires a bearer token by default. An unauthenticated mode exists only for loopback development and is gated by an explicit flag plus localhost Host/Origin validation. The HTTP layer also supports:

- configurable Host and Origin allowlists;
- request body size limits;
- per-client request rate limiting;
- bounded concurrent requests;
- per-session advisor call rate limits;
- an unauthenticated `/healthz` endpoint for liveness checks.

The HTTP server does not implement OAuth resource-server discovery. For multi-user or internet-facing deployments, put it behind a gateway that terminates TLS and authenticates callers, use a long random bearer token, and set `ADVISOR_HTTP_ALLOWED_HOSTS` to the public hostname. A static token gives every client the same advisor identity and budget; per-user isolation requires a real auth gateway or a future token-to-tenant mapping.

### Context protocol

The caller supplies a structured pack rather than a raw transcript dump:

- `goal`: the user's outcome;
- `state`: what is known and what has happened;
- `attempt`: the current approach or failed attempt;
- `evidence`: errors, tests, stack traces, relevant excerpts;
- `constraints`: non-negotiables;
- `question`: the exact decision;
- `context`: optional selected transcript;
- `transcript_path`: optional Claude Code JSONL file within the server-configured projects root, gated by `ADVISOR_TRANSCRIPT_ENABLED`;
- `options`: only when a decision is genuinely open.

This is intentionally closer to a design review brief than a chat log. Opt-in disk context retains the first user message and newest turns, with the executor's `state` summary on top. The user evidence prompt has an estimated token budget (UTF-8 bytes / 3), not an exact model tokenizer. The legacy character setting remains an environment alias. See README for the verified Claude Code file format, root confinement and discovery limitations.

### Session state

A session stores:

- call count and budget;
- goal and constraints;
- files touched;
- open questions;
- up to ten concise decisions;
- up to twenty recent turns.

The state lets a later consult say "we already rejected X because Y" without resending the whole history. The caller can update durable facts without spending a call.

### Concurrency

Per-session work is serialized through an in-process promise chain. This prevents lost updates and double-spending the same final call when an agent issues parallel tool calls. Different sessions do not block each other.

This is process-local. Multiple HTTP replicas need sticky routing by `session_id` or a store with atomic compare-and-swap semantics; the shipped file store is suitable for one process, not shared concurrent writers. In-memory HTTP rate limiting is also per replica.

### Provider abstraction

The service depends on `AdvisorProvider.complete()`, not on an SDK. Two adapters ship:

- OpenAI-compatible Chat Completions;
- Anthropic Messages.

This keeps the core testable with a fake provider and makes new adapters small. The OpenAI-compatible path deliberately covers local and gateway models as well as hosted APIs.

`ADVISOR_MODELS` wraps the configured adapter in an ordered fallback chain using the same endpoint and credential. Transient/quota failures advance immediately; authentication and cancellation stop. Safe per-model failures accompany the answering model. Single-model configurations retain the existing retry loop. Repair retains the same evidence and can start another completion chain.

### Output contract

The model returns JSON with:

- `verdict`: `proceed`, `adjust`, `stop`, or `need_more_context`;
- `summary`;
- `guidance`, `risks`, `next_actions`, `evidence_gaps`;
- `confidence`.

The server validates and normalizes that shape. Invalid output gets one repair attempt, then fails cleanly. A strict contract makes the advice easy for the executor to act on and prevents a chatty advisor from consuming the executor's context.

### Trust boundaries

- Transcript and tool output are untrusted data. The system prompt explicitly tells the advisor to ignore embedded instructions.
- Common credentials are redacted before any provider request.
- The server does not return provider error bodies beyond a bounded prefix.
- The advisor never gets tools or file access.
- The server's opt-in transcript reader only reads regular JSONL files confined to its configured root; that reader is never exposed as an advisor tool. Remote clients must be trusted before enabling it.
- File-backed sessions are hashed by ID, stored with restrictive permissions, and should still be treated as sensitive.
- HTTP bearer tokens are compared as SHA-256 digests with `timingSafeEqual`; the token itself is never logged.
- `/healthz` reports only liveness and auth mode, never model or credential details.

Redaction is defense in depth, not a guarantee. The calling agent must avoid sending secrets.

## Request lifecycle

```text
1. Agent selects consult kind and builds an evidence pack.
2. HTTP (optional) validates Host/Origin, bearer token, body size, client rate limit, and concurrency.
3. MCP validates argument size and shape.
4. Service loads or creates session state.
5. Session call budget and per-minute call rate are checked; the attempt is recorded.
6. Context is rendered, redacted, and truncated if needed.
7. Provider is called with bounded output and timeout.
8. Transient errors retry with exponential backoff; cancellation stops promptly.
9. JSON advice is parsed; one repair attempt is allowed.
10. Session decisions/questions/history are updated.
11. Agent receives text plus structured content.
```

## Deliberate non-goals

- **Always-on commentary.** An advisor that comments every turn duplicates the executor and burns tokens.
- **Autonomous fixing.** An advisor with write tools becomes another executor with an ambiguous source of truth.
- **A hidden global memory.** Sessions are explicit so unrelated tasks do not contaminate each other.
- **Model-name routing inside the server.** The host owns executor model selection; the server owns the advisor model configuration.
- **Perfect secret detection.** Heuristics help, but context minimization is the primary control.

## Future extensions

1. **Per-tenant authentication and quotas** for shared HTTP deployments, with token-to-workspace mapping.
2. **Provider-native structured output** where available, reducing repair calls.
3. **Prompt caching** for repeated advisor consults on long sessions.
4. **Policy profiles** per host or repository, such as "security review always uses model X."
5. **Evaluation harness** comparing advisor-on and advisor-off runs on a task suite, tracking pass rate, cost, and unnecessary consults.
6. **Transcript adapters** for hosts that expose a standard read-only transcript resource, while preserving explicit consent and redaction.
7. **Multi-advisor routing** for domain-specific review (security, database migration, frontend accessibility), with a single visible entry point.
8. **Shared session storage** with atomic updates and a cross-replica rate limiter.

## Evaluation plan

Measure, rather than assume:

- task pass rate with and without the advisor;
- number and timing of consults;
- cost per successful task;
- advice acceptance rate and cases where evidence contradicted advice;
- unnecessary consults on simple tasks;
- performance change with fixed-turn nudges versus outcome-based triggers.

A useful first suite has three classes: a routine refactor (advisor should rarely trigger), a recurring bug (advisor should help stop retry loops), and a high-risk completion review (advisor should catch a real missing check).

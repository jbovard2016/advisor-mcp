# advisor-mcp

`advisor-mcp` is a model-agnostic MCP server that gives any agent an independent second opinion during a task. It is inspired by the Claude Code / Claude API advisor pattern: a faster executor does the work while a stronger model is consulted only at consequential decision points.

Implemented with the stable MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.x, MCP spec 2026-07-28) and cross-checked against Claude Code 2.1.302 and MCP 2025-era clients. See `docs/architecture.md` for the research notes and design rationale.

The advisor is deliberately read-only. It cannot execute commands or edit files. The calling agent supplies a compact evidence pack; optionally the server adds a Claude Code transcript read from disk. The advisor receives only that evidence, never filesystem or command tools. The caller remains responsible for verifying and applying the advice.

## Why this differs from Claude Code's built-in advisor

Claude Code implements the advisor as a **server-side tool**. The API automatically passes the executor's full conversation, including tool calls and results, to a second model inside the same model request. The client cannot construct or alter that advisor context.

An MCP server is outside the host model request. It does not receive the host's transcript automatically. `advisor-mcp` makes context explicit and offers opt-in disk transcript access:

- the agent chooses when to consult;
- the agent sends goal, state, evidence, constraints, and the exact question;
- when enabled, the server includes the first user message and newest transcript turns, with `state` as the agent's summary on top;
- the server keeps a lightweight session across consults;
- every advisor call returns structured guidance, not actions.

This is less automatic than the proprietary Anthropic tool, but it works with any MCP-capable host and any sufficiently capable model provider.

## Design

```text
Host agent
  |
  | tools/call: consult_advisor
  v
advisor-mcp  ---> redact secrets ---> provider (OpenAI-compatible / Anthropic)
  |                                      |
  |<--------- validated JSON advice <----+
  |
  +--> per-session state (goal, constraints, decisions, call budget)
```

Key properties:

- **Explicit context:** the agent controls what the advisor sees.
- **Evidence-first prompt:** facts, attempts, and observed output are separated from assumptions.
- **Structured output:** advice is parsed into a fixed schema and validated before return.
- **Session handle:** repeated consults carry forward goal, constraints, touched files, and prior advice.
- **Call budget:** caps advisor usage per session to prevent consult loops.
- **Secret redaction:** common credentials are removed before the provider request.
- **Provider-neutral:** OpenAI-compatible Chat Completions by default, Anthropic Messages optionally.
- **Two transports:** stdio for local hosts, Streamable HTTP for remote agents.
- **Deployment guards:** bearer auth, Host/Origin allowlists, body/concurrency limits, and per-client rate limiting in HTTP mode.

## Tools

| Tool | Purpose |
| --- | --- |
| `consult_advisor` | Ask for a plan critique, diagnosis, risk review, decision, completion review, or handoff summary. |
| `get_advisor_session` | Read the stored goal, constraints, decisions, open questions, call count, and recent consults. |
| `update_advisor_session` | Record durable state without spending an advisor call. |
| `reset_advisor_session` | Delete session state when the task ends or changes fundamentally. |
| `advisor_health` | Report non-secret configuration without making a model request. |

`consult_advisor` accepts:

- required: `session_id`, `kind`, `question`
- context: `goal`, `state`, `attempt`, `expected_outcome`, `constraints`, `evidence`, `context`, `options`, `files_touched`
- control: `style`, `include_history`, `max_history_messages`
- optional disk context: `transcript_path` (requires server-side enablement below)

`kind` is one of `plan`, `stuck`, `review`, `risk`, `decision`, or `handoff`.

## Install

```bash
npm install
npm run build
```

Node.js 20.18 or later is required.

## Configure

The server reads configuration from its process environment. It does not load `.env` files automatically.

### OpenAI-compatible endpoint

```bash
export ADVISOR_PROVIDER=openai-compatible
export ADVISOR_MODEL=your-model-id
export ADVISOR_API_KEY=...
# Optional; the default is https://api.openai.com/v1
export ADVISOR_BASE_URL=https://api.openai.com/v1
node dist/index.js
```

`OPENAI_API_KEY` is accepted as a fallback for `ADVISOR_API_KEY`. Set `ADVISOR_BASE_URL` for OpenRouter, vLLM, Ollama, LM Studio, or another Chat Completions-compatible endpoint. A key is optional for local endpoints; if omitted no `Authorization` header is sent. Azure OpenAI's native API uses deployment paths and `api-version`; use a compatible gateway unless you add a dedicated adapter.

Some OpenAI-compatible servers reject `max_completion_tokens`. Set:

```bash
export ADVISOR_TOKEN_PARAM=max_tokens
```

### Anthropic

```bash
export ADVISOR_PROVIDER=anthropic
export ADVISOR_MODEL=claude-sonnet-4-6
export ANTHROPIC_API_KEY=...
node dist/index.js
```

`ADVISOR_API_KEY` takes precedence over `ANTHROPIC_API_KEY`. This mode calls the ordinary Messages API; it does not reproduce Anthropic's server-side advisor tool or its encrypted advisor result.

### Limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADVISOR_MAX_OUTPUT_TOKENS` | `1200` | Advisor output cap per call. |
| `ADVISOR_TIMEOUT_MS` | `60000` | Provider timeout per attempt. |
| `ADVISOR_MAX_CONTEXT_TOKENS` | `30000` | Estimated token budget for the user evidence prompt. |
| `ADVISOR_MAX_CONTEXT_CHARS` | `120000` | Legacy setting: divided by 4 to derive the token budget when the new setting is absent. |
| `ADVISOR_MAX_CALLS_PER_SESSION` | `12` | Advisor calls allowed per session. |
| `ADVISOR_MAX_CALLS_PER_MINUTE` | `30` | Advisor calls allowed per session per minute. |
| `ADVISOR_STYLE` | `brief` | Default advice style: `brief` or `detailed`. |
| `ADVISOR_STORE` | `memory` | `memory` or `file`. |
| `ADVISOR_DATA_DIR` | `~/.advisor-mcp` | Session directory when file storage is enabled. |

Use `ADVISOR_STORE=file` when the host may restart the MCP process between consults. File names are hashed, directory and file permissions are restricted, but stored prompts and advice are still plaintext on disk. Choose `memory` for sensitive work.

### Claude Code transcript access (opt-in)

Enable this only when the configured advisor endpoint may receive the session's contents:

```bash
export ADVISOR_TRANSCRIPT_ENABLED=true
# Optional: discover the newest session for the MCP server's working directory.
export ADVISOR_TRANSCRIPT_AUTO_DISCOVER=true
# Optional: defaults to ~/.claude/projects under the server user's home.
export ADVISOR_TRANSCRIPT_PROJECTS_DIR=/path/to/.claude/projects
export ADVISOR_MAX_CONTEXT_TOKENS=30000
```

Both enablement and auto-discovery default to `false`. For a precise session, pass an absolute `transcript_path` to `consult_advisor`; it overrides auto-discovery. Supply the agent's own summary in `state`. Without a path or enabled auto-discovery, the server uses only the caller's evidence pack.

```json
{
  "session_id": "my-task",
  "kind": "review",
  "question": "What should I verify before finishing?",
  "state": "Implemented the parser; focused tests pass.",
  "transcript_path": "/path/to/.claude/projects/encoded-project/session-id.jsonl"
}
```

Auto-discovery selects the most recently modified **direct `.jsonl` file** in the directory derived from the server's absolute working directory, replacing non-alphanumeric characters with `-`. It excludes nested subagent files and checks recorded `cwd` values. Launch the MCP process in the intended project directory. It cannot infer a remote HTTP caller's working directory. Concurrent sessions in one directory are ambiguous: use an explicit path to avoid selecting the wrong session.

Only regular `.jsonl` files inside the configured projects root are accepted; resolved paths and symlinks cannot escape that root. Reads take a size-bounded snapshot (maximum 64 MiB), never write to Claude Code folders, and fail visibly on missing, inaccessible or malformed files. An unfinished final JSONL record is omitted. Do not enable this on a shared HTTP server unless all callers are trusted to select transcripts under that root. Use a narrower root for explicit-path access if needed.

Text, tool calls and text tool results are included as **untrusted evidence**. Metadata, sidechain records, thinking/signatures and image payloads are excluded. Secrets are redacted before trimming, including configured credentials and tool names. Redaction is heuristic; review the destination and avoid secrets in sessions.

The budget estimates tokens as `ceil(UTF-8 bytes / 3)`; it is not a model-specific tokenizer or an exact context-window guarantee. It covers the user evidence prompt, not the fixed system/schema instructions, provider framing or output. The legacy character setting is converted using 4 characters per token; it no longer promises an exact character cap. The new variable takes precedence. With disk context, the complete first user message, summary and question are preserved; if they cannot fit, the call fails and asks for a larger budget. Remaining room prioritizes recent transcript content; oversized turns can be clipped, with an omission notice. Context/history controls still govern the caller's excerpts and prior advisor turns, independently of disk access.

**Verified on this machine, 7 November 2026:** read-only inspection of
`C:\Users\jonbo\.claude\projects\C--Users-jonbo-orca-workspaces-experiment\4bd85505-ef5a-4c35-9dc9-505158556c5c.jsonl`
found Claude Code `2.1.319` records, a recorded `cwd` matching that encoded directory, and newline-delimited JSON. The sample contained `user`/`assistant` records with `message.role` and `message.content` (string or block array), `text`, `tool_use` (`id`, `name`, `input`) and `tool_result` (`tool_use_id`, `content`, `is_error`) blocks, plus metadata and thinking blocks. The new parser retained 81 messages, including 32 tool results, in a local read-only check. No private transcript content was copied into this repository or sent to a provider. Other Claude Code versions, OS layouts, custom config homes and long-path directory encodings remain unverified; use the configurable root and explicit path when discovery differs.

### Ordered model fallback

```bash
export ADVISOR_MODELS=first-model,second-model,third-model
```

`ADVISOR_MODELS` accepts 1-10 comma-separated model IDs in priority order and takes precedence over `ADVISOR_MODEL`. All entries use the same configured provider, base URL and credential, so a model gateway can route them to different backends. Without the list, `ADVISOR_MODEL` keeps its existing behavior.

### ProxyPilot preset (OpenAI-compatible gateway)

`ADVISOR_REASONING_EFFORT` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) is sent as `reasoning_effort` on OpenAI-compatible requests; when unset, nothing is sent. A gateway such as ProxyPilot (`http://127.0.0.1:8317/v1`) can serve every fallback model from one endpoint and key:

```bash
export ADVISOR_PROVIDER=openai-compatible
export ADVISOR_BASE_URL=http://127.0.0.1:8317/v1
export ADVISOR_API_KEY="$PROXYPILOT_API_KEY"
export ADVISOR_MODELS=gpt-6-astra,gpt-6.1-sol,claude-opus-5-5
export ADVISOR_REASONING_EFFORT=medium
```

Model IDs must come from the gateway's live `/v1/models` list. The effort applies to every model in the list; a model that rejects the field fails that attempt and the chain moves on. Observed on ProxyPilot: `glm/glm-5.3` rejects `medium` (HTTP 400, accepts only low, high or max), so keep GLM out of a medium-effort chain; `gpt-6-astra`, `gpt-6.1-sol` and `claude-opus-5-5` accepted it.

The next model is tried immediately on HTTP 429, 5xx, 408/409, quota exhaustion (402 or structured `insufficient_quota`/`quota_exceeded` on 400/403), network failures and request/body timeouts. Cancellation, authentication failures and other non-transient errors stop the chain. Each chain entry is attempted once per completion; a single-model configuration retains the existing transient retries. One invalid advice response may trigger a repair completion with the same bounded evidence, starting the chain again. A consult still consumes one session call, although several provider requests may be made.

Successful MCP results include `advisorModel` and, when applicable, `failures: [{ model, reason }]`; the text result lists failed models too. Exhaustion reports all attempted models. Failure reasons use fixed categories/status codes and exclude provider response bodies, credentials and URLs. A shared bad key cannot be repaired by switching models; it remains a terminal error. Worst-case latency grows with the number of models and per-attempt timeout.

**Warning:** do not configure an advisor that is weaker than the executor and expect a quality lift. The pattern works because the advisor contributes stronger judgment at selected moments.

## Remote HTTP mode

Use HTTP when agents run on another machine, inside a container, or in a separate client that cannot launch a stdio process. The default transport is still `stdio`.

Start the server:

```bash
export ADVISOR_TRANSPORT=http
export ADVISOR_HTTP_HOST=0.0.0.0
export ADVISOR_HTTP_PORT=8787
export ADVISOR_HTTP_TOKEN="$(openssl rand -hex 32)"
export ADVISOR_PROVIDER=openai-compatible
export ADVISOR_MODEL=your-advisor-model
export ADVISOR_API_KEY=...
export ADVISOR_STORE=file
export ADVISOR_DATA_DIR=/srv/advisor-data

node dist/index.js
```

The MCP endpoint is `http://host:8787/mcp`. Health is available without a token at `http://host:8787/healthz`. The server refuses to start without `ADVISOR_HTTP_TOKEN` unless the host is loopback and `ADVISOR_HTTP_ALLOW_UNAUTHENTICATED_LOOPBACK=true`.

```text
Streamable HTTP request
  -> Host / Origin policy
  -> bearer token check
  -> per-client request limit
  -> concurrency limit
  -> MCP 2026-07-28 handler (stateless transport)
  -> advisor service (session_id-scoped state)
```

### Remote host configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADVISOR_HTTP_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` inside a container. |
| `ADVISOR_HTTP_PORT` | `8787` | Listen port. |
| `ADVISOR_HTTP_PATH` | `/mcp` | MCP endpoint path. |
| `ADVISOR_HTTP_TOKEN` | empty | Bearer token; at least 16 characters, preferably 32 random bytes in hex. |
| `ADVISOR_HTTP_ALLOW_UNAUTHENTICATED_LOOPBACK` | `false` | Permit tokenless HTTP only on a loopback bind (development only). |
| `ADVISOR_HTTP_ALLOWED_ORIGINS` | empty | Comma-separated origin hostnames, or non-web wildcards such as `moz-extension://*`. |
| `ADVISOR_HTTP_ALLOWED_HOSTS` | empty | Comma-separated Host hostnames. Set this in production. |
| `ADVISOR_HTTP_MAX_BODY_BYTES` | `1048576` | Maximum MCP request body. |
| `ADVISOR_HTTP_MAX_CONCURRENT_REQUESTS` | `8` | Concurrent MCP requests per process. |
| `ADVISOR_HTTP_REQUESTS_PER_MINUTE` | `120` | Requests per client IP per minute. |
| `ADVISOR_HTTP_TRUST_PROXY` | `false` | Trust `X-Forwarded-For`. Enable only behind a trusted reverse proxy. |

Token-authenticated mode does not force localhost Host validation, so a reverse proxy may forward a public hostname. Set `ADVISOR_HTTP_ALLOWED_HOSTS` and `ADVISOR_HTTP_ALLOWED_ORIGINS` to constrain it. Non-browser clients normally omit `Origin`.

### Connect a remote agent

Codex:

```bash
export ADVISOR_HTTP_TOKEN=...
codex mcp add advisor \
  --url https://advisor.example.com/mcp \
  --bearer-token-env-var ADVISOR_HTTP_TOKEN
```

Claude Code:

```bash
claude mcp add --transport http advisor \
  https://advisor.example.com/mcp \
  --header "Authorization: Bearer $ADVISOR_HTTP_TOKEN"
```

Generic JSON:

```json
{
  "mcpServers": {
    "advisor": {
      "type": "streamable-http",
      "url": "https://advisor.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${ADVISOR_HTTP_TOKEN}"
      }
    }
  }
}
```

If the client does not support headers or environment interpolation, terminate authentication at a reverse proxy and add the bearer token server-side.

### Docker

```bash
export ADVISOR_HTTP_TOKEN="$(openssl rand -hex 32)"
export ADVISOR_MODEL=your-advisor-model
export ADVISOR_API_KEY=...
docker compose up -d --build
```

The compose file binds the published port to `127.0.0.1`; put a TLS reverse proxy in front of it or change the bind deliberately. The image runs as the unprivileged `node` user and keeps file sessions in the `advisor-data` volume.

For a public deployment:

1. Terminate TLS at a reverse proxy and forward to `http://127.0.0.1:8787`.
2. Set `ADVISOR_HTTP_ALLOWED_HOSTS=advisor.example.com`.
3. Set `ADVISOR_HTTP_ALLOWED_ORIGINS` only if browser clients call the endpoint.
4. Keep `ADVISOR_HTTP_TOKEN` in a secret store, not in a committed env file.
5. Run one replica or provide sticky routing by `session_id`; file storage and in-process limits are not shared safely across replicas.

## Connect to an MCP host

### Codex

Add a stdio server in `~/.codex/config.toml`:

```toml
[mcp_servers.advisor]
command = "node"
args = ["/absolute/path/to/advisorChou/dist/index.js"]

[mcp_servers.advisor.env]
ADVISOR_PROVIDER = "openai-compatible"
ADVISOR_MODEL = "your-advisor-model"
ADVISOR_API_KEY = "${ADVISOR_API_KEY}"
ADVISOR_STORE = "file"
```

Then ask the agent to use `consult_advisor` at real decision points, or add that instruction to `AGENTS.md`. The server's own MCP instructions are also exposed to clients that display them.

### Claude Code

```bash
claude mcp add advisor \
  -e ADVISOR_PROVIDER=openai-compatible \
  -e ADVISOR_MODEL=your-advisor-model \
  -e ADVISOR_API_KEY="$ADVISOR_API_KEY" \
  -- node /absolute/path/to/advisorChou/dist/index.js
```

Claude Code will still have its native advisor if enabled. Disable it with `/advisor off` when testing this server to avoid two independent mechanisms.

### Generic JSON configuration

Most MCP hosts accept a stdio entry like:

```json
{
  "mcpServers": {
    "advisor": {
      "command": "node",
      "args": ["/absolute/path/to/advisorChou/dist/index.js"],
      "env": {
        "ADVISOR_PROVIDER": "openai-compatible",
        "ADVISOR_MODEL": "your-advisor-model",
        "ADVISOR_API_KEY": "..."
      }
    }
  }
}
```

Do not put literal API keys in a repository-controlled host config. Prefer the host's secret or environment-variable mechanism.

## Manage with Magpie / 通过 Magpie 管理

[Magpie](https://github.com/yetone/magpie) keeps MCP servers in its **Library** and writes them into every agent it manages (Claude Code, Codex, OpenCode, Cursor, ...) in each agent's own format.

Magpie 的 **Library** 统一管理 MCP server，并按各 agent 自己的格式写入它们的配置。

**1. Local stdio server / 本地 stdio**

```bash
# straight from GitHub (built on first install) / 直接从 GitHub 运行
magpie library mcp add advisor npx -y github:Fan-chou/advisor-mcp agents=none

# or from a local clone / 或使用本地 clone
git clone https://github.com/Fan-chou/advisor-mcp && cd advisor-mcp && npm ci && npm run build
magpie library mcp add advisor node "$PWD/dist/index.js" agents=none
```

Then open Magpie -> Library -> MCP servers -> `advisor`, fill in the environment variables (`ADVISOR_PROVIDER`, `ADVISOR_MODEL`, `ADVISOR_API_KEY`, `ADVISOR_BASE_URL`) and tick the agents that should get it (or run `magpie library mcp agents advisor claude,codex`).

然后在 Magpie -> Library -> MCP servers 打开 `advisor`，填写上面的环境变量，再勾选要启用它的 agent。

**2. Remote server / 远程**

```bash
magpie library mcp add advisor https://your-host/mcp agents=none
```

Then add the header `Authorization: Bearer <ADVISOR_HTTP_TOKEN>` on the server's page in Magpie. 远程方式必须带 bearer token。

**3. Use Magpie as the advisor's upstream / 让 advisor 走 Magpie 网关**

Magpie's gateway speaks the OpenAI-compatible API, so the advisor can use any model Magpie routes (for example a stronger model on your subscription):

```bash
ADVISOR_PROVIDER=openai-compatible
ADVISOR_BASE_URL=http://127.0.0.1:3425/v1   # your Magpie gateway port
ADVISOR_API_KEY=<a Magpie gateway key>
ADVISOR_MODEL=<a model name Magpie exposes>
```

## Recommended agent policy

Add instructions close to this to the host agent:

```text
Use consult_advisor only at consequential decision points:
1. after reading enough context to understand the task, but before committing
   to a non-obvious plan;
2. when the same error survives two genuine fix attempts;
3. before declaring a complex, risky, or broad change complete;
4. when evidence conflicts or two designs have material tradeoffs.

Do not consult for routine edits, simple lookups, or every turn. Reuse one
session_id per task. Send the goal, current state, exact question, concrete
evidence, constraints, and what was already tried. Redact secrets.

Treat advisor output as advice, not truth. Verify claims against files, tests,
and tool results. If the advice conflicts with observed evidence, report the
conflict instead of following it blindly.
```

For a cheap executor, a turn-2 reminder can raise advisor usage. Do not use one blindly: Anthropic's own measurements show a badly timed nudge can reduce performance. Prefer outcome-based triggers such as "after two failed attempts" over a fixed turn number.

## Session behavior

`session_id` is an opaque handle. A typical value is `repo-name:task-slug`. Reuse it for one task; reset it when the task ends. Avoid using one global session for unrelated work because stale constraints and decisions will contaminate new advice.

The service serializes concurrent calls for the same session. A call is counted before the provider request so crashes and retries cannot bypass the budget. Concurrent calls for different sessions can proceed independently.

## Troubleshooting

- **`configuration error: Missing ADVISOR_MODEL`**: set an explicit model ID.
- **Provider returns HTTP 400 about a token field**: set `ADVISOR_TOKEN_PARAM=max_tokens`.
- **Provider returns HTTP 401**: check `ADVISOR_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` in the environment of the MCP process, not only your shell.
- **`limit_exceeded`**: reset the session or raise `ADVISOR_MAX_CALLS_PER_SESSION`.
- **HTTP 401 from `/mcp`**: send `Authorization: Bearer <ADVISOR_HTTP_TOKEN>`; `/healthz` intentionally does not require it.
- **HTTP 403 before JSON-RPC**: check `ADVISOR_HTTP_ALLOWED_HOSTS` and `ADVISOR_HTTP_ALLOWED_ORIGINS`.
- **HTTP 429**: the client IP exceeded `ADVISOR_HTTP_REQUESTS_PER_MINUTE`; wait for `Retry-After`.
- **`invalid_response`**: the provider could not produce the required JSON even after one repair attempt. Try a stronger model or inspect the provider compatibility.
- **No advice history after restart**: use `ADVISOR_STORE=file`.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run check
```

Tests use a fake provider and local HTTP servers; they do not call a paid model.

Original upstream verification (before this fork's changes):

- 43 unit, integration, provider, stdio, HTTP, and persistence tests pass;
- the built server completes a full MCP call under Claude Code 2.1.302;
- a raw 2025-06-18 handshake also lists all five tools successfully;
- the HTTP runner serves `/healthz` and rejects unauthenticated `/mcp` with 401.

JON-2274 verification is recorded in [docs/jon-2274-verification.md](docs/jon-2274-verification.md). Reproduce the built-server local stub check with `npm run build` followed by `node scripts/check-transcript-fallback.mjs`. It uses synthetic transcripts and no paid endpoint.

## Limitations

- Disk transcript access is opt-in and bounded; context quality still depends on the caller's summary and the selected session.
- There is no automatic trigger. The host agent decides when to call.
- Advice is advisory and can be wrong; independent verification is mandatory.
- A single advisor call runs synchronously from the MCP client's perspective. Hosts may show a pause while it runs.
- Provider-specific reasoning controls, prompt caching, and encrypted advisor results are not implemented.
- HTTP mode uses a static bearer token, not OAuth; all clients share one advisor identity and call budget.
- In-memory rate limits and per-session serialization are per process. Use sticky routing or a shared store before scaling horizontally.

## License

MIT

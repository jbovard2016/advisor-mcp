# JON-2274 local verification

Implemented transcript access and ordered model fallback in Jon's fork. This is local CODE delivery on `jon-2274-transcript-fallback`, based on `7fe6bf58728b8c2c2c74a4ca4bf7bfb784965b56`. No push, PR, upstream change or deployment is authorized or performed.

## Changes

- `src/transcript.ts`, `src/context-budget.ts`: opt-in root-confined JSONL reading, newest-session discovery, safe parsing, bounded recent context and token estimation.
- `src/config.ts`, `src/types.ts`, `src/server.ts`: transcript/model-list settings and request/result contracts.
- `src/prompt.ts`, `src/advisor.ts`: summary and first user preservation, newest evidence, budget enforcement, repair and failure propagation.
- `src/providers.ts`, `src/advice.ts`: ordered fallback, cancellation/body timeout handling and safe failure reporting in structured/text results.
- `src/redact.ts`: configured credential and JSON assignment redaction, retained alongside existing rules.
- Tests: `config`, `http-config`, `http`, `prompt`, `providers`, `redact`, `server`, `service`, `store`, and new `transcript.test.ts`.
- `scripts/check-transcript-fallback.mjs`: reproducible built-server MCP/local endpoint check with complete synthetic request/response capture.
- `README.md`, `docs/architecture.md`, this report and `CHECKPOINT.md`: settings, observed format, evidence and handover.

No new dependencies. Existing Windows test assumptions were corrected: paths now use `path.join`; file-mode assertions distinguish Windows's reported `0666` from POSIX `0600`. No file-store implementation or permission safeguard was changed. Windows ACL isolation is not proved by that mode test.

## Actual commands and output

Environment: native Windows, Node `v24.22.1`, npm `11.19.1`.

`npm install` exited 0, including its prepare/build step:

```text
added 24 packages, and audited 25 packages in 4s
1 moderate severity vulnerability
```

It also warned that esbuild's postinstall was not covered by `allowScripts`. No package or harness policy was changed. Subsequent builds and tsx tests ran successfully.

`npm run build` exited 0. `npm test` ran successfully; the final `npm run check` (typecheck, tests, build) exited 0 with:

```text
tests 61
suites 0
pass 61
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 3383.5048
```

The initial new config/transcript tests failed before implementation (missing models and missing transcript-only tool evidence). New provider tests also failed before their implementation. Final coverage includes explicit/discovered paths, opt-out, missing/malformed/partial files, path/link escape rejection, metadata exclusion, Unicode budget bounds, full first user text, summary order, redaction, fallback success/exhaustion/quota/timeout/auth, repair and cancellation.

`node scripts/check-transcript-fallback.mjs` exited 0:

```text
PASS: built MCP stdio server; explicit path and auto-discovery; first model HTTP 429; second answered with transcript-only tool evidence; redaction and 1000-token estimate verified.
```

This starts the compiled server, calls `consult_advisor` over MCP twice, and runs a real local HTTP stub. Each call observes `first` fail with 429 and `second` answer. The returned summary cites “17 checks passed,” present only in the synthetic transcript's tool result, not in the consult arguments. The result reports `advisorModel: second` and `failures: [{model: first, reason: HTTP 429}]`. All child/server processes and temporary fixtures are closed/deleted by the check.

Full local logs (ignored by Git, retained in this checkout): `artifacts/jon-2274/check.log` and JSON-formatted `artifacts/jon-2274/local-stub.log`. The latter contains complete synthetic provider requests/responses and MCP call arguments/results; it contains no real transcript data. Re-running the check replaces its log.

## Real transcript observation

Read-only inspected the actual file documented in README under `C:\Users\jonbo\.claude\projects`, with Claude Code version `2.1.319`. At inspection it was 13,365,097 bytes and had 5,455 JSONL records. Verified encoded cwd, nested message roles/content, string/block text, tool inputs/results, metadata and thinking blocks. No writes were made under Claude Code's folders.

The implemented parser then read the same file locally: first user present; 81 retained messages; 32 tool messages; truncation true; retained content estimate 27,211 tokens before final prompt framing. No private content was printed, retained in this repository or sent to a provider.

## Review and limits

Independent transcript/service review found and then accepted fixes for tool-name redaction, bounded repair context, failure preservation and cancellation classification. The lead separately inspected the provider diff and exercised the integrated built server.

A separate QA role failed to launch: `The 'codex/gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.` No alternate role was launched without approval; this role provided no review evidence.

Not verified: a consult launched by a real Claude Code session against a real model; model quality; Node 20.18 execution; other OS/Claude versions; deployed service loading; Windows ACL isolation. The ticket's earlier bad-key fallback criterion is not implemented: current instructions specify transient/quota failures, while shared authentication failures stop the chain.

Risks: token counts are estimates; auto-discovery can choose another active session in the same directory; all fallback models share endpoint/credentials; enabled shared HTTP clients can select transcripts inside the configured root. These limits are documented in README.

`npm audit --json` reported one moderate pre-existing transitive advisory in `@hono/node-server`, [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f), concerning `serveStatic` double decoding. This repository does not call `serveStatic`. Dependency maintenance is deferred and recorded on JON-2274; no automatic upgrade was attempted.

Hindsight: no registry entry for this checkout and no guarded tool exposed. No durable write was claimed. Any owed durable decision must wait for Jon's registration/access repair; the task-local handover records this limitation.

JON-2274 remains open because its original real-Claude-Code acceptance is unverified. Jon owns the local branch and decides whether to push or arrange that live acceptance.

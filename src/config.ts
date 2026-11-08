import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";

export type ProviderKind = "openai-compatible" | "anthropic";
export type TokenParam = "max_completion_tokens" | "max_tokens";
export type TransportKind = "stdio" | "http";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
const REASONING_EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

export interface AdvisorConfig {
  transport: TransportKind;
  provider: ProviderKind;
  model: string;
  models: string[];
  apiKey: string;
  baseUrl: string;
  apiVersion: string;
  tokenParam: TokenParam;
  /** Sent as `reasoning_effort` on openai-compatible requests when set. */
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens: number;
  timeoutMs: number;
  maxContextTokens: number;
  transcriptEnabled: boolean;
  transcriptAutoDiscover: boolean;
  transcriptProjectsDir: string;
  maxCallsPerSession: number;
  maxCallsPerMinute: number;
  dataDir: string;
  store: "memory" | "file";
  defaultAdviceStyle: AdviceStyle;
  http: HttpConfig;
}

export type AdviceStyle = "brief" | "detailed";

export interface HttpConfig {
  host: string;
  port: number;
  path: string;
  token: string;
  allowUnauthenticatedLoopback: boolean;
  allowedOrigins: string[];
  allowedHosts: string[];
  maxBodyBytes: number;
  maxConcurrentRequests: number;
  requestsPerMinute: number;
  trustProxy: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  const min = opts.min ?? 1;
  if (!Number.isInteger(value) || value < min || value > (opts.max ?? Number.MAX_SAFE_INTEGER)) {
    throw new ConfigError(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function parseProvider(raw: string | undefined): ProviderKind {
  const value = (raw ?? "openai-compatible").trim().toLowerCase();
  if (value === "openai" || value === "openai-compatible" || value === "compatible") {
    return "openai-compatible";
  }
  if (value === "anthropic") return "anthropic";
  throw new ConfigError(
    `ADVISOR_PROVIDER must be "openai-compatible" or "anthropic", got "${raw}"`,
  );
}

function parseTransport(raw: string | undefined): TransportKind {
  const value = (raw ?? "stdio").trim().toLowerCase();
  if (value !== "stdio" && value !== "http") {
    throw new ConfigError('ADVISOR_TRANSPORT must be "stdio" or "http"');
  }
  return value;
}

function parseBoolean(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new ConfigError(`${name} must be true or false`);
}

function parseHostAllowlist(name: string, raw: string | undefined): string[] {
  if (!raw) return [];
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      try {
        const url = new URL(item.includes("://") ? item : `http://${item}`);
        if (
          !url.hostname ||
          url.hostname === "*" ||
          url.pathname !== "/" ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        ) {
          throw new Error("missing hostname");
        }
        return url.hostname.toLowerCase();
      } catch {
        throw new ConfigError(
          `${name} entries must be hostnames (optionally with a port), not "${item}"`,
        );
      }
    });
  return [...new Set(values)];
}

function parseOriginAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const schemeWildcard = /^([a-z][a-z0-9+.-]*):\/\/\*$/i.exec(item);
      if (schemeWildcard?.[1]) {
        const scheme = schemeWildcard[1].toLowerCase();
        if (scheme === "http" || scheme === "https") {
          throw new ConfigError(
            "ADVISOR_HTTP_ALLOWED_ORIGINS does not allow http://* or https://*; list concrete hostnames",
          );
        }
        return `${scheme}://*`;
      }
      return parseHostAllowlist("ADVISOR_HTTP_ALLOWED_ORIGINS", item)[0] as string;
    });
  return [...new Set(values)];
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function parseHttpPath(raw: string | undefined): string {
  const path = (raw ?? "/mcp").trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("?") || path.includes("#")) {
    throw new ConfigError("ADVISOR_HTTP_PATH must be an absolute path such as /mcp");
  }
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value === "::1") return true;
  return isIP(value) === 4 && value.startsWith("127.");
}

function loadHttpConfig(env: NodeJS.ProcessEnv, transport: TransportKind): HttpConfig {
  const host = env.ADVISOR_HTTP_HOST?.trim() || "127.0.0.1";
  const port = parsePositiveInt("ADVISOR_HTTP_PORT", env.ADVISOR_HTTP_PORT, 8787, {
    max: 65_535,
  });
  const token = env.ADVISOR_HTTP_TOKEN?.trim() ?? "";
  const allowUnauthenticatedLoopback = parseBoolean(
    "ADVISOR_HTTP_ALLOW_UNAUTHENTICATED_LOOPBACK",
    env.ADVISOR_HTTP_ALLOW_UNAUTHENTICATED_LOOPBACK,
    false,
  );

  if (transport === "http") {
    const loopback = isLoopbackHost(host);
    if (!token && !(loopback && allowUnauthenticatedLoopback)) {
      throw new ConfigError(
        "ADVISOR_HTTP_TOKEN is required for HTTP transport. For local unauthenticated development only, set ADVISOR_HTTP_ALLOW_UNAUTHENTICATED_LOOPBACK=true with a loopback host.",
      );
    }
    if (token && token.length < 16) {
      throw new ConfigError("ADVISOR_HTTP_TOKEN must be at least 16 characters");
    }
    if (!loopback && allowUnauthenticatedLoopback && !token) {
      throw new ConfigError(
        "Unauthenticated HTTP is only allowed on a loopback host",
      );
    }
  }

  return {
    host,
    port,
    path: parseHttpPath(env.ADVISOR_HTTP_PATH),
    token,
    allowUnauthenticatedLoopback,
    allowedOrigins: parseOriginAllowlist(env.ADVISOR_HTTP_ALLOWED_ORIGINS),
    allowedHosts: parseHostAllowlist(
      "ADVISOR_HTTP_ALLOWED_HOSTS",
      env.ADVISOR_HTTP_ALLOWED_HOSTS,
    ),
    maxBodyBytes: parsePositiveInt(
      "ADVISOR_HTTP_MAX_BODY_BYTES",
      env.ADVISOR_HTTP_MAX_BODY_BYTES,
      1_048_576,
      { min: 1_024, max: 16_777_216 },
    ),
    maxConcurrentRequests: parsePositiveInt(
      "ADVISOR_HTTP_MAX_CONCURRENT_REQUESTS",
      env.ADVISOR_HTTP_MAX_CONCURRENT_REQUESTS,
      8,
      { max: 1_000 },
    ),
    requestsPerMinute: parsePositiveInt(
      "ADVISOR_HTTP_REQUESTS_PER_MINUTE",
      env.ADVISOR_HTTP_REQUESTS_PER_MINUTE,
      120,
      { max: 100_000 },
    ),
    trustProxy: parseBoolean(
      "ADVISOR_HTTP_TRUST_PROXY",
      env.ADVISOR_HTTP_TRUST_PROXY,
      false,
    ),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdvisorConfig {
  const transport = parseTransport(env.ADVISOR_TRANSPORT);
  const provider = parseProvider(env.ADVISOR_PROVIDER);
  const baseUrl =
    env.ADVISOR_BASE_URL?.trim() ||
    (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");

  const style = (env.ADVISOR_STYLE ?? "brief").trim().toLowerCase();
  if (style !== "brief" && style !== "detailed") {
    throw new ConfigError('ADVISOR_STYLE must be "brief" or "detailed"');
  }

  const store = (env.ADVISOR_STORE ?? "memory").trim().toLowerCase();
  if (store !== "memory" && store !== "file") {
    throw new ConfigError('ADVISOR_STORE must be "memory" or "file"');
  }

  const tokenParam = (env.ADVISOR_TOKEN_PARAM ?? "max_completion_tokens").trim();
  if (tokenParam !== "max_completion_tokens" && tokenParam !== "max_tokens") {
    throw new ConfigError(
      'ADVISOR_TOKEN_PARAM must be "max_completion_tokens" or "max_tokens"',
    );
  }

  const effort = env.ADVISOR_REASONING_EFFORT?.trim().toLowerCase();
  if (effort && !REASONING_EFFORTS.includes(effort)) {
    throw new ConfigError(`ADVISOR_REASONING_EFFORT must be one of: ${REASONING_EFFORTS.join(", ")}`);
  }

  const models = (env.ADVISOR_MODELS ?? env.ADVISOR_MODEL ?? "").split(",").map((model) => model.trim());
  const model = models[0];
  if (!model) {
    throw new ConfigError("Missing ADVISOR_MODEL or ADVISOR_MODELS (use model IDs exposed by your provider)");
  }
  if (models.some((item) => !item) || models.length > 10) {
    throw new ConfigError("ADVISOR_MODELS must contain 1-10 non-empty comma-separated model IDs");
  }
  const transcriptEnabled = parseBoolean("ADVISOR_TRANSCRIPT_ENABLED", env.ADVISOR_TRANSCRIPT_ENABLED, false);
  const transcriptAutoDiscover = parseBoolean("ADVISOR_TRANSCRIPT_AUTO_DISCOVER", env.ADVISOR_TRANSCRIPT_AUTO_DISCOVER, false);
  if (transcriptAutoDiscover && !transcriptEnabled) {
    throw new ConfigError("ADVISOR_TRANSCRIPT_AUTO_DISCOVER requires ADVISOR_TRANSCRIPT_ENABLED=true");
  }

  const apiKey =
    provider === "anthropic"
      ? env.ADVISOR_API_KEY ?? env.ANTHROPIC_API_KEY ?? ""
      : env.ADVISOR_API_KEY ?? env.OPENAI_API_KEY ?? "";
  if (provider === "anthropic" && !apiKey) {
    throw new ConfigError("Missing credentials: set ADVISOR_API_KEY or ANTHROPIC_API_KEY");
  }

  return {
    transport,
    provider,
    model,
    models,
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiVersion: env.ADVISOR_API_VERSION?.trim() || "2023-06-01",
    tokenParam,
    ...(effort ? { reasoningEffort: effort as ReasoningEffort } : {}),
    maxOutputTokens: parsePositiveInt(
      "ADVISOR_MAX_OUTPUT_TOKENS",
      env.ADVISOR_MAX_OUTPUT_TOKENS,
      1200,
      { min: 128, max: 16000 },
    ),
    timeoutMs: parsePositiveInt("ADVISOR_TIMEOUT_MS", env.ADVISOR_TIMEOUT_MS, 60_000, {
      min: 1_000,
      max: 300_000,
    }),
    maxContextTokens: parsePositiveInt(
      "ADVISOR_MAX_CONTEXT_TOKENS",
      env.ADVISOR_MAX_CONTEXT_TOKENS,
      env.ADVISOR_MAX_CONTEXT_TOKENS?.trim() ? 30_000 : Math.floor(parsePositiveInt(
        "ADVISOR_MAX_CONTEXT_CHARS", env.ADVISOR_MAX_CONTEXT_CHARS, 120_000,
        { min: 4_000, max: 2_000_000 },
      ) / 4),
      { min: 1_000, max: 500_000 },
    ),
    transcriptEnabled,
    transcriptAutoDiscover,
    transcriptProjectsDir: expandHomePath(env.ADVISOR_TRANSCRIPT_PROJECTS_DIR?.trim() || join(homedir(), ".claude", "projects")),
    maxCallsPerSession: parsePositiveInt(
      "ADVISOR_MAX_CALLS_PER_SESSION",
      env.ADVISOR_MAX_CALLS_PER_SESSION,
      12,
      { max: 100 },
    ),
    maxCallsPerMinute: parsePositiveInt(
      "ADVISOR_MAX_CALLS_PER_MINUTE",
      env.ADVISOR_MAX_CALLS_PER_MINUTE,
      30,
      { max: 10_000 },
    ),
    dataDir: expandHomePath(
      env.ADVISOR_DATA_DIR?.trim() || join(homedir(), ".advisor-mcp"),
    ),
    store,
    defaultAdviceStyle: style,
    http: loadHttpConfig(env, transport),
  };
}

export function redactedConfigSummary(config: AdvisorConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    transport: config.transport,
    model: config.model,
    models: config.models,
    baseUrl: config.baseUrl,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    tokenParam: config.tokenParam,
    maxContextTokens: config.maxContextTokens,
    transcriptEnabled: config.transcriptEnabled,
    transcriptAutoDiscover: config.transcriptAutoDiscover,
    maxCallsPerSession: config.maxCallsPerSession,
    maxCallsPerMinute: config.maxCallsPerMinute,
    store: config.store,
    dataDir: config.dataDir,
    defaultAdviceStyle: config.defaultAdviceStyle,
    credentials: "configured",
    http: {
      host: config.http.host,
      port: config.http.port,
      path: config.http.path,
      auth: config.http.token ? "bearer" : "disabled-loopback-only",
      allowedOrigins: config.http.allowedOrigins,
      allowedHosts: config.http.allowedHosts,
      maxBodyBytes: config.http.maxBodyBytes,
      maxConcurrentRequests: config.http.maxConcurrentRequests,
      requestsPerMinute: config.http.requestsPerMinute,
      trustProxy: config.http.trustProxy,
    },
  };
}

export function assertConfig(config: AdvisorConfig): void {
  try {
    new URL(config.baseUrl);
  } catch {
    throw new ConfigError(`ADVISOR_BASE_URL is not a valid URL: ${config.baseUrl}`);
  }
}

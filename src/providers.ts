import type { AdvisorConfig } from "./config.js";
import { redactSecrets } from "./redact.js";
import type { AdvisorProvider, ModelFailure, ProviderRequest, ProviderResponse, Usage } from "./types.js";

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      refusal?: string | null;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function openAIEndpoint(baseUrl: string): string {
  if (baseUrl.endsWith("/chat/completions")) return baseUrl;
  if (baseUrl.endsWith("/v1")) return `${baseUrl}/chat/completions`;
  return `${baseUrl}/v1/chat/completions`;
}

function anthropicEndpoint(baseUrl: string): string {
  if (baseUrl.endsWith("/v1/messages")) return baseUrl;
  if (baseUrl.endsWith("/v1")) return `${baseUrl}/messages`;
  return `${baseUrl}/v1/messages`;
}

type OpenAIContent = NonNullable<NonNullable<OpenAIResponse["choices"]>[number]["message"]>["content"];

function openAIText(content: OpenAIContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" || part.text ? part.text ?? "" : ""))
      .join("");
  }
  return "";
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  secrets: string[] = [],
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  try {
    const response = await fetch(url, { ...init, signal: combined });
    if (!response.ok) {
      const body = await response.text();
      let code: unknown;
      try {
        const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
        code = parsed.error?.code ?? parsed.error?.type;
      } catch { /* Non-JSON errors are still reported by status. */ }
      const quota = response.status === 402 ||
        ((response.status === 400 || response.status === 403) &&
          (code === "insufficient_quota" || code === "quota_exceeded"));
      const safeBody = redactProviderText(body, secrets).slice(0, 800);
      throw new ProviderError(
        `Provider returned HTTP ${response.status}${safeBody ? `: ${safeBody}` : ""}`,
        response.status,
        quota || response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500,
        quota ? "quota exceeded" : `HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (signal?.aborted) throw new ProviderError("Advisor request was cancelled");
    if (timeout.aborted) {
      throw new ProviderError(`Provider request timed out after ${timeoutMs}ms`, undefined, true, "timeout");
    }
    if (error instanceof ProviderError || error instanceof SyntaxError) throw error;
    throw new ProviderError(
      `Provider request failed: ${redactProviderText(error instanceof Error ? error.message : String(error), secrets)}`,
      undefined,
      true,
      "network error",
    );
  }
}

function redactProviderText(text: string, secrets: string[]): string {
  const redacted = redactSecrets(text).text;
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((value, secret) => value.split(secret).join("[REDACTED]"), redacted);
}

export class OpenAICompatibleProvider implements AdvisorProvider {
  readonly name = "openai-compatible";

  constructor(private readonly config: AdvisorConfig) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const url = openAIEndpoint(this.config.baseUrl);
    const data = await requestJson<OpenAIResponse>(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          [this.config.tokenParam]: request.maxOutputTokens,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
        }),
      },
      this.config.timeoutMs,
      request.signal,
      [this.config.apiKey],
    );

    const message = data.choices?.[0]?.message;
    const text = openAIText(message?.content).trim();
    if (!text) {
      const detail = message?.refusal ? `: ${redactProviderText(message.refusal, [this.config.apiKey])}` : "";
      throw new ProviderError(`Provider returned an empty response${detail}`);
    }

    const usage: Usage = {
      ...(data.usage?.prompt_tokens !== undefined ? { inputTokens: data.usage.prompt_tokens } : {}),
      ...(data.usage?.completion_tokens !== undefined
        ? { outputTokens: data.usage.completion_tokens }
        : {}),
      ...(data.usage?.total_tokens !== undefined ? { totalTokens: data.usage.total_tokens } : {}),
    };

    return {
      text,
      model: this.config.model,
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }
}

export class AnthropicProvider implements AdvisorProvider {
  readonly name = "anthropic";

  constructor(private readonly config: AdvisorConfig) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const url = anthropicEndpoint(this.config.baseUrl);
    const data = await requestJson<AnthropicResponse>(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": this.config.apiVersion,
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
        }),
      },
      this.config.timeoutMs,
      request.signal,
      [this.config.apiKey],
    );

    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!text) throw new ProviderError("Provider returned an empty response");

    const inputTokens = data.usage?.input_tokens;
    const outputTokens = data.usage?.output_tokens;
    const usage: Usage = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(inputTokens !== undefined && outputTokens !== undefined
        ? { totalTokens: inputTokens + outputTokens }
        : {}),
    };

    return {
      text,
      model: this.config.model,
      ...(Object.keys(usage).length ? { usage } : {}),
    };
  }
}

export function createProvider(config: AdvisorConfig): AdvisorProvider {
  const models = config.models ?? [config.model];
  const providers = models.map((model) => {
    const modelConfig = { ...config, model };
    return config.provider === "anthropic"
      ? new AnthropicProvider(modelConfig)
      : new OpenAICompatibleProvider(modelConfig);
  });
  if (providers.length === 1) return providers[0]!;
  return {
    name: config.provider,
    async complete(request) {
      const failures: ModelFailure[] = [];
      for (let i = 0; i < providers.length; i++) {
        try {
          const result = await providers[i]!.complete(request);
          return { ...result, ...(failures.length ? { failures } : {}) };
        } catch (error) {
          if (!(error instanceof ProviderError) || request.signal?.aborted) throw error;
          failures.push({ model: models[i]!, reason: error.reason ?? "provider error" });
          if (!error.retryable) {
            throw new ProviderError(`Advisor model failed: ${failures.map((f) => `${f.model}: ${f.reason}`).join(", ")}`, error.status);
          }
        }
      }
      throw new ProviderError(`All advisor models failed: ${failures.map((f) => `${f.model}: ${f.reason}`).join(", ")}`);
    },
  };
}
